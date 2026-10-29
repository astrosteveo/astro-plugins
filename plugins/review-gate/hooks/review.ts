import type { EngineInterface, ModelUsage } from 'claude-code'
import type { AgentStat, Depth, Finding, Ledger, Risk, Round, Run, Tokens } from '../types'
import { changedFiles, changedLines, commitLog, diffOf, firstCommit, guideFiles, inRanges, isAncestor, short, uncommitted } from './git'
import type { Place } from './git'
import {
  DEPTHS,
  ROUND_CAP,
  UNJUDGED,
  decided,
  securityReason,
  spent,
  depthFor,
  excludes,
  fixedIds,
  fresh,
  globTest,
  merge,
  openFindings,
  parseGuide,
  quorum,
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
const PHASE_LIMIT_MS = 10 * 60_000

/** How long the last agent of a phase may run on once all the others have answered. */
const LAST_AGENT_MS = 3 * 60_000

/** How long the first checker runs alone, so the others' first requests find its prompt in the cache. */
const STAGGER_SECONDS = '8'

const NONE: Tokens = { input: 0, output: 0, cached: 0 }

/** Tokens with one call's usage added: input at full price (cache writes included), output, and cache reads. */
export function plus(tokens: Tokens, usage: ModelUsage | undefined): Tokens {
  if (usage === undefined) return tokens
  return {
    input: tokens.input + (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
    output: tokens.output + (usage.output_tokens ?? 0),
    cached: tokens.cached + (usage.cache_read_input_tokens ?? 0),
  }
}

const sum = (a: Tokens, b: Tokens): Tokens => ({ input: a.input + b.input, output: a.output + b.output, cached: a.cached + b.cached })

/** An agent's reply: its last answer, and what its turn cost. */
export type Reply = { answer: string; usage?: ModelUsage }

/**
 * Where spawned agents' replies arrive. A spawn answers once its agent starts; the agent's reply is
 * its turn.complete, which a hook hands to `settle`, and a round waits on it with `take`.
 */
export type Mailbox = {
  settle: (agentId: string, answer: string, usage?: ModelUsage) => void
  take: (agentId: string) => Promise<Reply>
  drop: (agentId: string) => void
}

export function mailbox(): Mailbox {
  const waiting = new Map<string, (reply: Reply) => void>()
  // A reply can land before its round asks for it: kept a while, the newest few.
  const early = new Map<string, Reply>()
  return {
    settle(agentId, answer, usage) {
      const reply: Reply = usage === undefined ? { answer } : { answer, usage }
      const resolve = waiting.get(agentId)
      if (resolve !== undefined) {
        waiting.delete(agentId)
        resolve(reply)
        return
      }
      early.set(agentId, reply)
      for (const oldest of early.keys()) {
        if (early.size <= 20) break
        early.delete(oldest)
      }
    },
    take(agentId) {
      const reply = early.get(agentId)
      if (reply !== undefined) {
        early.delete(agentId)
        return Promise.resolve(reply)
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
  /** The reviewers' and checkers' model; left out, the session's. */
  model?: string
  /** The risk classifier's model; left out, the reviewers'. */
  riskModel?: string
  /** The person's own run: past the round cap, and again over a commit already reviewed. */
  force: boolean
  signal: AbortSignal
  mail: Mailbox
  /** The review agents running or run: theirs are the review's read-only tools. */
  reviewers: Set<string>
  /** Changes the round in progress, which the band draws. */
  progress: (change: (run: Run | null) => Run | null) => Promise<void>
  /** How many tool calls an agent has made. */
  callsOf: (agentId: string) => Promise<number>
  /**
   * Changes the branch's record as it stands when the round ends: `change` gives the new record, or
   * why the round may not add to it, which comes back and leaves the record as it was.
   */
  edit: (change: (ledger: Ledger) => Ledger | string) => Promise<Ledger | string>
}

export type RoundResult = { ok: true; ledger: Ledger; round: number; text: string } | { ok: false; text: string }

type Job = { type: string; label: string; description: string; prompt: string; focus?: string }

const refuse = (text: string): RoundResult => ({ ok: false, text })

function listed(items: readonly string[], most = 5) {
  return items.length <= most ? items.join(', ') : `${items.slice(0, most).join(', ')} and ${items.length - most} more`
}

// Ends an agent a round stopped waiting for, so it spends nothing more. Best effort: one that has
// ended already, or a session that will not stop it, is left as it is.
async function stop($: EngineInterface, agentId: string) {
  await $.tool.call({ tool: 'TaskStop', task_id: agentId }).catch(() => undefined)
}

/** A phase's agents and what came of them. */
type Team = {
  replies: (string | undefined)[]
  /** Agents stopped because the vote was decided without them: no failure, and not unread. */
  cut: number
  tokens: Tokens
  stats: AgentStat[]
}

type TeamOptions = {
  /** Start the first agent alone, so the others, given the same prompt, read it from the cache. */
  stagger?: boolean
  /** Whether the replies so far settle the outcome, counted over the agents `planned`. */
  decide?: (replies: readonly (string | undefined)[], planned: number) => boolean
  /** Hears each reply as it lands, so the band can show what it raised. */
  onReply?: (job: Job, agentId: string, answer: string) => Promise<void>
}

const mark = (agentId: string, state: 'done' | 'stopped', endedAt: number) => (run: Run | null) =>
  run === null ? run : { ...run, agents: run.agents.map(agent => (agent.id === agentId ? { ...agent, state, endedAt } : agent)) }

/**
 * Starts one agent per job and waits for their replies, in order, undefined for an agent that did
 * not start or did not answer. A hook's clock stops while any `$` call of its is in flight, and the
 * replies arrive through other hooks' events, so the wait keeps a short sleep in flight.
 *
 * Each agent shows in the band from its start to its end. The wait is no longer than it must be:
 * once `decide` says the replies so far settle the outcome, the rest are stopped; once all but one
 * agent has answered, the last gets LAST_AGENT_MS more.
 */
async function team($: EngineInterface, ask: RoundAsk, jobs: readonly Job[], options: TeamOptions = {}): Promise<Team> {
  const began = new Map<string, number>()
  const spawn = async (job: Job) => {
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
    const id = spawned.agentId
    ask.reviewers.add(id)
    const startedAt = await $.clock.now()
    began.set(id, startedAt)
    await ask.progress(run => (run === null ? run : { ...run, agents: [...run.agents, { id, label: job.label, state: 'running', startedAt }] }))
    return id
  }
  const [lead, ...others] = jobs
  const ahead = options.stagger === true && lead !== undefined && others.length > 0 ? [await spawn(lead)] : []
  if (ahead.length > 0) await $.process.run(['sleep', STAGGER_SECONDS]).catch(() => undefined)
  const ids = [...ahead, ...(await Promise.all((ahead.length > 0 ? others : jobs).map(spawn)))]
  const started = ids.filter(id => id !== undefined).length
  const replies: (string | undefined)[] = ids.map(() => undefined)
  const ended = new Map<string, number>()
  let tokens = NONE
  let done = 0
  const all = Promise.all(
    ids.map(async (id, index) => {
      if (id === undefined) return
      const reply = await ask.mail.take(id)
      replies[index] = reply.answer
      tokens = plus(tokens, reply.usage)
      done += 1
      const at = await $.clock.now()
      ended.set(id, at)
      const job = jobs[index]
      if (job !== undefined) await options.onReply?.(job, id, reply.answer)
      await ask.progress(mark(id, 'done', at))
    }),
  )
  let settled = false
  void all.then(() => {
    settled = true
  })
  const since = await $.clock.now()
  let lastAlone: number | undefined
  let isDecided = false
  while (!settled && !ask.signal.aborted) {
    const now = await $.clock.now()
    if (now - since >= PHASE_LIMIT_MS) break
    if (options.decide !== undefined && done > 0 && options.decide(replies, jobs.length)) {
      isDecided = true
      break
    }
    if (started > 1 && done === started - 1) {
      lastAlone ??= now
      if (now - lastAlone >= LAST_AGENT_MS) break
    }
    await Promise.race([all, $.process.run(['sleep', '1'])])
  }
  const now = await $.clock.now()
  let cut = 0
  await Promise.all(
    ids.map(async (id, index) => {
      if (id === undefined || replies[index] !== undefined) return
      ask.mail.drop(id)
      if (isDecided) cut += 1
      await stop($, id)
      await ask.progress(mark(id, 'stopped', now))
    }),
  )
  const stats = await Promise.all(
    jobs.map(async (job, index): Promise<AgentStat> => {
      const id = ids[index]
      if (id === undefined) return { label: job.label, ms: 0, calls: 0, state: 'unread' }
      const state = replies[index] !== undefined ? 'done' : isDecided ? 'stopped' : 'unread'
      return { label: job.label, ms: (ended.get(id) ?? now) - (began.get(id) ?? since), calls: await ask.callsOf(id), state }
    }),
  )
  return { replies, cut, tokens, stats }
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
async function judge($: EngineInterface, ask: RoundAsk, context: Context, diff: string): Promise<{ risk: Risk; tokens: Tokens }> {
  const model = ask.riskModel ?? ask.model ?? (await $.session.model())
  // The prompt is marked for the cache, so a second try, or a run again within five minutes, reads it there.
  const prompt = [{ text: riskPrompt(context, diff), cache: true as const }]
  let tokens = NONE
  for (let tries = 0; tries < 2 && !ask.signal.aborted; tries++) {
    const reply = await $.model.complete({ model, system: RISK, prompt, maxTokens: 1_024 }, { signal: ask.signal }).catch(() => undefined)
    tokens = plus(tokens, reply?.usage)
    const risk = reply?.isAnswered === true ? readRisk(reply.text) : undefined
    if (risk !== undefined) return { risk, tokens }
  }
  return { risk: UNJUDGED, tokens }
}

/**
 * Runs one round of review on the branch's latest commit and records what it found. A git read that
 * fails ends the round with git's words, and nothing is recorded.
 */
export async function runRound($: EngineInterface, ask: RoundAsk): Promise<RoundResult> {
  try {
    return await roundOf($, ask)
  } catch (error) {
    return refuse(`${error instanceof Error ? error.message : String(error)}. Nothing was recorded.`)
  }
}

async function roundOf($: EngineInterface, ask: RoundAsk): Promise<RoundResult> {
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

  const startedAt = await $.clock.now()
  const n = (last?.n ?? 0) + 1
  await ask.progress(() => ({ round: n, phase: 'judging', startedAt, agents: [], raised: [] }))
  const files = await changedFiles(git, place.base, place.head)
  const changed = new Set(files)
  const guides = (await guideFiles(git, place.base, files)).map(file => parseGuide(file.path, file.text))
  const skipped = guides.flatMap(guide => guide.skip)
  const skip = skipped.map(globTest)
  const kept = (list: readonly string[]) => list.filter(file => !skip.some(test => test(file)))
  const left = excludes(skipped)

  // After the first round, a round reads only the commits since the last one, as long as they
  // build on it; a rebase or an amend sends it back over the whole branch.
  const reviewed = ledger.reviewed
  const isDelta = reviewed !== undefined && reviewed !== place.head && last !== undefined && (await isAncestor(git, reviewed, place.head))
  const from = isDelta && reviewed !== undefined ? reviewed : place.base
  const newFiles = isDelta ? await changedFiles(git, from, place.head) : files
  const roundFiles = kept(newFiles)
  // The agents read the diff with REVIEW.md's Skip files left out; the risk classifier reads all of it.
  const [whole, full, diff, commits, lines] = await Promise.all([
    diffOf(git, place.base, place.head, left),
    left.length === 0 ? undefined : diffOf(git, place.base, place.head, []),
    diffOf(git, from, place.head, left),
    commitLog(git, place.base, place.head),
    changedLines(git, place.base, place.head),
  ])
  const everything = full ?? whole
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

  // The change's risk picks the round's depth, unless the call or the options name one. A commit
  // judged before keeps its verdict, and a round over new commits alone runs at most at standard.
  let tokens = NONE
  let judged = ledger.riskFor?.sha === place.head ? ledger.riskFor.risk : undefined
  let isUnjudged = false
  if (judged === undefined) {
    const verdict = await judge($, ask, { ...context, stat: everything.stat }, everything.body)
    judged = verdict.risk
    isUnjudged = verdict.risk === UNJUDGED
    tokens = sum(tokens, verdict.tokens)
  }
  if (ask.signal.aborted) return refuse('The review was stopped before it finished, so nothing was recorded.')
  const wanted = ask.depthOption === 'auto' ? depthFor(riskWith(judged, ledger.findings)) : ask.depthOption
  const depth = ask.depth ?? (isDelta && wanted === 'deep' ? 'standard' : wanted)

  const plan = DEPTHS[depth]
  const focuses = roundFiles.length === 0 ? [] : plan.focuses
  await ask.progress(run => (run === null ? run : { ...run, phase: 'reviewing', agents: [] }))
  const reviewers = await team(
    $,
    ask,
    focuses.map(focus => ({ type: REVIEWER_TYPE, label: nameOf(focus), description: `review: ${nameOf(focus)}`, prompt: reviewerPrompt(context, focus), focus })),
    {
      // What a reviewer raised shows in the band as soon as it answers, before any vote.
      onReply: async (job, agentId, answer) => {
        const found = readFindings(answer, job.focus ?? 'logic', changed) ?? []
        await ask.progress(run =>
          run === null
            ? run
            : {
                ...run,
                raised: [...run.raised, ...found.map(one => one.title)],
                agents: run.agents.map(agent => (agent.id === agentId ? { ...agent, raised: found.length } : agent)),
              },
        )
      },
    },
  )
  tokens = sum(tokens, reviewers.tokens)
  if (ask.signal.aborted) return refuse('The review was stopped before it finished, so nothing was recorded.')
  const read = reviewers.replies.map((reply, index) => (reply === undefined ? undefined : readFindings(reply, focuses[index] ?? 'logic', changed)))
  const unreadReviewers = read.filter(list => list === undefined).length
  if (focuses.length > 0 && unreadReviewers === focuses.length)
    return refuse(`None of the ${focuses.length} reviewers gave a reply that could be read, so the round has nothing it can stand behind. Nothing was recorded; review again.`)
  const candidates = fresh(merge(read.flatMap(list => list ?? [])), ledger.findings)

  // Every open finding is looked at again: a fix may sit in another file than the one it names.
  const recheck = open
  const votesOf = (replies: readonly (string | undefined)[]) =>
    replies.flatMap((reply): CheckerReply[] => {
      const verdicts = reply === undefined ? undefined : readVerdicts(reply)
      return verdicts === undefined ? [] : [verdicts]
    })
  let confirmed: Kept[] = []
  let fixed: string[] = []
  let unreadCheckers = 0
  let isComplete = unreadReviewers === 0
  const stats = [...reviewers.stats]
  if (candidates.length > 0 || recheck.length > 0) {
    await ask.progress(run => (run === null ? run : { ...run, phase: 'checking', agents: [] }))
    const prompt = checkerPrompt(context, candidates, recheck, (file, line) => inRanges(lines.get(file), line))
    // The vote is counted over the checkers asked for, so one that never starts makes it harder to
    // pass, never easier.
    const checkers = await team(
      $,
      ask,
      Array.from({ length: plan.checkers }, (_, index) => ({
        type: CHECKER_TYPE,
        label: `checker ${index + 1}`,
        description: `check findings ${index + 1}`,
        prompt,
      })),
      {
        stagger: true,
        decide: (replies, planned) =>
          decided(
            candidates.length,
            recheck.map(finding => finding.id),
            votesOf(replies),
            planned,
          ),
      },
    )
    tokens = sum(tokens, checkers.tokens)
    stats.push(...checkers.stats)
    if (ask.signal.aborted) return refuse('The review was stopped before it finished, so nothing was recorded.')
    const votes = votesOf(checkers.replies)
    unreadCheckers = plan.checkers - checkers.cut - votes.length
    if (votes.length === 0)
      return refuse(`None of the ${plan.checkers} checkers gave a reply that could be read, so no finding could be confirmed. Nothing was recorded; review again.`)
    isComplete = isComplete && votes.length + checkers.cut >= quorum(plan.checkers)
    confirmed = rank(tally(candidates, votes, plan.checkers))
    fixed = fixedIds(recheck, votes, plan.checkers)
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
  const at = await $.clock.now()
  const first = ledger.first ?? (await firstCommit(git, place.base, place.head))
  // The round adds to the record as it stands now, so an answer given while it ran, such as a
  // dismissal, an approval or the person's leave for more rounds, stays. A record reset meanwhile,
  // or given a round by another session, is not the one the round read, and is left alone.
  const saved = await ask.edit(current => {
    if (current.rounds.length !== ledger.rounds.length)
      return `${place.branch}'s review record was reset, or another session recorded a round on it, while this round ran, so this round was not recorded. Review again.`
    // Only a finding still open is closed as fixed: one dismissed meanwhile keeps its reason.
    const closing = current.findings.filter(finding => finding.status === 'open' && fixed.includes(finding.id)).map(finding => finding.id)
    const findings: Finding[] = [
      ...current.findings.map(finding =>
        closing.includes(finding.id) ? { ...finding, status: 'fixed' as const, answer: `fixed at ${short(place.head)}`, closedRound: n } : finding,
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
      fixed: closing.length,
      open: findings.filter(finding => finding.status === 'open').length,
      unread: unreadReviewers + unreadCheckers,
      at,
      durationMs: at - startedAt,
      tokens,
      agents: stats,
      complete: isComplete,
    }
    // A round that lost agents keeps what it found but vouches for nothing: the commit stays to be
    // reviewed. A classifier with no verdict is asked again next time.
    return {
      ...current,
      rounds: [...current.rounds, round],
      findings,
      ...(isComplete ? { reviewed: place.head } : {}),
      first: current.first ?? first,
      ...(isUnjudged ? {} : { riskFor: { sha: place.head, risk: judged } }),
    }
  })
  if (typeof saved === 'string') return refuse(saved)
  return { ok: true, ledger: saved, round: n, text: summary(saved, n) }
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
  if (round.complete === false) {
    lines.push(
      `This round lost ${round.unread} of its agents, so it does not count as a review of ${short(round.head)}: review again to cover what they missed.`,
    )
  } else if (open.length === 0) {
    const approval =
      risk.tier === 'high' && ledger.approved?.sha !== round.head
        ? ' It is high risk, so the gate asks the user to approve it when the pull request is opened or merged.'
        : ''
    lines.push(`Nothing is open. ${ledger.branch} at ${short(round.head)} is ready for a pull request.${approval}`)
  }
  if (round.unread > 0) lines.push(`${round.unread} agent repl${round.unread === 1 ? 'y' : 'ies'} could not be read and counted for nothing.`)
  const cost = spent(round)
  if (cost !== '') lines.push(`The round took ${cost}.`)
  if (open.length > 0 && streak(ledger) >= ROUND_CAP) lines.push(stepBack(ledger))
  return lines.join('\n\n')
}
