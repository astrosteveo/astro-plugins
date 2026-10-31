import type { EngineInterface } from 'claude-code'
import type { Finding, Ledger, Level, Risk, Round, Run } from '../types'
import { changedFiles, commitLog, diffOf, guideFiles, headNow, isAncestor, short, uncommitted } from './git'
import type { Place } from './git'
import { LEVELS, NIT_CAP, ROUND_CAP, UNJUDGED, aboutOf, atMost, globTest, levelFor, nothingOpen, openFindings, parseGuide, riskNow, riskWith, capLeft, leftText, spent, streak, whereOf } from './ledger'
import type { Recheck } from './ledger'
import { RISK, readRisk, riskPrompt } from './prompts'
import type { Context, Plan } from './prompts'

/** The skill a round runs: Claude Code's own code review. */
export const SKILL = 'code-review'

/** The round waiting on its review: what the review is told, and what it hands back. */
export type Pending = {
  plan: Plan
  /** The files the branch changes, which a finding's path is read against. */
  changed: ReadonlySet<string>
  /** Whether /code-review's prompt has been given the round's section. */
  isBriefed: boolean
  /**
   * The review's agent, once something proves it: the agent list says this plugin started it, or the
   * Skill tool names it.
   */
  agentId?: string
  /** The review's tool calls so far. */
  calls: number
  /** New agents no plugin named that made calls while the review was unknown: the review, untagged, may be one. */
  untagged: Set<string>
  /**
   * Why the round records nothing because the repository is no longer as it found it, or undefined
   * while it is: HEAD moved, or a file changed. The record call asks before it takes the findings.
   */
  drift: () => Promise<string | undefined>
  /** What the record call's drift said, so the round records nothing. */
  drifted?: string
  /** Set when a record call came from an untagged agent the gate could not place as the review. */
  isUnplaced?: boolean
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
}

/** What a round needs besides the repository: the caller's wishes and the session's plumbing. */
export type RoundAsk = {
  place: Place
  ledger: Ledger
  intent: string
  /** The call's or the person's level; left out, the option's, else the one the risk calls for. */
  level?: Level
  levelOption: 'auto' | Level
  /** The person's `--max-findings`, handed to /code-review as given. */
  maxFindings?: string
  /** The risk classifier's model; left out, the session's. */
  riskModel?: string
  /** The person's own run: past the round cap, and again over a commit already reviewed. */
  force: boolean
  signal: AbortSignal
  /** Names the round, so a record call can be matched to it. */
  token: string
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
async function judge($: EngineInterface, ask: RoundAsk, context: Context, diff: string): Promise<Risk> {
  const model = ask.riskModel ?? (await $.session.model())
  // The prompt is marked for the cache, so a second try, or a run again within five minutes, reads it there.
  const prompt = [{ text: riskPrompt(context, diff), cache: true as const }]
  for (let tries = 0; tries < 2 && !ask.signal.aborted; tries++) {
    const reply = await $.model.complete({ model, system: RISK, prompt, maxTokens: 1_024 }, { signal: ask.signal }).catch(() => undefined)
    const risk = reply?.isAnswered === true ? readRisk(reply.text) : undefined
    if (risk !== undefined) return risk
  }
  return UNJUDGED
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
export type Bell = { ring: () => void; next: () => Wake }

/** Something a wait may be woken by: a promise that settles then, and whether it has come already. */
export type Wake = { promise: Promise<unknown>; isReady: () => boolean }

export function bell(): Bell {
  let current = fresh()
  function fresh() {
    let isRung = false
    let resolve = () => undefined as void
    const promise = new Promise<void>(done => (resolve = done))
    return { promise, isReady: () => isRung, ring: () => ((isRung = true), resolve()) }
  }
  return {
    ring() {
      const rung = current
      current = fresh()
      rung.ring()
    },
    next: () => ({ promise: current.promise, isReady: current.isReady }),
  }
}

/**
 * Waits until `wake` comes, the round is stopped, or `seconds` pass, with one `sleep` in flight
 * all the while: a hook's own clock runs while no call of its is in flight, and what it waits for
 * comes through other hooks' events. The sleep is ended as soon as the wait is woken, so the wait
 * costs one child however long it lasts. False when `sleep` cannot run; the hook's own sleep would
 * spend its clock, so the caller stops waiting rather than spin or time out.
 */
async function pause($: EngineInterface, wake: Wake, signal: AbortSignal, seconds: number) {
  // A round already stopped, or a wait already woken, has nothing to wait for.
  if (signal.aborted || wake.isReady()) return true
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
    const ended = await Promise.race([slept, wake.promise.then(() => 'woken' as const), stopped])
    if (ended !== 'woken') return ended || signal.aborted
    await child.return({ code: null, signal: null }).catch(() => undefined)
    return true
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

const STUCK = 'review-gate could not wait for the review, since the `sleep` program could not run here, so it stopped the review.'

const UNLISTED = 'review-gate could not read the agent list to see whether the review had ended, so it stopped the review.'

/**
 * Why the round records nothing, as the person reads it, or undefined while the repository is as the
 * round found it: HEAD where it was, and no file changed. The tree was clean when the round began, so
 * a changed file is one the review may have read: changed by the person, by another agent, or by the
 * review against its instructions.
 */
async function driftOf(git: Place['git'], place: Place) {
  const now = await headNow(git)
  if (now.head !== place.head || now.branch !== place.branch) {
    const where = now.branch === '' ? `a detached HEAD at ${short(now.head)}` : `${now.branch} at ${short(now.head)}`
    return `HEAD moved while the round ran: it began on ${place.branch} at ${short(place.head)}, and HEAD is now ${where}. Nothing was recorded. Put HEAD where you want the review to read, then review again.`
  }
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
 * Waits on a review the Skill tool started in the background until it has handed back its findings
 * through the record tool, which rings the round's bell, as long as that takes: a pause
 * between its turns, such as while agents of its own work, is no end. The agent list is read only to
 * see a review that ends without handing it all back: one the list shows ended, or idle with nothing
 * of its own at work for QUIET_MS, since until then it may only be waiting on a background agent's or
 * shell's notice. Gives how it ended, as the list says, and whether the wait could not go on: where
 * `sleep` cannot run, or the agent list cannot be read.
 */
async function untilDone($: EngineInterface, ask: RoundAsk, agentId: string): Promise<{ stuck?: string; status?: string }> {
  let quietSince: number | undefined
  for (let misses = 0; !ask.signal.aborted && ask.desk.pending?.record === undefined && !cannotRecord(ask); ) {
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

/** How long a review that has not recorded must stay idle before it has ended. */
const QUIET_MS = 5 * 60_000

// Whether the review can no longer record: its record was refused because the repository changed, or
// because the agent list did not name review-gate as its starter. Waiting on it has no point.
function cannotRecord(ask: RoundAsk) {
  const pending = ask.desk.pending
  return pending?.drifted !== undefined || pending?.isUnplaced === true
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
 * How the review ended. One that ran in the foreground has ended by the time the Skill tool answers;
 * one the Skill tool started in the background is waited for until it has recorded, then stopped with
 * its agents: the round has what it needs, and a review left running could change files no round records.
 */
async function endOf($: EngineInterface, ask: RoundAsk, run: Forked): Promise<{ stuck?: string; status?: string }> {
  if (run.background !== true) return {}
  const ended = await untilDone($, ask, run.agentId)
  // A stopped round stops the review itself, once.
  if (!ask.signal.aborted) await stop($, ask, run.agentId)
  return ended
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
  // A commit is read again only when the person asks.
  if (!ask.force && last !== undefined && ledger.reviewed === place.head) {
    return { ok: true, ledger, round: last.n, text: `${summary(ledger, last.n)}\n\nThis commit was reviewed already; nothing was run again.` }
  }
  if (!ask.force && streak(ledger) >= ROUND_CAP && open.length > 0) return refuse(stepBack(ledger))

  const startedAt = await $.clock.now()
  const n = (last?.n ?? 0) + 1
  // The count the band shows for this round is the one the cap left when it started.
  const left = capLeft(ledger)
  await ask.progress(() => ({ round: n, phase: 'judging', startedAt, ...(left === undefined ? {} : { left }) }))
  const files = await changedFiles(git, place.base, place.head)
  const guides = (await guideFiles(git, place.base, files)).map(file => parseGuide(file.path, file.text))
  const skip = guides.flatMap(guide => guide.skip)
  const skipped = skip.map(globTest)
  const kept = (list: readonly string[]) => list.filter(file => !skipped.some(test => test(file)))

  // After the first round, a round reads only the commits since the last one, as long as they build
  // on it; a rebase or an amend sends it back over the whole branch.
  const reviewed = ledger.reviewed
  const isDelta = reviewed !== undefined && reviewed !== place.head && last !== undefined && (await isAncestor(git, reviewed, place.head))
  const from = isDelta && reviewed !== undefined ? reviewed : place.base
  const span = isDelta ? await changedFiles(git, from, place.head) : files
  const roundFiles = kept(span)

  // The change's risk picks the round's level, unless the call or the options name one. A commit
  // judged before keeps its verdict, and a round over new commits alone runs at most at high. Only
  // the classifier reads the branch's whole diff, so it is read only when the classifier runs.
  let judged = ledger.riskFor?.sha === place.head ? ledger.riskFor.risk : undefined
  let isUnjudged = false
  if (judged === undefined) {
    const [whole, commits] = await Promise.all([diffOf(git, place.base, place.head), commitLog(git, place.base, place.head)])
    const context: Context = { branch: place.branch, head: place.head, intent: ask.intent, commits, stat: whole.stat, guides }
    judged = await judge($, ask, context, whole.body)
    isUnjudged = judged === UNJUDGED
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
    intent: ask.intent,
    guides,
    skip,
    earlier: ledger.findings,
  }
  let record: NonNullable<Pending['record']> = { raised: 0, rechecked: [], added: [], repeats: 0, nitsLeft: 0, skippedOut: 0 }
  let calls: number | undefined
  // Why the round could not wait for the review to end, when it could not.
  let stuck: string | undefined
  // Why the review did not succeed, in its words or a stand-in.
  let failed: string | undefined
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
      untagged: new Set(),
      drift: () => driftOf(git, place),
    }
    ask.desk.pending = pending
    await ask.progress(run => (run === null ? run : { ...run, phase: 'reviewing', level }))
    const args = [level, `${from}..${place.head}`, ...(ask.maxFindings === undefined ? [] : ['--max-findings', ask.maxFindings])]
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
        const got = await endOf($, ask, run)
        stuck = got.stuck
        failed = endedBadly(got.status) ?? failed
      }
      calls = pending.calls
    }
    if (ask.signal.aborted) return halt()
    // A round's findings are about the commit it began at. When HEAD moved, or a file changed, the
    // round cannot say what the review read, and records nothing.
    const drifted = pending.drifted ?? (await driftOf(git, place))
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
  }

  const added = record.added
  const fixedIds = record.rechecked.filter(one => one.fixed).map(one => one.id)
  const at = await $.clock.now()
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
      raised: record.raised,
      kept: added.length,
      ...(record.nitsLeft > 0 ? { nitsLeft: record.nitsLeft } : {}),
      ...(record.skippedOut > 0 ? { skippedOut: record.skippedOut } : {}),
      fixed: closing.length,
      open: findings.filter(finding => finding.status === 'open').length,
      at,
      durationMs: at - startedAt,
      ...(calls === undefined ? {} : { calls }),
      ...(isReviewed ? {} : span.length === 0 ? { unchanged: true } : { skipped: true }),
    }
    // A classifier with no verdict is asked again next time.
    return {
      ...current,
      rounds: [...current.rounds, round],
      findings,
      reviewed: place.head,
      ...(isUnjudged ? {} : { riskFor: { sha: place.head, risk: judged } }),
    }
  })
  if (typeof saved === 'string') return refuse(saved)
  const notes: string[] = []
  if (stuck !== undefined) notes.push(`${stuck} It had recorded its findings before that.`)
  if (failed !== undefined) notes.push(`The review recorded its findings, then failed: ${failed}`)
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
  if (open.length > 0)
    lines.push(
      `${open.length} finding${open.length === 1 ? '' : 's'} open. Answer each one: fix it and commit, then review again (the next round checks the fix); or dismiss it with the reason it can stay.`,
      ...open.map(findingText),
    )
  const closed = ledger.findings.filter(finding => finding.closedRound === n)
  if (closed.length > 0) lines.push(`Found fixed this round: ${closed.map(finding => `${finding.id} (${finding.title})`).join('; ')}.`)
  const nits = round.nitsLeft ?? 0
  const skippedOut = round.skippedOut ?? 0
  const again = round.raised - round.kept - nits - skippedOut
  if (again > 0)
    lines.push(`${again} finding${again === 1 ? '' : 's'} the review reported ${again === 1 ? 'was' : 'were'} on the record already, so ${again === 1 ? 'it was' : 'they were'} not raised again.`)
  if (nits > 0) lines.push(`${nits} more nit${nits === 1 ? ' was' : 's were'} left out: a branch raises at most ${NIT_CAP}.`)
  if (skippedOut > 0) lines.push(`${skippedOut} finding${skippedOut === 1 ? ' was' : 's were'} in files REVIEW.md skips, so ${skippedOut === 1 ? 'it was' : 'they were'} left out.`)
  if (open.length === 0) lines.push(nothingOpen(ledger, round.head))
  if (round.skipped === true) lines.push(`Every file the round covers is on a REVIEW.md Skip list, so no review ran.`)
  if (round.unchanged === true) lines.push('The commits the round covers change no file, so no review ran.')
  const cost = spent(round)
  const calls = round.calls === undefined ? '' : `, and the review made ${round.calls} tool call${round.calls === 1 ? '' : 's'}`
  if (cost !== '') lines.push(`The round took ${cost}${calls}.`)
  const left = capLeft(ledger) ?? 0
  if (left > 0)
    lines.push(`${leftText(left)}: after ${ROUND_CAP} rounds in a row end with findings open, no further round runs until the user allows more.`)
  if (open.length > 0 && streak(ledger) >= ROUND_CAP) lines.push(stepBack(ledger))
  return lines.join('\n\n')
}
