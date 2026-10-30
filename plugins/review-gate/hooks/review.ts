import type { EngineInterface, ModelUsage } from 'claude-code'
import type { Finding, Ledger, Level, Risk, Round, Run, Tokens } from '../types'
import { changedFiles, commitLog, diffOf, firstCommit, guideFiles, headNow, isAncestor, short, uncommitted } from './git'
import type { Place } from './git'
import { LEVELS, NIT_CAP, ROUND_CAP, UNJUDGED, aboutOf, atLeast, atMost, globTest, isApplied, isCapped, levelFor, nothingOpen, openFindings, parseGuide, rereadLevel, riskNow, riskWith, spent, streak, whereOf } from './ledger'
import type { Recheck } from './ledger'
import { RISK, readRisk, riskPrompt } from './prompts'
import type { Context, Fix, Plan } from './prompts'

/** The skill a round runs: Claude Code's own code review. */
export const SKILL = 'code-review'

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
  /**
   * The review's agent, once something proves it: the agent list says this plugin started it, or the
   * Skill tool names it.
   */
  agentId?: string
  /** The review's tool calls so far. */
  calls: number
  /** What the turns of the review and the agents it started have cost so far. */
  tokens: Tokens
  /** The agents the review started, as far as the agent list has shown them, whose turns count in its cost. */
  team: Set<string>
  /** Agents the list showed outside the review's team, which never join it. */
  strangers: Set<string>
  /** New agents no plugin named that made calls while the review was unknown: the review, untagged, may be one. */
  untagged: Set<string>
  /**
   * Why the round records nothing because the repository is no longer as it found it, or undefined
   * while it is: HEAD moved, or a file changed. The record call asks before it takes the findings.
   */
  drift: () => Promise<string | undefined>
  /** What the record call's drift said, so the round records nothing. */
  drifted?: string
  /** Whether a file is one REVIEW.md skips, so a finding in it is left out. */
  isSkipped: (file: string) => boolean
  /**
   * Where the skill named code-review came from, when it is not Claude Code's own: a project's or a
   * person's skill of that name is not the gate's review, and is not briefed.
   */
  shadowed?: string
  /**
   * What the review recorded through the record tool: how many findings it reported, the rechecks,
   * the findings the round adds, with the ids the review was told, and how many it left out as
   * repeats, as nits past the cap, and as findings in files REVIEW.md skips.
   */
  record?: { raised: number; rechecked: Recheck[]; added: Finding[]; repeats: number; nitsLeft: number; skippedOut: number }
  /** With --fix, what the review did about each finding, from its second record call. */
  fixes?: Fix[]
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
  /** Takes an agent as the round's review, on proof such as the Skill tool naming it. */
  bind: (agentId: string) => Promise<void>
  /** Rung by the hooks on each event that may have ended the review, which wakes the round's wait. */
  bell: Bell
  /** Marks agents the round stopped as its own, so their notices stay out of the conversation. */
  quiet: (agentIds: readonly string[]) => void

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
type Forked = { status: 'forked'; agentId: string; result: string; background?: boolean; success?: boolean }

function forked(value: unknown): Forked | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const result = value as Partial<Forked>
  return result.status === 'forked' && typeof result.agentId === 'string' ? { ...result, result: String(result.result ?? '') } as Forked : undefined
}

/**
 * What wakes a round's wait: the hooks ring it on each event that may have ended the review, such as
 * a turn's end in the review or an agent of its, and the round waits on it. `next` is the next ring.
 */
export type Bell = { ring: () => void; next: () => Promise<void> }

export function bell(): Bell {
  let ring = () => undefined as void
  let next = new Promise<void>(resolve => (ring = resolve))
  return {
    ring() {
      const rung = ring
      next = new Promise<void>(resolve => (ring = resolve))
      rung()
    },
    next: () => next,
  }
}

/**
 * Waits until `woken` settles, the round is stopped, or `seconds` pass, with one `sleep` in flight
 * all the while: a hook's own clock runs while no call of its is in flight, and what it waits for
 * comes through other hooks' events. The sleep is ended as soon as the wait is woken, so the wait
 * costs one child however long it lasts. False when `sleep` cannot run; the hook's own sleep would
 * spend its clock, so the caller stops waiting rather than spin or time out.
 */
async function pause($: EngineInterface, woken: Promise<unknown>, signal: AbortSignal, seconds: number) {
  // A round already stopped, or a wait already woken, has nothing to wait for.
  if (signal.aborted || (await isSettled(woken))) return true
  let child: ReturnType<EngineInterface['process']['spawn']>
  try {
    child = $.process.spawn({ argv: ['sleep', String(seconds)] })
  } catch {
    return false
  }
  const slept = child.next().then(
    step => step.done === true && step.value.code === 0,
    () => false,
  )
  let onAbort = () => undefined as void
  const stopped = new Promise<'woken'>(resolve => {
    onAbort = () => resolve('woken')
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    const ended = await Promise.race([slept, woken.then(() => 'woken' as const), stopped])
    if (ended !== 'woken') return ended || signal.aborted
    await child.return({ code: null, signal: null }).catch(() => undefined)
    return true
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

// Whether a promise has settled already, read without waiting on it.
async function isSettled(promise: Promise<unknown>) {
  const NOT_YET = Symbol('not yet')
  const first = await Promise.race([promise.then(() => true, () => true), Promise.resolve(NOT_YET)])
  return first !== NOT_YET
}

/**
 * Waits for `promise`, or until the round is stopped or `limitMs` passes, when it gives no value.
 * Where `sleep` cannot run the wait ends at once, and says so.
 */
async function waitFor<T>($: EngineInterface, promise: Promise<T>, signal: AbortSignal, limitMs: number): Promise<{ value?: T; isStuck: boolean }> {
  let value: T | undefined
  void promise.then(got => {
    value = got
  })
  const isRunning = await pause($, promise, signal, Math.ceil(limitMs / 1000))
  return value === undefined ? { isStuck: !isRunning } : { value, isStuck: false }
}

const STUCK = 'review-gate could not wait for the review, since the `sleep` program could not run here, so it stopped the review.'

const UNLISTED = 'review-gate could not read the agent list to see whether the review had ended, so it stopped the review.'

/**
 * Why the round records nothing, as the person reads it, or undefined while the repository is as the
 * round found it: HEAD where it was, and, with `files`, no file changed. The tree was clean when the
 * round began, so a changed file is one the review may have read: changed by the person, by another
 * agent, or by the review against its instructions.
 */
async function driftOf(git: Place['git'], place: Place, files: boolean) {
  const now = await headNow(git)
  if (now.head !== place.head || now.branch !== place.branch) {
    const where = now.branch === '' ? `a detached HEAD at ${short(now.head)}` : `${now.branch} at ${short(now.head)}`
    return `HEAD moved while the round ran: it began on ${place.branch} at ${short(place.head)}, and HEAD is now ${where}. Nothing was recorded. Put HEAD where you want the review to read, then review again.`
  }
  if (!files) return undefined
  const changed = await uncommitted(git)
  if (changed.length === 0) return undefined
  return `Files changed while the round ran: ${listed(changed)}. The review may have read them, so nothing was recorded. Commit or undo them, then review again.`
}

/** An agent and every agent under it, as the agent list's parents say. */
export function teamOf(agents: readonly { id: string; parentId?: string }[], root: string): Set<string> {
  const team = new Set([root])
  for (let isGrowing = true; isGrowing; ) {
    isGrowing = false
    for (const agent of agents)
      if (agent.parentId !== undefined && team.has(agent.parentId) && !team.has(agent.id)) {
        team.add(agent.id)
        isGrowing = true
      }
  }
  return team
}

// What the agent list says of an agent that has ended.
const ENDED = new Set(['completed', 'failed', 'killed'])

/**
 * Ends a review the round no longer waits for, and every agent it started, as /code-review max starts
 * its angles, so none spends more, changes a file or posts its report into the conversation. Those
 * stopped are the round's, so their notices are dropped as the review's are. Best effort: one that
 * has ended already, or a session that will not stop it, is left as it is.
 */
async function stop($: EngineInterface, ask: RoundAsk, agentId: string) {
  if (await isRefused($, ask, agentId)) stopLater($, ask, agentId, STOP_TRIES)
}

/** How long a refused stop waits before it asks again, and how many times it asks in all. */
const STOP_AGAIN_MS = 1_000
const STOP_TRIES = 3

// Asks the session to stop an agent and every agent under it that has not ended, as the agent list
// shows them now, and gives whether it refused any. One that has ended already answers with an
// error, which is no refusal.
async function isRefused($: EngineInterface, ask: RoundAsk, agentId: string) {
  const agents = await $.agent.list().catch(() => undefined)
  const team = agents === undefined ? new Set([agentId]) : teamOf(agents, agentId)
  ask.quiet([...team])
  const live = [...team].filter(id => !ENDED.has(agents?.find(one => one.id === id)?.status ?? ''))
  const answers: unknown[] = await Promise.all(live.map(id => $.tool.call({ tool: 'TaskStop', task_id: id }).catch(() => undefined)))
  return answers.some(answer => typeof answer === 'object' && answer !== null && 'deny' in answer)
}

// Right after the person presses Esc, the session refuses every tool call, the round's TaskStop
// included, and the review runs on, and may start agents meanwhile. A moment later, from a timer
// outside the round, it does not: the list is read again, so those agents are stopped too.
function stopLater($: EngineInterface, ask: RoundAsk, agentId: string, tries: number) {
  $.clock.after(STOP_AGAIN_MS, () => {
    void isRefused($, ask, agentId).then(refused => {
      if (refused && tries > 1) stopLater($, ask, agentId, tries - 1)
    })
  })
}

/** How many reads of the agent list in a row may fail before the round stops waiting on it. */
const LIST_TRIES = 10

/**
 * Waits on a review the Skill tool started in the background until it has handed back all the round
 * asks of it through the record tool, which rings the round's bell, as long as that takes: a pause
 * between its turns, such as while agents of its own work, is no end. The agent list is read only to
 * see a review that ends without handing it all back: one the list shows ended, or idle with nothing
 * of its own at work for QUIET_MS, since until then it may only be waiting on a background agent's or
 * shell's notice. Gives how it ended, as the list says, and whether the wait could not go on: where
 * `sleep` cannot run, or the agent list cannot be read.
 */
async function untilDone($: EngineInterface, ask: RoundAsk, agentId: string): Promise<{ stuck?: string; status?: string }> {
  let quietSince: number | undefined
  for (let misses = 0; !ask.signal.aborted && !isHandedBack(ask); ) {
    // The ring is taken before the list is read, so one that comes while it is read still wakes the wait.
    const woken = ask.bell.next()
    const agents = await $.agent.list().catch(() => undefined)
    // A list that could not be read says nothing of the review: it is read again soon.
    misses = agents === undefined ? misses + 1 : 0
    if (misses >= LIST_TRIES) return { stuck: UNLISTED }
    const state = agents === undefined ? 'running' : stateOf(agents, agentId)
    if (typeof state === 'object') return state
    const now = await $.clock.now()
    quietSince = state === 'quiet' ? (quietSince ?? now) : undefined
    if (quietSince !== undefined && now - quietSince >= QUIET_MS) return {}
    const seconds = misses > 0 ? 1 : quietSince === undefined ? CHECK_EVERY_S : Math.ceil((QUIET_MS - (now - quietSince)) / 1000)
    if (!(await pause($, woken, ask.signal, Math.max(1, Math.min(seconds, CHECK_EVERY_S))))) return ask.signal.aborted ? {} : { stuck: STUCK }
  }
  return {}
}

/** How often, in seconds, a round looks at the agent list when no event wakes it. */
const CHECK_EVERY_S = 15

/** How long a review that has not handed back all the round asks must stay idle before it has ended. */
const QUIET_MS = 60_000

// Whether the review has handed back all the round asks of it: its findings, and with --fix its fixes.
function isHandedBack(ask: RoundAsk) {
  const pending = ask.desk.pending
  return pending?.record !== undefined && (!pending.plan.fix || pending.fixes !== undefined)
}

/**
 * What the agent list says of the review: how it ended; `quiet`, idle between turns with no agent of
 * its own at work; or `running`. One the list no longer shows has ended. One waiting on agents of its
 * own reads as waiting, so is running.
 */
function stateOf(agents: readonly { id: string; parentId?: string; status: string }[], agentId: string): { status?: string } | 'quiet' | 'running' {
  const agent = agents.find(one => one.id === agentId)
  if (agent === undefined) return {}
  if (ENDED.has(agent.status)) return { status: agent.status }
  if (agent.status !== 'idle') return 'running'
  const team = teamOf(agents, agentId)
  const isBusy = agents.some(one => one.id !== agentId && team.has(one.id) && !ENDED.has(one.status) && one.status !== 'idle')
  return isBusy ? 'running' : 'quiet'
}

/**
 * The review's last reply, and how it ended. One that ran in the foreground has replied by the time
 * the Skill tool answers; one the Skill tool started in the background is waited for until it is done,
 * then given a moment for its closing words, then stopped with its agents: the round has what it
 * needs, and a review left running could change files no round records.
 */
async function replyOf($: EngineInterface, ask: RoundAsk, run: Forked): Promise<{ reply?: Reply; stuck?: string; status?: string }> {
  const ended = run.background === true ? await untilDone($, ask, run.agentId) : {}
  if (ended.stuck !== undefined) {
    await stop($, ask, run.agentId)
    return { stuck: ended.stuck }
  }
  const got = await waitFor($, ask.mail.take(run.agentId), ask.signal, REPLY_LIMIT_MS)
  if (got.value === undefined) ask.mail.drop(run.agentId)
  // A stopped round stops the review itself, once.
  if (run.background === true && !ask.signal.aborted) await stop($, ask, run.agentId)
  return got.value === undefined ? ended : { ...ended, reply: got.value }
}

// Why the agent list says a review ended, when it did not end as it should.
const endedBadly = (status: string | undefined) =>
  status === 'failed' ? 'the agent list shows its agent failed' : status === 'killed' ? 'the agent list shows its agent was stopped' : undefined

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
  if (place.main === '' || place.mainRef === '')
    return refuse(`${place.root} has no default branch to compare against: no main, master or trunk, here or on origin.`)
  if (place.base === '' && place.forkError !== '')
    return refuse(`git could not find where ${place.branch} forked from ${place.mainRef}: ${place.forkError}. Nothing was recorded.`)
  if (place.base === '')
    return refuse(
      `git finds no commit ${place.branch} shares with ${place.mainRef}, so there is nothing to compare it against. In a shallow clone, fetch the history (git fetch --unshallow); a branch with no history in common with ${place.main} cannot be reviewed against it.`,
    )
  if (place.branch === place.main)
    return refuse(`You are on ${place.main}. A review covers a branch's commits past ${place.main}: make a branch for the change, commit it there, then review it.`)
  if (place.ahead === 0) return refuse(`${place.branch} has no commits past ${place.main}: commit the change, then review it.`)
  // The review reads the working tree, so a file the commit does not hold, a new one included, could
  // pass for part of the change.
  const dirty = await uncommitted(git)
  if (dirty.length > 0)
    return refuse(
      `Commit first: a review covers one commit, and these files, new ones included, are not in it: ${listed(dirty)}. Commit them, or remove or ignore the ones that are not part of the change.`,
    )

  const last = ledger.rounds[ledger.rounds.length - 1]
  const open = openFindings(ledger)
  // A commit is read again only by the person, or once after a round that hit its finding limit. That
  // read, or a round over commits since, reads the whole branch at that round's level at least: a
  // shallower read may miss what the deeper one left out.
  const reread = rereadLevel(ledger)
  const owed = reread ?? (isCapped(last) ? last?.level : undefined)
  if (!ask.force && last !== undefined && ledger.reviewed === place.head && reread === undefined) {
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
  // on it; a rebase or an amend sends it back over the whole branch, and so does a read owed after a
  // review that reported as many findings as its level lets it, since it may have left some out.
  const reviewed = ledger.reviewed
  const isDelta =
    reviewed !== undefined && reviewed !== place.head && last !== undefined && owed === undefined && (await isAncestor(git, reviewed, place.head))
  const from = isDelta && reviewed !== undefined ? reviewed : place.base
  const span = isDelta ? await changedFiles(git, from, place.head) : files
  const roundFiles = kept(span)

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
  const picked = ask.level ?? (isDelta ? atMost(wanted, 'high') : wanted)
  // The person's own level stands; any other read owed after a capped round reads as deep as it.
  const level = owed !== undefined && !(ask.force && ask.level !== undefined) ? atLeast(picked, owed) : picked

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
  let record: NonNullable<Pending['record']> = { raised: 0, rechecked: [], added: [], repeats: 0, nitsLeft: 0, skippedOut: 0 }
  let cap: number | undefined
  let calls: number | undefined
  let report = ''
  // Why the round could not wait for the review to end, when it could not.
  let stuck: string | undefined
  // Why the review did not succeed, in its words or a stand-in.
  let failed: string | undefined
  // Files the review left changed, new ones included: its fixes with --fix, and changes it was asked
  // not to make without. The tree was clean when the round began.
  let touched: string[] = []
  let fixes: Fix[] | undefined
  // Findings the review said it fixed though no file changed.
  let claimed: string[] = []
  // Commits that change only files REVIEW.md skips leave the review nothing to read, unless it has
  // open findings to look at again: a fix may sit in a skipped file.
  const isReviewed = roundFiles.length > 0 || open.length > 0
  if (isReviewed) {
    const pending: Pending = {
      plan,
      changed: new Set(files),
      isSkipped: file => skipped.some(test => test(file)),
      isBriefed: false,
      calls: 0,
      tokens: NONE,
      team: new Set(),
      strangers: new Set(),
      untagged: new Set(),
      drift: () => driftOf(git, place, true),
    }
    ask.desk.pending = pending
    await ask.progress(run => (run === null ? run : { ...run, phase: 'reviewing', level }))
    const args = [level, `${from}..${place.head}`, ...(ask.fix ? ['--fix'] : []), ...(ask.maxFindings === undefined ? [] : ['--max-findings', ask.maxFindings])]
    const called = await $.tool.call({ tool: 'Skill', skill: SKILL, args: args.join(' ') }).catch((error: unknown) => error)
    const run = forked(typeof called === 'object' && called !== null ? (called as { result?: unknown }).result : undefined)
    // The Skill tool names the review's agent: known from here, whatever happens next, so its notices
    // are the round's and the band follows it.
    if (run !== undefined) await ask.bind(run.agentId)
    // A review the round started runs on once the round stops: stopped, it spends nothing more and
    // changes no file after the person has said stop.
    const halt = async () => {
      const orphan = run?.agentId ?? pending.agentId
      if (orphan !== undefined) await stop($, ask, orphan)
      return refuse(STOPPED)
    }
    if (ask.signal.aborted) return halt()
    if (pending.shadowed !== undefined) {
      if (run !== undefined) await stop($, ask, run.agentId)
      return refuse(
        `The skill named ${SKILL} here comes from ${pending.shadowed}, not Claude Code, so review-gate did not run it as its review: a branch could make it say anything. Rename that skill, or remove it, then review again. Nothing was recorded.`,
      )
    }
    // A review that failed after it recorded keeps its record, and the round says it failed.
    const failure = failureOf(called)
    if (failure !== undefined && pending.record === undefined) return refuse(`/code-review could not run: ${failure}. Nothing was recorded.`)
    failed = failure
    if (run !== undefined) {
      // One that did not succeed, or did not start, is not waited for.
      if (run.success === false) {
        failed = run.result.trim() || 'it gave no reason'
        if (run.background === true) await stop($, ask, run.agentId)
      } else {
        const got = await replyOf($, ask, run)
        // A review in the background hands back word of its start, not its result.
        report = (got.reply?.answer ?? (run.background === true ? '' : run.result)).trim()
        stuck = got.stuck
        failed = endedBadly(got.status) ?? failed
      }
      tokens = sum(tokens, pending.tokens)
      calls = pending.calls
    }
    if (ask.signal.aborted) return halt()
    // A round's findings are about the commit it began at. When HEAD moved, or files changed before the
    // review recorded, or at all without --fix, when the review changes none, the round cannot say what
    // the review read, and records nothing. With --fix, files changed after the record are its fixes.
    const drifted = pending.drifted ?? (await driftOf(git, place, !ask.fix))
    if (drifted !== undefined) return refuse(drifted)
    if (pending.record === undefined)
      return refuse(
        `${
          run !== undefined && failed === undefined && pending.untagged.has(run.agentId)
            ? "/code-review ran, but the agent list did not name review-gate as its starter, so the gate could not tell it was the review and took no record from it."
            : `/code-review ended without recording its findings${
                run === undefined ? ', and it ran in no agent of its own' : failed !== undefined ? `, and it failed: ${failed}` : ''
              }, so the round has nothing to stand on.`
        }${stuck === undefined ? '' : ` ${stuck}`} Nothing was recorded; review again.`,
      )
    record = pending.record
    cap = pending.cap
    touched = await uncommitted(git)
    // A fix is in the working tree or nowhere: with no file changed, the fixes the review claims are
    // not kept, and the round says so.
    claimed = touched.length === 0 ? (pending.fixes ?? []).filter(one => one.applied).map(one => one.id) : []
    fixes = ask.fix ? pending.fixes?.filter(one => !claimed.includes(one.id)) : undefined
  }

  const added = record.added
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
    // What an earlier --fix did is replaced by this round's word on each open finding.
    const withFix = (finding: Finding): Finding => {
      const { fix: _, ...rest } = finding
      if (finding.status !== 'open') return rest
      const done = fixes?.find(one => one.id === finding.id)
      return done === undefined ? rest : { ...rest, fix: { round: n, applied: done.applied, why: done.why } }
    }
    const findings: Finding[] = [
      ...current.findings.map(finding =>
        closing.includes(finding.id) ? { ...finding, status: 'fixed' as const, answer: `fixed at ${short(place.head)}`, closedRound: n } : finding,
      ),
      ...added,
    ].map(withFix)
    const round: Round = {
      n,
      head: place.head,
      from,
      scope: isDelta ? 'delta' : 'full',
      level,
      risk: riskWith(judged, findings),
      raised: record.raised,
      ...(cap === undefined ? {} : { cap }),
      kept: added.length,
      ...(record.nitsLeft > 0 ? { nitsLeft: record.nitsLeft } : {}),
      ...(record.skippedOut > 0 ? { skippedOut: record.skippedOut } : {}),
      fixed: closing.length,
      open: findings.filter(finding => finding.status === 'open').length,
      at,
      durationMs: at - startedAt,
      tokens,
      ...(calls === undefined ? {} : { calls }),
      ...(isReviewed ? {} : span.length === 0 ? { unchanged: true } : { skipped: true }),
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
  if (stuck !== undefined) notes.push(`${stuck} It had recorded its findings before that.`)
  if (failed !== undefined) notes.push(`The review recorded its findings, then failed: ${failed}`)
  // A review that said what it fixed is shown by the summary; one that did not is quoted.
  const quoted = report === '' ? '' : ` Its report:\n\n${report}`
  // A round whose files are all skipped ran no review, so it has no fixes to speak of. Files changed
  // once the review recorded are its fixes as a rule, but anything else running may have changed
  // them too, so they are named as changed, not as the review's.
  if (ask.fix && isReviewed) {
    if (touched.length === 0)
      notes.push(
        `No file changed while the round ran, though --fix let the review change files.${
          claimed.length > 0 ? ` The review said it fixed ${claimed.join(', ')}, so ${claimed.length === 1 ? 'that finding stays' : 'those findings stay'} open as before.` : ''
        }${fixes === undefined ? quoted : ''}`,
      )
    else if (fixes !== undefined) notes.push(`Files changed while the round ran, in the working tree and not committed: ${listed(touched, 10)}.`)
    else
      notes.push(
        `Files changed while the round ran: ${listed(touched)}. The review did not say which findings it fixed.${quoted}\n\nCommit the fixes you keep and review again: the next round confirms each fix.`,
      )
  }
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
  const about = aboutOf(finding)
  return [
    `${finding.id} · ${finding.severity}${kind} · ${whereOf(finding)}${about === '' ? '' : ` · ${about}`}`,
    `  ${finding.title}`,
    ...(finding.detail === '' ? [] : [`  ${finding.detail.replace(/\n/g, '\n  ')}`]),
    ...(finding.scenario === '' ? [] : [`  When: ${finding.scenario.replace(/\n/g, '\n  ')}`]),
    ...(finding.fix !== undefined && !finding.fix.applied && finding.fix.why !== '' ? [`  The review left it: ${finding.fix.why}`] : []),
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
  // A fix the review made is its word, not yet a round's: it stays open until a round confirms it.
  // Whether it has been committed since is git's to say, so the record does not guess.
  const open = openFindings(ledger)
  const applied = open.filter(isApplied)
  const waiting = open.filter(finding => !isApplied(finding))
  if (applied.length > 0)
    lines.push(
      `The review fixed ${
        applied.length === open.length ? (open.length === 1 ? 'the open finding' : `all ${open.length} open findings`) : `${applied.length} of the ${open.length} open findings`
      }. Each stays open until a round confirms its fix: commit the fixes you keep, then review again.`,
      applied.map(finding => `${finding.id} · ${whereOf(finding)}\n  ${finding.title}${finding.fix?.why ? `\n  Fixed: ${finding.fix.why}` : ''}`).join('\n\n'),
    )
  if (waiting.length > 0)
    lines.push(
      `${applied.length > 0 ? `The other ${waiting.length} need${waiting.length === 1 ? 's' : ''} your answer` : `${waiting.length} finding${waiting.length === 1 ? '' : 's'} open`}. Answer each one: fix it and commit, then review again (the next round checks the fix); or dismiss it with the reason it can stay.`,
      ...waiting.map(findingText),
    )
  const closed = ledger.findings.filter(finding => finding.closedRound === n)
  if (closed.length > 0) lines.push(`Found fixed this round: ${closed.map(finding => `${finding.id} (${finding.title})`).join('; ')}.`)
  const nits = round.nitsLeft ?? 0
  const skippedOut = round.skippedOut ?? 0
  const again = round.raised - round.kept - nits - skippedOut
  if (again > 0)
    lines.push(`${again} finding${again === 1 ? '' : 's'} the review reported ${again === 1 ? 'was' : 'were'} on the record already, so ${again === 1 ? 'it was' : 'they were'} not raised again.`)
  if (nits > 0) lines.push(`${nits} more nit${nits === 1 ? ' was' : 's were'} left out: a round raises at most ${NIT_CAP}.`)
  if (skippedOut > 0) lines.push(`${skippedOut} finding${skippedOut === 1 ? ' was' : 's were'} in files REVIEW.md skips, so ${skippedOut === 1 ? 'it was' : 'they were'} left out.`)
  if (isCapped(round)) lines.push(`The review reported ${round.raised}, as many findings as /code-review ${round.level} lets it, so the next round reviews the whole branch again.`)
  if (open.length === 0) lines.push(nothingOpen(ledger, round.head))
  if (round.skipped === true) lines.push(`Every file the round covers is on a REVIEW.md Skip list, so no review ran.`)
  if (round.unchanged === true) lines.push('The commits the round covers change no file, so no review ran.')
  const cost = spent(round)
  const calls = round.calls === undefined ? '' : `, and the review made ${round.calls} tool call${round.calls === 1 ? '' : 's'}`
  if (cost !== '') lines.push(`The round took ${cost}${calls}.`)
  if (open.length > 0 && streak(ledger) >= ROUND_CAP) lines.push(stepBack(ledger))
  return lines.join('\n\n')
}
