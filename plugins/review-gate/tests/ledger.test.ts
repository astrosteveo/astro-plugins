import { expect, test } from 'claude-code/testing'
import type { Finding, Ledger, Round } from '../types'
import { classify, emptyLedger, fixedIds, fresh, globTest, merge, parseGuide, parseLedger, rank, streak, tally } from '../hooks/ledger'
import type { Candidate, CheckerReply, Kept } from '../hooks/ledger'
import { lastJson, readFindings, readVerdicts } from '../hooks/prompts'

const candidate = (over: Partial<Candidate>): Candidate => ({
  file: 'src/app.ts',
  line: 12,
  title: 'A defect',
  detail: '',
  evidence: '',
  severity: 'important',
  introduced: true,
  kind: 'bug',
  focus: 'logic',
  raisedBy: 1,
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
  evidence: '',
  votes: { real: 3, of: 3 },
  status: 'open',
  ...over,
})

const round = (n: number, open: number): Round => ({
  n,
  head: `${n}`.repeat(40),
  from: 'b'.repeat(40),
  scope: 'full',
  depth: 'standard',
  risk: { tier: 'medium', why: [] },
  raised: open,
  kept: open,
  fixed: 0,
  open,
  unread: 0,
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

test("a REVIEW.md's Skip and Needs a person lists speak for its own folder", () => {
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
    '## Needs a person',
    '',
    '- hooks/register.ts',
    '',
    '## Style',
    '',
    '- not-a-glob-list',
  ].join('\n')
  expect(parseGuide('plugins/gates/REVIEW.md', text)).toEqual({
    path: 'plugins/gates/REVIEW.md',
    text,
    skip: ['/plugins/gates/**/*.lock', '/plugins/gates/**/generated/'],
    person: ['/plugins/gates/hooks/register.ts'],
  })
  expect(parseGuide('REVIEW.md', '## Skip\n- *.lock\n').skip).toEqual(['*.lock'])
  const guide = parseGuide('plugins/gates/REVIEW.md', text)
  expect(globTest(guide.skip[1] ?? '')('plugins/gates/generated/table.ts')).toBe(true)
  expect(globTest(guide.skip[1] ?? '')('plugins/other/generated/table.ts')).toBe(false)
})

test('a change touching a path a person approves is high risk, docs alone low, the rest medium', () => {
  expect(classify(['README.md', 'docs/setup.md'], [])).toEqual({ tier: 'low', why: ['it changes only docs'] })
  expect(classify(['src/app.ts', 'README.md'], [])).toEqual({ tier: 'medium', why: [] })
  expect(classify(['src/app.ts', '.github/workflows/ci.yml'], [])).toEqual({
    tier: 'high',
    why: ['it changes .github/workflows/ci.yml, a path a person approves'],
  })
  expect(classify(['plugins/gates/hooks/register.ts', 'Dockerfile'], ['/plugins/gates/hooks/register.ts'])).toEqual({
    tier: 'high',
    why: ['it changes plugins/gates/hooks/register.ts, Dockerfile, paths a person approves'],
  })
})

test('reports of one defect merge, keeping the gravest word; a defect the branch had before is not raised again', () => {
  const merged = merge([
    candidate({ line: 42, title: 'Token compared with == lets two tokens match', detail: 'The token check uses == so different tokens match.', severity: 'nit' }),
    candidate({ line: 43, title: 'Loose == compare of the token', detail: 'Different tokens match because the token check uses ==.', kind: 'security', focus: 'security' }),
    candidate({ file: 'src/other.ts', line: 42, title: 'Token compared with == lets two tokens match' }),
  ])
  expect(merged.map(one => [one.file, one.line, one.raisedBy, one.severity, one.kind])).toEqual([
    ['src/app.ts', 42, 2, 'important', 'security'],
    ['src/other.ts', 42, 1, 'important', 'bug'],
  ])
  const earlier = [finding({ file: 'src/other.ts', line: 60, title: 'Token compared with == lets two tokens match', status: 'dismissed' })]
  expect(fresh(merged, earlier).map(one => one.file)).toEqual(['src/app.ts'])
})

test('a candidate most checkers hold real is kept, graded by what most of them say', () => {
  const candidates = [
    candidate({ title: 'Real and new', kind: 'security' }),
    candidate({ title: 'Real to one checker only' }),
    candidate({ title: 'Real but old' }),
    candidate({ title: 'Real but small' }),
  ]
  const vote = (id: string, real: boolean, introduced = true, severity: 'important' | 'nit' = 'important', kind?: 'bug' | 'security') => ({
    id,
    real,
    introduced,
    severity,
    ...(kind === undefined ? {} : { kind }),
    why: '',
  })
  // C1 was raised as a security hole; both checkers who hold it real call it a bug.
  const replies: CheckerReply[] = [
    { verdicts: [vote('C1', true, true, 'important', 'bug'), vote('C2', true), vote('C3', true, false), vote('C4', true, true, 'nit')], earlier: [{ id: 'R1-1', fixed: true, why: '' }] },
    { verdicts: [vote('C1', true, true, 'important', 'bug'), vote('C2', false), vote('C3', true, false), vote('C4', true, true, 'nit')], earlier: [{ id: 'R1-1', fixed: true, why: '' }] },
    { verdicts: [vote('C1', false), vote('C3', true)], earlier: [{ id: 'R1-1', fixed: false, why: '' }, { id: 'R1-2', fixed: true, why: '' }] },
  ]
  const kept = tally(candidates, replies)
  expect(kept.map(one => [one.title, one.grade, one.kind, one.votes])).toEqual([
    ['Real and new', 'important', 'bug', { real: 2, of: 3 }],
    ['Real but old', 'pre-existing', 'bug', { real: 3, of: 3 }],
    ['Real but small', 'nit', 'bug', { real: 2, of: 3 }],
  ])
  expect(fixedIds([finding({ id: 'R1-1' }), finding({ id: 'R1-2' })], replies)).toEqual(['R1-1'])
  expect(tally(candidates, [])).toEqual([])
})

test('findings rank gravest first, security first among equals, and nits stop at the cap', () => {
  const kept = (title: string, grade: Kept['grade'], real: number, kind: Kept['kind'] = 'bug'): Kept => ({
    ...candidate({ title, kind }),
    grade,
    votes: { real, of: 3 },
  })
  const ranked = rank([
    kept('nit a', 'nit', 2),
    kept('old', 'pre-existing', 3),
    kept('bug', 'important', 2),
    kept('nit b', 'nit', 3),
    kept('hole', 'important', 2, 'security'),
    kept('nit c', 'nit', 3),
    kept('nit d', 'nit', 2),
  ])
  expect(ranked.map(one => one.title)).toEqual(['hole', 'bug', 'old', 'nit b', 'nit c', 'nit a'])
})

test('the cap counts the rounds in a row that ended with findings open, from where the person last allowed more', () => {
  const ledger: Ledger = { ...emptyLedger('feat/x'), rounds: [round(1, 2), round(2, 0), round(3, 3), round(4, 1)] }
  expect(streak(ledger)).toBe(2)
  expect(streak({ ...ledger, rounds: [...ledger.rounds, round(5, 1)] })).toBe(3)
  expect(streak({ ...ledger, streakFrom: 4 })).toBe(0)
  expect(streak(emptyLedger('feat/x'))).toBe(0)
})

test('a record in another shape reads as none', () => {
  expect(parseLedger(undefined, 'feat/x')).toEqual(emptyLedger('feat/x'))
  expect(parseLedger('not json', 'feat/x')).toEqual(emptyLedger('feat/x'))
  expect(parseLedger('{"version": 2, "rounds": [], "findings": []}', 'feat/x')).toEqual(emptyLedger('feat/x'))
  const stored = { ...emptyLedger('feat/x'), reviewed: 'a'.repeat(40), rounds: [round(1, 0)] }
  expect(parseLedger(JSON.stringify(stored), 'feat/x')).toEqual(stored)
})

test("an agent's reply is read from its last json block, or its last object", () => {
  expect(lastJson('Found one.\n\n```json\n{"findings": [{"file": "a.ts"}]}\n```')).toEqual({ findings: [{ file: 'a.ts' }] })
  expect(lastJson('```json\n{"findings": []}\n```\nThen I fixed it:\n```json\n{"findings": [\n```')).toEqual({ findings: [] })
  expect(lastJson('Nothing found. {"findings": []}')).toEqual({ findings: [] })
  expect(lastJson('No json here.')).toBe(undefined)
})

test("a reviewer's findings are normalised and a reply with no list reads as unread", () => {
  const reply = `\`\`\`json
{"findings": [
  {"file": "./src/app.ts", "line": 12, "title": "Off by one", "detail": "The last page is skipped.", "evidence": "i < n - 1", "severity": "important", "introduced": true, "kind": "bug"},
  {"file": "b/src/auth.ts", "line": "7", "title": "Token in the log", "severity": "minor"},
  {"file": "src/x.ts", "title": ""},
  "junk"
]}
\`\`\``
  expect(readFindings(reply, 'security')).toEqual([
    candidate({ file: 'src/app.ts', line: 12, title: 'Off by one', detail: 'The last page is skipped.', evidence: 'i < n - 1', focus: 'security' }),
    candidate({ file: 'src/auth.ts', line: 0, title: 'Token in the log', kind: 'security', focus: 'security' }),
  ])
  expect(readFindings('I could not finish.', 'logic')).toBe(undefined)
})

test("a checker's votes are read, and a reply with neither list reads as unread", () => {
  const reply =
    '```json\n{"verdicts": [{"id": "C1", "real": true, "introduced": false, "severity": "nit", "kind": "security", "why": "old"}, {"id": "C2", "kind": "style"}, {"real": true}], "earlier": [{"id": "R1-1", "fixed": true}]}\n```'
  expect(readVerdicts(reply)).toEqual({
    verdicts: [
      { id: 'C1', real: true, introduced: false, severity: 'nit', kind: 'security', why: 'old' },
      { id: 'C2', real: false, introduced: true, severity: 'important', why: '' },
    ],
    earlier: [{ id: 'R1-1', fixed: true, why: '' }],
  })
  expect(readVerdicts('```json\n{"findings": []}\n```')).toBe(undefined)
})
