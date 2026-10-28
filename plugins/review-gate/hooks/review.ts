import type { EngineInterface } from 'claude-code'
import type { Depth, Finding, Ledger, Risk, Round, Run } from '../types'
import { changedFiles, changedLines, commitLog, diffOf, guideFiles, inRanges, isAncestor, short, uncommitted } from './git'
import type { Place } from './git'
import {
  DEPTHS,
  ROUND_CAP,
  UNJUDGED,
  securityReason,
  depthFor,
  fixedIds,
  fresh,
  globTest,
  merge,
  openFindings,
  parseGuide,
  rank,
  riskNow,
  streak,
  tally,
} from './ledger'
import type { CheckerReply, Kept } from './ledger'
import { FOCUS, RISK, checkerPrompt, readFindings, readRisk, readVerdicts, reviewerPrompt, riskPrompt } from './prompts'
import type { Context } from './prompts'

export const REVIEWER_TYPE = 'review-gate:reviewer'
export const CHECKER_TYPE = 'review-gate:checker'

/** How long one phase of a round waits for its agents before it counts the missing ones as unread. */
const PHASE_LIMIT_MS = 20 * 60_000

/**
 * Where spawned agents' replies arrive. A spawn answers once its agent starts; the agent's reply is
 * its turn.complete, which a hook hands to `settle`, and a round waits on it with `take`.
 */
export type Mailbox = {
  settle: (agentId: string, answer: string) => void
  take: (agentId: string) => Promise<string>
  drop: (agentId: string) => void
}

export function mailbox(): Mailbox {
  const waiting = new Map<string, (answer: string) => void>()
  // A reply can land before its round asks for it: kept a while, the newest few.
  const early = new Map<string, string>()
  return {
    settle(agentId, answer) {
      const resolve = waiting.get(agentId)
      if (resolve !== undefined) {
        waiting.delete(agentId)
        resolve(answer)
        return
      }
      early.set(agentId, answer)
      for (const oldest of early.keys()) {
        if (early.size <= 20) break
        early.delete(oldest)
      }
    },
    take(agentId) {
      const answer = early.get(agentId)
      if (answer !== undefined) {
        early.delete(agentId)
        return Promise.resolve(answer)
      }
      return new Promise(resolve => waiting.set(agentId, resolve))
    },
    drop(agentId) {
      waiting.delete(agentId)
    },
  }
}

/** What a round needs besides the repository: the caller's wishes and the session's plumbing. */
export type RoundAsk = {
  place: Place
  ledger: Ledger
  intent: string
  /** The call's or the person's depth; left out, the option's, else the one the risk calls for. */
  depth?: Depth
  depthOption: 'auto' | Depth
  /** The reviewers' model; left out, the session's. */
  model?: string
  /** The person's own run: past the round cap, and again over a commit already reviewed. */
  force: boolean
  signal: AbortSignal
  mail: Mailbox
  /** The review agents running or run: their commands are held to reading. */
  reviewers: Set<string>
  progress: (run: Run | null) => Promise<void>
  save: (ledger: Ledger) => Promise<void>
}

export type RoundResult = { ok: true; ledger: Ledger; round: number; text: string } | { ok: false; text: string }

type Job = { type: string; description: string; prompt: string }

const refuse = (text: string): RoundResult => ({ ok: false, text })

function listed(items: readonly string[], most = 5) {
  return items.length <= most ? items.join(', ') : `${items.slice(0, most).join(', ')} and ${items.length - most} more`
}

// Ends an agent a round stopped waiting for, so it spends nothing more. Best effort: one that has
// ended already, or a session that will not stop it, is left as it is.
async function stop($: EngineInterface, agentId: string) {
  await $.tool.call({ tool: 'TaskStop', task_id: agentId }).catch(() => undefined)
}

/**
 * Starts one agent per job and waits for their replies, in order, undefined for an agent that did
 * not start or did not answer in time. A hook's clock stops while any `$` call of its is in flight,
 * and the replies arrive through other hooks' events, so the wait keeps a short sleep in flight.
 */
async function team(
  $: EngineInterface,
  ask: RoundAsk,
  jobs: readonly Job[],
  onDone: (done: number) => Promise<void>,
): Promise<(string | undefined)[]> {
  const ids = await Promise.all(
    jobs.map(async job => {
      const spawned = await $.agent
        .spawn({
          prompt: job.prompt,
          description: job.description,
          subagentType: job.type,
          cwd: ask.place.root,
          ...(ask.model === undefined ? {} : { model: ask.model }),
        })
        .catch(() => undefined)
      if (spawned === undefined || spawned.deny !== undefined || spawned.agentId === undefined) return undefined
      ask.reviewers.add(spawned.agentId)
      return spawned.agentId
    }),
  )
  const replies: (string | undefined)[] = ids.map(() => undefined)
  let done = 0
  const all = Promise.all(
    ids.map(async (id, index) => {
      if (id === undefined) return
      replies[index] = await ask.mail.take(id)
      done += 1
    }),
  )
  let settled = false
  void all.then(() => {
    settled = true
  })
  const started = await $.clock.now()
  let shown = -1
  while (!settled && !ask.signal.aborted && (await $.clock.now()) - started < PHASE_LIMIT_MS) {
    if (shown !== done) {
      shown = done
      await onDone(done)
    }
    await Promise.race([all, $.process.run(['sleep', '1'])])
  }
  await onDone(done)
  await Promise.all(
    ids.map(async (id, index) => {
      if (id === undefined || replies[index] !== undefined) return
      ask.mail.drop(id)
      await stop($, id)
    }),
  )
  return replies
}

/** The risk a change carries, a security finding on the branch included. */
function riskWith(risk: Risk, findings: readonly Finding[]): Risk {
  const security = findings.filter(finding => finding.kind === 'security' && finding.status !== 'fixed')
  if (security.length === 0 || risk.tier === 'high') return risk
  return { tier: 'high', why: [...risk.why, securityReason(security)] }
}

const nameOf = (focus: string) => FOCUS[focus]?.label ?? focus

/**
 * How much is at stake in the branch's change, as a classifier reads it from the code. It is asked
 * twice at most; with no verdict, a person looks.
 */
async function judge($: EngineInterface, ask: RoundAsk, context: Context, diff: string): Promise<Risk> {
  const model = ask.model ?? (await $.session.model())
  for (let tries = 0; tries < 2 && !ask.signal.aborted; tries++) {
    const reply = await $.model
      .complete({ model, system: RISK, prompt: riskPrompt(context, diff), maxTokens: 1_024 }, { signal: ask.signal })
      .catch(() => undefined)
    const risk = reply?.isAnswered === true ? readRisk(reply.text) : undefined
    if (risk !== undefined) return risk
  }
  return UNJUDGED
}

/** Runs one round of review on the branch's latest commit and records what it found. */
export async function runRound($: EngineInterface, ask: RoundAsk): Promise<RoundResult> {
  const { place, ledger } = ask
  const git = place.git
  if (place.branch === '') return refuse('HEAD is detached: check out the branch the change is on, then review it.')
  if (place.main === '' || place.base === '')
    return refuse(`${place.root} has no default branch to compare against: no main, master or trunk, here or on origin.`)
  if (place.branch === place.main)
    return refuse(`You are on ${place.main}. A review covers a branch's commits past ${place.main}: make a branch for the change, commit it there, then review it.`)
  if (place.ahead === 0) return refuse(`${place.branch} has no commits past ${place.main}: commit the change, then review it.`)
  const dirty = await uncommitted(git)
  if (dirty.length > 0)
    return refuse(`Commit first: a review covers one commit, and these files have changes it would not see: ${listed(dirty)}.`)

  const last = ledger.rounds[ledger.rounds.length - 1]
  const open = openFindings(ledger)
  if (!ask.force && last !== undefined && ledger.reviewed === place.head) {
    return { ok: true, ledger, round: last.n, text: `${summary(ledger, last.n)}\n\nThis commit was reviewed already; nothing was run again.` }
  }
  if (!ask.force && streak(ledger) >= ROUND_CAP && open.length > 0) return refuse(stepBack(ledger))

  const n = (last?.n ?? 0) + 1
  const files = await changedFiles(git, place.base, place.head)
  const guides = (await guideFiles(git, place.head, files)).map(file => parseGuide(file.path, file.text))
  const skip = guides.flatMap(guide => guide.skip).map(globTest)
  const kept = (list: readonly string[]) => list.filter(file => !skip.some(test => test(file)))

  // After the first round, a round reads only the commits since the last one, as long as they
  // build on it; a rebase or an amend sends it back over the whole branch.
  const reviewed = ledger.reviewed
  const isDelta = reviewed !== undefined && reviewed !== place.head && last !== undefined && (await isAncestor(git, reviewed, place.head))
  const from = isDelta && reviewed !== undefined ? reviewed : place.base
  const roundFiles = kept(isDelta ? await changedFiles(git, from, place.head) : files)
  const [whole, diff, commits, lines] = await Promise.all([
    diffOf(git, place.base, place.head, kept(files)),
    diffOf(git, from, place.head, roundFiles),
    commitLog(git, place.base, place.head),
    changedLines(git, place.base, place.head),
  ])
  const context: Context = {
    branch: place.branch,
    head: place.head,
    from,
    scope: isDelta ? 'delta' : 'full',
    intent: ask.intent,
    commits,
    stat: whole.stat,
    diff: diff.body,
    guides,
    earlier: ledger.findings,
  }

  // The change's risk picks the round's depth, unless the call or the options name one.
  await ask.progress({ round: n, phase: 'judging', done: 0, of: 1 })
  const judged = await judge($, ask, context, whole.body)
  if (ask.signal.aborted) return refuse('The review was stopped before it finished, so nothing was recorded.')
  const depth = ask.depth ?? (ask.depthOption === 'auto' ? depthFor(riskWith(judged, ledger.findings)) : ask.depthOption)

  const plan = DEPTHS[depth]
  const focuses = roundFiles.length === 0 ? [] : plan.focuses
  const reviewing = (done: number) => ask.progress({ round: n, phase: 'reviewing', done, of: focuses.length })
  await reviewing(0)
  const raised = await team(
    $,
    ask,
    focuses.map(focus => ({ type: REVIEWER_TYPE, description: `review: ${nameOf(focus)}`, prompt: reviewerPrompt(context, focus) })),
    reviewing,
  )
  if (ask.signal.aborted) return refuse('The review was stopped before it finished, so nothing was recorded.')
  const read = raised.map((reply, index) => (reply === undefined ? undefined : readFindings(reply, focuses[index] ?? 'logic')))
  const unreadReviewers = read.filter(list => list === undefined).length
  if (focuses.length > 0 && unreadReviewers === focuses.length)
    return refuse(`None of the ${focuses.length} reviewers gave a reply that could be read, so the round has nothing it can stand behind. Nothing was recorded; review again.`)
  const candidates = fresh(merge(read.flatMap(list => list ?? [])), ledger.findings)

  let confirmed: Kept[] = []
  let fixed: string[] = []
  let unreadCheckers = 0
  if (candidates.length > 0 || open.length > 0) {
    const checking = (done: number) => ask.progress({ round: n, phase: 'checking', done, of: plan.checkers })
    await checking(0)
    const prompt = checkerPrompt(context, candidates, open, (file, line) => inRanges(lines.get(file), line))
    const replies = await team(
      $,
      ask,
      Array.from({ length: plan.checkers }, (_, index) => ({ type: CHECKER_TYPE, description: `check findings ${index + 1}`, prompt })),
      checking,
    )
    if (ask.signal.aborted) return refuse('The review was stopped before it finished, so nothing was recorded.')
    const votes = replies.flatMap((reply): CheckerReply[] => {
      const verdicts = reply === undefined ? undefined : readVerdicts(reply)
      return verdicts === undefined ? [] : [verdicts]
    })
    unreadCheckers = plan.checkers - votes.length
    if (votes.length === 0)
      return refuse(`None of the ${plan.checkers} checkers gave a reply that could be read, so no finding could be confirmed. Nothing was recorded; review again.`)
    confirmed = rank(tally(candidates, votes))
    fixed = fixedIds(open, votes)
  }

  const added: Finding[] = confirmed.map((finding, index) => ({
    id: `R${n}-${index + 1}`,
    round: n,
    kind: finding.kind,
    severity: finding.grade,
    file: finding.file,
    line: finding.line,
    title: finding.title,
    detail: finding.detail,
    evidence: finding.evidence,
    votes: finding.votes,
    status: 'open',
  }))
  const findings: Finding[] = [
    ...ledger.findings.map(finding =>
      fixed.includes(finding.id) ? { ...finding, status: 'fixed' as const, answer: `fixed at ${short(place.head)}`, closedRound: n } : finding,
    ),
    ...added,
  ]
  const round: Round = {
    n,
    head: place.head,
    from,
    scope: isDelta ? 'delta' : 'full',
    depth,
    risk: riskWith(judged, findings),
    raised: candidates.length,
    kept: added.length,
    fixed: fixed.length,
    open: findings.filter(finding => finding.status === 'open').length,
    unread: unreadReviewers + unreadCheckers,
    at: await $.clock.now(),
  }
  const next: Ledger = { ...ledger, rounds: [...ledger.rounds, round], findings, reviewed: place.head }
  await ask.save(next)
  return { ok: true, ledger: next, round: n, text: summary(next, n) }
}

/** What the round cap says: three rounds have left findings open, so the next move is a person's. */
export function stepBack(ledger: Ledger) {
  const recent = ledger.rounds.slice(-ROUND_CAP)
  const counts = recent.map(round => `round ${round.n} left ${round.open} open`).join(', ')
  const open = openFindings(ledger)
  return `${ROUND_CAP} rounds in a row have ended with findings open (${counts}), so no further round runs. Step back rather than patch again: tell the user what keeps coming back (${open
    .map(finding => `${finding.id} ${finding.title}`)
    .join('; ')}) and whether the approach should change, and ask how to go on. They can allow more rounds with /review-gate more.`
}

function findingText(finding: Finding) {
  const kind = finding.kind === 'bug' ? '' : ` ${finding.kind}`
  const where = finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file
  return [
    `${finding.id} · ${finding.severity}${kind} · ${where} · ${finding.votes.real} of ${finding.votes.of} checkers agree`,
    `  ${finding.title}`,
    ...(finding.detail === '' ? [] : [`  ${finding.detail.replace(/\n/g, '\n  ')}`]),
    ...(finding.evidence === '' ? [] : [`  Evidence: ${finding.evidence.replace(/\n/g, '\n  ')}`]),
  ].join('\n')
}

/**
 * A round as the model and the person's command read it. Its first line names the round, branch
 * and commit, which the chat's card is found by.
 */
export function summary(ledger: Ledger, n: number) {
  const round = ledger.rounds.find(one => one.n === n)
  if (round === undefined) return `${ledger.branch} has no review round ${n}.`
  const plan = DEPTHS[round.depth]
  const risk = riskNow(ledger) ?? round.risk
  const lines = [
    `Review round ${n} of ${ledger.branch} at ${short(round.head)}: ${
      round.scope === 'full' ? 'the whole branch' : `the commits since ${short(round.from)}`
    }, ${round.depth} depth (${plan.focuses.length} reviewers, ${plan.checkers} checkers), risk ${risk.tier}${
      risk.why.length > 0 ? ` (${risk.why.join('; ')})` : ''
    }.`,
  ]
  const open = openFindings(ledger)
  if (open.length > 0) {
    lines.push(
      `${open.length} finding${open.length === 1 ? '' : 's'} open. Answer each one: fix it and commit, then review again (the next round checks the fix); or dismiss it with the reason it can stay.`,
      ...open.map(findingText),
    )
  }
  const closed = ledger.findings.filter(finding => finding.closedRound === n)
  if (closed.length > 0) lines.push(`Found fixed this round: ${closed.map(finding => `${finding.id} (${finding.title})`).join('; ')}.`)
  if (open.length === 0) {
    const approval =
      risk.tier === 'high' && ledger.approved?.sha !== round.head
        ? ' It is high risk, so the gate asks the user to approve it when the pull request is opened or merged.'
        : ''
    lines.push(`Nothing is open. ${ledger.branch} at ${short(round.head)} is ready for a pull request.${approval}`)
  }
  if (round.unread > 0) lines.push(`${round.unread} agent repl${round.unread === 1 ? 'y' : 'ies'} could not be read and counted for nothing.`)
  if (open.length > 0 && streak(ledger) >= ROUND_CAP) lines.push(stepBack(ledger))
  return lines.join('\n\n')
}
