import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { Finding, Ledger, Round, Run } from '../types'
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
const RECORD = 'mcp__review-gate__record'
const DISMISS = 'mcp__review-gate__dismiss'
const PULL_REQUEST = 'mcp__review-gate__pull_request'

const MEDIUM = '```json\n{"tier": "medium", "why": ["src/app.ts changes how results are paged"]}\n```'
const HIGH = '```json\n{"tier": "high", "why": ["src/app.ts builds a shell command from the query"]}\n```'

/** What /code-review's own prompt says, as the engine expands it before any plugin adds to it. */
const SKILL_TEXT = 'Review target: `feat/app`\n\n`high effort → 8 inline angles → dedup (no verify) → ≤10 findings`\n\nReturn findings as a JSON array of at most 10 objects.'

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
  agents?: { id: string; type: string; description?: string; spawnedBy?: string; parentId?: string }[]
  /** What the person picks when the gate asks. */
  answer?: string
  /** The risk classifier's reply; undefined for no answer at all. */
  risk?: string
  /** /code-review's own prompt; left out, SKILL_TEXT. */
  skillText?: string
  /** Why the Skill tool refuses to run /code-review; left out, it runs. */
  skillDeny?: string
  /** Whether the Skill tool starts /code-review in the background, as an interactive session may. */
  background?: boolean
  /** The repository's local branches. */
  branches?: string[]
  /** Whether git fails to list the changed files. */
  failDiff?: boolean
  /** The clock, which the test moves. */
  now: number
  /** Files git does not track. */
  untracked?: string[]
  /** Where the skill named code-review comes from; left out, Claude Code itself. */
  skillSource?: string
  /** How the Skill tool answers instead of the review's result: an error, or a fork that did not succeed. */
  skillFails?: 'error' | 'unsuccessful'
  /** Whether the sleep program cannot run. */
  noSleep?: boolean
  /** Holds the risk classifier's reply until it settles. */
  holdRisk?: Promise<void>
}

/** A run of /code-review the round started: what it was asked, and the hand that ends it. */
type Review = { id: string; args: string; prompt: string; token: string; finish: (answer: string) => void }

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

// An engine under the plugin: a git that answers from the world, the plugin's store in memory, a gh
// stand-in, and a /code-review whose prompt the engine expands through the plugins' hooks and whose
// agent works until the test answers for it.
function engine(on: On, repo: World) {
  const store = new Map<string, unknown>()
  const files = new Map<string, string>()
  const reviews: Review[] = []
  const asked: string[] = []
  // The agents stopped.
  const stops: string[] = []
  // What the risk classifier was asked, and every program run, by its argv.
  const judged: { model: string; prompt: string; cached: boolean }[] = []
  const argvs: string[][] = []
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
    if (sub === 'status') {
      const fresh = rest.includes('--untracked-files=no') ? [] : (repo.untracked ?? [])
      return ran(0, [...repo.dirty.map(path => ` M ${path}\0`), ...fresh.map(path => `?? ${path}\0`)].join(''))
    }
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
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  // The session's agents: the test's own, and each /code-review the plugin started, as the engine lists a forked skill.
  on('agent.list', () => ({
    value: [
      ...(repo.agents ?? []).map(agent => ({ ...agent, description: agent.description ?? 'an agent', status: 'running' as const })),
      ...reviews.map(review => ({ id: review.id, type: 'general-purpose', description: '/code-review', status: 'running' as const, spawnedBy: 'review-gate' })),
    ],
  }))
  // A skill's prompt as the engine computes it, before any plugin adds to it.
  on('skill.prompt', (_, e) => ({ text: e.text }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  // The engine's own verdict on a tool call, beneath the plugin's: every call may run.
  on('tool.check', () => ({ decision: 'allow' as const }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('model.complete', async (_, e) => {
    judged.push({ model: e.model, prompt: e.prompt, cached: e.promptBlocks?.some(block => block.cache === true) === true })
    if (repo.holdRisk !== undefined) await repo.holdRisk
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
    // A sleep takes a moment, so a wait is no busy loop, and moves the clock a tenth of its length.
    if (argv[0] === 'sleep') {
      if (repo.noSleep === true) return ran(127)
      await new Promise<void>(resolve => setTimeout(resolve, 1))
      repo.now += Number(argv[1]) * 100
    }
    return ran(0)
  })
  on('tool.call', async (_, e) => {
    if (e.tool === 'Skill') {
      const call = e as unknown as { skill: string; args?: string }
      if (repo.skillDeny !== undefined) return { deny: repo.skillDeny }
      // The engine expands the skill's prompt, through the plugins' hooks, for the agent it forks: a
      // call a hook's own $ does not carry, so the test's engine makes it.
      const { text } = await (session as Engine).skill.prompt({ skill: call.skill, text: repo.skillText ?? SKILL_TEXT, ...(repo.skillSource === undefined ? {} : { source: repo.skillSource }) })
      let finish: (answer: string) => void = () => undefined
      const answered = new Promise<string>(resolve => {
        finish = resolve
      })
      const id = `review-${reviews.length + 1}`
      reviews.push({ id, args: call.args ?? '', prompt: text, token: /- round: "([^"]+)"/.exec(text)?.[1] ?? '', finish })
      // In the background the call answers at once with word of the start, and the agent's reply comes later.
      if (repo.background === true) {
        const isStarted = repo.skillFails !== 'unsuccessful'
        return { result: { success: isStarted, commandName: call.skill, status: 'forked', agentId: id, result: isStarted ? 'Started in the background.' : 'could not start: no model', background: true } } as never
      }
      const result = await answered
      // A call that fails once the review has recorded, as an error after it does.
      if (repo.skillFails === 'error') return { deny: 'API error while it wrote its answer' }
      return { result: { success: true, commandName: call.skill, status: 'forked', agentId: id, result } } as never
    }
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
  return { store, files, reviews, asked, judged, argvs, stops }
}

// The test's engine, for the calls only it makes.
let session: Engine | undefined

function start($: Engine) {
  session = $
  return $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
}

const ledgerOf = (store: Map<string, unknown>) => store.get(KEY) as Ledger

const round = (n: number, head: string, open: number, over: Partial<Round> = {}): Round => ({
  n,
  head,
  from: BASE,
  scope: 'full',
  level: 'high',
  risk: { tier: 'medium', why: [] },
  raised: open,
  kept: open,
  fixed: 0,
  open,
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
  scenario: 'pages=3: page 3 never loads',
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

const reply = ($: Engine, agentId: string, answer: string) =>
  $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: `turn-${agentId}`, agentId, reason: 'answer', usage: USAGE })

type Act = { findings?: unknown[]; rechecked?: unknown[]; answer?: string; record?: boolean; between?: () => void }

// The review's part, once the round has started it: it records what it found, replies, and the
// Skill tool hands back its result.
async function act($: Engine, reviews: Review[], at: number, { findings = [], rechecked = [], answer = 'Done.', record = true, between }: Act = {}) {
  await until($, 'the review', () => reviews.length > at)
  const one = reviews[at] as Review
  const recorded = record ? await $.tool.call({ tool: RECORD, agentId: one.id, round: one.token, findings, rechecked }) : undefined
  // What happens once the review has recorded, before it answers: its fixes, or someone else's edit.
  between?.()
  await reply($, one.id, answer)
  one.finish(answer)
  return { one, recorded: String(recorded?.result ?? recorded?.deny ?? '') }
}

const SKIPPED_PAGE = {
  file: 'src/app.ts',
  line: 12,
  summary: 'The loop stops one page early, so the last page of results never loads.',
  short_summary: 'The last page is skipped',
  failure_scenario: 'pages=3: the loop runs i=0,1 and page 3 never loads',
  category: 'correctness',
}

const OVERLAP = {
  file: 'src/app.ts',
  line: 50,
  summary: 'Two pages share their last row.',
  short_summary: 'Pages overlap',
  failure_scenario: 'page 1 ends at row 20 and page 2 starts at row 20',
  category: 'correctness',
}

const SHELL = {
  file: 'src/app.ts',
  line: 30,
  summary: 'search() passes the query to sh -c unquoted.',
  short_summary: 'The query string reaches a shell',
  failure_scenario: 'a query of `x; rm -rf ~` runs rm',
  category: 'security',
  security: true,
}

const open = (title = 'Add search') => ({ tool: PULL_REQUEST, action: 'open', title, body: 'Body text' }) as const

// A command the person typed.
const person = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }

test('a round runs /code-review over the whole branch at the level its risk picks, and records what the review hands back, with its cost', async ($, on) => {
  const { store, reviews, judged } = engine(on, world())
  await start($)
  const call = $.tool.call({ tool: REVIEW, intent: 'Page through search results.' })
  const { one, recorded } = await act($, reviews, 0, { findings: [SKIPPED_PAGE, SHELL] })
  // The risk check runs on its own model, Haiku unless the options say otherwise, its prompt marked for the cache.
  expect(judged.map(asked => [asked.model, asked.cached])).toEqual([['haiku', true]])
  expect(judged[0]?.prompt).toContain('Judge the change on branch feat/app at commit 1111111: everything it would merge.')
  expect(one.args).toBe(`high ${BASE}..${ONE}`)
  expect(one.prompt.startsWith(`${SKILL_TEXT}\n\n## review-gate: round 1 of feat/app`)).toBe(true)
  expect(one.prompt).toContain(`- Review the whole branch, as its pull request will show it: \`git diff ${BASE} ${ONE}\`.`)
  expect(one.prompt).toContain('- The repository is at `/repo`, its working tree at 1111111: run git and read files there. Change no file.')
  expect(one.prompt).toContain('- What the author says the change is for: Page through search results.')
  expect(recorded).toBe(
    'Recorded round 1: R1-1 src/app.ts:30 The query string reaches a shell; R1-2 src/app.ts:12 The last page is skipped. Finish as your instructions say.',
  )

  const text = String((await call).result)
  expect(text.split('\n')[0]).toBe(
    'Review round 1 of feat/app at 1111111: the whole branch, /code-review high, risk high (src/app.ts changes how results are paged; it has security finding R1-1 not fixed).',
  )
  expect(text).toContain(
    'R1-1 · important security · src/app.ts:30 · security\n  The query string reaches a shell\n  search() passes the query to sh -c unquoted.\n  When: a query of `x; rm -rf ~` runs rm',
  )
  expect(text).toMatch(/The round took \d+s · 2k tokens, 500 from the cache, and the review made 1 tool call\./)

  const ledger = ledgerOf(store)
  expect([ledger.reviewed, ledger.first]).toEqual([ONE, FIRST])
  expect(ledger.riskFor).toEqual({ sha: ONE, risk: { tier: 'medium', why: ['src/app.ts changes how results are paged'] } })
  expect(ledger.findings.map(one => [one.id, one.status, one.severity, one.kind])).toEqual([
    ['R1-1', 'open', 'important', 'security'],
    ['R1-2', 'open', 'important', 'bug'],
  ])
  const first = ledger.rounds[0]
  expect([first?.level, first?.scope, first?.raised, first?.kept, first?.cap, first?.calls, first?.tokens]).toEqual([
    'high',
    'full',
    2,
    2,
    10,
    1,
    { input: 1001, output: 101, cached: 500 },
  ])
})

test('the next round reads only the new commits, closes what the review finds fixed, and never raises a finding twice', async ($, on) => {
  const repo = world({ head: TWO, history: [BASE, ONE, TWO], changes: { [ONE]: ['src/app.ts', 'README.md'], [TWO]: ['src/app.ts'] } })
  const { store, reviews } = engine(on, repo)
  seed(store, { rounds: [round(1, ONE, 1)], findings: [finding({})], reviewed: ONE })
  await start($)
  const call = $.tool.call({ tool: REVIEW })
  const { one, recorded } = await act($, reviews, 0, { findings: [SKIPPED_PAGE], rechecked: [{ id: 'R1-1', fixed: true, why: 'the bound is pages now' }] })
  expect(one.args).toBe(`high ${ONE}..${TWO}`)
  expect(one.prompt).toContain(`- Review only the commits since 1111111, which round 1 reviewed: \`git diff ${ONE} ${TWO}\`.`)
  expect(one.prompt).toContain('- R1-1 [open] src/app.ts:12 The last page is skipped')
  expect(one.prompt).toContain('- R1-1 src/app.ts:12 The last page is skipped. The loop stops one page early.')
  expect(recorded).toBe('Recorded round 2: no new findings. Left out: 1 the branch has had before. Finish as your instructions say.')

  const text = String((await call).result)
  expect(text.split('\n')[0]).toBe(
    'Review round 2 of feat/app at 2222222: the commits since 1111111, /code-review high, risk medium (src/app.ts changes how results are paged).',
  )
  expect(text).toContain('Found fixed this round: R1-1 (The last page is skipped).')
  expect(text).toContain('1 finding the review reported was on the record already, so it was not raised again.')
  expect(text).toContain('Nothing is open. feat/app at 2222222 is ready for a pull request.')
  expect(ledgerOf(store).findings.map(one => [one.id, one.status, one.answer, one.closedRound])).toEqual([['R1-1', 'fixed', 'fixed at 2222222', 2]])
})

test("the classifier's verdict on the code sets the level: high risk reads at xhigh, and a person approves the pull request", async ($, on) => {
  const { store, reviews } = engine(on, world({ risk: HIGH }))
  await start($)
  const call = $.tool.call({ tool: REVIEW, intent: 'Search the log.' })
  const { one } = await act($, reviews, 0)
  expect(one.args).toBe(`xhigh ${BASE}..${ONE}`)
  const text = String((await call).result)
  expect(text.split('\n')[0]).toBe(
    'Review round 1 of feat/app at 1111111: the whole branch, /code-review xhigh, risk high (src/app.ts builds a shell command from the query).',
  )
  expect(text).toContain('It is high risk, so the gate asks the user to approve it when the pull request is opened or merged.')
  expect(ledgerOf(store).rounds[0]?.risk).toEqual({ tier: 'high', why: ['src/app.ts builds a shell command from the query'] })
})

test('a classifier that gives no verdict is asked again, and then leaves the change to a person', async ($, on) => {
  const { store, reviews, judged } = engine(on, world({ risk: undefined }))
  await start($)
  const call = $.tool.call({ tool: REVIEW })
  const { one } = await act($, reviews, 0)
  expect([judged.length, one.args.split(' ')[0]]).toEqual([2, 'xhigh'])
  await call
  expect(ledgerOf(store).rounds[0]?.risk).toEqual({ tier: 'high', why: ['the classifier gave no verdict on its risk, so a person looks'] })
  expect(ledgerOf(store).riskFor).toBe(undefined)
})

test('a commit judged before keeps its verdict, and is not judged again', async ($, on) => {
  const { store, reviews, judged } = engine(on, world())
  seed(store, { riskFor: { sha: ONE, risk: { tier: 'low', why: ['it changes only docs'] } } })
  await start($)
  const call = $.tool.call({ tool: REVIEW })
  await act($, reviews, 0)
  expect(judged).toEqual([])
  expect(String((await call).result)).toContain('/code-review medium, risk low (it changes only docs)')
})

test('a round over new commits alone runs at most at high, and looks again at every open finding', async ($, on) => {
  const repo = world({ risk: HIGH, head: TWO, history: [BASE, ONE, TWO], changes: { [ONE]: ['src/app.ts', 'src/other.ts'], [TWO]: ['src/app.ts'] } })
  const { store, reviews } = engine(on, repo)
  seed(store, {
    rounds: [round(1, ONE, 2, { level: 'xhigh' })],
    findings: [finding({}), finding({ id: 'R1-2', file: 'src/other.ts', title: 'Pages overlap', detail: '' })],
    reviewed: ONE,
  })
  await start($)
  const call = $.tool.call({ tool: REVIEW })
  // A fix may sit in another file than the one a finding names, so both are looked at again.
  const { one } = await act($, reviews, 0, { rechecked: [{ id: 'R1-1', fixed: true, why: '' }, { id: 'R1-2', fixed: false, why: 'still overlaps' }] })
  expect(one.args).toBe(`high ${ONE}..${TWO}`)
  expect(one.prompt).toContain('- R1-1 src/app.ts:12 The last page is skipped. The loop stops one page early.')
  expect(one.prompt).toContain('- R1-2 src/other.ts:12 Pages overlap\n')
  await call
  expect(ledgerOf(store).findings.map(one => [one.id, one.status])).toEqual([
    ['R1-1', 'fixed'],
    ['R1-2', 'open'],
  ])
})

test("a level the call or the person names wins, max is the person's alone, and --fix and --max-findings reach /code-review", async ($, on) => {
  const repo = world()
  const { reviews } = engine(on, repo)
  await start($)
  const first = $.tool.call({ tool: REVIEW, level: 'xhigh' })
  expect((await act($, reviews, 0)).one.args).toBe(`xhigh ${BASE}..${ONE}`)
  await first

  repo.history.push(TWO)
  repo.head = TWO
  repo.changes[TWO] = ['src/app.ts']
  const second = $.tool.call({ tool: REVIEW, level: 'max' })
  expect((await act($, reviews, 1)).one.args).toBe(`high ${ONE}..${TWO}`)
  await second

  // The person's run reviews the commit again, over the whole branch.
  const third = $.command.run({ command: 'review-gate', args: 'max --fix --max-findings all', ...person })
  const { one } = await act($, reviews, 2)
  expect(one.args).toBe(`max ${BASE}..${TWO} --fix --max-findings all`)
  expect(one.prompt).toContain('before you change any file or write your answer, call the mcp__review-gate__record tool once')
  expect(one.prompt.includes('Change no file.')).toBe(false)
  expect((await third).text).toContain('Review round 3 of feat/app at 2222222: the whole branch, /code-review max')

  const run = (args: string) => $.command.run({ command: 'review-gate', args, ...person }).then(answer => answer.text)
  expect(await run('123')).toBe(
    "review-gate reviews the branch checked out, so 123 is not a target: check out the pull request's branch (gh pr checkout 123) and run /review-gate there.",
  )
  expect(await run('high --comment')).toBe(
    'review-gate does not pass --comment: its review runs before the pull request is opened. Run /code-review --comment on the pull request for that.',
  )
  expect(await run('deep')).toContain('deep is not something /review-gate takes.')
  expect(reviews.length).toBe(3)
})

test("with --fix, a review that does not say what it fixed has its report quoted, and each finding stays open for the next round", async ($, on) => {
  const repo = world()
  const { store, reviews } = engine(on, repo)
  await start($)
  const call = $.tool.call({ tool: REVIEW, fix: true })
  // The review's fix, once it has recorded its findings.
  const { one } = await act($, reviews, 0, {
    findings: [SKIPPED_PAGE],
    answer: 'Fixed R1-1: the loop now runs to pages.',
    between: () => {
      repo.dirty = ['src/app.ts']
    },
  })
  expect(one.args).toBe(`high ${BASE}..${ONE} --fix`)
  const text = String((await call).result)
  expect(text).toContain(
    'Files changed while the round ran: src/app.ts. The review did not say which findings it fixed. Its report:\n\nFixed R1-1: the loop now runs to pages.\n\nCommit the fixes you keep and review again: the next round confirms each fix.',
  )
  expect(ledgerOf(store).findings.map(one => [one.id, one.status, one.fix])).toEqual([['R1-1', 'open', undefined]])
})

test('with --fix, the review records what it fixed, and the round shows those fixes apart from the findings left to answer', async ($, on) => {
  const repo = world()
  const { store, reviews } = engine(on, repo)
  await start($)
  const call = $.tool.call({ tool: REVIEW, fix: true })
  await until($, 'the review', () => reviews.length === 1)
  const one = reviews[0] as Review
  expect(one.prompt).toContain(`call ${RECORD} a second time`)
  // Fixes come after the findings, in a second call, once.
  expect(String((await $.tool.call({ tool: RECORD, agentId: one.id, round: one.token, fixes: [] })).deny)).toBe('Record the findings first, then the fixes in a second call.')
  const first = await $.tool.call({ tool: RECORD, agentId: one.id, round: one.token, findings: [SKIPPED_PAGE, OVERLAP] })
  expect(String(first.result)).toContain('Now fix them, then record the fixes as your instructions say.')
  repo.dirty = ['src/app.ts']
  expect(String((await $.tool.call({ tool: RECORD, agentId: one.id, round: one.token, fixes: [{ id: 'R9-9', applied: true }] })).deny)).toContain('has no open finding R9-9')
  const second = await $.tool.call({
    tool: RECORD,
    agentId: one.id,
    round: one.token,
    fixes: [
      { id: 'r1-1', applied: true, why: 'the loop runs to pages' },
      { id: 'R1-2', applied: false, why: 'the overlap is what the API returns' },
    ],
  })
  expect(String(second.result)).toBe('Recorded 1 fix in the working tree. End with two or three sentences: review-gate shows the findings and fixes itself.')
  expect(String((await $.tool.call({ tool: RECORD, agentId: one.id, round: one.token, fixes: [] })).deny)).toContain('recorded already')
  const report = 'Fixed one, left one. ```json\n[{"file": "src/app.ts"}]\n```'
  await reply($, one.id, report)
  one.finish(report)
  const text = String((await call).result)
  expect(text).toContain(
    'The review fixed 1 of the 2 open findings. Each stays open until a round confirms its fix: commit the fixes you keep, then review again.\n\nR1-1 · src/app.ts:12\n  The last page is skipped\n  Fixed: the loop runs to pages',
  )
  expect(text).toContain('The other 1 needs your answer.')
  expect(text).toContain('  The review left it: the overlap is what the API returns')
  expect(text).toContain('Files changed while the round ran, in the working tree and not committed: src/app.ts.')
  // The raw report is the review's own, and the round has said all it holds.
  expect(text.includes('```json')).toBe(false)
  expect(ledgerOf(store).findings.map(one => [one.id, one.status, one.fix?.applied])).toEqual([
    ['R1-1', 'open', true],
    ['R1-2', 'open', false],
  ])

  // The next round looks again: what it finds fixed closes, and the word of round 1's --fix goes.
  repo.dirty = []
  repo.history = [BASE, ONE, TWO]
  repo.changes[TWO] = ['src/app.ts']
  repo.head = TWO
  const again = $.tool.call({ tool: REVIEW })
  await act($, reviews, 1, { rechecked: [{ id: 'R1-1', fixed: true, why: 'fixed' }, { id: 'R1-2', fixed: false, why: 'still there' }] })
  await again
  expect(ledgerOf(store).findings.map(one => [one.id, one.status, one.fix])).toEqual([
    ['R1-1', 'fixed', undefined],
    ['R1-2', 'open', undefined],
  ])
})

test("a review's task notification is kept out of the conversation, and others pass", async ($, on) => {
  const { reviews } = engine(on, world({ background: true }))
  await start($)
  const call = $.tool.call({ tool: REVIEW })
  const { one } = await act($, reviews, 0)
  await call
  const notice = (id: string) => $.prompt.submit({ text: `<task-notification><task-id>${id}</task-id><result>[raw]</result></task-notification>`, wait: false, origin: { kind: 'task-notification' } })
  expect(await notice(one.id)).toEqual({ drop: "review-gate: the review finished; the round's result has its findings." })
  expect((await notice('other-agent')).text).toContain('<task-id>other-agent</task-id>')
  expect((await $.prompt.submit({ text: `about ${one.id}`, wait: false, origin: { kind: 'composer' } })).text).toBe(`about ${one.id}`)
})

test('a --fix round where no file changed says so; a round where files change before the record, or without --fix at all, records nothing', async ($, on) => {
  const repo = world()
  const { store, reviews } = engine(on, repo)
  await start($)
  const fixing = $.tool.call({ tool: REVIEW, fix: true })
  await act($, reviews, 0, { answer: '[]' })
  expect(String((await fixing).result)).toContain('No file changed while the round ran, though --fix let the review change files. Its report:\n\n[]')
  const rounds = () => ledgerOf(store).rounds.length

  // Someone edits a file while the review reads, before it records: the record is refused.
  const early = $.command.run({ command: 'review-gate', args: '--fix', ...person })
  await until($, 'the second review', () => reviews.length === 2)
  repo.dirty = ['src/app.ts']
  const { recorded } = await act($, reviews, 1)
  expect(recorded).toBe(
    'Files changed while the round ran: src/app.ts. The review may have read them, so nothing was recorded. Commit or undo them, then review again. Finish without recording.',
  )
  expect((await early).text).toBe(
    'Files changed while the round ran: src/app.ts. The review may have read them, so nothing was recorded. Commit or undo them, then review again.',
  )

  // Without --fix the review only reads, so a file changed by the end was changed by someone else.
  repo.dirty = []
  const late = $.command.run({ command: 'review-gate', args: '', ...person })
  await act($, reviews, 2, {
    between: () => {
      repo.dirty = ['src/app.ts']
    },
  })
  expect((await late).text).toBe(
    'Files changed while the round ran: src/app.ts. The review may have read them, so nothing was recorded. Commit or undo them, then review again.',
  )
  expect(rounds()).toBe(1)
})

test('while a round runs, no agent answers a finding or opens a pull request', async ($, on) => {
  const { store, reviews } = engine(on, world())
  seed(store, { rounds: [round(1, BASE, 1)], findings: [finding({})], reviewed: BASE })
  await start($)
  const call = $.tool.call({ tool: REVIEW })
  await until($, 'the review', () => reviews.length === 1)
  const agentId = (reviews[0] as Review).id
  expect(String((await $.tool.call({ tool: DISMISS, agentId, ids: ['R1-1'], reason: 'The review thinks it is fine as it is.' })).deny)).toContain(
    'findings are answered from the main conversation',
  )
  expect(String((await $.tool.call({ tool: PULL_REQUEST, agentId, action: 'open', title: 'App' })).deny)).toContain('pull requests are opened and merged from the main conversation')
  await act($, reviews, 0)
  await call
  expect(ledgerOf(store).findings.map(one => one.status)).toEqual(['open'])
})

test('a review the Skill tool starts in the background is waited for, and the band follows it from its start', async ($, on) => {
  const runs: (Run | null)[] = []
  on('state.set', (_, e, next) => {
    // A shaped value is written with its shape tag around it.
    if (e.plugin === 'review-gate' && e.key === 'run') runs.push((e.value as unknown as { value?: Run | null }).value ?? null)
    return next(e)
  })
  const { store, reviews, stops } = engine(on, world({ background: true }))
  await start($)
  const call = $.tool.call({ tool: REVIEW })
  await until($, 'the review', () => reviews.length === 1)
  const one = reviews[0] as Review
  await until($, 'the band to name the review', () => runs.at(-1)?.agentId === one.id)
  await $.tool.call({ tool: RECORD, agentId: one.id, round: one.token, findings: [SKIPPED_PAGE] })
  await reply($, one.id, 'Done.')
  const text = String((await call).result)
  expect(text).toContain('R1-1 · important · src/app.ts:12 · correctness')
  expect(stops).toEqual([])
  expect(ledgerOf(store).rounds[0]?.tokens).toEqual({ input: 1001, output: 101, cached: 500 })
})

test('a review in the background that has not answered after thirty minutes is stopped, and what it recorded stands', async ($, on) => {
  const repo = world({ background: true })
  const { store, reviews, stops } = engine(on, repo)
  await start($)
  const call = $.tool.call({ tool: REVIEW, fix: true })
  await until($, 'the review', () => reviews.length === 1)
  const one = reviews[0] as Review
  await $.tool.call({ tool: RECORD, agentId: one.id, round: one.token, findings: [SKIPPED_PAGE] })
  let finished = false
  void call.then(() => {
    finished = true
  })
  // A minute of clock a tick, and no reply.
  await until($, 'the round to end', () => {
    repo.now += 60_000
    return finished
  })
  expect(stops).toEqual([one.id])
  const text = String((await call).result)
  expect(text).toContain('The review had not finished after 30 minutes, so it was stopped; it had recorded its findings before that.')
  // Word of the start is no report of fixes.
  expect(text.includes('Its report')).toBe(false)
  expect(ledgerOf(store).findings.map(finding => [finding.id, finding.status])).toEqual([['R1-1', 'open']])
})

test('a review that records nothing, or cannot run, leaves no round', async ($, on) => {
  const repo = world()
  const { store, reviews } = engine(on, repo)
  await start($)
  const call = $.tool.call({ tool: REVIEW })
  await act($, reviews, 0, { record: false })
  expect((await call).deny).toBe(
    '/code-review ended without recording its findings, so the round has nothing to stand on. Nothing was recorded; review again.',
  )
  repo.skillDeny = 'Skill code-review is not available'
  expect((await $.tool.call({ tool: REVIEW })).deny).toBe('/code-review could not run: Skill code-review is not available. Nothing was recorded.')
  expect(store.has(KEY)).toBe(false)
})

test("the record takes findings only from the round's own review, naming its round, once", async ($, on) => {
  const { reviews } = engine(on, world())
  await start($)
  const refusal = "record takes the findings of review-gate's own review round, from its review, with the round its instructions name."
  expect((await $.tool.call({ tool: RECORD, round: 'x', findings: [] })).deny).toBe(refusal)
  const call = $.tool.call({ tool: REVIEW })
  await until($, 'the review', () => reviews.length === 1)
  const one = reviews[0] as Review
  const record = (input: Record<string, unknown>) => $.tool.call({ tool: RECORD, round: one.token, findings: [], ...input })
  expect((await record({})).deny).toBe(refusal)
  expect((await record({ round: 'a-guess', agentId: one.id })).deny).toBe(refusal)
  expect((await record({ findings: 'none', agentId: one.id })).deny).toBe('Give findings as a list, empty when the review found nothing.')
  // Another agent that has the round's name, once the review's agent is known, records nothing.
  expect((await record({ agentId: 'agent-other' })).deny).toBe(refusal)
  expect((await record({ agentId: one.id })).result).toBe('Recorded round 1: no new findings. Finish as your instructions say.')
  expect((await record({ agentId: one.id })).deny).toBe("Round 1's findings are recorded already: finish as your instructions say.")
  one.finish('Nothing found.')
  expect(String((await call).result)).toContain('Nothing is open. feat/app at 1111111 is ready for a pull request.')
})

test('a review that reports as many findings as its level allows sends the next round over the whole branch', async ($, on) => {
  const repo = world({ skillText: 'Return findings as a JSON array of at most 2 objects.' })
  const { store, reviews } = engine(on, repo)
  await start($)
  const first = $.tool.call({ tool: REVIEW })
  await act($, reviews, 0, { findings: [SKIPPED_PAGE, OVERLAP] })
  expect(String((await first).result)).toContain(
    'The review reported 2, as many findings as /code-review high lets it, so the next round reviews the whole branch again.',
  )
  expect(ledgerOf(store).rounds[0]?.cap).toBe(2)

  repo.history.push(TWO)
  repo.head = TWO
  repo.changes[TWO] = ['src/app.ts']
  const second = $.tool.call({ tool: REVIEW })
  const { one } = await act($, reviews, 1)
  expect(one.args).toBe(`high ${BASE}..${TWO}`)
  expect(one.prompt).toContain('- Review the whole branch, as its pull request will show it:')
  await second
  expect(ledgerOf(store).rounds[1]?.scope).toBe('full')
})

test('commits that change only files REVIEW.md skips leave the review nothing to read, and the round says so', async ($, on) => {
  const { reviews } = engine(on, world({ guide: '## Skip\n- src/\n' }))
  await start($)
  const text = String((await $.tool.call({ tool: REVIEW })).result)
  expect(reviews).toEqual([])
  expect(text).toContain('Every file the round covers is on a REVIEW.md Skip list, so no review ran.')
  expect(text).toContain('Nothing is open. feat/app at 1111111 is ready for a pull request.')
})

test("a dismissal and the person's leave for more rounds, given while a round runs, stay when it records", async ($, on) => {
  const repo = world({ head: TWO, history: [BASE, ONE, TWO], changes: { [ONE]: ['src/app.ts'], [TWO]: ['src/app.ts'] } })
  const { store, reviews } = engine(on, repo)
  seed(store, { rounds: [round(1, ONE, 2)], findings: [finding({}), finding({ id: 'R1-2', line: 40, title: 'Pages overlap' })], reviewed: ONE })
  await start($)
  const call = $.tool.call({ tool: REVIEW })
  await until($, 'the review', () => reviews.length === 1)
  expect((await $.tool.call({ tool: DISMISS, ids: ['R1-2'], reason: 'Each page starts where the last one ended.' })).result).toContain('Dismissed R1-2')
  expect((await $.command.run({ command: 'review-gate', args: 'more', ...person })).text).toBe('feat/app may run 3 more rounds.')
  // The review, briefed as the round began, finds both fixed; the dismissed one keeps its reason.
  const rechecked = [
    { id: 'R1-1', fixed: true, why: 'the bound is pages now' },
    { id: 'R1-2', fixed: true, why: 'the pages no longer meet' },
  ]
  await act($, reviews, 0, { rechecked })
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
  const { store, reviews } = engine(on, repo)
  seed(store, { rounds: [round(1, ONE, 1)], findings: [finding({})], reviewed: ONE })
  await start($)
  const call = $.tool.call({ tool: REVIEW })
  await until($, 'the review', () => reviews.length === 1)
  expect((await $.command.run({ command: 'review-gate', args: 'reset', ...person })).text).toContain("Forgot feat/app's review record")
  // The round leaves out what R1-1 already said, so recorded after the reset it would vouch with that defect unrecorded.
  await act($, reviews, 0, { findings: [SKIPPED_PAGE], rechecked: [{ id: 'R1-1', fixed: false, why: 'still pages - 1' }] })
  expect((await call).deny).toBe(
    "feat/app's review record was reset, or another session recorded a round on it, while this round ran, so this round was not recorded. Review again.",
  )
  expect(store.has(KEY)).toBe(false)
})

test("a git read that fails ends the round with git's words, and nothing is recorded", async ($, on) => {
  const { store, reviews } = engine(on, world({ failDiff: true }))
  await start($)
  expect((await $.tool.call({ tool: REVIEW })).deny).toBe('git could not list the changed files: failed. Nothing was recorded.')
  expect(reviews).toEqual([])
  expect(store.has(KEY)).toBe(false)
})

test('REVIEW.md is read where the branch forked, and goes to the review with its Skip globs; the classifier reads every file', async ($, on) => {
  const repo = world({ guide: '# Rules\n\n## Skip\n- src/\n', changes: { [ONE]: ['src/app.ts', 'README.md'] } })
  const { reviews, judged, argvs } = engine(on, repo)
  await start($)
  const call = $.tool.call({ tool: REVIEW })
  const { one } = await act($, reviews, 0)
  expect(argvs.some(argv => argv.includes('ls-tree') && argv.includes(BASE))).toBe(true)
  expect(argvs.filter(argv => argv[0] === 'git' && argv.includes('diff')).every(argv => argv.includes('--no-ext-diff'))).toBe(true)
  // A diff the plugin reads begins its paths a/ and b/ whatever git's config says.
  const patches = argvs.filter(argv => argv.includes('--unified=5'))
  expect([patches.length > 0, patches.every(argv => argv.includes('--src-prefix=a/') && argv.includes('--dst-prefix=b/'))]).toEqual([true, true])
  expect(judged[0]?.prompt).toContain('diff --git a/src/app.ts b/src/app.ts')
  expect(one.prompt).toContain('--- REVIEW.md\n# Rules')
  expect(one.prompt).toContain("- Leave out the files these globs match, as the repository's REVIEW.md asks: `src/`.")
  await call
})

test('a REVIEW.md the branch adds does not apply to its own review', async ($, on) => {
  const { reviews } = engine(on, world({ guide: '## Skip\n- src/\n', guideAt: ONE }))
  await start($)
  const call = $.tool.call({ tool: REVIEW })
  const { one } = await act($, reviews, 0)
  expect(one.prompt.includes('REVIEW.md')).toBe(false)
  await call
})

test('a finding in a folder named b keeps its path, and one copied from a diff loses the prefix', async ($, on) => {
  const { store, reviews } = engine(on, world({ changes: { [ONE]: ['b/util.ts', 'src/app.ts'] } }))
  await start($)
  const call = $.tool.call({ tool: REVIEW })
  await act($, reviews, 0, { findings: [{ ...SKIPPED_PAGE, file: 'b/util.ts' }, { ...SHELL, file: 'b/src/app.ts' }] })
  await call
  expect(ledgerOf(store).findings.map(one => one.file)).toEqual(['src/app.ts', 'b/util.ts'])
})

test("a review's row draws as a card of its findings and their cost, and the band says what is open", async ($, on) => {
  const { store } = engine(on, world())
  seed(store, {
    rounds: [round(1, ONE, 1, { durationMs: 252_000, tokens: { input: 150_000, output: 60_000, cached: 610_000 }, calls: 31 })],
    findings: [
      finding({ category: 'correctness', verdict: 'confirmed' }),
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
    expect(drawn).toContain('whole branch · /code-review high · 4m 12s · 820k tokens, 610k from the cache · 31 calls · risk')
    expect(drawn).toContain('src/app.ts:12 · correctness, confirmed')
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

test("while a round runs, its state says the phase and level, and names the review's agent from its first tool call", async ($, on) => {
  const repo = world({ agents: [{ id: 'agent-g', type: 'general-purpose' }] })
  // A drawing waits for the round in the test kit, so the round is read as the plugin writes it.
  const runs: (Run | null)[] = []
  on('state.set', (_, e, next) => {
    // A shaped value is written with its shape tag around it.
    if (e.plugin === 'review-gate' && e.key === 'run') runs.push((e.value as unknown as { value?: Run | null }).value ?? null)
    return next(e)
  })
  const { store, reviews } = engine(on, repo)
  await start($)
  const call = $.tool.call({ tool: REVIEW })
  await until($, 'the review', () => reviews.length === 1)
  expect(runs.some(run => run?.phase === 'judging')).toBe(true)
  expect([runs.at(-1)?.phase, runs.at(-1)?.level, runs.at(-1)?.agentId]).toEqual(['reviewing', 'high', undefined])
  // Another agent's calls are not the review's.
  await $.tool.call({ tool: 'Read', file_path: '/repo/src/app.ts', agentId: 'agent-g' })
  expect(runs.at(-1)?.agentId).toBe(undefined)
  await $.tool.call({ tool: 'Read', file_path: '/repo/src/app.ts', agentId: 'review-1' })
  expect(runs.at(-1)?.agentId).toBe('review-1')
  await act($, reviews, 0)
  await call
  expect(runs.at(-1)).toBe(null)
  expect(ledgerOf(store).rounds[0]?.calls).toBe(2)
})

test('the live band draws the round, and the review with its calls, latest action and a watch button', async ($, on) => {
  const reviewing: Run = { round: 3, phase: 'reviewing', level: 'high', startedAt: 0, agentId: 'a1' }
  let shown: Run = reviewing
  on('ui.render', ($, e) => liveBand($, e, shown, { calls: 44, doing: 'reading hooks/review.ts' }, 370_000))
  const props = { hasSurvey: false, isWorking: true, maxRows: 12, bodyColumns: 160, scroll: { offset: 0, bodyRows: 12 }, view: {} }
  const band = await $.ui.mount({ plugin: 'review-gate', surface: 'terminal', component: 'AbovePrompt', requestId: 'band', props })
  const drawn = (await band.findAll({ type: 'Text' })).map(text => text.text).join('\n')
  expect(drawn).toContain('round 3 · /code-review high · 6m 10s')
  expect(drawn).toContain('44 calls · reading hooks/review.ts')
  // Pressing it opens the review's transcript.
  expect((await band.findAll({ type: 'Button' })).map(button => button.key)).toEqual(['watch'])
  await band.unmount()

  shown = { round: 3, phase: 'judging', startedAt: 0 }
  const judging = await $.ui.mount({ plugin: 'review-gate', surface: 'terminal', component: 'AbovePrompt', requestId: 'band-2', props })
  const said = (await judging.findAll({ type: 'Text' })).map(text => text.text).join('\n')
  expect(said).toContain("round 3 · judging the change's risk · 6m 10s")
  expect(said.includes('calls')).toBe(false)
  await judging.unmount()
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
    'Commit first: a review covers one commit, and these files, new ones included, are not in it: src/app.ts. Commit them, or remove or ignore the ones that are not part of the change.',
  )
  repo.dirty = []
  repo.head = BASE
  expect((await $.tool.call({ tool: REVIEW })).deny).toBe('feat/app has no commits past main: commit the change, then review it.')
})
test('a commit reviewed already is not reviewed again by the model', async ($, on) => {
  const { store, reviews } = engine(on, world())
  seed(store, { rounds: [round(1, ONE, 1)], findings: [finding({})], reviewed: ONE })
  await start($)
  expect(String((await $.tool.call({ tool: REVIEW })).result)).toContain('This commit was reviewed already; nothing was run again.')
  expect(reviews).toEqual([])
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

const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} }

async function bandText($: Engine) {
  const band = await $.ui.mount({ plugin: 'review-gate', surface: 'terminal', component: 'AbovePrompt', requestId: 'band', props: BAND_PROPS })
  const said = (await band.findAll({ type: 'Text' })).map(text => text.text).join('')
  await band.unmount()
  return said
}

test("a review's fix shows as fixed by the review and not yet confirmed, whatever git says since, until a round confirms it", async ($, on) => {
  const repo = world({ dirty: ['src/app.ts'] })
  const { store } = engine(on, repo)
  seed(store, { rounds: [round(1, ONE, 1)], findings: [finding({ fix: { round: 1, applied: true, why: 'the loop runs to pages' } })], reviewed: ONE })
  await start($)
  expect(await bandText($)).toContain('◐ 1 fixed by the review, not yet confirmed: R1-1 · commit, then review again')
  const status = async () => String((await $.command.run({ command: 'review-gate', args: 'status', ...person })).text)
  const said = await status()
  expect(said).toContain('The review fixed the open finding. Each stays open until a round confirms its fix: commit the fixes you keep, then review again.')
  expect(said).toContain('R1-1 · src/app.ts:12\n  The last page is skipped\n  Fixed: the loop runs to pages')

  // Committed since: the mark says the same, and the band adds the commits not reviewed yet.
  repo.dirty = []
  repo.history = [BASE, ONE, TWO]
  repo.changes[TWO] = ['src/app.ts']
  repo.head = TWO
  expect(await status()).toContain('The review fixed the open finding.')
  const band = await bandText($)
  expect(band).toContain('◐ 1 fixed by the review, not yet confirmed: R1-1')
  expect(band).toContain('○ new commits since 1111111')

  const row = await $.ui.mount({
    plugin: 'review-gate',
    surface: 'terminal',
    component: 'ToolResult',
    requestId: 'toolu_9',
    props: { tool_use_id: 'toolu_9', tool: REVIEW, output: 'Review round 1 of feat/app at 1111111: the whole branch.', isErrored: false },
  })
  const drawn = (await row.findAll({ type: 'Text' })).map(text => text.text).join('\n')
  expect(drawn).toContain('fixed by the review in round 1, not yet confirmed: the loop runs to pages')
  expect(drawn).toContain('1 fixed by the review, not yet confirmed.')
  await row.unmount()
})

test("only Claude Code's own /code-review is the gate's review: another skill of its name is told to stop, and the round refuses it", async ($, on) => {
  const { store, reviews, stops } = engine(on, world({ skillSource: 'projectSettings' }))
  await start($)
  const call = $.tool.call({ tool: REVIEW })
  await until($, 'the review', () => reviews.length === 1)
  const one = reviews[0] as Review
  expect(one.prompt.includes('## review-gate')).toBe(false)
  expect(one.prompt).toContain('review-gate will not run this skill as its review.')
  one.finish('Not run.')
  expect(String((await call).deny)).toContain("The skill named code-review here comes from its projectSettings skills, not Claude Code, so review-gate did not run it as its review")
  expect(stops).toEqual([one.id])
  expect(store.has(KEY)).toBe(false)
})

test('a review of an earlier round still running is not this round’s review, and cannot record for it', async ($, on) => {
  const repo = world({ background: true })
  const { reviews } = engine(on, repo)
  await start($)
  // An earlier review, still running, that the session lists as review-gate's /code-review.
  repo.agents = [{ id: 'old-review', type: 'general-purpose', description: '/code-review', spawnedBy: 'review-gate' }]
  const call = $.tool.call({ tool: REVIEW })
  await until($, 'the review', () => reviews.length === 1)
  const one = reviews[0] as Review
  await $.tool.call({ tool: 'Read', agentId: 'old-review', file_path: '/repo/src/app.ts' })
  expect(String((await $.tool.call({ tool: RECORD, agentId: 'old-review', round: one.token, findings: [] })).deny)).toContain('record takes the findings')
  expect(String((await $.tool.call({ tool: RECORD, agentId: one.id, round: one.token, findings: [SKIPPED_PAGE] })).result)).toContain('Recorded round 1')
  await reply($, one.id, 'Done.')
  expect(String((await call).result)).toContain('R1-1')
})

test('with --fix, a file the review creates counts as a fix', async ($, on) => {
  const repo = world()
  const { store, reviews } = engine(on, repo)
  await start($)
  const call = $.tool.call({ tool: REVIEW, fix: true })
  await until($, 'the review', () => reviews.length === 1)
  const one = reviews[0] as Review
  await $.tool.call({ tool: RECORD, agentId: one.id, round: one.token, findings: [SKIPPED_PAGE] })
  // The fix is a new test file alone.
  repo.untracked = ['src/app.test.ts']
  await $.tool.call({ tool: RECORD, agentId: one.id, round: one.token, fixes: [{ id: 'R1-1', applied: true, why: 'a test pins the last page' }] })
  await reply($, one.id, 'Done.')
  one.finish('Done.')
  expect(String((await call).result)).toContain('Files changed while the round ran, in the working tree and not committed: src/app.test.ts.')
  expect(ledgerOf(store).findings[0]?.fix?.applied).toBe(true)
})

test('a new file the commit does not hold stops a round, as a changed one does', async ($, on) => {
  const { reviews } = engine(on, world({ untracked: ['src/util.ts'] }))
  await start($)
  expect(String((await $.tool.call({ tool: REVIEW })).deny)).toBe(
    'Commit first: a review covers one commit, and these files, new ones included, are not in it: src/util.ts. Commit them, or remove or ignore the ones that are not part of the change.',
  )
  expect(reviews.length).toBe(0)
})

test('a review that moves HEAD, by a commit, a checkout or a reset, leaves the round with nothing recorded', async ($, on) => {
  const repo = world()
  const { store, reviews } = engine(on, repo)
  await start($)
  const call = $.tool.call({ tool: REVIEW, fix: true })
  await until($, 'the review', () => reviews.length === 1)
  const one = reviews[0] as Review
  expect(one.prompt).toContain('Leave HEAD where it is: read other commits with git show or git diff, and do not commit, check out or reset, or the round records nothing.')
  await $.tool.call({ tool: RECORD, agentId: one.id, round: one.token, findings: [SKIPPED_PAGE] })
  // The review commits its fix.
  repo.history = [BASE, ONE, TWO]
  repo.changes[TWO] = ['src/app.ts']
  repo.head = TWO
  await reply($, one.id, 'Done.')
  one.finish('Done.')
  expect(String((await call).deny)).toBe(
    'HEAD moved while the round ran: it began on feat/app at 1111111, and HEAD is now feat/app at 2222222. Nothing was recorded. Put HEAD where you want the review to read, then review again.',
  )
  expect(store.has(KEY)).toBe(false)

  // A checkout of the same commit that detaches HEAD moves it too.
  repo.head = ONE
  repo.history = [BASE, ONE]
  const again = $.command.run({ command: 'review-gate', args: '', ...person })
  await until($, 'the second review', () => reviews.length === 2)
  const two = reviews[1] as Review
  await $.tool.call({ tool: RECORD, agentId: two.id, round: two.token, findings: [] })
  repo.branch = ''
  await reply($, two.id, 'Done.')
  two.finish('Done.')
  expect(String((await again).text)).toContain('HEAD is now a detached HEAD at 1111111. Nothing was recorded.')
  expect(store.has(KEY)).toBe(false)
})

test('a review that recorded, then failed, keeps its record; one that failed to start is not waited for', async ($, on) => {
  const repo = world({ skillFails: 'error' })
  const { store, reviews } = engine(on, repo)
  await start($)
  const call = $.tool.call({ tool: REVIEW })
  await act($, reviews, 0, { findings: [SKIPPED_PAGE] })
  const text = String((await call).result)
  expect(text).toContain('The review recorded its findings, then failed: API error while it wrote its answer')
  expect(ledgerOf(store).findings.map(one => one.id)).toEqual(['R1-1'])

  repo.skillFails = 'unsuccessful'
  repo.background = true
  const now = repo.now
  const failed = $.command.run({ command: 'review-gate', args: '', ...person })
  expect(String((await failed).text)).toContain('/code-review ended without recording its findings, and it failed: could not start: no model')
  // No thirty-minute wait: the clock moved by the few sleeps of the risk check at most.
  expect(repo.now - now < 60_000).toBe(true)
})

test('where sleep cannot run, the round stops waiting for a background review at once and says why', async ($, on) => {
  const repo = world({ background: true, noSleep: true })
  const { reviews, stops } = engine(on, repo)
  await start($)
  const call = $.tool.call({ tool: REVIEW })
  await until($, 'the review', () => reviews.length === 1)
  const one = reviews[0] as Review
  // No spin and no half-hour wait: the round ends at the first sleep that fails.
  expect(String((await call).deny)).toBe(
    '/code-review ended without recording its findings, so the round has nothing to stand on. review-gate could not wait for the review, since the `sleep` program could not run here, so it stopped the review. Nothing was recorded; review again.',
  )
  expect(stops).toEqual([one.id])
})

test("a delivery keeps other tasks' notices, and drops the review's whole when the hook cannot cut it out", async ($, on) => {
  const { reviews } = engine(on, world({ background: true }))
  await start($)
  const call = $.tool.call({ tool: REVIEW })
  const { one } = await act($, reviews, 0)
  await call
  const submit = (text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'task-notification' } })
  const other = '<task-notification><task-id>build-7</task-id><status>completed</status></task-notification>'
  const mine = `<task-notification id="n1"><task-id>${one.id}</task-id><result>[raw]</result></task-notification>`
  expect((await submit(`${mine}\n${other}`)).text?.trim()).toBe(other)
  // Framing with no other notice left, and the id in a form the hook does not read, are dropped.
  const dropped = { drop: "review-gate: the review finished; the round's result has its findings." }
  expect(await submit(`A background task finished:\n${mine}`)).toEqual(dropped)
  expect(await submit(`<notice><task-id>${one.id}</task-id>[raw]</notice>\n${other}`)).toEqual(dropped)
})

test('open findings are looked at again when the new commits change only skipped files, and findings in skipped files are left out', async ($, on) => {
  const repo = world({ guide: '## Skip\n- generated/\n', history: [BASE, ONE, TWO], head: TWO, changes: { [ONE]: ['src/app.ts'], [TWO]: ['generated/api.ts'] } })
  const { store, reviews } = engine(on, repo)
  seed(store, { rounds: [round(1, ONE, 1)], findings: [finding({})], reviewed: ONE })
  await start($)
  const call = $.tool.call({ tool: REVIEW })
  const generated = { ...OVERLAP, file: 'generated/api.ts', line: 812, short_summary: 'Unused import' }
  const { recorded } = await act($, reviews, 0, { findings: [generated], rechecked: [{ id: 'R1-1', fixed: true, why: 'the generator now pages' }] })
  expect(recorded).toContain('Left out: 1 in files REVIEW.md skips.')
  const text = String((await call).result)
  expect(text).toContain('Found fixed this round: R1-1')
  expect(text).toContain('1 finding was in files REVIEW.md skips, so it was left out.')
  expect(ledgerOf(store).findings.map(one => [one.id, one.status])).toEqual([['R1-1', 'fixed']])
})

test('without --fix the review only reads; with it, it changes nothing until it has recorded; a review changes nothing once its round is over; other agents are free', async ($, on) => {
  const repo = world({ agents: [{ id: 'helper-0', type: 'general-purpose' }] })
  const { reviews } = engine(on, repo)
  await start($)
  const verdict = (agentId: string, tool: string, isReadOnly = false) => $.tool.check({ tool, input: {}, agentId, ...(isReadOnly ? { isReadOnly: true as const } : {}) })
  const check = async (agentId: string, tool: string, isReadOnly = false) => (await verdict(agentId, tool, isReadOnly)).decision
  const call = $.tool.call({ tool: REVIEW })
  await until($, 'the review', () => reviews.length === 1)
  const one = reviews[0] as Review
  expect(await check(one.id, 'Edit')).toBe('deny')
  expect(await check(one.id, 'Bash')).toBe('deny')
  expect(await check(one.id, 'Bash', true)).toBe('allow')
  expect(await check(one.id, 'Read')).toBe('allow')
  expect(await check(one.id, RECORD)).toBe('allow')
  // Only listed tools, shell reads and foreground agents of its own: a message could act for it, an
  // agent in the background or elsewhere would outlive the rule, and an MCP server's word is no proof.
  expect(await check(one.id, 'WebFetch', true)).toBe('deny')
  expect(await check(one.id, 'mcp__docs__publish', true)).toBe('deny')
  expect(await check(one.id, 'SendMessage', true)).toBe('deny')
  expect((await $.tool.check({ tool: 'Agent', input: { prompt: 'look', run_in_background: true }, agentId: one.id, isReadOnly: true })).decision).toBe('deny')
  expect((await $.tool.check({ tool: 'Agent', input: { prompt: 'look', isolation: 'remote' }, agentId: one.id, isReadOnly: true })).decision).toBe('deny')
  expect((await $.tool.check({ tool: 'Agent', input: { prompt: 'look' }, agentId: one.id, isReadOnly: true })).decision).toBe('allow')
  // An agent the review starts is held to the same; one the session had before the round is not.
  repo.agents = [
    { id: 'helper-0', type: 'general-purpose' },
    { id: 'angle-1', type: 'general-purpose', parentId: one.id },
  ]
  expect(await check('angle-1', 'Write')).toBe('deny')
  expect(await check('helper-0', 'Write')).toBe('allow')
  expect((await verdict(one.id, 'Edit')).reason).toContain('review-gate: this review only reads.')
  await act($, reviews, 0)
  await call

  const fixing = $.command.run({ command: 'review-gate', args: '--fix', ...person })
  await until($, 'the second review', () => reviews.length === 2)
  const two = reviews[1] as Review
  expect(await verdict(two.id, 'Edit')).toEqual({ decision: 'deny', reason: 'review-gate: record the findings with the record tool first, then fix them.' })
  await $.tool.call({ tool: RECORD, agentId: two.id, round: two.token, findings: [SKIPPED_PAGE] })
  expect(await check(two.id, 'Edit')).toBe('allow')
  await reply($, two.id, 'Done.')
  two.finish('Done.')
  await fixing
  // A review woken after its round, by a notice or a message, and any agent it started, change nothing.
  repo.agents = [
    { id: 'helper-0', type: 'general-purpose' },
    { id: 'angle-1', type: 'general-purpose', parentId: one.id },
  ]
  expect(await verdict(two.id, 'Edit')).toEqual({
    decision: 'deny',
    reason: 'review-gate: this agent is a review whose round is over, or one a review started, so it changes nothing now.',
  })
  expect(await check('angle-1', 'Bash')).toBe('deny')
  // Outside a round, the gate leaves every other agent's call to the session's own rules.
  expect(await check('helper-0', 'Edit')).toBe('allow')
  expect(await check('agent-z', 'Edit')).toBe('allow')
})

test('an agent the main conversation starts during a round is never taken for the review', async ($, on) => {
  const repo = world()
  const { reviews } = engine(on, repo)
  await start($)
  const call = $.tool.call({ tool: REVIEW })
  await until($, 'the review', () => reviews.length === 1)
  const one = reviews[0] as Review
  // A test run the model started alongside the review, with no plugin behind it.
  repo.agents = [{ id: 'tests-1', type: 'general-purpose' }]
  await $.tool.call({ tool: 'Read', agentId: 'tests-1', file_path: '/repo/src/app.ts' })
  expect(String((await $.tool.call({ tool: RECORD, agentId: one.id, round: one.token, findings: [SKIPPED_PAGE] })).result)).toContain('Recorded round 1')
  await reply($, one.id, 'Done.')
  one.finish('Done.')
  expect(String((await call).result)).toContain('R1-1')
  const notice = (id: string) => $.prompt.submit({ text: `<task-notification><task-id>${id}</task-id></task-notification>`, wait: false, origin: { kind: 'task-notification' } })
  expect((await notice('tests-1')).text).toContain('<task-id>tests-1</task-id>')
  expect(await notice(one.id)).toEqual({ drop: "review-gate: the review finished; the round's result has its findings." })
})

test('no agent answers at the gate for the whole round, the risk check included', async ($, on) => {
  let release: () => void = () => undefined
  const repo = world({
    holdRisk: new Promise<void>(resolve => {
      release = resolve
    }),
  })
  const { store, reviews, judged } = engine(on, repo)
  seed(store, { rounds: [round(1, BASE, 1)], findings: [finding({})], reviewed: BASE })
  await start($)
  const call = $.tool.call({ tool: REVIEW })
  await until($, 'the risk check', () => judged.length === 1)
  expect(String((await $.tool.call({ tool: DISMISS, agentId: 'agent-x', ids: ['R1-1'], reason: 'An agent thinks it is fine as it is.' })).deny)).toContain(
    'findings are answered from the main conversation',
  )
  release()
  await act($, reviews, 0)
  await call
  expect(ledgerOf(store).findings.map(one => one.status)).toEqual(['open'])
})

test('a fix the review claims with no file changed is not kept, and the round names it', async ($, on) => {
  const { store, reviews } = engine(on, world())
  await start($)
  const call = $.tool.call({ tool: REVIEW, fix: true })
  await until($, 'the review', () => reviews.length === 1)
  const one = reviews[0] as Review
  await $.tool.call({ tool: RECORD, agentId: one.id, round: one.token, findings: [SKIPPED_PAGE] })
  await $.tool.call({ tool: RECORD, agentId: one.id, round: one.token, fixes: [{ id: 'R1-1', applied: true, why: 'the loop runs to pages' }] })
  await reply($, one.id, 'Done.')
  one.finish('Done.')
  const text = String((await call).result)
  expect(text).toContain('No file changed while the round ran, though --fix let the review change files. The review said it fixed R1-1, so that finding stays open as before.')
  expect(text.includes('The review left it')).toBe(false)
  expect(ledgerOf(store).findings.map(finding => [finding.id, finding.status, finding.fix])).toEqual([['R1-1', 'open', undefined]])
})

test("a review the round ends before its first tool call still has its notice kept out", async ($, on) => {
  const { reviews } = engine(on, world({ background: true, skillSource: 'projectSettings' }))
  await start($)
  const call = $.tool.call({ tool: REVIEW })
  await until($, 'the review', () => reviews.length === 1)
  const one = reviews[0] as Review
  expect(String((await call).deny)).toContain('so review-gate did not run it as its review')
  const notice = await $.prompt.submit({ text: `<task-notification><task-id>${one.id}</task-id><result>[raw]</result></task-notification>`, wait: false, origin: { kind: 'task-notification' } })
  expect(notice).toEqual({ drop: "review-gate: the review finished; the round's result has its findings." })
})

test("another task's notice that names the review's output file passes beside the review's", async ($, on) => {
  const { reviews } = engine(on, world({ background: true }))
  await start($)
  const call = $.tool.call({ tool: REVIEW })
  const { one } = await act($, reviews, 0)
  await call
  const monitor = `<task-notification><task-id>mon-2</task-id><summary>Watched /tmp/tasks/${one.id}.output to its end</summary></task-notification>`
  const mine = `<task-notification><task-id>${one.id}</task-id><result>[raw]</result></task-notification>`
  const passed = await $.prompt.submit({ text: `${mine}\n${monitor}`, wait: false, origin: { kind: 'task-notification' } })
  expect(passed.text?.trim()).toBe(monitor)
})

test('an agent the list does not show is no review, and goes free during a round', async ($, on) => {
  const { reviews } = engine(on, world())
  await start($)
  const call = $.tool.call({ tool: REVIEW })
  await until($, 'the review', () => reviews.length === 1)
  // A workflow's agent, or one whose parent has ended: no list names it.
  expect((await $.tool.check({ tool: 'Edit', input: {}, agentId: 'workflow-7' })).decision).toBe('allow')
  expect((await $.tool.check({ tool: 'Edit', input: {}, agentId: (reviews[0] as Review).id })).decision).toBe('deny')
  await act($, reviews, 0)
  await call
})

test('a review never answers at the gate, during its round or after it', async ($, on) => {
  const { store, reviews } = engine(on, world())
  seed(store, { rounds: [round(1, BASE, 1)], findings: [finding({})], reviewed: BASE })
  await start($)
  const call = $.tool.call({ tool: REVIEW })
  const { one } = await act($, reviews, 0)
  await call
  expect(String((await $.tool.call({ tool: DISMISS, agentId: one.id, ids: ['R1-1'], reason: 'The review thinks it is fine as it is.' })).deny)).toContain(
    'findings are answered from the main conversation',
  )
  expect(String((await $.tool.call({ tool: DISMISS, agentId: 'agent-q', ids: ['R1-1'], reason: 'Another agent read it and it holds up.' })).result)).toContain('Dismissed R1-1')
})
