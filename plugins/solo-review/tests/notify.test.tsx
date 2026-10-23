import { describe, expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { reviewNotice } from '../hooks/status'
import type { ReviewRun, ReviewStatus } from '../types'

const RUN: ReviewRun = { round: 1, depth: 'deep', clean: true, check: null, thin: [], ts: 't1', changed_since: false }
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
const FINDING = { id: 'F-7', severity: 'nit', category: 'logic', file: 'a.py', line: 3, title: 't', fix: null }

const CLEAN: ReviewStatus = { ...BASE, last_run: RUN }
const CAPPED: ReviewStatus = { ...BASE, open: [FINDING], nits: 1, last_run: { ...RUN, round: 3, clean: false, ts: 't3' } }
const WAITING: ReviewStatus = { ...BASE, open: [FINDING], nits: 1, last_run: { ...RUN, round: 2, ts: 't2' } }

describe('reviewNotice', () => {
  test('one message for each way a review stops', () => {
    expect(reviewNotice(CLEAN)?.text).toBe('Review of feat/x came back clean (round 1).')
    expect(reviewNotice(CAPPED)?.text).toBe('Review of feat/x stopped at the round cap with 1 finding open.')
    expect(reviewNotice(WAITING)?.text).toBe('Review of feat/x needs you: 1 finding open.')
  })

  test('nothing while a round runs, before any review, outside an opted-in repo, or with fixes awaiting a round', () => {
    expect(reviewNotice({ ...CLEAN, pending: { round: 2, depth: 'quick' } })).toBeNull()
    expect(reviewNotice(BASE)).toBeNull()
    expect(reviewNotice({ opted_in: false })).toBeNull()
    expect(reviewNotice({ ...CLEAN, last_run: { ...RUN, clean: false } })).toBeNull()
  })
})

/** Stands in for the engine: `ledger.py status` answers what `ledger.now` holds; notifications are kept. */
function engine(on: Parameters<TestBody>[1], first: ReviewStatus) {
  const ledger = { now: first, running: false, failing: false }
  const sent: string[] = []
  on('process.run', () => ({
    value: ledger.failing
      ? { exitCode: 1, stdout: '', stderr: 'boom', isStdoutTruncated: false, isStderrTruncated: false }
      : { exitCode: 0, stdout: JSON.stringify(ledger.now), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('agent.list', () => ({
    value: ledger.running ? [{ id: 'a1', description: 'fix', type: 'solo-review:fixer', status: 'running' as const }] : [],
  }))
  on('ui.notify', (_, e) => {
    sent.push(e.text)
    return { value: { isSent: true as const, channel: 'terminal_bell' } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'solo-review-findings' } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__solo-review__${e.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  return { ledger, sent }
}

const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const
const TURN = { answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as const

test('a review that settles after the session starts is notified once', async ($, on) => {
  const { ledger, sent } = engine(on, BASE)
  await $.session.start(START)
  ledger.now = CAPPED
  await $.turn.complete(TURN)
  await $.turn.complete(TURN)
  expect(sent).toEqual(['Review of feat/x stopped at the round cap with 1 finding open.'])
})

test('the state a session opens on is not notified', async ($, on) => {
  const { sent } = engine(on, WAITING)
  await $.session.start(START)
  await $.turn.complete(TURN)
  expect(sent).toEqual([])
})

test('a status read that fails at session start and succeeds later does not notify the state it finds', async ($, on) => {
  const { ledger, sent } = engine(on, WAITING)
  ledger.failing = true
  await $.session.start(START)
  await $.turn.complete(TURN)
  expect(sent).toEqual([])
  ledger.failing = false
  await $.turn.complete(TURN)
  expect(sent).toEqual([])
  ledger.now = CAPPED
  await $.turn.complete(TURN)
  expect(sent).toEqual(['Review of feat/x stopped at the round cap with 1 finding open.'])
})

test("a subagent's turn, or a turn that ends with a fixer still running, sends nothing yet", async ($, on) => {
  const { ledger, sent } = engine(on, BASE)
  await $.session.start(START)
  ledger.now = CLEAN
  await $.turn.complete({ ...TURN, agentId: 'a1' })
  ledger.running = true
  await $.turn.complete(TURN)
  expect(sent).toEqual([])
  ledger.running = false
  await $.turn.complete(TURN)
  expect(sent).toEqual(['Review of feat/x came back clean (round 1).'])
})
