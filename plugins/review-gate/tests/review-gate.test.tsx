import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { Activity, Finding, Ledger, Round, Run } from '../types'
import { emptyLedger, globTest } from '../hooks/ledger'
import { liveBand } from '../hooks/views'

// The test runtime has timers, though the hooks' own environment does not.
declare function setTimeout(callback: () => void, ms: number): unknown

const ROOT = '/repo'
const KEY = 'record:/repo/.git/review-gate:feat/app'
const BASE = 'b'.repeat(40)
const ONE = '1'.repeat(40)
const TWO = '2'.repeat(40)
const FIRST = '2026-10-28T10:00:00-05:00 dev@example.com'
const REVIEW = 'mcp__review-gate__review'
const DISMISS = 'mcp__review-gate__dismiss'
const PULL_REQUEST = 'mcp__review-gate__pull_request'
const GIT_TOOL = 'mcp__review-gate__review_git'
const SEARCH_TOOL = 'mcp__review-gate__review_search'

const MEDIUM = '```json\n{"tier": "medium", "why": ["src/app.ts changes how results are paged"]}\n```'
const HIGH = '```json\n{"tier": "high", "why": ["src/app.ts builds a shell command from the query"]}\n```'

/** The repository the fake git answers for: the branch's commits after BASE, and what each changes. */
type World = {
  branch: string
  head: string
  history: string[]
  changes: Record<string, string[]>
  dirty: string[]
  guide?: string
  /** The commit whose tree holds the REVIEW.md `guide` is: the base, unless the branch added it. */
  guideAt?: string
  agents?: { id: string; type: string }[]
  /** What the person picks when the gate asks. */
  answer?: string
  /** The risk classifier's reply; undefined for no answer at all. */
  risk?: string
  /** The repository's local branches. */
  branches?: string[]
  /** Whether git fails to list the changed files. */
  failDiff?: boolean
  /** Whether ripgrep can start. */
  hasRg?: boolean
  /** The clock, which the test moves. */
  now: number
}

type Spawned = { id: string; type: string; description: string; prompt: string }

const world = (over: Partial<World> = {}): World => ({
  risk: MEDIUM,
  branch: 'feat/app',
  head: ONE,
  history: [BASE, ONE],
  changes: { [ONE]: ['src/app.ts'] },
  dirty: [],
  now: 1_000,
  ...over,
})

const USAGE = { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 500, model: 'claude-test' }

// An engine under the plugin: a git that answers from the world, the plugin's store in memory, gh
// and ripgrep stand-ins, and agents that start when spawned and answer when the test says.
function engine(on: On, repo: World) {
  const store = new Map<string, unknown>()
  const files = new Map<string, string>()
  const spawned: Spawned[] = []
  const asked: string[] = []
  // What the risk classifier was asked; every program run, by its argv; spawns and staggers, in
  // order; and the agents stopped.
  const judged: { model: string; prompt: string; cached: boolean }[] = []
  const argvs: string[][] = []
  const log: string[] = []
  const stops: string[] = []
  const ran = (exitCode: number, stdout = '') => ({
    value: { exitCode, stdout, stderr: exitCode === 0 ? '' : 'failed', isStdoutTruncated: false, isStderrTruncated: false },
  })
  const between = (from: string, to: string) => {
    const commits = repo.history.slice(repo.history.indexOf(from) + 1, repo.history.indexOf(to) + 1)
    return [...new Set(commits.flatMap(commit => repo.changes[commit] ?? []))]
  }
  const git = (given: string[], cwd: string) => {
    if (cwd !== ROOT && !cwd.startsWith(`${ROOT}/`)) return ran(128)
    const args = [...given]
    while ((args[0] ?? '').startsWith('-')) args.splice(0, args[0] === '-c' || args[0] === '-C' ? 2 : 1)
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
    if (sub === 'log') return rest.includes('--format=%aI %ae') ? ran(0, `${FIRST}\n`) : ran(0, '1111111 Add the app\n\nIt pages through results.\n\0')
    if (sub === 'for-each-ref') return ran(0, (repo.branches ?? ['main', 'feat/app']).map(name => `${name}\n`).join(''))
    if (sub === 'push') return ran(0)
    const guided = repo.guide !== undefined && (rest.includes(repo.guideAt ?? BASE) || rest[0] === `${repo.guideAt ?? BASE}:REVIEW.md`)
    if (sub === 'ls-tree') return ran(0, guided ? 'REVIEW.md\0src/app.ts\0' : 'src/app.ts\0')
    if (sub === 'show') return guided ? ran(0, repo.guide ?? '') : ran(128)
    if (sub === 'diff') {
      const dash = rest.indexOf('--')
      const range = (dash < 0 ? rest : rest.slice(0, dash)).filter(arg => !arg.startsWith('-'))
      const changed = between(range[0] ?? BASE, range[1] ?? repo.head)
      if (rest[0] === '--name-only') return repo.failDiff === true ? ran(1) : ran(0, changed.map(file => `${file}\0`).join(''))
      if (rest[0] === '-U0') return ran(0, changed.map(file => `+++ b/${file}\n@@ -0,0 +1,40 @@\n`).join(''))
      // `-- . :(exclude,glob)…` keeps the changed files no exclusion names.
      const left = rest.slice(dash + 2).map(spec => globTest(`/${spec.replace(':(exclude,glob)', '')}`))
      const listed = dash < 0 ? changed : changed.filter(file => !left.some(skip => skip(file)))
      if ((rest[0] ?? '').startsWith('--stat')) return ran(0, listed.map(file => ` ${file} | 40 +`).join('\n'))
      return ran(0, listed.map(file => `diff --git a/${file} b/${file}\n+export const page = 1\n`).join(''))
    }
    return ran(0, `git ${args.join(' ')}\n`)
  }
  const gh = (args: string[]) => {
    if (args[1] === 'view') return ran(0, JSON.stringify({ number: 7, headRefName: repo.branch, headRefOid: repo.head, state: 'OPEN' }))
    if (args[1] === 'create') return ran(0, 'https://github.com/o/r/pull/7\n')
    return ran(0)
  }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: ROOT }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
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
    log.push(`spawn ${type}`)
    // It answers as a spawn does, and as the Agent tool does for an agent it started in the background.
    return { model: 'claude-test', agentId: id, result: { status: 'async_launched', agentId: id, description: e.description, prompt: e.prompt } } as never
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('model.complete', (_, e) => {
    judged.push({ model: e.model, prompt: e.prompt, cached: e.promptBlocks?.some(block => block.cache === true) === true })
    const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    return {
      value:
        repo.risk === undefined
          ? { isAnswered: false as const, reason: 'empty-reply' as const, usage }
          : { isAnswered: true as const, text: repo.risk, usage },
    }
  })
  on('clock.now', () => ({ value: repo.now }))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('fs.read', (_, e) => {
    const text = files.get(String(e.path))
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('process.run', async (_, e) => {
    const argv = e.argv.map(String)
    argvs.push(argv)
    if (argv[0] === 'git') return git(argv.slice(1), e.init?.cwd ?? ROOT)
    if (argv[0] === 'gh') return gh(argv.slice(1))
    if (argv[0] === 'rg') {
      if (repo.hasRg === false) throw new Error('rg: not found')
      return ran(0, 'src/app.ts:12:const token = query\n')
    }
    // A sleep takes a moment, so a round's wait is no busy loop, and moves the clock a tenth of its
    // length, so a round left waiting by a failed check still ends at its phase limit.
    if (argv[0] === 'sleep') {
      await new Promise<void>(resolve => setTimeout(resolve, 1))
      repo.now += Number(argv[1]) * 100
      if (argv[1] !== '1') log.push(`sleep ${argv[1]}`)
    }
    return ran(0)
  })
  on('tool.call', (_, e) => {
    if (e.tool === 'TaskStop') {
      stops.push(String((e as unknown as { task_id?: string }).task_id))
      return { result: {} }
    }
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
  return { store, files, spawned, asked, judged, argvs, log, stops }
}

const start = ($: Engine) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

const ledgerOf = (store: Map<string, unknown>) => store.get(KEY) as Ledger

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

const seed = (store: Map<string, unknown>, over: Partial<Ledger>) => store.set(KEY, { ...emptyLedger('feat/app'), first: FIRST, ...over })

// One tick of a wait: an event through the engine, and a millisecond, so the plugin's own calls and
// its sleeps go round.
async function tick($: Engine) {
  await $.turn.start({ text: '', turnId: 'tick', agentId: 'tick' })
  await new Promise<void>(resolve => setTimeout(resolve, 1))
}

// Waits for the plugin to get as far as the test needs.
async function until($: Engine, what: string, done: () => boolean) {
  for (let tries = 0; tries < 2_000 && !done(); tries++) await tick($)
  expect({ what, done: done() }).toEqual({ what, done: true })
}

// The same, for a check that reads a drawing.
async function untilShown($: Engine, what: string, done: () => Promise<boolean>) {
  for (let tries = 0; tries < 500 && !(await done()); tries++) await tick($)
  expect({ what, done: await done() }).toEqual({ what, done: true })
}

const reply = ($: Engine, agentId: string, answer: string) =>
  $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: `turn-${agentId}`, agentId, reason: 'answer', usage: USAGE })

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

const open = (title = 'Add search') => ({ tool: PULL_REQUEST, action: 'open', title, body: 'Body text' }) as const

// A command the person typed.
const person = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }

test('a round sends one reviewer per focus, has checkers vote, and records what most hold real, with its cost', async ($, on) => {
  const repo = world()
  const { store, spawned, judged, log } = engine(on, repo)
  await start($)

  const call = $.tool.call({ tool: REVIEW, intent: 'Page through search results.' })
  await until($, 'four reviewers', () => spawned.length === 4)
  // The risk check runs on its own model, Haiku unless the options say otherwise, its prompt marked for the cache.
  expect(judged.map(one => [one.model, one.cached])).toEqual([['haiku', true]])
  expect(judged[0]?.prompt).toContain('Judge the change on branch feat/app at commit 1111111: everything it would merge.')
  expect(spawned.map(agent => agent.description)).toEqual(['review: correctness', 'review: failure paths', 'review: fit', 'review: security'])
  expect(spawned.map(agent => agent.type)).toEqual(Array(4).fill('review-gate:reviewer'))
  expect(spawned[0]?.prompt).toContain('This round covers the whole branch: git diff bbbbbbb 1111111')
  for (const agent of spawned.splice(0)) {
    const findings = agent.description === 'review: correctness' ? [SKIPPED_PAGE] : agent.description === 'review: security' ? [SHELL] : []
    await reply($, agent.id, json({ findings }))
  }

  await until($, 'three checkers', () => spawned.length === 3)
  // The first checker starts alone, so the others find its prompt in the cache.
  expect(log.slice(-4)).toEqual(['spawn review-gate:checker', 'sleep 8', 'spawn review-gate:checker', 'spawn review-gate:checker'])
  expect(spawned[0]?.prompt).toContain('C1. src/app.ts:12 (a line this branch changes; raised as bug, important, by 1 reviewer)')
  await reply($, spawned[0]?.id ?? '', json({ verdicts: [vote('C1', true), vote('C2', true)], earlier: [] }))
  await reply($, spawned[1]?.id ?? '', json({ verdicts: [vote('C1', true), vote('C2', false)], earlier: [] }))
  await reply($, spawned[2]?.id ?? '', 'I ran out of time.')

  const text = String((await call).result)
  expect(text.split('\n')[0]).toBe(
    'Review round 1 of feat/app at 1111111: the whole branch, standard depth (4 reviewers, 3 checkers), risk medium (src/app.ts changes how results are paged).',
  )
  expect(text).toContain('R1-1 · important · src/app.ts:12 · 2 of 2 checkers agree')
  expect(text).toContain('1 agent reply could not be read and counted for nothing.')
  expect(text).toMatch(/The round took \d+s · 11k tokens, 4k from the cache\./)
  expect(text.includes('reaches a shell')).toBe(false)

  const ledger = ledgerOf(store)
  expect(ledger.reviewed).toBe(ONE)
  expect(ledger.first).toBe(FIRST)
  expect(ledger.riskFor).toEqual({ sha: ONE, risk: { tier: 'medium', why: ['src/app.ts changes how results are paged'] } })
  expect(ledger.findings.map(one => [one.id, one.status, one.severity])).toEqual([['R1-1', 'open', 'important']])
  expect(ledger.rounds[0]?.tokens).toEqual({ input: 7001, output: 701, cached: 3500 })
})

test('the next round reads only the new commits, confirms a fix, and stops the checker it no longer needs', async ($, on) => {
  const repo = world({ head: TWO, history: [BASE, ONE, TWO], changes: { [ONE]: ['src/app.ts', 'README.md'], [TWO]: ['src/app.ts'] } })
  const { store, spawned, stops } = engine(on, repo)
  seed(store, { rounds: [round(1, ONE, 1)], findings: [finding({})], reviewed: ONE })
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
  // Two of three say it is fixed: the third could change nothing, and is stopped.
  for (const agent of spawned.slice(0, 2)) await reply($, agent.id, json({ verdicts: [], earlier: [{ id: 'R1-1', fixed: true, why: 'the bound is pages now' }] }))

  const text = String((await call).result)
  expect(stops).toEqual([spawned[2]?.id])
  expect(text.split('\n')[0]).toBe(
    'Review round 2 of feat/app at 2222222: the commits since 1111111, standard depth (4 reviewers, 3 checkers), risk medium (src/app.ts changes how results are paged).',
  )
  expect(text).toContain('Found fixed this round: R1-1 (The last page is skipped).')
  expect(text).toContain('Nothing is open. feat/app at 2222222 is ready for a pull request.')
  expect(text.includes('could not be read')).toBe(false)
  expect(ledgerOf(store).findings.map(one => [one.id, one.status, one.answer, one.closedRound])).toEqual([['R1-1', 'fixed', 'fixed at 2222222', 2]])
})

test("the classifier's verdict on the code sets the risk: high reads deeper, and a person approves the pull request", async ($, on) => {
  const repo = world({ risk: HIGH })
  const { store, spawned } = engine(on, repo)
  await start($)
  const call = $.tool.call({ tool: REVIEW, intent: 'Search the log.' })
  await until($, 'five reviewers', () => spawned.length === 5)
  expect(spawned.map(agent => agent.description).at(-1)).toBe('review: state and data')
  for (const agent of spawned.splice(0)) await reply($, agent.id, json({ findings: [] }))
  const text = String((await call).result)
  expect(text.split('\n')[0]).toBe(
    'Review round 1 of feat/app at 1111111: the whole branch, deep depth (5 reviewers, 3 checkers), risk high (src/app.ts builds a shell command from the query).',
  )
  expect(text).toContain('It is high risk, so the gate asks the user to approve it when the pull request is opened or merged.')
  expect(ledgerOf(store).rounds[0]?.risk).toEqual({ tier: 'high', why: ['src/app.ts builds a shell command from the query'] })
})

test('a classifier that gives no verdict is asked again, and then leaves the change to a person', async ($, on) => {
  const { store, spawned, judged } = engine(on, world({ risk: undefined }))
  await start($)
  const call = $.tool.call({ tool: REVIEW })
  await until($, 'five reviewers', () => spawned.length === 5)
  expect(judged.length).toBe(2)
  for (const agent of spawned.splice(0)) await reply($, agent.id, json({ findings: [] }))
  await call
  expect(ledgerOf(store).rounds[0]?.risk).toEqual({ tier: 'high', why: ['the classifier gave no verdict on its risk, so a person looks'] })
  expect(ledgerOf(store).riskFor).toBe(undefined)
})

test('a commit judged before keeps its verdict, and is not judged again', async ($, on) => {
  const { store, spawned, judged } = engine(on, world())
  seed(store, { riskFor: { sha: ONE, risk: { tier: 'low', why: ['it changes only docs'] } } })
  await start($)
  const call = $.tool.call({ tool: REVIEW })
  await until($, 'two reviewers', () => spawned.length === 2)
  expect(judged).toEqual([])
  for (const agent of spawned.splice(0)) await reply($, agent.id, json({ findings: [] }))
  expect(String((await call).result)).toContain('quick depth (2 reviewers, 1 checkers), risk low (it changes only docs)')
})

test('a round over new commits alone runs at most at standard depth, and rechecks every open finding', async ($, on) => {
  const repo = world({ risk: HIGH, head: TWO, history: [BASE, ONE, TWO], changes: { [ONE]: ['src/app.ts', 'src/other.ts'], [TWO]: ['src/app.ts'] } })
  const { store, spawned } = engine(on, repo)
  seed(store, {
    rounds: [round(1, ONE, 2, { depth: 'deep' })],
    findings: [finding({}), finding({ id: 'R1-2', file: 'src/other.ts', title: 'Pages overlap' })],
    reviewed: ONE,
  })
  await start($)
  const call = $.tool.call({ tool: REVIEW })
  await until($, 'four reviewers', () => spawned.length === 4)
  for (const agent of spawned.splice(0)) await reply($, agent.id, json({ findings: [] }))
  await until($, 'three checkers', () => spawned.length === 3)
  // A fix may sit in another file than the one a finding names, so both are looked at again.
  expect(spawned[0]?.prompt).toContain('R1-1. src/app.ts:12')
  expect(spawned[0]?.prompt).toContain('R1-2. src/other.ts:12')
  for (const agent of spawned.slice(0, 2)) await reply($, agent.id, json({ verdicts: [], earlier: [{ id: 'R1-1', fixed: true, why: '' }] }))
  await call
  expect(ledgerOf(store).findings.map(one => [one.id, one.status])).toEqual([
    ['R1-1', 'fixed'],
    ['R1-2', 'open'],
  ])
})

test('the last agent of a phase gets three minutes once the others have answered, then is stopped, and the round counts for nothing', async ($, on) => {
  const repo = world()
  const { store, spawned, stops } = engine(on, repo)
  await start($)
  const call = $.tool.call({ tool: REVIEW })
  let finished = false
  void call.then(() => {
    finished = true
  })
  await until($, 'four reviewers', () => spawned.length === 4)
  for (const agent of spawned.slice(0, 3)) await reply($, agent.id, json({ findings: [] }))
  // Ten seconds of clock a tick, until the round gives up on the fourth.
  await until($, 'the round to end', () => {
    repo.now += 10_000
    return finished
  })
  expect(stops).toEqual([spawned[3]?.id])
  const text = String((await call).result)
  expect(text).toContain('1 agent reply could not be read and counted for nothing.')
  expect(text).toContain('This round lost 1 of its agents, so it does not count as a review of 1111111: review again to cover what they missed.')
  expect(text.includes('ready for a pull request')).toBe(false)
  const ledger = ledgerOf(store)
  expect([ledger.reviewed, ledger.rounds[0]?.complete]).toEqual([undefined, false])
  expect(ledger.rounds[0]?.agents?.map(agent => [agent.label, agent.state])).toEqual([
    ['correctness', 'done'],
    ['failure paths', 'done'],
    ['fit', 'done'],
    ['security', 'unread'],
  ])
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
  const { store, spawned } = engine(on, world())
  seed(store, { rounds: [round(1, ONE, 1)], findings: [finding({})], reviewed: ONE })
  await start($)
  expect(String((await $.tool.call({ tool: REVIEW })).result)).toContain('This commit was reviewed already; nothing was run again.')
  expect(spawned).toEqual([])
})

test('after three rounds that leave findings open the model is refused another, until the person allows more', async ($, on) => {
  const repo = world({ head: TWO, history: [BASE, ONE, TWO], changes: { [ONE]: ['src/app.ts'], [TWO]: ['src/app.ts'] } })
  const { store } = engine(on, repo)
  seed(store, { rounds: [round(1, ONE, 2), round(2, ONE, 2), round(3, ONE, 1)], findings: [finding({})], reviewed: ONE })
  await start($)
  const refused = (await $.tool.call({ tool: REVIEW })).deny ?? ''
  expect(refused.startsWith('3 rounds in a row have ended with findings open (round 1 left 2 open, round 2 left 2 open, round 3 left 1 open)')).toBe(true)
  expect((await $.command.run({ command: 'review-gate', args: 'more', ...person, origin: { kind: 'sdk' } })).text).toBe(
    'Only the person at the keyboard can run /review-gate more.',
  )
  expect((await $.command.run({ command: 'review-gate', args: 'more', ...person })).text).toBe('feat/app may run 3 more rounds.')
  expect(ledgerOf(store).streakFrom).toBe(3)
})

test('a pull request opens through the tool only for a reviewed commit with nothing open, and pushes first', async ($, on) => {
  const { store, argvs } = engine(on, world())
  await start($)
  expect((await $.tool.call(open(' '))).deny).toBe('Give the pull request a title.')
  expect((await $.tool.call(open())).deny).toBe(
    'Review first: feat/app at 1111111 has not been reviewed. Call mcp__review-gate__review with what the change is for, answer each finding, then try again.',
  )
  seed(store, { rounds: [round(1, ONE, 1)], findings: [finding({})], reviewed: ONE })
  expect((await $.tool.call(open())).deny).toBe(
    'feat/app has 1 open review finding: R1-1 (src/app.ts:12 The last page is skipped). Fix each and commit, then call mcp__review-gate__review again; or dismiss it with mcp__review-gate__dismiss and a reason.',
  )
  const dismissed = await $.tool.call({ tool: DISMISS, ids: ['r1-1'], reason: 'The caller never passes the last page index.' })
  expect(dismissed.result).toBe('Dismissed R1-1: The caller never passes the last page index.\nNothing is open. feat/app at 1111111 is ready for a pull request.')
  expect(argvs.some(argv => argv[0] === 'gh')).toBe(false)
  expect((await $.tool.call(open())).result).toBe('Opened https://github.com/o/r/pull/7 for feat/app at 1111111.')
  expect(argvs.filter(argv => argv[0] === 'gh' || argv[1] === 'push')).toEqual([
    ['git', 'push', '-u', 'origin', `${ONE}:refs/heads/feat/app`],
    ['gh', 'pr', 'create', '--head', 'feat/app', '--base', 'main', '--title', 'Add search', '--body', 'Body text'],
  ])
})

test("a merge goes through only while the pull request's head is the reviewed commit", async ($, on) => {
  const repo = world()
  const { store, argvs } = engine(on, repo)
  seed(store, { rounds: [round(1, ONE, 0)], reviewed: ONE })
  await start($)
  expect((await $.tool.call({ tool: PULL_REQUEST, action: 'merge', number: 7, method: 'squash' })).result).toBe('Merged #7: feat/app at 1111111.')
  expect(argvs.at(-1)).toEqual(['gh', 'pr', 'merge', '7', '--squash', '--match-head-commit', ONE])
  repo.history.push(TWO)
  repo.head = TWO
  expect((await $.tool.call({ tool: PULL_REQUEST, action: 'merge' })).deny).toBe(
    'Review first: feat/app at 2222222 has not been reviewed (the last round covered 1111111). Call mcp__review-gate__review with what the change is for, answer each finding, then try again.',
  )
})

test('a high-risk change waits for the person, and their approval holds for that commit alone', async ($, on) => {
  const repo = world()
  const { store, asked } = engine(on, repo)
  const risk = { tier: 'high' as const, why: ['src/auth.ts decides who may sign in'] }
  seed(store, {
    rounds: [round(1, ONE, 0, { risk })],
    findings: [finding({ status: 'dismissed', answer: 'The caller never passes the last page index.' })],
    reviewed: ONE,
  })
  await start($)
  expect((await $.tool.call(open())).deny).toBe(
    'The user has not approved feat/app at 1111111, which needs a person: src/auth.ts decides who may sign in. Ask them what they want changed.',
  )
  expect(asked[0]).toBe(
    'The review of feat/app passed, and it needs your approval: src/auth.ts decides who may sign in. Dismissed findings: R1-1 The last page is skipped (The caller never passes the last page index.). Do you approve opening its pull request at 1111111?',
  )
  repo.answer = 'Approve'
  expect((await $.tool.call(open())).result).toBe('Opened https://github.com/o/r/pull/7 for feat/app at 1111111.')
  expect(ledgerOf(store).approved).toEqual({ sha: ONE, at: 1_000 })
  expect((await $.tool.call(open())).result).toBe('Opened https://github.com/o/r/pull/7 for feat/app at 1111111.')
  expect(asked.length).toBe(2)
})

test('a shell command that opens or merges a pull request is sent to the tool', async ($, on) => {
  engine(on, world())
  await start($)
  const refusal =
    "review-gate: open and merge pull requests with mcp__review-gate__pull_request, which checks the branch's review, then pushes and runs gh. If the command only mentions this in text, such as a commit message, put that text in a file and pass the file (git commit -F FILE)."
  const commands = [
    'gh pr create --fill',
    "bash -c 'gh pr merge 3'",
    'echo 3 | xargs gh pr merge',
    'cd ~/x && gh pr new',
    'gh pr \\\nmerge 3',
    'gh api -X PUT repos/o/r/pulls/3/merge',
  ]
  for (const command of commands) {
    expect({ command, deny: (await $.tool.call({ tool: 'Bash', command })).deny }).toEqual({ command, deny: refusal })
  }
  for (const command of ['gh pr view 3', 'gh api repos/o/r/pulls/3/comments']) {
    expect({ command, deny: (await $.tool.call({ tool: 'Bash', command })).deny }).toEqual({ command, deny: undefined })
  }
})

test("the review's agents read through their own tools, and have no shell", async ($, on) => {
  const repo = world({ agents: [{ id: 'agent-r', type: 'review-gate:reviewer' }, { id: 'agent-g', type: 'general-purpose' }] })
  const { argvs } = engine(on, repo)
  await start($)
  expect((await $.tool.call({ tool: GIT_TOOL, args: ['shortlog', '-s'], agentId: 'agent-r' })).result).toBe('git shortlog -s')
  await $.tool.call({ tool: GIT_TOOL, args: ['diff', 'a', 'b'], agentId: 'agent-r' })
  expect(argvs.at(-1)).toEqual(['git', '-c', 'core.quotePath=false', '--no-pager', 'diff', '--no-ext-diff', 'a', 'b'])
  expect((await $.tool.call({ tool: GIT_TOOL, args: ['commit', '-m', 'x'], agentId: 'agent-r' })).deny).toBe(
    'review-gate: git commit is not one that only reads.',
  )
  expect((await $.tool.call({ tool: GIT_TOOL, args: ['log'] })).deny).toBe("review_git is for review-gate's own reviewers and checkers.")
  expect((await $.tool.call({ tool: GIT_TOOL, args: ['log'], agentId: 'agent-g' })).deny).toBe("review_git is for review-gate's own reviewers and checkers.")

  expect((await $.tool.call({ tool: SEARCH_TOOL, pattern: 'token', path: 'src', agentId: 'agent-r' })).result).toBe('src/app.ts:12:const token = query')
  expect(argvs.at(-1)?.[0]).toBe('rg')
  repo.hasRg = false
  await $.tool.call({ tool: SEARCH_TOOL, pattern: 'token', agentId: 'agent-r' })
  expect(argvs.at(-1)?.slice(0, 5)).toEqual(['git', '-c', 'core.quotePath=false', '--no-pager', 'grep'])

  expect((await $.tool.call({ tool: 'Bash', command: 'git log', agentId: 'agent-r' })).deny).toBe(
    'review-gate: reviewers have no shell. Read files with Read, and use review_git and review_search.',
  )
  expect((await $.tool.call({ tool: 'Bash', command: 'git log', agentId: 'agent-g' })).deny).toBe(undefined)
})

test('a dismissal needs an open finding and a reason', async ($, on) => {
  const { store } = engine(on, world())
  seed(store, { rounds: [round(1, ONE, 1)], findings: [finding({}), finding({ id: 'R1-2', status: 'fixed' })], reviewed: ONE })
  await start($)
  const dismiss = (ids: string[], reason = 'The caller never passes the last page index.') => $.tool.call({ tool: DISMISS, ids, reason })
  expect((await dismiss(['R1-9'])).deny).toBe('feat/app has no finding R1-9.')
  expect((await dismiss(['R1-2'])).deny).toBe('R1-2 is not open.')
  expect((await dismiss(['R1-1'], 'wrong')).deny).toBe('Give the reason in a sentence: why the finding is wrong, or why the code is fine as it is.')
  expect(ledgerOf(store).findings[0]?.status).toBe('open')
})

test("a dismissal and the person's leave for more rounds, given while a round runs, stay when it records", async ($, on) => {
  const repo = world({ head: TWO, history: [BASE, ONE, TWO], changes: { [ONE]: ['src/app.ts'], [TWO]: ['src/app.ts'] } })
  const { store, spawned } = engine(on, repo)
  seed(store, { rounds: [round(1, ONE, 2)], findings: [finding({}), finding({ id: 'R1-2', line: 40, title: 'Pages overlap' })], reviewed: ONE })
  await start($)
  const call = $.tool.call({ tool: REVIEW })
  await until($, 'four reviewers', () => spawned.length === 4)
  expect((await $.tool.call({ tool: DISMISS, ids: ['R1-2'], reason: 'Each page starts where the last one ended.' })).result).toContain('Dismissed R1-2')
  expect((await $.command.run({ command: 'review-gate', args: 'more', ...person })).text).toBe('feat/app may run 3 more rounds.')
  for (const agent of spawned.splice(0)) await reply($, agent.id, json({ findings: [] }))
  await until($, 'three checkers', () => spawned.length === 3)
  // The checkers, who read the record as the round began, find both fixed; the dismissed one keeps its reason.
  const earlier = [
    { id: 'R1-1', fixed: true, why: 'the bound is pages now' },
    { id: 'R1-2', fixed: true, why: 'the pages no longer meet' },
  ]
  for (const agent of spawned.slice(0, 2)) await reply($, agent.id, json({ verdicts: [], earlier }))
  const text = String((await call).result)
  expect(text).toContain('Found fixed this round: R1-1 (The last page is skipped).')
  expect(text).toContain('Nothing is open. feat/app at 2222222 is ready for a pull request.')
  const ledger = ledgerOf(store)
  expect(ledger.findings.map(one => [one.id, one.status, one.answer, one.closedRound])).toEqual([
    ['R1-1', 'fixed', 'fixed at 2222222', 2],
    ['R1-2', 'dismissed', 'Each page starts where the last one ended.', undefined],
  ])
  expect([ledger.rounds.length, ledger.rounds[1]?.fixed, ledger.rounds[1]?.open, ledger.streakFrom, ledger.reviewed]).toEqual([2, 1, 0, 1, TWO])
})

test('a round whose record the person resets while it runs records nothing, so the record stays forgotten', async ($, on) => {
  const repo = world({ head: TWO, history: [BASE, ONE, TWO], changes: { [ONE]: ['src/app.ts'], [TWO]: ['src/app.ts'] } })
  const { store, spawned } = engine(on, repo)
  seed(store, { rounds: [round(1, ONE, 1)], findings: [finding({})], reviewed: ONE })
  await start($)
  const call = $.tool.call({ tool: REVIEW })
  await until($, 'four reviewers', () => spawned.length === 4)
  expect((await $.command.run({ command: 'review-gate', args: 'reset', ...person })).text).toContain("Forgot feat/app's review record")
  // The round leaves out what R1-1 already said, so recorded after the reset it would vouch with that defect unrecorded.
  for (const agent of spawned.splice(0)) await reply($, agent.id, json({ findings: agent.description === 'review: correctness' ? [SKIPPED_PAGE] : [] }))
  await until($, 'three checkers', () => spawned.length === 3)
  for (const agent of spawned.slice(0, 2)) await reply($, agent.id, json({ verdicts: [], earlier: [{ id: 'R1-1', fixed: false, why: 'still pages - 1' }] }))
  expect((await call).deny).toBe(
    "feat/app's review record was reset, or another session recorded a round on it, while this round ran, so this round was not recorded. Review again.",
  )
  expect(store.has(KEY)).toBe(false)
})

test('a record written as a file in the git folder vouches for nothing: only the plugin keeps records', async ($, on) => {
  const { store, files, argvs } = engine(on, world())
  files.set(`${ROOT}/.git/review-gate/feat%2Fapp.json`, JSON.stringify({ ...emptyLedger('feat/app'), rounds: [round(1, ONE, 0)], reviewed: ONE }))
  await start($)
  expect((await $.tool.call(open())).deny).toBe(
    'Review first: feat/app at 1111111 has not been reviewed. Call mcp__review-gate__review with what the change is for, answer each finding, then try again.',
  )
  expect(store.has(KEY)).toBe(false)
  expect(argvs.some(argv => argv[0] === 'gh' || argv[1] === 'push')).toBe(false)
})

test('a record begun by another branch of the same name reads as none, and records of deleted branches go', async ($, on) => {
  const { store } = engine(on, world())
  seed(store, { rounds: [round(1, ONE, 0)], reviewed: ONE, first: '2025-01-01T00:00:00Z someone@example.com' })
  store.set('record:/repo/.git/review-gate:feat/old', emptyLedger('feat/old'))
  await start($)
  expect([...store.keys()]).toEqual([KEY])
  expect((await $.tool.call(open())).deny).toBe(
    'Review first: feat/app at 1111111 has not been reviewed. Call mcp__review-gate__review with what the change is for, answer each finding, then try again.',
  )
})

test("a git read that fails ends the round with git's words, and nothing is recorded", async ($, on) => {
  const { store, spawned } = engine(on, world({ failDiff: true }))
  await start($)
  expect((await $.tool.call({ tool: REVIEW })).deny).toBe('git could not list the changed files: failed. Nothing was recorded.')
  expect(spawned).toEqual([])
  expect(store.has(KEY)).toBe(false)
})

test('REVIEW.md is read where the branch forked, its Skip files kept from the agents but not from the classifier', async ($, on) => {
  const repo = world({ guide: '# Rules\n\n## Skip\n- src/\n', changes: { [ONE]: ['src/app.ts', 'README.md'] } })
  const { spawned, judged, argvs } = engine(on, repo)
  await start($)
  const call = $.tool.call({ tool: REVIEW })
  await until($, 'four reviewers', () => spawned.length === 4)
  expect(argvs.some(argv => argv.includes('ls-tree') && argv.includes(BASE))).toBe(true)
  expect(argvs.filter(argv => argv[0] === 'git' && argv.includes('diff')).every(argv => argv.includes('--no-ext-diff'))).toBe(true)
  // A diff the plugin parses, or the agents copy paths from, begins its paths a/ and b/ whatever git's config says.
  const patches = argvs.filter(argv => argv.includes('-U0') || argv.includes('--unified=5'))
  expect([patches.length > 0, patches.every(argv => argv.includes('--src-prefix=a/') && argv.includes('--dst-prefix=b/'))]).toEqual([true, true])
  expect(judged[0]?.prompt).toContain('diff --git a/src/app.ts b/src/app.ts')
  expect(spawned[0]?.prompt).toContain('--- REVIEW.md')
  expect(spawned[0]?.prompt).toContain('diff --git a/README.md b/README.md')
  expect(spawned[0]?.prompt.includes('diff --git a/src/app.ts')).toBe(false)
  for (const agent of spawned.splice(0)) await reply($, agent.id, json({ findings: [] }))
  await call
})

test('a REVIEW.md the branch adds does not apply to its own review', async ($, on) => {
  const { spawned } = engine(on, world({ guide: '## Skip\n- src/\n', guideAt: ONE }))
  await start($)
  const call = $.tool.call({ tool: REVIEW })
  await until($, 'four reviewers', () => spawned.length === 4)
  expect(spawned[0]?.prompt.includes('REVIEW.md')).toBe(false)
  expect(spawned[0]?.prompt).toContain('diff --git a/src/app.ts b/src/app.ts')
  for (const agent of spawned.splice(0)) await reply($, agent.id, json({ findings: [] }))
  await call
})

test('a finding in a folder named b keeps its path, so its checkers see it on a line the branch changes', async ($, on) => {
  const { store, spawned } = engine(on, world({ changes: { [ONE]: ['b/util.ts'] } }))
  await start($)
  const call = $.tool.call({ tool: REVIEW })
  await until($, 'four reviewers', () => spawned.length === 4)
  for (const agent of spawned.splice(0)) {
    await reply($, agent.id, json({ findings: agent.description === 'review: correctness' ? [{ ...SKIPPED_PAGE, file: 'b/util.ts' }] : [] }))
  }
  await until($, 'three checkers', () => spawned.length === 3)
  expect(spawned[0]?.prompt).toContain('C1. b/util.ts:12 (a line this branch changes;')
  for (const agent of spawned.slice(0, 2)) await reply($, agent.id, json({ verdicts: [vote('C1', true)], earlier: [] }))
  await call
  expect(ledgerOf(store).findings.map(one => one.file)).toEqual(['b/util.ts'])
})

test("a review's row draws as a card of its findings and their cost, and the band says what is open", async ($, on) => {
  const { store } = engine(on, world())
  seed(store, {
    rounds: [round(1, ONE, 1, { durationMs: 252_000, tokens: { input: 150_000, output: 60_000, cached: 610_000 } })],
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
    expect(drawn).toContain('4m 12s · 820k tokens, 610k from the cache')
    expect(drawn).toContain('R1-1')
    expect(drawn).toContain('dismissed: run() quotes every argument.')
    expect(drawn).toContain('1 finding open.')
    await row.unmount()

    const output = await $.ui.mount({
      plugin: 'review-gate',
      surface,
      component: 'CommandOutput',
      requestId: 'msg_1',
      props: { command: 'review-gate', args: 'status', text: 'review-gate: Review round 1 of feat/app at 1111111: the whole branch.', isErrored: false },
    })
    expect((await output.findAll({ type: 'Text' })).map(text => text.text).join('\n')).toContain('The last page is skipped')
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

test('while a round runs, its state names each agent of the phase, and what each reviewer raised', async ($, on) => {
  const repo = world()
  // A drawing waits for the round in the test kit, so the round is read as the plugin writes it.
  const runs: (Run | null)[] = []
  on('state.set', (_, e, next) => {
    // A shaped value is written with its shape tag around it.
    if (e.plugin === 'review-gate' && e.key === 'run') runs.push((e.value as unknown as { value?: Run | null }).value ?? null)
    return next(e)
  })
  const { spawned } = engine(on, repo)
  await start($)
  const call = $.tool.call({ tool: REVIEW })
  await until($, 'four reviewers', () => spawned.length === 4)
  const live = async () => runs.at(-1)
  expect((await live())?.agents.map(agent => [agent.label, agent.state])).toEqual([
    ['correctness', 'running'],
    ['failure paths', 'running'],
    ['fit', 'running'],
    ['security', 'running'],
  ])
  await reply($, spawned[0]?.id ?? '', json({ findings: [SKIPPED_PAGE] }))
  for (let tries = 0; tries < 200 && (await live())?.agents[0]?.state !== 'done'; tries++) await tick($)
  const raised = await live()
  expect([raised?.phase, raised?.raised, raised?.agents[0]?.state, raised?.agents[0]?.raised]).toEqual(['reviewing', ['The last page is skipped'], 'done', 1])
  for (const agent of spawned.slice(1)) await reply($, agent.id, json({ findings: [] }))
  await until($, 'three checkers', () => spawned.length === 7)
  for (const agent of spawned.slice(4, 6)) await reply($, agent.id, json({ verdicts: [vote('C1', true)], earlier: [] }))
  await call
  expect(await live()).toBe(null)
})

test('the live band draws each agent with its time, calls and latest action, and a watch button for a running one', async ($, on) => {
  const run: Run = {
    round: 3,
    phase: 'reviewing',
    startedAt: 0,
    agents: [
      { id: 'a1', label: 'correctness', state: 'done', startedAt: 0, endedAt: 242_000, raised: 2 },
      { id: 'a2', label: 'failure paths', state: 'running', startedAt: 0 },
    ],
    raised: ['git grep cannot search one file', 'the push sends a commit made after the review'],
  }
  const doing = new Map<string, Activity | null>([
    ['a1', { calls: 31, doing: 'searching "token"' }],
    ['a2', { calls: 44, doing: 'reading hooks/review.ts' }],
  ])
  on('ui.render', ($, e) => liveBand($, e, run, doing, 370_000))
  const props = { hasSurvey: false, isWorking: true, maxRows: 12, bodyColumns: 160, scroll: { offset: 0, bodyRows: 12 }, view: {} }
  const band = await $.ui.mount({ plugin: 'review-gate', surface: 'terminal', component: 'AbovePrompt', requestId: 'band', props })
  const drawn = (await band.findAll({ type: 'Text' })).map(text => text.text).join('\n')
  expect(drawn).toContain('round 3 · reviewing 1 of 2 · 6m 10s')
  expect(drawn).toContain('correctness    ')
  expect(drawn).toContain('4m 02s · 31 calls · raised 2')
  expect(drawn).toContain('6m 10s · 44 calls · reading hooks/review.ts')
  expect(drawn).toContain('raised so far: git grep cannot search one file · the push sends a commit made after the review')
  // Only the running agent has a button; pressing it opens that agent's transcript.
  expect((await band.findAll({ type: 'Button' })).map(button => button.key)).toEqual(['watch-a2'])
  await band.unmount()
})
