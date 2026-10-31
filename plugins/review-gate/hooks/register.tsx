import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput } from 'claude-code'
import type { Ledger, Level } from '../types'
import { branches, locate, short } from './git'
import type { Place } from './git'
import { opensOrMerges } from './guard'
import { LEVELS, NIT_CAP, ROUND_CAP, emptyLedger, nothingOpen, openFindings, recordKey, recordPrefix, sortOut, standing, toLedger, whereOf } from './ledger'
import { RECORD, readRecord, reviewSection } from './prompts'
import { SKILL, bell, isLevel, runRound, summary } from './review'
import type { Pending, RoundAsk } from './review'
import { band, card } from './views'

const PLUGIN = 'review-gate'
const REVIEW = 'mcp__review-gate__review'
const DISMISS = 'mcp__review-gate__dismiss'
const PULL_REQUEST = 'mcp__review-gate__pull_request'
const COMMAND = 'review-gate'

const repo = atom({ plugin: 'review-gate', key: 'repo' } as const, null, { shape: 'repo-1' })
const ledgerState = atom({ plugin: 'review-gate', key: 'ledger' } as const, null, { shape: 'ledger-2' })
const run = atom({ plugin: 'review-gate', key: 'run' } as const, null, { shape: 'run-3' })
const activity = atom({ plugin: 'review-gate', key: 'activity' } as const, null)

const METHODS = ['merge', 'squash', 'rebase'] as const

const PATH = {
  type: 'string',
  description: "A folder in the repository, when the session's working directory is not in it.",
}

const REVIEW_TOOL = {
  name: 'review',
  description:
    "Review the current branch's commits, as its pull request would show them, before you open the pull request. It runs Claude Code's /code-review over the branch, at a level the change's risk picks, and keeps every finding in the branch's review record. Call it once the change is committed and its checks pass: the pull_request tool opens and merges pull requests only for a commit that was reviewed with every finding answered. Answer each finding: fix it and commit, then review again (later rounds read only the new commits and confirm each fix); or dismiss it with the reason it can stay. After three rounds in a row end with findings open, it stops and asks you to step back with the user. A round takes minutes.",
  isDeferred: false,
  inputSchema: {
    type: 'object',
    properties: {
      intent: {
        type: 'string',
        description: 'What the change is for, in a sentence or two: the problem it solves and how. The review checks the change against it.',
      },
      level: {
        type: 'string',
        enum: LEVELS.filter(level => level !== 'max'),
        description: "The /code-review level. Leave it out and the change's risk picks: medium for low risk, high for medium, xhigh for high.",
      },
      path: PATH,
    },
  },
}

const RECORD_TOOL = {
  name: 'record',
  description:
    "For review-gate's own /code-review round only: hands the review's findings to the branch's review record. Call it only when a review-gate section of your instructions tells you to, with the round it names.",
  isDeferred: false,
  inputSchema: {
    type: 'object',
    properties: {
      round: { type: 'string', description: 'The round, as the instructions name it.' },
      findings: {
        type: 'array',
        description: 'Every finding of the final list, empty when there are none.',
        items: {
          type: 'object',
          properties: {
            file: { type: 'string', description: "Its path from the repository's root." },
            line: { type: 'number', description: 'The line it anchors to, counted from 1.' },
            summary: { type: 'string', description: 'The defect in one sentence.' },
            short_summary: { type: 'string', description: 'The claim alone, in at most 60 characters.' },
            failure_scenario: { type: 'string', description: 'The input or state that sets it off, and what goes wrong.' },
            category: { type: 'string', description: 'A kebab-case word for its kind, such as correctness, security or efficiency.' },
            verdict: { type: 'string', enum: ['CONFIRMED', 'PLAUSIBLE'], description: 'Set when a verify pass ran.' },
            security: {
              type: 'boolean',
              description: 'True when it lets someone do what they should not: read or change data that is not theirs, get past a check, run code, or learn a secret.',
            },
            introduced: { type: 'boolean', description: 'False when the defect was there before this branch.' },
          },
          required: ['file', 'summary', 'failure_scenario'],
        },
      },
      rechecked: {
        type: 'array',
        description: 'One entry for each open finding the instructions list.',
        items: {
          type: 'object',
          properties: { id: { type: 'string' }, fixed: { type: 'boolean' }, why: { type: 'string' } },
          required: ['id', 'fixed'],
        },
      },
    },
    required: ['round'],
  },
}

const DISMISS_TOOL = {
  name: 'dismiss',
  description:
    "Answer review findings you will not fix, with the reason: the finding is wrong, or the code is fine as it is. A finding you fix is closed by the next review round, not by this. The user sees each reason in the review's card, and a dismissed security finding makes the pull request wait for the user's approval.",
  isDeferred: false,
  inputSchema: {
    type: 'object',
    properties: {
      ids: { type: 'array', items: { type: 'string' }, description: 'The findings to dismiss, such as ["R2-1"].' },
      reason: { type: 'string', description: 'Why each can stay, in a sentence or more.' },
      path: PATH,
    },
    required: ['ids', 'reason'],
  },
}

const PULL_REQUEST_TOOL = {
  name: 'pull_request',
  description:
    "Open or merge a pull request: the only way to, as gh pr create, gh pr merge and gh api calls that do either are refused in Bash. open pushes the current branch to origin and opens its pull request, or brings the branch's open pull request up to the reviewed commit. merge merges a pull request, and only while its head is still the commit that was reviewed. Both are refused until that commit has been reviewed and every finding answered; a high-risk change also waits for the user's approval in a dialog. Ask the user before you open or merge one.",
  isDeferred: false,
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['open', 'merge'] },
      title: { type: 'string', description: "open: the pull request's title." },
      body: { type: 'string', description: 'open: its description, in Markdown.' },
      base: { type: 'string', description: 'open: the branch it merges into; left out, the default branch.' },
      draft: { type: 'boolean', description: 'open: open it as a draft.' },
      number: { type: 'number', description: "merge: the pull request's number; left out, the current branch's." },
      method: { type: 'string', enum: [...METHODS], description: 'merge: how it merges; left out, with a merge commit.' },
      deleteBranch: { type: 'boolean', description: 'merge: delete the branch once it is merged.' },
      path: PATH,
    },
    required: ['action'],
  },
}

const USAGE = `/review-gate runs a review round on this branch now, at the level the change's risk picks; /review-gate low, medium, high, xhigh or max picks the level. Add --max-findings <n|all|default> to pass /code-review its limit. /review-gate status shows where the review stands, /review-gate more allows ${ROUND_CAP} more rounds after the cap, and /review-gate reset forgets this branch's review record.`

const RAW_PR_REFUSAL = `review-gate: open and merge pull requests with ${PULL_REQUEST}, which checks the branch's review, then pushes and runs gh. If the command only mentions this in text, such as a commit message, put that text in a file and pass the file (git commit -F FILE).`

const asText = (value: unknown) => (typeof value === 'string' ? value : '')

const why = (error: unknown) => (error instanceof Error ? error.message : String(error))

type Ran = { exitCode: number; stdout: string; stderr: string }

// A program that cannot start answers as one that failed, so callers read one shape.
async function runIn($: EngineInterface, argv: readonly string[], cwd: string, timeoutMs: number): Promise<Ran> {
  return $.process.run(argv, { cwd, timeoutMs }).catch(error => ({ exitCode: 1, stdout: '', stderr: why(error) }))
}

async function cwdOf($: EngineInterface, path: unknown) {
  const given = asText(path).trim()
  const cwd = await $.session.cwd()
  if (given === '') return cwd
  return given.startsWith('/') ? given : `${cwd}/${given}`
}

/**
 * A branch's record, from the plugin's own store and nowhere else: a file in the repository is
 * Claude's to write.
 */
async function load($: EngineInterface, place: Place, branch = place.branch) {
  return toLedger(await $.store.get(recordKey(place.store, branch)), branch)
}

async function save($: EngineInterface, place: Place, ledger: Ledger) {
  await $.store.set(recordKey(place.store, ledger.branch), ledger)
  if (ledger.branch === (await read($, repo))?.branch) await update($, ledgerState, () => ledger)
}

// Writes to the records, one at a time.
let writing: Promise<unknown> = Promise.resolve()

function serially<T>(work: () => Promise<T>): Promise<T> {
  const done = writing.then(work)
  writing = done.catch(() => undefined)
  return done
}

/**
 * Changes a branch's record as it stands when written, so a change made since the caller read it,
 * such as a dismissal while a round ran, is kept. `change` gives the new record, or why the record
 * may not change; that reason comes back and nothing is written.
 */
async function edit($: EngineInterface, place: Place, change: (ledger: Ledger) => Ledger | string, branch = place.branch) {
  return serially(async () => {
    const next = change(await load($, place, branch))
    if (typeof next !== 'string') await save($, place, next)
    return next
  })
}

// Records of branches that no longer exist go: a branch made later under the same name starts with none.
async function prune($: EngineInterface, place: Place) {
  const prefix = recordPrefix(place.store)
  const keys = (await $.store.keys()).filter(key => key.startsWith(prefix))
  if (keys.length === 0) return
  const live = await branches(place.git)
  for (const key of keys) if (!live.has(key.slice(prefix.length))) await $.store.delete(key)
}

// Where the session's repository stands, for the band: read after git commands and at each turn's end.
async function refresh($: EngineInterface) {
  await show($, await locate($, await $.session.cwd()))
}

// A repository as the band and the cards draw it: its branch, and that branch's record.
async function show($: EngineInterface, place: Place | string) {
  if (typeof place === 'string' || place.branch === '') {
    await update($, repo, () => null)
    await update($, ledgerState, () => null)
    return
  }
  await prune($, place).catch(() => undefined)
  const isDefault = place.branch === place.main
  await update($, repo, () => ({ branch: place.branch, head: place.head, main: place.main, isDefault, ahead: place.ahead }))
  const record = isDefault ? null : await load($, place)
  await update($, ledgerState, () => record)
}

/**
 * Why a pull request may not be opened or merged for `branch` at `sha`, or undefined when it may, by
 * the rule `standing` gives: a high-risk change's approval is asked for here when it has none.
 */
async function vouch($: EngineInterface, place: Place, branch: string, sha: string, action: 'open' | 'merge'): Promise<string | undefined> {
  const ledger = await load($, place, branch)
  const now = standing(ledger, sha)
  if (now.kind === 'ready') return undefined
  if (now.kind === 'unreviewed')
    return `Review first: ${branch} at ${short(sha)} has not been reviewed${
      ledger.reviewed === undefined ? '' : ` (the last round covered ${short(ledger.reviewed)})`
    }. Call ${REVIEW} with what the change is for, answer each finding, then try again.`
  if (now.kind === 'open')
    return `${branch} has ${now.open.length} open review finding${now.open.length === 1 ? '' : 's'}: ${now.open
      .map(finding => `${finding.id} (${finding.file}:${finding.line} ${finding.title})`)
      .join('; ')}. Fix each and commit, then call ${REVIEW} again; or dismiss it with ${DISMISS} and a reason.`
  const { risk } = now

  // A person's approval: the dialog is theirs to answer, never the model's.
  const dismissed = ledger.findings.filter(finding => finding.status === 'dismissed')
  const doing = action === 'open' ? 'opening its pull request' : 'merging it'
  const question = `The review of ${branch} passed, and it needs your approval: ${risk.why.join('; ')}.${
    dismissed.length === 0 ? '' : ` Dismissed findings: ${dismissed.map(finding => `${finding.id} ${finding.title} (${finding.answer ?? ''})`).join('; ')}.`
  } Do you approve ${doing} at ${short(sha)}?`
  const answer = await $.ui.ask(question, { options: ['Approve', 'Not yet'], header: 'Review' }).catch(() => undefined)
  if (answer !== 'Approve')
    return `The user has not approved ${branch} at ${short(sha)}, which needs a person: ${risk.why.join('; ')}. Ask them what they want changed.`
  const at = await $.clock.now()
  await edit($, place, current => ({ ...current, approved: { sha, at } }), branch)
  return undefined
}

type Input = Record<string, unknown>
type Answer = { result: string } | { deny: string }

// Pushes the current branch and opens its pull request, once its review vouches for it. A branch
// whose pull request is open already has it brought up to the reviewed commit by the push.
async function openPullRequest($: EngineInterface, place: Place, input: Input): Promise<Answer> {
  if (place.branch === '' || place.branch === place.main)
    return { deny: `Check out the branch to open a pull request for: ${place.branch || 'a detached HEAD'} is not one.` }
  const title = asText(input.title).trim()
  if (title === '') return { deny: 'Give the pull request a title.' }
  const refusal = await vouch($, place, place.branch, place.head, 'open')
  if (refusal !== undefined) return { deny: refusal }
  const pushed = await runIn($, ['git', 'push', 'origin', `${place.head}:refs/heads/${place.branch}`], place.root, 120_000)
  if (pushed.exitCode !== 0) return { deny: `git push failed, so no pull request was opened: ${pushed.stderr.trim()}` }
  // A push by commit id sets no upstream, so the branch tracks origin's copy from here, for a plain git push.
  await runIn($, ['git', 'branch', `--set-upstream-to=origin/${place.branch}`, place.branch], place.root, 30_000)
  const existing = await runIn($, ['gh', 'pr', 'view', place.branch, '--json', 'url,state'], place.root, 30_000)
  const found = existing.exitCode === 0 ? (JSON.parse(existing.stdout) as { url?: string; state?: string }) : undefined
  if (found?.state === 'OPEN') return { result: `Pushed ${place.branch} at ${short(place.head)} to its open pull request, ${found.url ?? ''}.` }
  const base = asText(input.base).trim() || place.main
  const made = await runIn(
    $,
    ['gh', 'pr', 'create', '--head', place.branch, '--base', base, '--title', title, '--body', asText(input.body), ...(input.draft === true ? ['--draft'] : [])],
    place.root,
    60_000,
  )
  if (made.exitCode !== 0) return { deny: `The branch was pushed, but gh could not open the pull request: ${made.stderr.trim()}` }
  return { result: `Opened ${made.stdout.trim()} for ${place.branch} at ${short(place.head)}.` }
}

// Merges a pull request whose head its review vouches for; gh refuses if that head moves meanwhile.
async function mergePullRequest($: EngineInterface, place: Place, input: Input): Promise<Answer> {
  const number = typeof input.number === 'number' && Number.isInteger(input.number) && input.number > 0 ? String(input.number) : undefined
  const view = await runIn(
    $,
    ['gh', 'pr', 'view', ...(number === undefined ? [] : [number]), '--json', 'number,headRefName,headRefOid,state'],
    place.root,
    30_000,
  )
  const found = view.exitCode === 0 ? (JSON.parse(view.stdout) as { number?: number; headRefName?: string; headRefOid?: string; state?: string }) : undefined
  if (found?.number === undefined || found.headRefName === undefined || found.headRefOid === undefined)
    return { deny: `gh could not find the pull request: ${view.stderr.trim() || 'it gave no head'}.` }
  if (found.state !== undefined && found.state !== 'OPEN') return { deny: `Pull request #${found.number} is ${found.state.toLowerCase()}, so there is nothing to merge.` }
  const refusal = await vouch($, place, found.headRefName, found.headRefOid, 'merge')
  if (refusal !== undefined) return { deny: refusal }
  const method = METHODS.find(name => name === input.method) ?? 'merge'
  const merged = await runIn(
    $,
    ['gh', 'pr', 'merge', String(found.number), `--${method}`, '--match-head-commit', found.headRefOid, ...(input.deleteBranch === true ? ['--delete-branch'] : [])],
    place.root,
    120_000,
  )
  if (merged.exitCode !== 0) return { deny: `gh could not merge #${found.number}: ${merged.stderr.trim()}` }
  return { result: `Merged #${found.number}: ${found.headRefName} at ${short(found.headRefOid)}.` }
}

// The round waiting on its review, the folder it runs in, and whether one runs: the session's, kept here.
// Rung on each event that may have ended a round's review, so the round looks at once.
const doorbell = bell()
const desk: { pending?: Pending } = {}
// What the round said of each review it ran: in place of the raw report in the review's notice, and
// as the notice's row.
const told = new Map<string, Told>()
// The review agent of the round running now, once known, and when that round ends.
let current: string | undefined
let ended: Promise<void> = Promise.resolve()

/**
 * What a round said of its review. `note` stands in for the raw report in the review's first notice
 * and goes once used; `isQuiet` says it gives the model nothing to do; `label` draws the notice's row.
 */
type Told = { note?: string; isQuiet: boolean; label: string }

const CLOSE = '</task-notification>'

// Text put inside a notice's result, so a finding that quotes the notice's own tags cannot end it.
const escaped = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * A delivery with the raw report of each review's notice replaced by `word`. A notice's result comes
 * last, and a report may quote `</result>` or the notice's own closing tag, so a review's notice
 * runs from its `<result>` to the last `</result></task-notification>` before the next notice opens
 * with its task id, or before the delivery ends. Gives the text outside every notice, which may name a review too, and how
 * many notices are other tasks'.
 */
export function rewriteNotices(text: string, ids: readonly string[], word: (id: string) => string) {
  let out = ''
  let outside = ''
  let others = 0
  let at = 0
  for (;;) {
    const start = text.indexOf('<task-notification', at)
    const close = start < 0 ? -1 : text.indexOf(CLOSE, start)
    if (start < 0 || close < 0) {
      out += text.slice(at)
      outside += text.slice(at)
      return { text: out, outside, others }
    }
    out += text.slice(at, start)
    outside += text.slice(at, start)
    const result = text.indexOf('<result>', start)
    const head = text.slice(start, result >= 0 && result < close ? result : close)
    const id = ids.find(one => head.includes(`<task-id>${one}</task-id>`))
    if (id === undefined) {
      others += 1
      out += text.slice(start, close + CLOSE.length)
      at = close + CLOSE.length
      continue
    }
    if (result < 0 || result > close) {
      out += `${head}<result>${word(id)}</result>${CLOSE}`
      at = close + CLOSE.length
      continue
    }
    const after = text.slice(result).search(/<task-notification\b[^>]*>\s*<task-id>/)
    const limit = after < 0 ? text.length : result + after
    const ends = [...text.slice(result, limit).matchAll(/<\/result>\s*<\/task-notification>/g)].map(match => result + (match.index ?? 0) + match[0].length)
    const end = ends[ends.length - 1] ?? close + CLOSE.length
    out += `${head}<result>${word(id)}</result>${CLOSE}`
    at = end
  }
}

// The review agents rounds have run, and the agents of theirs a round stopped: their task
// notifications repeat what the round reported, and none of them is a later round's review.
const reviews = new Set<string>()
// Agents the round has found are not its review, so it does not ask about them again.
const others = new Set<string>()
// The agents the session had when the round began, none of which is its review.
let before = new Set<string>()
let activeRoot: string | undefined
let busy = false

type Settings = { levelOption: 'auto' | Level; riskModel?: string }

type Wishes = Pick<RoundAsk, 'intent' | 'level' | 'maxFindings' | 'force' | 'signal'>

// One round, for the tool and the command alike; a second is refused while one runs.
async function round($: EngineInterface, place: Place, settings: Settings, wishes: Wishes) {
  if (busy) return { ok: false as const, text: 'A review round is running already: wait for it to finish.' }
  busy = true
  current = undefined
  let settle = () => undefined as void
  ended = new Promise<void>(resolve => (settle = resolve))
  activeRoot = place.root
  others.clear()
  before = new Set((await $.agent.list().catch(() => [])).map(agent => agent.id))
  let isSaved = false
  try {
    const now = await $.clock.now()
    const outcome = await runRound($, {
      ...wishes,
      ...settings,
      place,
      ledger: await load($, place),
      token: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      desk,
      bell: doorbell,
      progress: async change => {
        await update($, run, change)
      },
      bind: agentId => bind($, agentId),
      quiet: agentIds => {
        for (const id of agentIds) reviews.add(id)
      },
      edit: change => edit($, place, change),
    })
    isSaved = outcome.ok
    if (current !== undefined) told.set(current, tell(outcome, wishes.force))
    return outcome
  } finally {
    settle()
    busy = false
    activeRoot = undefined
    // The band's activity for the round's review goes with the round.
    const shown = (await read($, run).catch(() => null))?.agentId
    if (shown !== undefined) await update($, memberOf(activity, { requestId: shown }), () => null).catch(() => undefined)
    await update($, run, () => null).catch(() => undefined)
    // A round stopped before it saved changed no record, and right after Esc git cannot run, so the
    // band would read as no repository at all: it keeps what it showed. One that saved is shown.
    if (isSaved || !wishes.signal.aborted) await refresh($).catch(() => undefined)
  }
}

/**
 * What a review's notice says once its round is over. The model that called the review tool has the
 * round's result already; after the person's /review-gate, the notice starts a turn of its own and
 * carries the result, so the model follows up with its suggestions.
 */
function tell(outcome: Awaited<ReturnType<typeof runRound>>, isPerson: boolean): Told {
  // The round's output has said why it recorded nothing, Esc included, so its notice starts no turn.
  if (!outcome.ok) return { note: `review-gate recorded nothing from this review: ${outcome.text}`, isQuiet: true, label: 'the round recorded nothing' }
  const label = `round ${outcome.round} recorded`
  if (!isPerson)
    return { note: `review-gate recorded this review as round ${outcome.round}, and the review tool's result holds its findings: nothing more to do for this notice.`, isQuiet: true, label }
  return { note: `The user ran /review-gate, and review-gate recorded this review as round ${outcome.round}:\n\n${outcome.text}\n\n${followUp(outcome.ledger)}`, isQuiet: false, label }
}

/**
 * Takes an agent as the round's review, on proof: the agent list says this plugin started it, or the
 * Skill tool names it. The first proof wins. Every agent proved
 * a review is remembered, so its task notices are the round's, no later round takes it for its own,
 * and it never answers at the gate.
 */
async function bind($: EngineInterface, agentId: string) {
  reviews.add(agentId)
  const pending = desk.pending
  if (pending === undefined || pending.agentId !== undefined) return
  pending.agentId = agentId
  current = agentId
  await update($, run, current => (current === null ? current : { ...current, agentId }))
}

/**
 * What an agent is to the gate: the round's review; a review of an earlier round, which a notice or a
 * message can wake once its round is over; or neither. Agents the review starts, as /code-review max
 * does, are neither: they neither record nor answer at the gate, since the review is known by then.
 */
type Scope = 'review' | 'past' | 'other'

async function scopeOf($: EngineInterface, agentId: string): Promise<Scope> {
  const pending = desk.pending
  if (pending?.agentId === agentId) return 'review'
  if (reviews.has(agentId)) return 'past'
  // Only a round that has yet to learn its review's agent has anyone left to place.
  if (pending === undefined || pending.agentId !== undefined || others.has(agentId)) return 'other'
  // The review is listed with this plugin's name from its first call, as a live session shows, so
  // that call names it. An agent the list does not show is asked about again at its next call.
  const agent = (await $.agent.list()).find(one => one.id === agentId)
  if (agent === undefined) return 'other'
  if (!before.has(agentId) && agent.spawnedBy === PLUGIN) {
    await bind($, agentId)
    return 'review'
  }
  if (!before.has(agentId) && agent.spawnedBy === undefined && agent.parentId === undefined) pending.untagged.add(agentId)
  others.add(agentId)
  return 'other'
}

// No agent answers at the gate: a finding's answer and a pull request are the session's main
// conversation's to give, so no subagent can, a review or an agent it started included.
const isSubagent = (agentId: string | undefined) => agentId !== undefined

// The review's tool call as a few words for the band.
function describeCall(e: { tool: string } & Record<string, unknown>) {
  const root = activeRoot === undefined ? '' : `${activeRoot}/`
  const path = (value: unknown) => asText(value).replace(root, '')
  const tool = String(e.tool)
  if (tool === 'Read') return `reading ${path(e.file_path)}`
  if (tool === 'Bash') return `$ ${asText(e.command).split('\n')[0] ?? ''}`.slice(0, 80)
  if (tool === 'Grep' || tool === 'Glob') return `searching "${asText(e.pattern).slice(0, 40)}"`
  if (tool === RECORD) return 'recording its findings'
  return tool
}

// A plugin tool's result as its row holds it: the text, or text blocks.
function textOf(output: unknown): string {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) return output.map(textOf).join('\n')
  if (typeof output === 'object' && output !== null && 'text' in output && typeof output.text === 'string') return output.text
  return ''
}

// A round's text opens with its number, branch and commit (a command's row puts the plugin's name
// first); its card draws from the branch's record.
async function roundCard($: EngineInterface, e: RenderInput, text: string) {
  const named = /(?:^|: )Review round (\d+) of (\S+) at /.exec(text)
  const record = await read($, ledgerState)
  if (named === null || record === null || record.branch !== named[2]) return undefined
  return card($, e, record, Number(named[1]), await read($, repo))
}

/**
 * What the person asked of a round they started: a level, and --max-findings with its value. A pull
 * request's number, --fix and --comment are refused with the reason, as is anything else.
 */
export function parseRun(args: string): Pick<Wishes, 'level' | 'maxFindings'> | string {
  const words = args.trim().split(/\s+/).filter(word => word !== '')
  let level: Level | undefined
  let maxFindings: string | undefined
  for (let at = 0; at < words.length; at++) {
    const word = words[at] ?? ''
    const lower = word.toLowerCase()
    if (level === undefined && isLevel(lower)) level = lower
    else if (lower === '--fix')
      return 'review-gate does not pass --fix: Claude fixes the findings and commits, and the next round confirms each fix. Run /code-review --fix yourself for that.'
    else if (lower === '--max-findings') {
      const value = (words[at + 1] ?? '').toLowerCase()
      if (!/^(\d+|all|default)$/.test(value)) return `--max-findings takes a number, all or default${value === '' ? '' : `, not ${words[at + 1]}`}. ${USAGE}`
      maxFindings = value
      at += 1
    } else if (/^#?\d+$/.test(word))
      return `review-gate reviews the branch checked out, so ${word} is not a target: check out the pull request's branch (gh pr checkout ${word.replace('#', '')}) and run /review-gate there.`
    else if (lower === '--comment')
      return 'review-gate does not pass --comment: its review runs before the pull request is opened. Run /code-review --comment on the pull request for that.'
    else return `${word} is not something /review-gate takes. ${USAGE}`
  }
  return { ...(level === undefined ? {} : { level }), ...(maxFindings === undefined ? {} : { maxFindings }) }
}

/**
 * What the model says to the person once a round is back: a suggestion for each open finding, or the
 * next step when none is open. The card shows the findings, so the model adds its judgment, not a list.
 */
export function followUp(ledger: Ledger) {
  const open = openFindings(ledger)
  if (open.length === 0) return 'Tell the user the review passed, and suggest the next step, such as opening the pull request.'
  return `Tell the user what you suggest for ${open.length === 1 ? 'the open finding' : `each of the ${open.length} open findings`}, a line each by its id: fix it, and how, or dismiss it, and why. The user sees the findings in the review's card, so do not repeat them.`
}

const choice = (value: unknown) => (typeof value === 'string' && value !== '' && value !== 'inherit' ? value : undefined)

export const register: Register = (on, options) => {
  const riskModel = choice(options.riskModel)
  const settings: Settings = {
    levelOption: LEVELS.find(name => name === options.level) ?? 'auto',
    ...(riskModel === undefined ? {} : { riskModel }),
  }

  on('session.start', async ($, e, next) => {
    for (const tool of [REVIEW_TOOL, RECORD_TOOL, DISMISS_TOOL, PULL_REQUEST_TOOL]) await $.tool.register(tool)
    await $.command.register({
      name: COMMAND,
      description: 'Review this branch now with /code-review, or see where its review stands',
      argumentHint: '[low | medium | high | xhigh | max] [--max-findings <n|all>] | status | more | reset',
    })
    // A round a reload cut short left its progress behind.
    await update($, run, () => null)
    await refresh($).catch(() => undefined)
    return next(e)
  })

  // The engine sends a notice when a review run in the background ends, and its result is
  // /code-review's raw report, findings the round left out included. The round has reported the
  // review already, so the notice carries the round's word in its place. A notice delivered into the
  // turn that called the review tool tells the model only that; one that starts a turn of its own,
  // after the person's /review-gate, carries the round's result and asks for suggestions. A drop
  // would put a warning row on the person's screen instead.
  on('prompt.submit', async (_, e, next) => {
    if (e.origin.kind !== 'task-notification') return next(e)
    const ids = [...reviews, desk.pending?.agentId].filter((one): one is string => one !== undefined && e.text.includes(`<task-id>${one}</task-id>`))
    if (ids.length === 0) return next(e)
    doorbell.ring()
    // The notice of the round running now can come while it still checks and saves what the review found.
    if (busy && current !== undefined && ids.includes(current)) await ended
    let isQuiet = true
    const used: string[] = []
    const rewritten = rewriteNotices(e.text, ids, id => {
      const said = told.get(id)
      if (said?.note !== undefined) used.push(id)
      isQuiet &&= said?.note === undefined || said.isQuiet
      return escaped(said?.note ?? 'review-gate handled this review already: nothing to do.')
    })
    // A review's id outside any notice the hook can read may carry its raw report, so the delivery goes.
    if (ids.some(id => rewritten.outside.includes(id))) return { drop: 'review-gate: a review report it could not read was kept out' }
    // A notice that would start a turn of its own with nothing to do is dropped: its row is the lesser cost.
    if (e.turnId === undefined && isQuiet && rewritten.others === 0) return { drop: 'review-gate: the round reported this review already' }
    // A note is used up once a delivery carries it; a later notice of the same review says only that.
    for (const id of used) {
      const said = told.get(id)
      if (said !== undefined) told.set(id, { isQuiet: said.isQuiet, label: said.label })
    }
    return next({ ...e, text: rewritten.text })
  }).catch((_, e, next) => next(e))

  // A review's notice row is one dim line: the round's card above already shows what it found.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const id = e.props.task?.id
    if (e.props.isExpanded || id === undefined || !reviews.has(id)) return next(e)
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>  review-gate · {told.get(id)?.label ?? '/code-review ended'}</Text>
  })

  // A subagent's turn's end may be the review's; the main thread's end is a moment to look at git again.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) doorbell.ring()
    else await refresh($).catch(() => undefined)
    return next(e)
  })

  // The round's review is /code-review with a section of the round's added: its scope, what the
  // branch has had, the findings to look at again, and how to hand back what it found.
  on('skill.prompt', { skill: SKILL }, async (_, e, next) => {
    const computed = await next(e)
    const pending = desk.pending
    if (pending === undefined || pending.isBriefed) return computed
    pending.isBriefed = true
    // Only Claude Code's own /code-review is the gate's review: another skill of its name, such as one
    // the branch adds, is told to stop, and the round refuses it.
    if (e.source !== 'built-in') {
      pending.shadowed = e.pluginName === undefined ? `its ${e.source} skills` : `the ${e.pluginName} plugin`
      return { text: `review-gate will not run this skill as its review. Do nothing, and answer only: "Not run: this is not Claude Code's own ${SKILL}."` }
    }
    return { text: `${computed.text}\n\n${reviewSection(pending.plan)}` }
  })

  // A pull request is opened and merged by the gate's own tool: a shell command that does either is
  // refused, by a match on its text.
  on('tool.call', { tool: 'Bash' }, (_, e, next) => (opensOrMerges(e.command) ? { deny: RAW_PR_REFUSAL } : next(e))).catch((_, e, next) =>
    next.called ? next(e) : { deny: RAW_PR_REFUSAL },
  )

  // What the review's agent is doing, for the band: its calls so far, and its latest. Its first call
  // names it, so the count is whole. The round keeps its own count: the band's activity is display
  // state, which the engine keeps for drawn rows.
  on('tool.call', async ($, e, next) => {
    const pending = desk.pending
    if (e.agentId !== undefined && pending !== undefined && (await scopeOf($, e.agentId)) === 'review') {
      pending.calls += 1
      const doing = describeCall(e)
      await update($, memberOf(activity, { requestId: e.agentId }), last => ({ calls: (last?.calls ?? 0) + 1, doing }))
    }
    return next(e)
  }).catch((_, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined && /\b(git|gh)\b/.test(e.command)) await refresh($)
    return ran
  }).catch((_, e, next) => next(e))

  // The review hands back its findings here: only the round's own review, naming the round, once.
  // Another agent that has the round's name, such as one the review started, or another /code-review
  // briefed by mistake, records nothing. The agent list names the review at its first call; a review
  // it does not name cannot record, and is told why.
  on('tool.call', { tool: RECORD }, async ($, e) => {
    const pending = desk.pending
    const refusal = "record takes the findings of review-gate's own review round, from its review, with the round its instructions name."
    if (pending === undefined || e.agentId === undefined || asText(e.round).trim() !== pending.plan.token) return { deny: refusal }
    const scope = await scopeOf($, e.agentId)
    if (scope !== 'review' && pending.untagged.has(e.agentId)) {
      pending.isUnplaced = true
      doorbell.ring()
    }
    if (scope !== 'review')
      return {
        deny:
          pending.untagged.has(e.agentId)
            ? `${refusal} The agent list does not name review-gate as this agent's starter, so the gate cannot tell it is the round's review. Say so in your answer.`
            : refusal,
      }
    // The findings are about the commit the round began at: when the repository changed before they
    // are recorded, the round cannot say what the review read, and records nothing.
    if (pending.record === undefined) {
      const drifted = await pending.drift()
      if (drifted !== undefined) {
        pending.drifted = drifted
        doorbell.ring()
        return { deny: 'The repository changed while you read it, so this round records nothing. Finish without recording.' }
      }
    }
    if (pending.record !== undefined) return { deny: `Round ${pending.plan.n}'s findings are recorded already: finish as your instructions say.` }
    const read = readRecord(e, pending.changed, pending.plan.root)
    if (typeof read === 'string') return { deny: read }
    // A finding in a file REVIEW.md skips is left out, as the repository asked.
    const kept = read.findings.filter(finding => !pending.isSkipped(finding.file))
    // The ids the review is told here are the ones the round saves.
    const { added, repeats, nitsLeft } = sortOut(kept, pending.plan.n, pending.plan.earlier)
    const skippedOut = read.findings.length - kept.length
    const record = { raised: read.findings.length, rechecked: read.rechecked, added, repeats, nitsLeft, skippedOut }
    pending.record = record
    doorbell.ring()
    const left = [
      repeats > 0 ? `${repeats} the branch has had before` : '',
      nitsLeft > 0 ? `${nitsLeft} nit${nitsLeft === 1 ? '' : 's'} past the ${NIT_CAP} a branch raises` : '',
      skippedOut > 0 ? `${skippedOut} in files REVIEW.md skips` : '',
    ].filter(part => part !== '')
    return {
      result: `Recorded round ${pending.plan.n}: ${
        added.length === 0 ? 'no new findings' : added.map(finding => `${finding.id} ${whereOf(finding)} ${finding.title}`).join('; ')
      }.${left.length > 0 ? ` Left out: ${left.join(', ')}.` : ''} Finish as your instructions say.`,
    }
  }).catch(() => ({ deny: 'review-gate: the findings could not be recorded.' }))

  on('tool.call', { tool: PULL_REQUEST }, async ($, e) => {
    if (isSubagent(e.agentId)) return { deny: 'review-gate: pull requests are opened and merged from the main conversation, not by an agent.' }
    const place = await locate($, await cwdOf($, e.path))
    if (typeof place === 'string') return { deny: place }
    if (e.action === 'open') return openPullRequest($, place, e)
    if (e.action === 'merge') return mergePullRequest($, place, e)
    return { deny: 'Say what to do: action is "open" or "merge".' }
  }).catch(() => ({ deny: 'review-gate: the pull request tool failed before it finished. Check the branch and any pull request with gh pr view.' }))

  on('tool.call', { tool: REVIEW }, async ($, e, next) => {
    const place = await locate($, await cwdOf($, e.path))
    if (typeof place === 'string') return { deny: place }
    // max is the person's to ask for: the model's tool offers the levels below it, and a call that
    // names it anyway gets the level the risk picks.
    const asked: unknown = e.level
    const level = isLevel(asked) && asked !== 'max' ? asked : undefined
    const outcome = await round($, place, settings, {
      intent: asText(e.intent),
      ...(level === undefined ? {} : { level }),
      force: false,
      signal: next.signal,
    })
    return outcome.ok ? { result: `${outcome.text}\n\n${followUp(outcome.ledger)}` } : { deny: outcome.text }
  }).catch((_, _e, next) => ({ deny: `review-gate: the review failed${next.error?.message ? `: ${next.error.message}` : ''}. Nothing was recorded.` }))

  on('tool.call', { tool: DISMISS }, async ($, e) => {
    if (isSubagent(e.agentId))
      return {
        deny: 'review-gate: findings are answered from the main conversation, not by an agent. A review hands back what it found with record.',
      }
    const ids = (Array.isArray(e.ids) ? e.ids : [e.ids]).map(id => asText(id).trim().toUpperCase()).filter(id => id !== '')
    const reason = asText(e.reason).trim()
    if (ids.length === 0) return { deny: 'Name the findings to dismiss, such as ["R2-1"].' }
    if (reason.length < 12) return { deny: 'Give the reason in a sentence: why the finding is wrong, or why the code is fine as it is.' }
    const place = await locate($, await cwdOf($, e.path))
    if (typeof place === 'string') return { deny: place }
    await show($, place)
    const next = await edit($, place, ledger => {
      const unknown = ids.filter(id => !ledger.findings.some(finding => finding.id === id))
      if (unknown.length > 0) return `${place.branch} has no finding ${unknown.join(', ')}.`
      const closed = ids.filter(id => ledger.findings.find(finding => finding.id === id)?.status !== 'open')
      if (closed.length > 0) return `${closed.join(', ')} ${closed.length === 1 ? 'is' : 'are'} not open.`
      return {
        ...ledger,
        findings: ledger.findings.map(finding => (ids.includes(finding.id) ? { ...finding, status: 'dismissed' as const, answer: reason } : finding)),
      }
    })
    if (typeof next === 'string') return { deny: next }
    const open = openFindings(next)
    return {
      result: `Dismissed ${ids.join(', ')}: ${reason}\n${
        open.length > 0 ? `Still open: ${open.map(finding => finding.id).join(', ')}.` : nothingOpen(next, place.head)
      }`,
    }
  }).catch(() => ({ deny: 'review-gate: the dismissal failed, so nothing changed.' }))

  on('command.run', { command: COMMAND }, async ($, e, next) => {
    const verb = e.args.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
    const isPerson = e.origin?.kind === 'composer' || e.origin?.kind === 'bridge'
    const place = await locate($, await $.session.cwd())
    if (typeof place === 'string') return { text: place }
    // The branch may have changed outside the session: the card draws from the record shown.
    await show($, place)
    const ledger = await load($, place)
    const last = ledger.rounds[ledger.rounds.length - 1]
    if (verb === 'status') {
      if (place.branch === '' || place.branch === place.main) return { text: `${place.branch || 'HEAD'} is not a branch to review.` }
      if (last === undefined) return { text: `${place.branch} has not been reviewed: ${place.ahead} commit${place.ahead === 1 ? '' : 's'} past ${place.main}.` }
      return { text: summary(ledger, last.n) }
    }
    if (verb === 'more' || verb === 'reset') {
      if (!isPerson) return { text: `Only the person at the keyboard can run /review-gate ${verb}.` }
      if (last === undefined) return { text: `${place.branch} has no review record.` }
      if (verb === 'more') {
        await edit($, place, current => ({ ...current, streakFrom: current.rounds.length }))
        return { text: `${place.branch} may run ${ROUND_CAP} more rounds.` }
      }
      // A round running now finds its record gone when it ends, and records nothing.
      await serially(() => $.store.delete(recordKey(place.store, place.branch)))
      await update($, ledgerState, () => emptyLedger(place.branch))
      return { text: `Forgot ${place.branch}'s review record: ${ledger.rounds.length} rounds and ${ledger.findings.length} findings.` }
    }
    const wishes = parseRun(e.args)
    if (typeof wishes === 'string') return { text: wishes }
    const outcome = await round($, place, settings, { intent: '', ...wishes, force: isPerson, signal: next.signal })
    // A review that ran in the foreground sends no notice to start Claude's follow-up, so the output
    // carries it too, for Claude's next turn; the card draws the round, not this line.
    return { text: outcome.ok && isPerson ? `${outcome.text}\n\n${followUp(outcome.ledger)}` : outcome.text }
  }).catch((_, _e, next) => ({ text: `review-gate: the command failed${next.error?.message ? `: ${next.error.message}` : ''}.` }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const live = await read($, run)
    const doing = live?.agentId === undefined ? null : await read($, memberOf(activity, { requestId: live.agentId }))
    const mine = band($, e, await read($, repo), await read($, ledgerState), live, doing, await $.clock.now())
    if (mine === undefined) return below
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {mine}
        {below}
      </Box>
    )
  })

  // A review's row in the chat draws as its card; ctrl+o still shows the text the model read.
  on('ui.render', { component: 'ToolResult', props: { tool: REVIEW } }, async ($, e, next) => {
    if (e.props.isErrored || e.props.isExpanded === true) return next(e)
    return (await roundCard($, e, textOf(e.props.output))) ?? next(e)
  })

  on('ui.render', { component: 'CommandOutput', props: { command: COMMAND } }, async ($, e, next) =>
    (await roundCard($, e, e.props.text)) ?? next(e),
  )
}
