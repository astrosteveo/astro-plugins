import { expect, test } from 'claude-code/testing'
import type { Finding, Ledger, Round } from '../types'
import { NIT_CAP, atLeast, atMost, emptyLedger, rereadLevel, standing, globTest, isCapped, kindOf, levelFor, newFindings, parseGuide, sameDefect, severityOf, sortOut, spent, streak, toLedger } from '../hooks/ledger'
import type { Reported } from '../hooks/ledger'
import { capOf, lastJson, readRecord, readRisk, reviewSection } from '../hooks/prompts'
import type { Plan } from '../hooks/prompts'

const reported = (over: Partial<Reported>): Reported => ({
  file: 'src/app.ts',
  line: 12,
  summary: 'A defect',
  shortSummary: '',
  scenario: '',
  category: 'correctness',
  security: false,
  introduced: true,
  ...over,
})

const finding = (over: Partial<Finding>): Finding => ({
  id: 'R1-1',
  round: 1,
  kind: 'bug',
  severity: 'important',
  file: 'src/app.ts',
  line: 12,
  title: 'A defect',
  detail: '',
  scenario: '',
  status: 'open',
  ...over,
})

const round = (n: number, open: number): Round => ({
  n,
  head: `${n}`.repeat(40),
  from: 'b'.repeat(40),
  scope: 'full',
  level: 'high',
  risk: { tier: 'medium', why: [] },
  raised: open,
  kept: open,
  fixed: 0,
  open,
  at: 0,
})

test('a glob reads as in .gitignore: anchored with a slash, at any depth without, and a folder holds its files', () => {
  const cases: [string, string, boolean][] = [
    ['.github/workflows/', '.github/workflows/ci.yml', true],
    ['.github/workflows/', 'docs/.github/workflows/ci.yml', false],
    ['Dockerfile', 'Dockerfile', true],
    ['Dockerfile', 'services/api/Dockerfile', true],
    ['auth/', 'src/auth/token.ts', true],
    ['auth/', 'src/oauth/token.ts', false],
    ['*secret*', 'config/secrets.json', true],
    ['*secret*', 'secrets/key.txt', true],
    ['.env*', 'app/.env.local', true],
    ['*.md', 'plugins/x/README.md', true],
    ['*.md', 'plugins/x/README.mdx', false],
    ['/build/out.js', 'build/out.js', true],
    ['/build/out.js', 'src/build/out.js', false],
    ['/plugins/gates/**/*.ts', 'plugins/gates/hooks/register.ts', true],
    ['/plugins/gates/**/*.ts', 'plugins/gates/register.ts', true],
    ['/plugins/gates/**/*.ts', 'plugins/other/hooks/register.ts', false],
    ['src/*.ts', 'src/app.ts', true],
    ['src/*.ts', 'src/lib/app.ts', false],
  ]
  for (const [pattern, path, matches] of cases) expect({ pattern, path, matches: globTest(pattern)(path) }).toEqual({ pattern, path, matches })
})

test("a REVIEW.md's Skip list speaks for its own folder, and no other heading is a list", () => {
  const text = [
    '# Review rules',
    '',
    'Failure here means a gate lets a risky command through.',
    '',
    '## Skip',
    '',
    '- `*.lock`',
    '- generated/',
    '',
    '## Style',
    '',
    '- not-a-glob-list',
  ].join('\n')
  expect(parseGuide('plugins/gates/REVIEW.md', text)).toEqual({
    path: 'plugins/gates/REVIEW.md',
    text,
    skip: ['/plugins/gates/**/*.lock', '/plugins/gates/**/generated/'],
  })
  expect(parseGuide('REVIEW.md', '## Skip\n- *.lock\n').skip).toEqual(['*.lock'])
  const guide = parseGuide('plugins/gates/REVIEW.md', text)
  expect(globTest(guide.skip[1] ?? '')('plugins/gates/generated/table.ts')).toBe(true)
  expect(globTest(guide.skip[1] ?? '')('plugins/other/generated/table.ts')).toBe(false)
})

test("the classifier's verdict is read with up to three reasons, and a reply naming no tier reads as none", () => {
  expect(
    readRisk('```json\n{"tier": "high", "why": ["hooks/guard.ts decides which commands may run", "", "a", "b", "c"]}\n```'),
  ).toEqual({ tier: 'high', why: ['hooks/guard.ts decides which commands may run', 'a', 'b'] })
  expect(readRisk('{"tier": "low"}')).toEqual({ tier: 'low', why: [] })
  expect(readRisk('{"tier": "severe", "why": []}')).toBe(undefined)
  expect(readRisk('It looks fine.')).toBe(undefined)
})

test('the cap counts the rounds in a row that ended with findings open, from where the person last allowed more', () => {
  const ledger: Ledger = { ...emptyLedger('feat/x'), rounds: [round(1, 2), round(2, 0), round(3, 3), round(4, 1)] }
  expect(streak(ledger)).toBe(2)
  expect(streak({ ...ledger, rounds: [...ledger.rounds, round(5, 1)] })).toBe(3)
  expect(streak({ ...ledger, streakFrom: 4 })).toBe(0)
  expect(streak(emptyLedger('feat/x'))).toBe(0)
})

test('a record in another shape reads as none', () => {
  expect(toLedger(undefined, 'feat/x')).toEqual(emptyLedger('feat/x'))
  expect(toLedger('not a record', 'feat/x')).toEqual(emptyLedger('feat/x'))
  // A record the agent reviewers kept, before /code-review ran the rounds, is another shape.
  expect(toLedger({ version: 1, branch: 'feat/x', rounds: [round(1, 0)], findings: [], reviewed: 'a'.repeat(40), streakFrom: 0 }, 'feat/x')).toEqual(
    emptyLedger('feat/x'),
  )
  const stored = { ...emptyLedger('feat/x'), reviewed: 'a'.repeat(40), rounds: [round(1, 0)] }
  expect(toLedger(stored, 'feat/x')).toEqual(stored)
})

test("a reply is read from its last json block, or its last object", () => {
  expect(lastJson('Found one.\n\n```json\n{"findings": [{"file": "a.ts"}]}\n```')).toEqual({ findings: [{ file: 'a.ts' }] })
  expect(lastJson('```json\n{"findings": []}\n```\nThen I fixed it:\n```json\n{"findings": [\n```')).toEqual({ findings: [] })
  expect(lastJson('Nothing found. {"findings": []}')).toEqual({ findings: [] })
  expect(lastJson('No json here.')).toBe(undefined)
})

test("a round's cost reads as its time and its tokens, the cache's share named", () => {
  expect(spent({ ...round(1, 0), durationMs: 252_000, tokens: { input: 150_000, output: 60_000, cached: 610_000 } })).toBe('4m 12s · 820k tokens, 610k from the cache')
  expect(spent({ ...round(1, 0), durationMs: 9_400, tokens: { input: 900, output: 50, cached: 0 } })).toBe('9s · 950 tokens')
  expect(spent({ ...round(1, 0), durationMs: 1_000, tokens: { input: 2_400_000, output: 0, cached: 0 } })).toBe('1s · 2.4M tokens')
  expect(spent(round(1, 0))).toBe('')
})

test('the risk picks the level, and a cap holds a level down', () => {
  expect([levelFor({ tier: 'low', why: [] }), levelFor({ tier: 'medium', why: [] }), levelFor({ tier: 'high', why: [] })]).toEqual(['medium', 'high', 'xhigh'])
  expect([atMost('xhigh', 'high'), atMost('max', 'high'), atMost('medium', 'high')]).toEqual(['high', 'high', 'medium'])
})

test("a review's findings are graded from what it said, gravest and security first, with none the branch has had and all of its own", () => {
  const list = [
    reported({ summary: 'The loop allocates a list per page', category: 'efficiency', line: 40 }),
    reported({ summary: 'The last page is skipped', shortSummary: 'Last page skipped', line: 12 }),
    reported({ summary: 'Old helper drops the sign', introduced: false, file: 'src/old.ts' }),
    reported({ summary: 'The query reaches a shell unquoted', security: true, line: 30, verdict: 'confirmed' }),
    reported({ summary: 'Token written to the log', category: 'secret-leak', file: 'src/auth.ts' }),
    reported({ summary: 'The last page is skipped by the loop', line: 13 }),
    reported({ summary: 'Pages overlap at the seam', line: 70, file: 'src/pages.ts' }),
  ]
  const earlier = [finding({ id: 'R1-1', file: 'src/pages.ts', line: 71, title: 'Pages overlap at their seam', status: 'dismissed' })]
  const made = newFindings(list, 2, earlier)
  // The review merged its own repeats, so two of its findings a line apart both stand.
  expect(made.map(one => [one.id, one.severity, one.kind, one.title])).toEqual([
    ['R2-1', 'important', 'security', 'The query reaches a shell unquoted'],
    ['R2-2', 'important', 'security', 'Token written to the log'],
    ['R2-3', 'important', 'bug', 'Last page skipped'],
    ['R2-4', 'important', 'bug', 'The last page is skipped by the loop'],
    ['R2-5', 'pre-existing', 'bug', 'Old helper drops the sign'],
    ['R2-6', 'nit', 'bug', 'The loop allocates a list per page'],
  ])
  expect(made[0]?.verdict).toBe('confirmed')
  expect(made[2]?.detail).toBe('The last page is skipped')
  expect(made[0]?.detail).toBe('')
})

test("a finding's grade is read from the review's whole word for it, not a word it starts like", () => {
  const graded = (category: string) => {
    const one = reported({ category })
    return [category, kindOf(one), severityOf(one)]
  }
  expect(
    ['memory-leak', 'resource-leak', 'dependency-injection', 'fault-injection', 'authoring', 'deadlock', 'deadline-exceeded', 'dockerfile', 'duplicate-charge'].map(graded),
  ).toEqual([
    ['memory-leak', 'bug', 'important'],
    ['resource-leak', 'bug', 'important'],
    ['dependency-injection', 'bug', 'important'],
    ['fault-injection', 'bug', 'important'],
    ['authoring', 'bug', 'important'],
    ['deadlock', 'bug', 'important'],
    ['deadline-exceeded', 'bug', 'important'],
    ['dockerfile', 'bug', 'important'],
    ['duplicate-charge', 'bug', 'important'],
  ])
  expect(['access-control', 'privilege-escalation', 'authorisation', 'information-disclosure', 'sandbox-escape', 'rce'].map(graded).map(([, kind]) => kind)).toEqual(
    Array(6).fill('security'),
  )
  // A word that names a thing as well as a hole counts only with the hole named.
  expect(
    ['tree-traversal', 'graph-traversal', 'permission-prompt', 'sandbox-setup', 'permissions', 'permission-bypass', 'sandbox', 'sandboxing', 'traversal'].map(graded).map(([, kind]) => kind),
  ).toEqual(['bug', 'bug', 'bug', 'bug', 'security', 'security', 'security', 'security', 'security'])
  expect(['secret-leak', 'data-leak', 'sql-injection', 'auth', 'broken-authorization', 'oauth-state', 'path-traversal'].map(graded)).toEqual([
    ['secret-leak', 'security', 'important'],
    ['data-leak', 'security', 'important'],
    ['sql-injection', 'security', 'important'],
    ['auth', 'security', 'important'],
    ['broken-authorization', 'security', 'important'],
    ['oauth-state', 'security', 'important'],
    ['path-traversal', 'security', 'important'],
  ])
  expect(['dead-code', 'duplication', 'duplicate-code', 'docs', 'tests', 'simplification', 'efficiency'].map(graded).map(([, , severity]) => severity)).toEqual(
    Array(7).fill('nit'),
  )
})

test('a path the review gives under the repository root is read from the root', () => {
  const read = readRecord({ findings: [{ file: '/repo/src/app.ts', summary: 'Off by one', failure_scenario: 'x' }, { file: '/elsewhere/a.ts', summary: 'Kept', failure_scenario: 'y' }] }, new Set(['src/app.ts']), '/repo')
  expect(typeof read === 'string' ? read : read.findings.map(one => one.file)).toEqual(['src/app.ts', '/elsewhere/a.ts'])
})

test("a record call is read whatever it leaves out, and a path keeps a real folder named b", () => {
  const changed = new Set(['b/util.ts', 'src/app.ts'])
  const read = readRecord(
    {
      findings: [
        { file: './src/app.ts', line: 12, summary: 'Off by one', short_summary: 'Off by one', failure_scenario: 'pages=3 skips page 3', category: 'Correctness', verdict: 'PLAUSIBLE' },
        { file: 'b/util.ts', line: '7', summary: 'In a folder named b', failure_scenario: 'x' },
        { file: 'a/src/app.ts', summary: 'Copied from the diff', failure_scenario: 'y', security: true, introduced: false },
        { file: 'src/x.ts', summary: '' },
        'junk',
      ],
      rechecked: [{ id: 'r1-2', fixed: true, why: 'the bound is pages now' }, { fixed: true }],
    },
    changed,
  )
  expect(read).toEqual({
    findings: [
      { file: 'src/app.ts', line: 12, summary: 'Off by one', shortSummary: 'Off by one', scenario: 'pages=3 skips page 3', category: 'correctness', verdict: 'plausible', security: false, introduced: true },
      { file: 'b/util.ts', line: 0, summary: 'In a folder named b', shortSummary: '', scenario: 'x', category: '', security: false, introduced: true },
      { file: 'src/app.ts', line: 0, summary: 'Copied from the diff', shortSummary: '', scenario: 'y', category: '', security: true, introduced: false },
    ],
    rechecked: [{ id: 'R1-2', fixed: true, why: 'the bound is pages now' }],
  })
  expect(readRecord({ findings: 'none' }, changed)).toBe('Give findings as a list, empty when the review found nothing.')
})

test("a review's cap is read from /code-review's own words for its level", () => {
  expect(capOf('Return findings as a JSON array of at most 10 objects:')).toBe(10)
  expect(capOf('Output at most **4 findings**, most-severe first')).toBe(4)
  expect(capOf('Report every finding.')).toBe(undefined)
  expect([isCapped({ ...round(1, 4), cap: 4 }), isCapped({ ...round(1, 3), cap: 4 }), isCapped(round(1, 9))]).toEqual([true, false, false])
})

test("the section a round adds to /code-review names its scope, the branch's findings, and the round to record under", () => {
  const plan: Plan = {
    token: 'tok-1',
    n: 2,
    branch: 'feat/x',
    root: '/repo',
    head: '2'.repeat(40),
    from: '1'.repeat(40),
    scope: 'delta',
    level: 'high',
    fix: false,
    intent: '',
    guides: [{ path: 'REVIEW.md', text: '## Skip\n- *.lock\n', skip: ['*.lock'] }],
    skip: ['*.lock'],
    earlier: [
      finding({ title: 'The last page is skipped', detail: 'The loop stops one page early.' }),
      finding({ id: 'R1-2', title: 'Pages overlap', status: 'dismissed', answer: 'Each page starts where the last ended.' }),
    ],
  }
  const text = reviewSection(plan)
  expect(text).toContain('## review-gate: round 2 of feat/x')
  expect(text).toContain(`- Review only the commits since 1111111, which round 1 reviewed: \`git diff ${'1'.repeat(40)} ${'2'.repeat(40)}\`.`)
  expect(text).toContain('its working tree at 2222222: run git and read files there. Change no file.')
  expect(text).toContain('What the author says the change is for: not stated; read it from the commits.')
  expect(text).toContain('- Leave out the files these globs match, as the repository\'s REVIEW.md asks: `*.lock`.')
  expect(text).toContain('--- REVIEW.md')
  expect(text).toContain('- R1-2 [dismissed: Each page starts where the last ended.] src/app.ts:12 Pages overlap')
  expect(text).toContain('Open findings to look at again.')
  expect(text).toContain('- R1-1 src/app.ts:12 The last page is skipped. The loop stops one page early.')
  expect(text.includes('- R1-2 src/app.ts:12 Pages overlap')).toBe(false)
  expect(text).toContain('- round: "tok-1"')
  expect(text).toContain('before you write your answer, call the mcp__review-gate__record tool once')
  const fixing = reviewSection({ ...plan, fix: true, earlier: [], scope: 'full' })
  expect(fixing).toContain('before you change any file or write your answer')
  expect(fixing.includes('Change no file.')).toBe(false)
  expect(fixing).toContain('- rechecked: an empty list.')
})

test('a round raises a few nits at most, and says how many it left out and how many were repeats', () => {
  const nits = Array.from({ length: 5 }, (_, at) => reported({ summary: `Helper ${at} is copied from util${at}`, category: 'reuse', line: 100 + at * 20 }))
  const sorted = sortOut([...nits, reported({ summary: 'The last page is skipped', line: 12 })], 2, [])
  expect(sorted.added.map(one => one.severity)).toEqual(['important', ...Array(NIT_CAP).fill('nit')])
  expect([sorted.nitsLeft, sorted.repeats]).toEqual([5 - NIT_CAP, 0])
})

test('two findings a few lines apart that share only common words are two defects', () => {
  const a = { file: 'src/app.ts', line: 12, title: 'The loop stops when the page is the last one', detail: '' }
  const b = { file: 'src/app.ts', line: 14, title: 'The cache is read when the key is stale and the lock is not held', detail: '' }
  expect(sameDefect(a, b)).toBe(false)
  expect(sameDefect(a, { ...a, line: 13, title: 'The loop stops at the last page' })).toBe(true)
})

test('a capped round wants a read as deep as it over the same commit, and a shallower one settles nothing', () => {
  const head = '1'.repeat(40)
  const at = (n: number, level: Round['level'], capped: boolean): Round => ({ ...round(n, capped ? 4 : 1), head, level, cap: 4 })
  const ledger = (...rounds: Round[]): Ledger => ({ ...emptyLedger('feat/x'), rounds, reviewed: head })
  expect(rereadLevel(ledger(at(1, 'high', false)))).toBe(undefined)
  expect(rereadLevel(ledger(at(1, 'max', true)))).toBe('max')
  expect(rereadLevel(ledger(at(1, 'max', true), at(2, 'xhigh', false)))).toBe('max')
  expect(rereadLevel(ledger(at(1, 'max', true), at(2, 'xhigh', true)))).toBe('max')
  // A read as deep settles it, capped or not.
  expect(rereadLevel(ledger(at(1, 'high', true), at(2, 'high', true)))).toBe(undefined)
  expect(rereadLevel(ledger(at(1, 'high', true), at(2, 'max', false)))).toBe(undefined)
  // A round over an earlier commit owes nothing for this one.
  expect(rereadLevel(ledger({ ...at(1, 'max', true), head: 'b'.repeat(40) }, at(2, 'high', false)))).toBe(undefined)
  expect([atLeast('high', 'max'), atLeast('max', 'high')]).toEqual(['max', 'max'])
})

test('where a commit stands: reviewed, nothing open, read again when capped, then approved when high risk', () => {
  const head = '1'.repeat(40)
  const base = { ...emptyLedger('feat/x'), rounds: [{ ...round(1, 0), head }], reviewed: head }
  expect(standing({ ...base, reviewed: 'b'.repeat(40) }, head).kind).toBe('unreviewed')
  expect(standing({ ...base, findings: [finding({})] }, head).kind).toBe('open')
  expect(standing({ ...base, rounds: [{ ...round(1, 0), head, raised: 4, cap: 4 }] }, head)).toEqual({ kind: 'reread', level: 'high' })
  const high = { ...base, rounds: [{ ...round(1, 0), head, risk: { tier: 'high' as const, why: ['runs commands'] } }] }
  expect(standing(high, head).kind).toBe('approval')
  expect(standing({ ...high, approved: { sha: head, at: 0 } }, head).kind).toBe('ready')
  expect(standing(base, head).kind).toBe('ready')
})
