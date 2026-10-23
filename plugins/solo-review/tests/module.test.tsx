import { describe, expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { statusLine, summary } from '../hooks/status'
import type { ReviewStatus } from '../types'

const BASE = {
  opted_in: true,
  branch: 'feat/x',
  default_branch: 'main',
  tier: null,
  workflow: 'auto',
  max_rounds: 3,
  open: [],
  important: 0,
  nits: 0,
  backlog: 0,
  last_run: null,
  pending: null,
} as const satisfies ReviewStatus

const RUN = { round: 2, depth: 'standard', clean: false, check: 'passed: ok', thin: [], ts: '', changed_since: false }

const OPEN: ReviewStatus = {
  ...BASE,
  open: [
    { id: 'F-7', severity: 'important', category: 'logic', file: 'a.py', line: 3, title: 'off by one', fix: 'use <=' },
    { id: 'F-8', severity: 'nit', category: 'logic', file: 'b.py', line: null, title: 'wrong message', fix: null },
  ],
  important: 1,
  nits: 1,
  backlog: 2,
  last_run: RUN,
}

describe('statusLine', () => {
  test('says nothing outside an opted-in repo, or on the default branch with nothing open', () => {
    expect(statusLine(null)).toBeUndefined()
    expect(statusLine({ opted_in: false })).toBeUndefined()
    expect(statusLine({ ...BASE, branch: 'main' })).toBeUndefined()
  })

  test('counts open findings and names the round', () => {
    expect(statusLine(OPEN)).toBe('review: 2 open (1 Important, 1 nit) · round 2/3')
  })

  test('shows a round in progress first', () => {
    expect(statusLine({ ...OPEN, pending: { round: 3, depth: 'quick' } })).toBe('review: round 3 running (quick)')
  })

  test('never calls changed code clean', () => {
    const clean = { ...RUN, clean: true }
    expect(statusLine({ ...BASE, last_run: clean })).toBe('review: clean (round 2)')
    expect(statusLine({ ...BASE, last_run: { ...clean, thin: ['security'] } })).toBe('review: clean (round 2) · thin')
    expect(statusLine({ ...BASE, last_run: { ...clean, changed_since: true } })).toBe('review: changes since round 2')
    expect(statusLine(BASE)).toBe('review: not reviewed yet')
  })

  test("ends with the branch's risk tier, which says whether ship lands it alone", () => {
    expect(statusLine({ ...BASE, tier: 'low', last_run: { ...RUN, clean: true } })).toBe('review: clean (round 2) · Low risk')
    expect(statusLine({ ...OPEN, tier: 'high' })).toBe('review: 2 open (1 Important, 1 nit) · round 2/3 · High risk')
    expect(statusLine({ ...BASE, tier: 'medium' })).toBe('review: not reviewed yet · Medium risk')
    expect(statusLine({ ...OPEN, tier: 'low', pending: { round: 3, depth: 'quick' } })).toBe('review: round 3 running (quick)')
  })
})

test('the text summary names the risk tier after the branch', () => {
  expect(summary({ ...BASE, tier: 'low' }).split('\n')[0]).toBe('No open findings on feat/x (Low risk).')
  expect(summary({ ...OPEN, tier: 'high' }).split('\n')[0]).toBe('2 open findings on feat/x (High risk):')
  expect(summary(BASE).split('\n')[0]).toBe('No open findings on feat/x.')
})

/** Stands in for the engine beneath the module: `ledger.py status` answers `stdout`; status lines are kept. */
function engine(on: Parameters<TestBody>[1], stdout: string, exitCode = 0) {
  const shown: (string | undefined)[] = []
  on('process.run', () => ({
    value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('ui.status', (_, e) => {
    shown.push(e.text)
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'solo-review-findings' } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__solo-review__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  return shown
}

const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const
const TURN = { answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as const

test('the status line follows the ledger at session start and after each turn', async ($, on) => {
  const shown = engine(on, JSON.stringify(OPEN))
  await $.session.start(START)
  await $.turn.complete(TURN)
  expect(shown).toEqual([statusLine(OPEN), statusLine(OPEN)])
})

test('outside an opted-in repo the status line is cleared', async ($, on) => {
  const shown = engine(on, JSON.stringify({ opted_in: false }))
  await $.session.start(START)
  expect(shown).toEqual([undefined])
})

test('a failing ledger.py leaves the status line alone', async ($, on) => {
  const shown = engine(on, 'Traceback ...', 1)
  await $.session.start(START)
  await $.turn.complete(TURN)
  expect(shown).toEqual([])
})

test('the command answers with the findings as text', async ($, on) => {
  engine(on, JSON.stringify(OPEN))
  await $.session.start(START)
  const ran = await $.command.run({
    command: 'solo-review-findings',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })
  expect(ran.text).toBe(summary(OPEN))
})

const PANE = {
  plugin: 'solo-review',
  component: 'Pane',
  requestId: 'solo-review-findings',
  props: {
    title: 'Review findings',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

test('the pane lists open findings, on every surface', async ($, on) => {
  engine(on, JSON.stringify(OPEN))
  await $.session.start(START)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /F-7/ }))?.text).toBe('F-7 important a.py:3  off by one')
    expect((await ui.find({ type: 'Text', text: /F-8/ }))?.text).toBe('F-8 nit b.py:?  wrong message')
    expect(await ui.find({ type: 'Text', text: /Backlog: 2/ })).toBeDefined()
    await ui.unmount()
  }
})

test("the pane's heading names the risk tier", async ($, on) => {
  engine(on, JSON.stringify({ ...OPEN, tier: 'low' }))
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /feat\/x/ }))?.text).toBe('feat/x · 1 Important, 1 nit(s) open · Low risk')
  await ui.unmount()
})

test('outside an opted-in repo the pane says how to set it up', async ($, on) => {
  engine(on, JSON.stringify({ opted_in: false }))
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /setup/ }))?.text).toBe(summary({ opted_in: false }))
  await ui.unmount()
})
