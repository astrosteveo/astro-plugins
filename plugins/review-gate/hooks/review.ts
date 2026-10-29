import type { EngineInterface, ModelUsage } from 'claude-code'
import type { Finding, Ledger, Level, Risk, Round, Run, Tokens } from '../types'
import { changedFiles, commitLog, diffOf, firstCommit, guideFiles, isAncestor, short, uncommitted } from './git'
import type { Place } from './git'
import { LEVELS, ROUND_CAP, UNJUDGED, aboutOf, atMost, globTest, isCapped, levelFor, newFindings, openFindings, parseGuide, riskNow, riskWith, spent, streak } from './ledger'
import type { Recheck, Reported } from './ledger'
import { RISK, readRisk, riskPrompt } from './prompts'
import type { Context, Plan } from './prompts'

/** The skill a round runs: Claude Code's own code review. */
export const SKILL = 'code-review'

/** How long a round waits for a review the Skill tool started in the background before it stops it. */
const REVIEW_LIMIT_MS = 30 * 60_000

/** How long a round waits for the reply of a review that ran in the foreground, which has landed by then as a rule. */
const REPLY_LIMIT_MS = 5_000

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
 * Where agents' replies arrive: an agent's reply is its turn.complete, which a hook hands to
 * `settle`, and a round waits on it with `take`.
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

/** The round waiting on its review: what the review is told, and what it hands back. */
export type Pending = {
  plan: Plan
  /** The files the branch changes, which a finding's path is read against. */
  changed: ReadonlySet<string>
  /** Whether /code-review's prompt has been given the round's section. */
  isBriefed: boolean
  /** The most findings the review's level lets it report, as its prompt says. */
  cap?: number
  /** The review's agent, once it is known. */
  agentId?: string
  /** The review's tool calls so far. */
  calls: number
  /** What the review recorded through the record tool. */
  record?: { findings: Reported[]; rechecked: Recheck[] }
}

/** What a round needs besides the repository: the caller's wishes and the session's plumbing. */
export type RoundAsk = {
  place: Place
  ledger: Ledger
  intent: string
  /** The call's or the person's level; left out, the option's, else the one the risk calls for. */
  level?: Level
  levelOption: 'auto' | Level
  /** Let the review fix what it finds in the working tree once it has recorded it. */
  fix: boolean
  /** The person's `--max-findings`, handed to /code-review as given. */
  maxFindings?: string
  /** The risk classifier's model; left out, the session's. */
  riskModel?: string
  /** The person's own run: past the round cap, and again over a commit already reviewed. */
  force: boolean
  signal: AbortSignal
  /** Names the round, so a record call can be matched to it. */
  token: string
  mail: Mailbox
  /** Holds the round waiting on its review, for the hooks that brief the review and take its record. */
  desk: { pending?: Pending }
  /** Changes the round in progress, which the band draws. */
  progress: (change: (run: Run | null) => Run | null) => Promise<void>
  /**
   * Changes the branch's record as it stands when the round ends: `change` gives the new record, or
   * why the round may not add to it, which comes back and leaves the record as it was.
   */
  edit: (change: (ledger: Ledger) => Ledger | string) => Promise<Ledger | string>
}

export type RoundResult = { ok: true; ledger: Ledger; round: number; text: string } | { ok: false; text: string }

const refuse = (text: string): RoundResult => ({ ok: false, text })

const STOPPED = 'The review was stopped before it finished, so nothing was recorded.'

function listed(items: readonly string[], most = 5) {
  return items.length <= most ? items.join(', ') : `${items.slice(0, most).join(', ')} and ${items.length - most} more`
}

/**
 * How much is at stake in the branch's change, as a classifier reads it from the code. It is asked
 * twice at most; with no verdict, a person looks.
 */
async function judge($: EngineInterface, ask: RoundAsk, context: Context, diff: string): Promise<{ risk: Risk; tokens: Tokens }> {
  const model = ask.riskModel ?? (await $.session.model())
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

// Why a tool call did not answer: its refusal, its error, or what it threw; undefined when it answered.
function failureOf(called: unknown): string | undefined {
  if (called instanceof Error) return called.message
  if (typeof called !== 'object' || called === null) return String(called)
  const answer = called as { deny?: unknown; isError?: unknown; text?: unknown }
  if (typeof answer.deny === 'string') return answer.deny
  if (answer.isError !== true) return undefined
  return typeof answer.text === 'string' && answer.text !== '' ? answer.text : 'the Skill tool reported an error'
}

/** What the Skill tool hands back for a skill it ran in an agent of its own. */
type Forked = { status: 'forked'; agentId: string; result: string; background?: boolean }

function forked(value: unknown): Forked | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const result = value as Partial<Forked>
  return result.status === 'forked' && typeof result.agentId === 'string' ? { ...result, result: String(result.result ?? '') } as Forked : undefined
}

/**
 * Waits for `promise`, or until the round is stopped or `limitMs` passes, when it gives undefined. A
 * hook's own clock runs while no call of its is in flight, and the reply comes through another
 * hook's event, so the wait keeps a short sleep in flight.
 */
async function waitFor<T>($: EngineInterface, promise: Promise<T>, signal: AbortSignal, limitMs: number): Promise<T | undefined> {
  let value: T | undefined
  let isSettled = false
  void promise.then(got => {
    value = got
    isSettled = true
  })
  const since = await $.clock.now()
  while (!isSettled && !signal.aborted && (await $.clock.now()) - since < limitMs) {
    await Promise.race([promise, $.process.run(['sleep', '1']).catch(() => undefined)])
  }
  return value
}

// Ends a review the round no longer waits for, so it spends nothing more. Best effort: one that has
// ended already, or a session that will not stop it, is left as it is.
async function stop($: EngineInterface, agentId: string) {
  await $.tool.call({ tool: 'TaskStop', task_id: agentId }).catch(() => undefined)
}

/**
 * The review's reply. One that ran in the foreground has replied by the time the Skill tool answers;
 * one the Skill tool started in the background is waited for, and stopped once the round stops
 * waiting for it.
 */
async function replyOf($: EngineInterface, ask: RoundAsk, run: Forked): Promise<Reply | undefined> {
  const got = await waitFor($, ask.mail.take(run.agentId), ask.signal, run.background === true ? REVIEW_LIMIT_MS : REPLY_LIMIT_MS)
  if (got !== undefined) return got
  ask.mail.drop(run.agentId)
  if (run.background === true) await stop($, run.agentId)
  return undefined
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
  } finally {
    ask.desk.pending = undefined
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
  await ask.progress(() => ({ round: n, phase: 'judging', startedAt }))
  const files = await changedFiles(git, place.base, place.head)
  const guides = (await guideFiles(git, place.base, files)).map(file => parseGuide(file.path, file.text))
  const skip = guides.flatMap(guide => guide.skip)
  const skipped = skip.map(globTest)
  const kept = (list: readonly string[]) => list.filter(file => !skipped.some(test => test(file)))

  // After the first round, a round reads only the commits since the last one, as long as they build
  // on it; a rebase or an amend sends it back over the whole branch, and so does a last review that
  // reported as many findings as its level lets it, since it may have left some out.
  const reviewed = ledger.reviewed
  const isDelta =
    reviewed !== undefined && reviewed !== place.head && last !== undefined && !isCapped(last) && (await isAncestor(git, reviewed, place.head))
  const from = isDelta && reviewed !== undefined ? reviewed : place.base
  const roundFiles = kept(isDelta ? await changedFiles(git, from, place.head) : files)

  // The change's risk picks the round's level, unless the call or the options name one. A commit
  // judged before keeps its verdict, and a round over new commits alone runs at most at high. Only
  // the classifier reads the branch's whole diff, so it is read only when the classifier runs.
  let tokens = NONE
  let judged = ledger.riskFor?.sha === place.head ? ledger.riskFor.risk : undefined
  let isUnjudged = false
  if (judged === undefined) {
    const [whole, commits] = await Promise.all([diffOf(git, place.base, place.head), commitLog(git, place.base, place.head)])
    const context: Context = { branch: place.branch, head: place.head, intent: ask.intent, commits, stat: whole.stat, guides }
    const verdict = await judge($, ask, context, whole.body)
    judged = verdict.risk
    isUnjudged = verdict.risk === UNJUDGED
    tokens = sum(tokens, verdict.tokens)
  }
  if (ask.signal.aborted) return refuse(STOPPED)
  const wanted = ask.levelOption === 'auto' ? levelFor(riskWith(judged, ledger.findings)) : ask.levelOption
  const level = ask.level ?? (isDelta ? atMost(wanted, 'high') : wanted)

  const plan: Plan = {
    token: ask.token,
    n,
    branch: place.branch,
    root: place.root,
    head: place.head,
    from,
    scope: isDelta ? 'delta' : 'full',
    level,
    fix: ask.fix,
    intent: ask.intent,
    guides,
    skip,
    earlier: ledger.findings,
  }
  let record: Pending['record'] = { findings: [], rechecked: [] }
  let cap: number | undefined
  let calls: number | undefined
  let fixes = ''
  let isUnfinished = false
  // Commits that change only files REVIEW.md skips leave the review nothing to read.
  if (roundFiles.length > 0) {
    const pending: Pending = { plan, changed: new Set(files), isBriefed: false, calls: 0 }
    ask.desk.pending = pending
    await ask.progress(run => (run === null ? run : { ...run, phase: 'reviewing', level }))
    const args = [level, `${from}..${place.head}`, ...(ask.fix ? ['--fix'] : []), ...(ask.maxFindings === undefined ? [] : ['--max-findings', ask.maxFindings])]
    const called = await $.tool.call({ tool: 'Skill', skill: SKILL, args: args.join(' ') }).catch((error: unknown) => error)
    const run = forked(typeof called === 'object' && called !== null ? (called as { result?: unknown }).result : undefined)
    if (ask.signal.aborted) {
      // A review the round started runs on once the round stops: stopped, it spends nothing more and
      // changes no file after the person has said stop.
      const orphan = run?.agentId ?? pending.agentId
      if (orphan !== undefined) await stop($, orphan)
      return refuse(STOPPED)
    }
    const failure = failureOf(called)
    if (failure !== undefined) return refuse(`/code-review could not run: ${failure}. Nothing was recorded.`)
    if (run !== undefined) {
      // A review the Skill tool started in the background is known from here, and the band follows it.
      if (pending.agentId === undefined) {
        pending.agentId = run.agentId
        await ask.progress(current => (current === null ? current : { ...current, agentId: run.agentId }))
      }
      const reply = await replyOf($, ask, run)
      tokens = plus(tokens, reply?.usage)
      // A review in the background hands back word of its start, not its result.
      fixes = (reply?.answer ?? (run.background === true ? '' : run.result)).trim()
      calls = pending.calls
      isUnfinished = reply === undefined && run.background === true
    }
    if (ask.signal.aborted) return refuse(STOPPED)
    if (pending.record === undefined)
      return refuse(
        `/code-review ended without recording its findings${run === undefined ? ', and it ran in no agent of its own' : ''}, so the round has nothing to stand on. Nothing was recorded; review again.`,
      )
    record = pending.record
    cap = pending.cap
  }

  const added = newFindings(record.findings, n, ledger.findings)
  const fixedIds = record.rechecked.filter(one => one.fixed).map(one => one.id)
  const at = await $.clock.now()
  const first = ledger.first ?? (await firstCommit(git, place.base, place.head))
  // The round adds to the record as it stands now, so an answer given while it ran, such as a
  // dismissal, an approval or the person's leave for more rounds, stays. A record reset meanwhile,
  // or given a round by another session, is not the one the round read, and is left alone.
  const saved = await ask.edit(current => {
    if (current.rounds.length !== ledger.rounds.length)
      return `${place.branch}'s review record was reset, or another session recorded a round on it, while this round ran, so this round was not recorded. Review again.`
    // Only a finding still open is closed as fixed: one dismissed meanwhile keeps its reason.
    const closing = current.findings.filter(finding => finding.status === 'open' && fixedIds.includes(finding.id)).map(finding => finding.id)
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
      level,
      risk: riskWith(judged, findings),
      raised: record.findings.length,
      ...(cap === undefined ? {} : { cap }),
      kept: added.length,
      fixed: closing.length,
      open: findings.filter(finding => finding.status === 'open').length,
      at,
      durationMs: at - startedAt,
      tokens,
      ...(calls === undefined ? {} : { calls }),
      ...(roundFiles.length === 0 ? { skipped: true } : {}),
    }
    // A classifier with no verdict is asked again next time.
    return {
      ...current,
      rounds: [...current.rounds, round],
      findings,
      reviewed: place.head,
      first: current.first ?? first,
      ...(isUnjudged ? {} : { riskFor: { sha: place.head, risk: judged } }),
    }
  })
  if (typeof saved === 'string') return refuse(saved)
  const notes: string[] = []
  if (isUnfinished)
    notes.push(`The review had not finished after ${REVIEW_LIMIT_MS / 60_000} minutes, so it was stopped; it had recorded its findings before that.`)
  if (ask.fix && fixes !== '')
    notes.push(
      `The review then changed the working tree, as --fix asks. Its report:\n\n${fixes}\n\nCommit the fixes you keep and review again: the next round confirms each fix. Dismiss, with a reason, any finding it skipped that you will not fix.`,
    )
  return { ok: true, ledger: saved, round: n, text: [summary(saved, n), ...notes].join('\n\n') }
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
  const about = aboutOf(finding)
  return [
    `${finding.id} · ${finding.severity}${kind} · ${where}${about === '' ? '' : ` · ${about}`}`,
    `  ${finding.title}`,
    ...(finding.detail === '' ? [] : [`  ${finding.detail.replace(/\n/g, '\n  ')}`]),
    ...(finding.scenario === '' ? [] : [`  When: ${finding.scenario.replace(/\n/g, '\n  ')}`]),
  ].join('\n')
}

/** Whether a word names a level a person or the model may ask for. */
export const isLevel = (word: unknown): word is Level => LEVELS.some(level => level === word)

/**
 * A round as the model and the person's command read it. Its first line names the round, branch
 * and commit, which the chat's card is found by.
 */
export function summary(ledger: Ledger, n: number) {
  const round = ledger.rounds.find(one => one.n === n)
  if (round === undefined) return `${ledger.branch} has no review round ${n}.`
  const risk = riskNow(ledger) ?? round.risk
  const lines = [
    `Review round ${n} of ${ledger.branch} at ${short(round.head)}: ${
      round.scope === 'full' ? 'the whole branch' : `the commits since ${short(round.from)}`
    }, /code-review ${round.level}, risk ${risk.tier}${risk.why.length > 0 ? ` (${risk.why.join('; ')})` : ''}.`,
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
  if (round.raised > round.kept) {
    const again = round.raised - round.kept
    lines.push(`${again} finding${again === 1 ? '' : 's'} the review reported ${again === 1 ? 'was' : 'were'} on the record already, so ${again === 1 ? 'it was' : 'they were'} not raised again.`)
  }
  if (isCapped(round)) lines.push(`The review reported ${round.raised}, as many findings as /code-review ${round.level} lets it, so the next round reviews the whole branch again.`)
  if (open.length === 0) {
    const approval =
      risk.tier === 'high' && ledger.approved?.sha !== round.head
        ? ' It is high risk, so the gate asks the user to approve it when the pull request is opened or merged.'
        : ''
    lines.push(`Nothing is open. ${ledger.branch} at ${short(round.head)} is ready for a pull request.${approval}`)
  }
  if (round.skipped === true) lines.push(`Every file the round covers is on a REVIEW.md Skip list, so no review ran.`)
  const cost = spent(round)
  const calls = round.calls === undefined ? '' : `, and the review made ${round.calls} tool call${round.calls === 1 ? '' : 's'}`
  if (cost !== '') lines.push(`The round took ${cost}${calls}.`)
  if (open.length > 0 && streak(ledger) >= ROUND_CAP) lines.push(stepBack(ledger))
  return lines.join('\n\n')
}
