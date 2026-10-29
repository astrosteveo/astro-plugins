import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput } from 'claude-code'
import type { Activity, Depth, Ledger } from '../types'
import { branches, firstCommit, locate, short } from './git'
import type { Place } from './git'
import { gitArgsRefusal, gitArgv, gitGrepArgv, opensOrMerges, rgArgv } from './guard'
import type { Search } from './guard'
import { ROUND_CAP, emptyLedger, openFindings, recordKey, recordPrefix, riskNow, toLedger } from './ledger'
import { CHECKER, REVIEWER } from './prompts'
import { CHECKER_TYPE, REVIEWER_TYPE, mailbox, runRound, summary } from './review'
import type { RoundAsk } from './review'
import { band, card } from './views'

const REVIEW = 'mcp__review-gate__review'
const DISMISS = 'mcp__review-gate__dismiss'
const PULL_REQUEST = 'mcp__review-gate__pull_request'
const GIT_TOOL = 'mcp__review-gate__review_git'
const SEARCH_TOOL = 'mcp__review-gate__review_search'
const COMMAND = 'review-gate'

const repo = atom({ plugin: 'review-gate', key: 'repo' } as const, null, { shape: 'repo-1' })
const ledgerState = atom({ plugin: 'review-gate', key: 'ledger' } as const, null, { shape: 'ledger-1' })
const run = atom({ plugin: 'review-gate', key: 'run' } as const, null, { shape: 'run-2' })
const activity = atom({ plugin: 'review-gate', key: 'activity' } as const, null)

const DEPTH_NAMES = ['quick', 'standard', 'deep'] as const
const METHODS = ['merge', 'squash', 'rebase'] as const

const PATH = {
  type: 'string',
  description: "A folder in the repository, when the session's working directory is not in it.",
}

const REVIEW_TOOL = {
  name: 'review',
  description:
    "Review the current branch's commits, as its pull request would show them, before you open the pull request. Reviewer agents, each with its own focus, look for defects in parallel; checker agents then vote, and only findings most of them hold real are kept. Call it once the change is committed and its checks pass: the pull_request tool opens and merges pull requests only for a commit that was reviewed with every finding answered. Answer each finding: fix it and commit, then review again (later rounds read only the new commits and confirm the fix); or dismiss it with the reason it can stay. After three rounds in a row end with findings open, it stops and asks you to step back with the user. A round takes minutes.",
  isDeferred: false,
  inputSchema: {
    type: 'object',
    properties: {
      intent: {
        type: 'string',
        description: 'What the change is for, in a sentence or two: the problem it solves and how. Reviewers check the change against it.',
      },
      depth: {
        type: 'string',
        enum: [...DEPTH_NAMES],
        description: "Leave it out and the change's risk picks: quick runs 2 reviewers and 1 checker, standard 4 and 3, deep 5 and 3.",
      },
      path: PATH,
    },
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
    "Open or merge a pull request: the only way to, as gh pr create, gh pr merge and gh api calls that do either are refused in Bash. open pushes the current branch to origin and opens its pull request. merge merges a pull request, and only while its head is still the commit that was reviewed. Both are refused until that commit has been reviewed and every finding answered, and a high-risk change also waits for the user's approval in a dialog. Ask the user before you open or merge one.",
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

const GIT_TOOL_SPEC = {
  name: 'review_git',
  description:
    "For review-gate's reviewers and checkers only: run one of git's reading commands (log, show, diff, blame, grep, ls-files, ls-tree, rev-parse, cat-file and the like) in the repository under review. Give git's arguments as a list, without git itself.",
  isDeferred: false,
  inputSchema: {
    type: 'object',
    properties: {
      args: { type: 'array', items: { type: 'string' }, description: 'git\'s arguments, such as ["log", "-p", "-3", "--", "src/app.ts"].' },
    },
    required: ['args'],
  },
}

const SEARCH_TOOL_SPEC = {
  name: 'review_search',
  description: "For review-gate's reviewers and checkers only: search the repository under review for a pattern, with line numbers.",
  isDeferred: false,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'A regular expression, or plain text when fixed is set.' },
      path: { type: 'string', description: 'A file or folder to search; left out, the whole repository.' },
      glob: { type: 'string', description: 'Only files whose names match it, such as "*.ts".' },
      ignoreCase: { type: 'boolean' },
      fixed: { type: 'boolean', description: 'Match the pattern as plain text.' },
      context: { type: 'number', description: 'Lines to show around each match, up to 20.' },
    },
    required: ['pattern'],
  },
}

const USAGE = `/review-gate runs a review round on this branch now; /review-gate quick, standard or deep picks its depth. /review-gate status shows where the review stands, /review-gate more allows ${ROUND_CAP} more rounds after the cap, and /review-gate reset forgets this branch's review record.`

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

// Who began the branch whose head is `sha`: its fork from the default branch, then its first commit.
async function identity(place: Place, sha: string) {
  if (sha === place.head) return firstCommit(place.git, place.base, sha)
  const fork = await place.git(['merge-base', sha, place.mainRef])
  if (!fork.ok) throw new Error(fork.err)
  return firstCommit(place.git, fork.out.trim(), sha)
}

/**
 * A branch's record, from the plugin's own store and nowhere else: a file in the repository is
 * Claude's to write. A record begun by another commit than the branch's first was left by an
 * earlier branch of the same name, and reads as none.
 */
async function load($: EngineInterface, place: Place, branch = place.branch, sha = place.head) {
  const ledger = toLedger(await $.store.get(recordKey(place.store, branch)), branch)
  if (ledger.first === undefined) return ledger
  // A head this clone cannot place (a pull request not fetched) keeps its record: its review is
  // still matched to the exact commit.
  const first = await identity(place, sha).catch(() => ledger.first)
  return first === ledger.first ? ledger : emptyLedger(branch)
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
async function edit($: EngineInterface, place: Place, change: (ledger: Ledger) => Ledger | string, branch = place.branch, sha = place.head) {
  return serially(async () => {
    const next = change(await load($, place, branch, sha))
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

function nothingOpen(ledger: Ledger, head: string) {
  if (ledger.reviewed !== head) return `Nothing is open, but the commits since ${short(ledger.reviewed ?? '')} have not been reviewed.`
  const high = riskNow(ledger)?.tier === 'high' && ledger.approved?.sha !== head
  return `Nothing is open. ${ledger.branch} at ${short(head)} is ready for a pull request${high ? ', once the user approves it at the gate: it is high risk' : ''}.`
}

/**
 * Why a pull request may not be opened or merged for `branch` at `sha`, or undefined when it may:
 * the commit was reviewed, no finding is open, and a high-risk change has the person's approval for
 * that commit, asked for here when it has none.
 */
async function vouch($: EngineInterface, place: Place, branch: string, sha: string, action: 'open' | 'merge'): Promise<string | undefined> {
  const ledger = await load($, place, branch, sha)
  if (ledger.reviewed !== sha)
    return `Review first: ${branch} at ${short(sha)} has not been reviewed${
      ledger.reviewed === undefined ? '' : ` (the last round covered ${short(ledger.reviewed)})`
    }. Call ${REVIEW} with what the change is for, answer each finding, then try again.`
  const open = openFindings(ledger)
  if (open.length > 0)
    return `${branch} has ${open.length} open review finding${open.length === 1 ? '' : 's'}: ${open
      .map(finding => `${finding.id} (${finding.file}:${finding.line} ${finding.title})`)
      .join('; ')}. Fix each and commit, then call ${REVIEW} again; or dismiss it with ${DISMISS} and a reason.`
  const risk = riskNow(ledger)
  if (risk?.tier !== 'high' || ledger.approved?.sha === sha) return undefined

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
  await edit($, place, current => ({ ...current, approved: { sha, at } }), branch, sha)
  return undefined
}

type Input = Record<string, unknown>
type Answer = { result: string } | { deny: string }

// Pushes the current branch and opens its pull request, once its review vouches for it.
async function openPullRequest($: EngineInterface, place: Place, input: Input): Promise<Answer> {
  if (place.branch === '' || place.branch === place.main)
    return { deny: `Check out the branch to open a pull request for: ${place.branch || 'a detached HEAD'} is not one.` }
  const title = asText(input.title).trim()
  if (title === '') return { deny: 'Give the pull request a title.' }
  const refusal = await vouch($, place, place.branch, place.head, 'open')
  if (refusal !== undefined) return { deny: refusal }
  const pushed = await runIn($, ['git', 'push', '-u', 'origin', `${place.head}:refs/heads/${place.branch}`], place.root, 120_000)
  if (pushed.exitCode !== 0) return { deny: `git push failed, so no pull request was opened: ${pushed.stderr.trim()}` }
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

// What the reviewers' tools hand back: the output, cut where it runs long, and git's complaint.
const OUTPUT_CAP = 30_000

function shown(ran: Ran, empty: string) {
  const out =
    ran.stdout.length > OUTPUT_CAP
      ? `${ran.stdout.slice(0, OUTPUT_CAP)}\n… cut at ${OUTPUT_CAP} of ${ran.stdout.length} characters: narrow the command.`
      : ran.stdout
  const failed = ran.exitCode !== 0 && ran.stderr.trim() !== '' ? `\n(exit ${ran.exitCode}) ${ran.stderr.trim()}` : ''
  return `${out}${failed}`.trim() || empty
}

// The agents' replies, the review's own agents, the folder a round runs in, and whether one runs:
// the session's, kept here.
const mail = mailbox()
const reviewers = new Set<string>()
let activeRoot: string | undefined
let busy = false

async function isReviewer($: EngineInterface, agentId: string) {
  if (reviewers.has(agentId)) return true
  const agents = await $.agent.list()
  return agents.some(agent => agent.id === agentId && (agent.type === REVIEWER_TYPE || agent.type === CHECKER_TYPE))
}

type Settings = { depthOption: 'auto' | Depth; model?: string; riskModel?: string }

// One round, for the tool and the command alike; a second is refused while one runs.
async function round($: EngineInterface, place: Place, settings: Settings, ask: Pick<RoundAsk, 'intent' | 'depth' | 'force' | 'signal'>) {
  if (busy) return { ok: false as const, text: 'A review round is running already: wait for it to finish.' }
  busy = true
  activeRoot = place.root
  try {
    return await runRound($, {
      ...ask,
      ...settings,
      place,
      ledger: await load($, place),
      mail,
      reviewers,
      progress: async change => {
        await update($, run, change)
      },
      callsOf: async agentId => (await read($, memberOf(activity, { requestId: agentId })))?.calls ?? 0,
      edit: change => edit($, place, change),
    })
  } finally {
    busy = false
    activeRoot = undefined
    await update($, run, () => null)
    await refresh($).catch(() => undefined)
  }
}

// A review agent's tool call as a few words for the band.
function describeCall(e: { tool: string } & Record<string, unknown>) {
  const root = activeRoot === undefined ? '' : `${activeRoot}/`
  const path = (value: unknown) => asText(value).replace(root, '')
  if (e.tool === 'Read') return `reading ${path(e.file_path)}`
  if (e.tool === GIT_TOOL) return `git ${(Array.isArray(e.args) ? e.args : []).map(asText).join(' ')}`.slice(0, 80)
  if (e.tool === SEARCH_TOOL) return `searching "${asText(e.pattern).slice(0, 40)}"${asText(e.path) === '' ? '' : ` in ${path(e.path)}`}`
  return e.tool
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

const choice = (value: unknown) => (typeof value === 'string' && value !== '' && value !== 'inherit' ? value : undefined)

export const register: Register = (on, options) => {
  const model = choice(options.model)
  const riskModel = choice(options.riskModel)
  const settings: Settings = {
    depthOption: DEPTH_NAMES.find(name => name === options.depth) ?? 'auto',
    ...(model === undefined ? {} : { model }),
    ...(riskModel === undefined ? {} : { riskModel }),
  }

  on('session.start', async ($, e, next) => {
    for (const tool of [REVIEW_TOOL, DISMISS_TOOL, PULL_REQUEST_TOOL, GIT_TOOL_SPEC, SEARCH_TOOL_SPEC]) await $.tool.register(tool)
    // Medium effort and a turn limit keep each agent's thinking and its context in bounds.
    const agent = { tools: ['Read', GIT_TOOL, SEARCH_TOOL], model: 'inherit', effort: 'medium', maxTurns: 40 }
    await $.agent.register({ name: 'reviewer', description: 'Reviews a change for one kind of defect. review-gate runs it.', prompt: REVIEWER, ...agent })
    await $.agent.register({ name: 'checker', description: 'Votes on review findings. review-gate runs it.', prompt: CHECKER, ...agent })
    await $.command.register({
      name: COMMAND,
      description: 'Review this branch now, or see where its review stands',
      argumentHint: '[quick | standard | deep | status | more | reset]',
    })
    // A round a reload cut short left its progress behind.
    await update($, run, () => null)
    await refresh($).catch(() => undefined)
    return next(e)
  })

  // The review's own agents are its to run: the model is not offered them.
  on('agent.offer', { agent: 'review-gate:reviewer' }, () => ({ isOffered: false })).catch(() => ({ isOffered: false }))
  on('agent.offer', { agent: 'review-gate:checker' }, () => ({ isOffered: false })).catch(() => ({ isOffered: false }))

  // A subagent's reply is its turn's end; the main thread's end is a moment to look at git again.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) mail.settle(e.agentId, e.answer, e.usage)
    else await refresh($).catch(() => undefined)
    return next(e)
  })

  // A pull request is opened and merged by the gate's own tool: a shell command that does either is
  // refused, by a match on its text.
  on('tool.call', { tool: 'Bash' }, (_, e, next) => (opensOrMerges(e.command) ? { deny: RAW_PR_REFUSAL } : next(e))).catch((_, e, next) =>
    next.called ? next(e) : { deny: RAW_PR_REFUSAL },
  )

  // What each of the review's agents is doing, for the band: its calls so far, and its latest.
  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined && reviewers.has(e.agentId)) {
      const doing = describeCall(e)
      await update($, memberOf(activity, { requestId: e.agentId }), last => ({ calls: (last?.calls ?? 0) + 1, doing }))
    }
    return next(e)
  }).catch((_, e, next) => next(e))

  // The review's agents have no shell: they read through review_git and review_search.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) =>
    e.agentId !== undefined && (await isReviewer($, e.agentId))
      ? { deny: 'review-gate: reviewers have no shell. Read files with Read, and use review_git and review_search.' }
      : next(e),
  ).catch((_, e, next) => (next.called || !reviewers.has(e.agentId ?? '') ? next(e) : { deny: 'review-gate: reviewers have no shell.' }))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined && /\b(git|gh)\b/.test(e.command)) await refresh($)
    return ran
  }).catch((_, e, next) => next(e))

  on('tool.call', { tool: GIT_TOOL }, async ($, e) => {
    if (e.agentId === undefined || !(await isReviewer($, e.agentId))) return { deny: "review_git is for review-gate's own reviewers and checkers." }
    const args = (Array.isArray(e.args) ? e.args : []).filter((arg): arg is string => typeof arg === 'string')
    const refusal = gitArgsRefusal(args)
    if (refusal !== undefined) return { deny: `review-gate: ${refusal}.` }
    const ran = await runIn($, gitArgv(args), activeRoot ?? (await $.session.cwd()), 60_000)
    return { result: shown(ran, '(no output)') }
  }).catch(() => ({ deny: 'review-gate: the git command could not be run.' }))

  on('tool.call', { tool: SEARCH_TOOL }, async ($, e) => {
    if (e.agentId === undefined || !(await isReviewer($, e.agentId))) return { deny: "review_search is for review-gate's own reviewers and checkers." }
    const pattern = asText(e.pattern)
    if (pattern === '') return { deny: 'Give a pattern to search for.' }
    const search: Search = {
      pattern,
      path: asText(e.path),
      glob: asText(e.glob),
      ignoreCase: e.ignoreCase === true,
      fixed: e.fixed === true,
      context: typeof e.context === 'number' ? e.context : 0,
    }
    const cwd = activeRoot ?? (await $.session.cwd())
    // ripgrep exits 1 for no match and 2 for an error; where it cannot start, git grep searches.
    const rg = await $.process.run(rgArgv(search), { cwd, timeoutMs: 60_000 }).catch(() => undefined)
    const ran = rg ?? (await runIn($, gitGrepArgv(search), cwd, 60_000))
    return { result: shown(ran, 'No matches.') }
  }).catch(() => ({ deny: 'review-gate: the search could not be run.' }))

  on('tool.call', { tool: PULL_REQUEST }, async ($, e) => {
    const place = await locate($, await cwdOf($, e.path))
    if (typeof place === 'string') return { deny: place }
    if (e.action === 'open') return openPullRequest($, place, e)
    if (e.action === 'merge') return mergePullRequest($, place, e)
    return { deny: 'Say what to do: action is "open" or "merge".' }
  }).catch(() => ({ deny: 'review-gate: the pull request tool failed before it finished. Check the branch and any pull request with gh pr view.' }))

  on('tool.call', { tool: REVIEW }, async ($, e, next) => {
    const place = await locate($, await cwdOf($, e.path))
    if (typeof place === 'string') return { deny: place }
    const depth = DEPTH_NAMES.find(name => name === e.depth)
    const outcome = await round($, place, settings, {
      intent: asText(e.intent),
      ...(depth === undefined ? {} : { depth }),
      force: false,
      signal: next.signal,
    })
    return outcome.ok ? { result: outcome.text } : { deny: outcome.text }
  }).catch((_, e, next) => ({ deny: `review-gate: the review failed${next.error?.message ? `: ${next.error.message}` : ''}. Nothing was recorded.` }))

  on('tool.call', { tool: DISMISS }, async ($, e) => {
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
    const verb = e.args.trim().split(/\s+/)[0]?.toLowerCase() || 'run'
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
    const depth = DEPTH_NAMES.find(name => name === verb)
    if (verb !== 'run' && depth === undefined) return { text: USAGE }
    const outcome = await round($, place, settings, { intent: '', ...(depth === undefined ? {} : { depth }), force: isPerson, signal: next.signal })
    return { text: outcome.text }
  }).catch((_, e, next) => ({ text: `review-gate: the command failed${next.error?.message ? `: ${next.error.message}` : ''}.` }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const live = await read($, run)
    const doing = new Map<string, Activity | null>()
    for (const agent of live?.agents ?? []) doing.set(agent.id, await read($, memberOf(activity, { requestId: agent.id })))
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
