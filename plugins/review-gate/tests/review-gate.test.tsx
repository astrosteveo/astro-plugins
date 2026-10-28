import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { Finding, Ledger, Round } from '../types'
import { emptyLedger } from '../hooks/ledger'

const ROOT = '/repo'
const RECORD = `${ROOT}/.git/review-gate/feat%2Fapp.json`
const BASE = 'b'.repeat(40)
const ONE = '1'.repeat(40)
const TWO = '2'.repeat(40)
const REVIEW = 'mcp__review-gate__review'
const DISMISS = 'mcp__review-gate__dismiss'

/** The repository the fake git answers for: the branch's commits after BASE, and what each changes. */
type World = {
  branch: string
  head: string
  history: string[]
  changes: Record<string, string[]>
  dirty: string[]
  guide?: string
  agents?: { id: string; type: string }[]
  /** What the person picks when the gate asks. */
  answer?: string
  /** The risk classifier's reply; undefined for no answer at all. */
  risk?: string
}

type Spawned = { id: string; type: string; description: string; prompt: string }

const MEDIUM = '```json\n{"tier": "medium", "why": ["src/app.ts changes how results are paged"]}\n```'

const world = (over: Partial<World> = {}): World => ({
  risk: MEDIUM,
  branch: 'feat/app',
  head: ONE,
  history: [BASE, ONE],
  changes: { [ONE]: ['src/app.ts'] },
  dirty: [],
  ...over,
})

// An engine under the plugin: a git that answers from the world, a disk in memory, and agents
// that start when spawned and answer when the test says.
function engine(on: On, repo: World) {
  const files = new Map<string, string>()
  const spawned: Spawned[] = []
  const asked: string[] = []
  // What the risk classifier was asked, and with which model.
  const judged: { model: string; prompt: string }[] = []
  const ran = (exitCode: number, stdout = '') => ({
    value: { exitCode, stdout, stderr: exitCode === 0 ? '' : 'failed', isStdoutTruncated: false, isStderrTruncated: false },
  })
  const between = (from: string, to: string) => {
    const commits = repo.history.slice(repo.history.indexOf(from) + 1, repo.history.indexOf(to) + 1)
    return [...new Set(commits.flatMap(commit => repo.changes[commit] ?? []))]
  }
  const git = (args: string[]) => {
    const [sub, ...rest] = args
    const last = rest[rest.length - 1] ?? ''
    if (sub === 'rev-parse') {
      if (rest[0] === '--show-toplevel') return ran(0, `${ROOT}\n`)
      if (rest[0] === '--path-format=absolute') return ran(0, `${ROOT}/.git\n`)
      if (last === 'HEAD') return ran(0, `${repo.head}\n`)
      return last === 'refs/heads/main' ? ran(0, `${BASE}\n`) : ran(1)
    }
    if (sub === 'symbolic-ref') return last === 'HEAD' && repo.branch !== '' ? ran(0, `${repo.branch}\n`) : ran(1)
    if (sub === 'merge-base' && rest[0] === '--is-ancestor') {
      const older = repo.history.indexOf(rest[1] ?? '')
      return older >= 0 && older <= repo.history.indexOf(rest[2] ?? '') ? ran(0) : ran(1)
    }
    if (sub === 'merge-base') return ran(0, `${BASE}\n`)
    if (sub === 'rev-list') return ran(0, `${repo.history.indexOf(repo.head)}\n`)
    if (sub === 'status') return ran(0, repo.dirty.map(path => ` M ${path}\0`).join(''))
    if (sub === 'log') return ran(0, '1111111 Add the app\n\nIt pages through results.\n\0')
    if (sub === 'ls-tree') return ran(0, repo.guide === undefined ? '' : 'REVIEW.md\0')
    if (sub === 'show') return ran(0, repo.guide ?? '')
    if (sub === 'diff') {
      const dash = rest.indexOf('--')
      const range = (dash < 0 ? rest : rest.slice(0, dash)).filter(arg => !arg.startsWith('-'))
      const changed = between(range[0] ?? BASE, range[1] ?? repo.head)
      if (rest[0] === '--name-only') return ran(0, changed.map(file => `${file}\0`).join(''))
      if (rest[0] === '-U0') return ran(0, changed.map(file => `+++ b/${file}\n@@ -0,0 +1,40 @@\n`).join(''))
      const listed = dash < 0 ? changed : rest.slice(dash + 1)
      if ((rest[0] ?? '').startsWith('--stat')) return ran(0, listed.map(file => ` ${file} | 40 +`).join('\n'))
      return ran(0, listed.map(file => `diff --git a/${file} b/${file}\n+export const page = 1\n`).join(''))
    }
    return ran(1)
  }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: ROOT }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__review-gate__${e.name}` } }))
  on('agent.register', (_, e) => ({ value: { agent: `review-gate:${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('agent.list', () => ({
    value: (repo.agents ?? []).map(agent => ({ ...agent, description: 'an agent', status: 'running' as const })),
  }))
  on('agent.spawn', (_, e) => {
    // A plugin's spawn reaches the engine as the Agent tool's call, its type under subagent_type.
    const call = e as unknown as { subagentType?: string; subagent_type?: string }
    const type = call.subagentType ?? call.subagent_type ?? ''
    const id = `agent-${spawned.length + 1}`
    spawned.push({ id, type, description: e.description, prompt: e.prompt })
    // It answers as a spawn does, and as the Agent tool does for an agent it started in the background.
    return { model: 'claude-test', agentId: id, result: { status: 'async_launched', agentId: id, description: e.description, prompt: e.prompt } } as never
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('model.complete', (_, e) => {
    judged.push({ model: e.model, prompt: e.prompt })
    const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    return {
      value:
        repo.risk === undefined
          ? { isAnswered: false as const, reason: 'empty-reply' as const, usage }
          : { isAnswered: true as const, text: repo.risk, usage },
    }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('clock.now', () => ({ value: 1_000 }))
  on('fs.read', (_, e) => {
    const text = files.get(String(e.path))
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', (_, e) => {
    files.set(String(e.path), String(e.text))
    return { value: undefined }
  })
  on('process.run', (_, e) => {
    const argv = e.argv.map(String)
    if (argv[0] === 'git') return git(argv.slice(3))
    if (argv[0] === 'mv') {
      files.set(argv[4] ?? '', files.get(argv[3] ?? '') ?? '')
      files.delete(argv[3] ?? '')
      return ran(0)
    }
    if (argv[0] === 'rm') {
      files.delete(argv[3] ?? '')
      return ran(0)
    }
    if (argv[0] === 'gh') return ran(0, JSON.stringify({ headRefName: repo.branch, headRefOid: repo.head }))
    return ran(0)
  })
  on('tool.call', (_, e) => {
    if (e.tool !== 'AskUserQuestion') return { result: {} }
    const questions = (e as unknown as { questions: { question: string }[] }).questions
    const question = questions[0]?.question ?? ''
    asked.push(question)
    return { result: { questions, answers: { [question]: repo.answer ?? 'Not yet' } } }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  return { files, spawned, asked, judged }
}

const start = ($: Engine) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

const ledgerOf = (files: Map<string, string>): Ledger => JSON.parse(files.get(RECORD) ?? 'null') as Ledger

const round = (n: number, head: string, open: number, over: Partial<Round> = {}): Round => ({
  n,
  head,
  from: BASE,
  scope: 'full',
  depth: 'standard',
  risk: { tier: 'medium', why: [] },
  raised: open,
  kept: open,
  fixed: 0,
  open,
  unread: 0,
  at: 0,
  ...over,
})

const finding = (over: Partial<Finding>): Finding => ({
  id: 'R1-1',
  round: 1,
  kind: 'bug',
  severity: 'important',
  file: 'src/app.ts',
  line: 12,
  title: 'The last page is skipped',
  detail: 'The loop stops one page early.',
  evidence: 'i < pages - 1',
  votes: { real: 3, of: 3 },
  status: 'open',
  ...over,
})

const seed = (files: Map<string, string>, over: Partial<Ledger>) => files.set(RECORD, JSON.stringify({ ...emptyLedger('feat/app'), ...over }))

// Waits for the plugin to get as far as the test needs: each tick is an event through the engine,
// which lets the plugin's own calls on it go round.
async function until($: Engine, what: string, done: () => boolean) {
  for (let tries = 0; tries < 5_000 && !done(); tries++) await $.turn.start({ text: '', turnId: 'tick', agentId: 'tick' })
  expect({ what, done: done() }).toEqual({ what, done: true })
}

const reply = ($: Engine, agentId: string, answer: string) =>
  $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: `turn-${agentId}`, agentId, reason: 'answer' })

const json = (value: unknown) => `Done.\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``

const SKIPPED_PAGE = {
  file: 'src/app.ts',
  line: 12,
  title: 'The last page is skipped',
  detail: 'The loop stops one page early, so the last page of results never loads.',
  evidence: 'for (let i = 0; i < pages - 1; i++)',
  severity: 'important',
  introduced: true,
  kind: 'bug',
}

const SHELL = {
  file: 'src/app.ts',
  line: 30,
  title: 'The query string reaches a shell',
  detail: 'search() passes the query to sh -c unquoted.',
  evidence: 'run(`grep ${query}`)',
  severity: 'important',
  introduced: true,
  kind: 'security',
}

const vote = (id: string, real: boolean) => ({ id, real, introduced: true, severity: 'important', why: real ? 'the bound is off' : 'run() quotes it' })

test('a round sends one reviewer per focus, has checkers vote, and records what most hold real', async ($, on) => {
  const repo = world()
  const { files, spawned, judged } = engine(on, repo)
  await start($)

  const call = $.tool.call({ tool: REVIEW, intent: 'Page through search results.' })
  await until($, 'four reviewers', () => spawned.length === 4)
  expect(judged.map(one => one.model)).toEqual(['claude-opus-5-5'])
  expect(judged[0]?.prompt).toContain('Judge the change on branch feat/app at commit 1111111: everything it would merge.')
  expect(judged[0]?.prompt).toContain('diff --git a/src/app.ts b/src/app.ts')
  expect(spawned.map(agent => agent.description)).toEqual(['review: correctness', 'review: failure paths', 'review: fit', 'review: security'])
  expect(spawned.map(agent => agent.type)).toEqual(Array(4).fill('review-gate:reviewer'))
  expect(spawned[0]?.prompt).toContain('This round covers the whole branch: git diff bbbbbbb 1111111')
  expect(spawned[0]?.prompt).toContain('What the change is for: Page through search results.')
  for (const agent of spawned.splice(0)) {
    const findings = agent.description === 'review: correctness' ? [SKIPPED_PAGE] : agent.description === 'review: security' ? [SHELL] : []
    await reply($, agent.id, json({ findings }))
  }

  await until($, 'three checkers', () => spawned.length === 3)
  expect(spawned.map(agent => agent.type)).toEqual(Array(3).fill('review-gate:checker'))
  expect(spawned[0]?.prompt).toContain('C1. src/app.ts:12 (a line this branch changes; raised as bug, important, by 1 reviewer)')
  expect(spawned[0]?.prompt).toContain('C2. src/app.ts:30')
  await reply($, spawned[0]?.id ?? '', json({ verdicts: [vote('C1', true), vote('C2', true)], earlier: [] }))
  await reply($, spawned[1]?.id ?? '', json({ verdicts: [vote('C1', true), vote('C2', false)], earlier: [] }))
  await reply($, spawned[2]?.id ?? '', 'I ran out of time.')

  const result = await call
  const text = String(result.result)
  expect(text.split('\n')[0]).toBe(
    'Review round 1 of feat/app at 1111111: the whole branch, standard depth (4 reviewers, 3 checkers), risk medium (src/app.ts changes how results are paged).',
  )
  expect(text).toContain('R1-1 · important · src/app.ts:12 · 2 of 2 checkers agree')
  expect(text).toContain('1 agent reply could not be read and counted for nothing.')
  // The shell finding had one vote of two: not kept.
  expect(text.includes('reaches a shell')).toBe(false)

  const ledger = ledgerOf(files)
  expect(ledger.reviewed).toBe(ONE)
  expect(ledger.findings.map(one => [one.id, one.status, one.severity])).toEqual([['R1-1', 'open', 'important']])
  expect(ledger.rounds.map(one => [one.n, one.scope, one.raised, one.kept, one.open, one.unread])).toEqual([[1, 'full', 2, 1, 1, 1]])
})

test('the next round reads only the new commits, hands the reviewers what was raised, and confirms a fix', async ($, on) => {
  const repo = world({ head: TWO, history: [BASE, ONE, TWO], changes: { [ONE]: ['src/app.ts', 'README.md'], [TWO]: ['src/app.ts'] } })
  const { files, spawned } = engine(on, repo)
  seed(files, { rounds: [round(1, ONE, 1)], findings: [finding({})], reviewed: ONE })
  await start($)

  const call = $.tool.call({ tool: REVIEW, intent: 'Page through search results.' })
  await until($, 'four reviewers', () => spawned.length === 4)
  expect(spawned[0]?.prompt).toContain('This round covers only the commits since 1111111, which an earlier round reviewed: git diff 1111111 2222222')
  expect(spawned[0]?.prompt).toContain('- R1-1 [open] src/app.ts:12 The last page is skipped')
  // A reviewer raising the open finding again does not raise it twice.
  for (const agent of spawned.splice(0)) await reply($, agent.id, json({ findings: agent.description === 'review: correctness' ? [SKIPPED_PAGE] : [] }))

  await until($, 'three checkers', () => spawned.length === 3)
  expect(spawned[0]?.prompt).toContain('Findings to check:\n\n(none)')
  expect(spawned[0]?.prompt).toContain('R1-1. src/app.ts:12 The last page is skipped')
  for (const [index, agent] of spawned.splice(0).entries()) {
    await reply($, agent.id, json({ verdicts: [], earlier: [{ id: 'R1-1', fixed: index !== 2, why: 'the bound is pages now' }] }))
  }

  const text = String((await call).result)
  expect(text.split('\n')[0]).toBe(
    'Review round 2 of feat/app at 2222222: the commits since 1111111, standard depth (4 reviewers, 3 checkers), risk medium (src/app.ts changes how results are paged).',
  )
  expect(text).toContain('Found fixed this round: R1-1 (The last page is skipped).')
  expect(text).toContain('Nothing is open. feat/app at 2222222 is ready for a pull request.')
  const ledger = ledgerOf(files)
  expect(ledger.findings.map(one => [one.id, one.status, one.answer, one.closedRound])).toEqual([['R1-1', 'fixed', 'fixed at 2222222', 2]])
  expect(ledger.reviewed).toBe(TWO)
})

test("the classifier's verdict on the code sets the risk: high reads deeper, and a person approves the pull request", async ($, on) => {
  const repo = world({ risk: '```json\n{"tier": "high", "why": ["src/app.ts builds a shell command from the query"]}\n```' })
  const { files, spawned } = engine(on, repo)
  await start($)
  const call = $.tool.call({ tool: REVIEW, intent: 'Search the log.' })
  await until($, 'five reviewers', () => spawned.length === 5)
  expect(spawned.map(agent => agent.description).at(-1)).toBe('review: state and data')
  for (const agent of spawned.splice(0)) await reply($, agent.id, json({ findings: [] }))
  const text = String((await call).result)
  expect(text.split('\n')[0]).toBe(
    'Review round 1 of feat/app at 1111111: the whole branch, deep depth (5 reviewers, 5 checkers), risk high (src/app.ts builds a shell command from the query).',
  )
  expect(text).toContain('It is high risk, so the gate asks the user to approve it when the pull request is opened or merged.')
  expect(ledgerOf(files).rounds[0]?.risk).toEqual({ tier: 'high', why: ['src/app.ts builds a shell command from the query'] })
})

test('a classifier that gives no verdict is asked again, and then leaves the change to a person', async ($, on) => {
  const repo = world({ risk: undefined })
  const { files, spawned, judged } = engine(on, repo)
  await start($)
  const call = $.tool.call({ tool: REVIEW })
  await until($, 'five reviewers', () => spawned.length === 5)
  expect(judged.length).toBe(2)
  for (const agent of spawned.splice(0)) await reply($, agent.id, json({ findings: [] }))
  await call
  expect(ledgerOf(files).rounds[0]?.risk).toEqual({ tier: 'high', why: ['the classifier gave no verdict on its risk, so a person looks'] })
})

test('a review is refused on the default branch, with no commits past it, and with changes not committed', async ($, on) => {
  const repo = world()
  engine(on, repo)
  await start($)
  repo.branch = 'main'
  expect((await $.tool.call({ tool: REVIEW })).deny).toContain('You are on main.')
  repo.branch = 'feat/app'
  repo.dirty = ['src/app.ts']
  expect((await $.tool.call({ tool: REVIEW })).deny).toBe(
    'Commit first: a review covers one commit, and these files have changes it would not see: src/app.ts.',
  )
  repo.dirty = []
  repo.head = BASE
  expect((await $.tool.call({ tool: REVIEW })).deny).toBe('feat/app has no commits past main: commit the change, then review it.')
})

test('a commit reviewed already is not reviewed again by the model', async ($, on) => {
  const repo = world()
  const { files, spawned } = engine(on, repo)
  seed(files, { rounds: [round(1, ONE, 1)], findings: [finding({})], reviewed: ONE })
  await start($)
  const text = String((await $.tool.call({ tool: REVIEW })).result)
  expect(text).toContain('This commit was reviewed already; nothing was run again.')
  expect(spawned).toEqual([])
})

test('after three rounds that leave findings open the model is refused another, until the person allows more', async ($, on) => {
  const repo = world({ head: TWO, history: [BASE, ONE, TWO], changes: { [ONE]: ['src/app.ts'], [TWO]: ['src/app.ts'] } })
  const { files } = engine(on, repo)
  seed(files, { rounds: [round(1, ONE, 2), round(2, ONE, 2), round(3, ONE, 1)], findings: [finding({})], reviewed: ONE })
  await start($)

  const refused = (await $.tool.call({ tool: REVIEW })).deny ?? ''
  expect(refused.startsWith('3 rounds in a row have ended with findings open (round 1 left 2 open, round 2 left 2 open, round 3 left 1 open)')).toBe(true)
  expect(refused).toContain('tell the user what keeps coming back (R1-1 The last page is skipped)')

  const person = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }
  expect((await $.command.run({ command: 'review-gate', args: 'more', ...person, origin: { kind: 'sdk' } })).text).toBe(
    'Only the person at the keyboard can run /review-gate more.',
  )
  const more = await $.command.run({ command: 'review-gate', args: 'more', ...person })
  expect(more.text).toBe('feat/app may run 3 more rounds.')
  expect(ledgerOf(files).streakFrom).toBe(3)
})

test('the gate refuses a pull request until its commit is reviewed and nothing is open', async ($, on) => {
  const repo = world()
  const { files } = engine(on, repo)
  await start($)
  const create = () => $.tool.call({ tool: 'Bash', command: 'git push -u origin feat/app && gh pr create --fill' })

  expect((await create()).deny).toBe(
    'Review first: feat/app at 1111111 has not been reviewed. Call mcp__review-gate__review with what the change is for, answer each finding, then run this again.',
  )
  seed(files, { rounds: [round(1, ONE, 1)], findings: [finding({})], reviewed: ONE })
  expect((await create()).deny).toBe(
    'feat/app has 1 open review finding: R1-1 (src/app.ts:12 The last page is skipped). Fix each and commit, then call mcp__review-gate__review again; or dismiss it with mcp__review-gate__dismiss and a reason.',
  )

  const dismissed = await $.tool.call({ tool: DISMISS, ids: ['r1-1'], reason: 'The caller never passes the last page index.' })
  expect(dismissed.result).toBe(
    'Dismissed R1-1: The caller never passes the last page index.\nNothing is open. feat/app at 1111111 is ready for a pull request.',
  )
  expect((await create()).deny).toBe(undefined)

  // A commit after the review is one the review never saw.
  repo.history.push(TWO)
  repo.head = TWO
  expect((await $.tool.call({ tool: 'Bash', command: 'gh pr merge --squash' })).deny).toBe(
    'Review first: feat/app at 2222222 has not been reviewed (the last round covered 1111111). Call mcp__review-gate__review with what the change is for, answer each finding, then run this again.',
  )
})

test('a dismissal needs an open finding and a reason', async ($, on) => {
  const { files } = engine(on, world())
  seed(files, { rounds: [round(1, ONE, 1)], findings: [finding({}), finding({ id: 'R1-2', status: 'fixed' })], reviewed: ONE })
  await start($)
  const dismiss = (ids: string[], reason = 'The caller never passes the last page index.') => $.tool.call({ tool: DISMISS, ids, reason })
  expect((await dismiss(['R1-9'])).deny).toBe('feat/app has no finding R1-9.')
  expect((await dismiss(['R1-2'])).deny).toBe('R1-2 is not open.')
  expect((await dismiss(['R1-1'], 'wrong')).deny).toBe('Give the reason in a sentence: why the finding is wrong, or why the code is fine as it is.')
  expect(ledgerOf(files).findings[0]?.status).toBe('open')
})

test('a high-risk change waits for the person, and their approval holds for that commit alone', async ($, on) => {
  const repo = world()
  const { files, asked } = engine(on, repo)
  const risk = { tier: 'high' as const, why: ['it changes .github/workflows/ci.yml, a path a person approves'] }
  seed(files, {
    rounds: [round(1, ONE, 0, { risk })],
    findings: [finding({ status: 'dismissed', answer: 'The caller never passes the last page index.' })],
    reviewed: ONE,
  })
  await start($)
  const create = () => $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })

  expect((await create()).deny).toBe(
    'The user has not approved feat/app at 1111111, which needs a person: it changes .github/workflows/ci.yml, a path a person approves. Ask them what they want changed.',
  )
  expect(asked[0]).toBe(
    'The review of feat/app passed, and it needs your approval: it changes .github/workflows/ci.yml, a path a person approves. Dismissed findings: R1-1 The last page is skipped (The caller never passes the last page index.). Do you approve opening its pull request at 1111111?',
  )

  repo.answer = 'Approve'
  expect((await create()).deny).toBe(undefined)
  expect(ledgerOf(files).approved).toEqual({ sha: ONE, at: 1_000 })
  expect((await create()).deny).toBe(undefined)
  expect(asked.length).toBe(2)
})

test("a reviewer agent's commands are held to reading; another agent's are not", async ($, on) => {
  engine(on, world({ agents: [{ id: 'agent-r', type: 'review-gate:reviewer' }, { id: 'agent-g', type: 'general-purpose' }] }))
  await start($)
  const refused = await $.tool.call({ tool: 'Bash', command: 'git checkout main', agentId: 'agent-r' })
  expect(refused.deny).toBe('review-gate: reviewers only read, so this command was refused: git checkout is not one that only reads.')
  expect((await $.tool.call({ tool: 'Bash', command: 'git log -3', agentId: 'agent-r' })).deny).toBe(undefined)
  expect((await $.tool.call({ tool: 'Bash', command: 'git checkout main', agentId: 'agent-g' })).deny).toBe(undefined)
})

test("a review's row draws as a card of its findings, and the band says what is open", async ($, on) => {
  const { files } = engine(on, world())
  seed(files, {
    rounds: [round(1, ONE, 1)],
    findings: [
      finding({}),
      finding({ id: 'R1-2', kind: 'security', title: 'The query string reaches a shell', status: 'dismissed', answer: 'run() quotes every argument.' }),
    ],
    reviewed: ONE,
  })
  await start($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const row = await $.ui.mount({
      plugin: 'review-gate',
      surface,
      component: 'ToolResult',
      requestId: 'toolu_1',
      props: { tool_use_id: 'toolu_1', tool: REVIEW, output: 'Review round 1 of feat/app at 1111111: the whole branch.', isErrored: false },
    })
    const drawn = (await row.findAll({ type: 'Text' })).map(text => text.text).join('\n')
    expect(drawn).toContain('Review round 1')
    expect(drawn).toContain('R1-1')
    expect(drawn).toContain('The last page is skipped')
    expect(drawn).toContain('dismissed: run() quotes every argument.')
    expect(drawn).toContain('1 finding open.')
    await row.unmount()

    // A command's row reaches the hook with the plugin's name before its text.
    const output = await $.ui.mount({
      plugin: 'review-gate',
      surface,
      component: 'CommandOutput',
      requestId: 'msg_1',
      props: { command: 'review-gate', args: 'status', text: 'review-gate: Review round 1 of feat/app at 1111111: the whole branch.', isErrored: false },
    })
    const listed = (await output.findAll({ type: 'Text' })).map(text => text.text).join('\n')
    expect(listed).toContain('Review round 1')
    expect(listed).toContain('The last page is skipped')
    await output.unmount()

    const band = await $.ui.mount({
      plugin: 'review-gate',
      surface,
      component: 'AbovePrompt',
      requestId: 'band',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
    })
    const said = (await band.findAll({ type: 'Text' })).map(text => text.text).join('')
    expect(said).toContain('✗ 1 open: R1-1')
    expect(said).toContain('engine')
    await band.unmount()
  }
})

test('a row that is not a round, or a refused review, draws as the engine draws it', async ($, on) => {
  engine(on, world())
  await start($)
  const row = await $.ui.mount({
    plugin: 'review-gate',
    surface: 'terminal',
    component: 'ToolResult',
    requestId: 'toolu_2',
    props: { tool_use_id: 'toolu_2', tool: REVIEW, output: 'Commit first: …', isErrored: true },
  })
  expect((await row.findAll({ type: 'Text' })).map(text => text.text)).toEqual(['engine'])
  await row.unmount()
})
