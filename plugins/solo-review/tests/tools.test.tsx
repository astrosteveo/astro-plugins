import { describe, expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { ledgerRun, toolName } from '../hooks/tools'

describe('ledgerRun', () => {
  test('record passes only the payload fields, on stdin', () => {
    const run = ledgerRun('record', { tool: 'mcp__solo-review__record', tool_use_id: 't', candidates: 1, findings: [] })
    expect(run).toEqual({ argv: ['record'], stdin: '{"candidates":1,"findings":[]}' })
  })

  test("check_record keeps the repo's output off the command line", () => {
    const run = ledgerRun('check_record', { status: 2, summary: 'failed: $(rm -rf ~)' })
    expect(run).toEqual({ argv: ['check', '--record', '--status', '2'], stdin: 'failed: $(rm -rf ~)' })
    expect('error' in ledgerRun('check_record', { status: '0', summary: '' })).toBe(true)
  })

  test('resolve passes ids as values and every other field as --name=value', () => {
    const run = ledgerRun('resolve', { ids: ['f12', '-3'], outcome: 'wontfix', by: 'user', reason: '--by=agent' })
    expect(run).toEqual({ argv: ['resolve', 'F-12', 'F-3', '--as=wontfix', '--by=user', '--reason=--by=agent'] })
  })

  test('resolve refuses an id or commit that could read as an option', () => {
    expect('error' in ledgerRun('resolve', { ids: ['--all'], outcome: 'fixed', by: 'agent' })).toBe(true)
    expect('error' in ledgerRun('resolve', { ids: [], outcome: 'fixed', by: 'agent' })).toBe(true)
    expect('error' in ledgerRun('resolve', { ids: ['F-1'], outcome: 'fixed', by: 'agent', commit: '--git-dir=x' })).toBe(
      true,
    )
    expect(ledgerRun('resolve', { ids: ['F-1'], outcome: 'fixed', by: 'agent', commit: 'abc123' })).toEqual({
      argv: ['resolve', 'F-1', '--as=fixed', '--by=agent', '--commit=abc123'],
    })
  })

  test('toolName knows only this plugin\'s tools', () => {
    expect(toolName('mcp__solo-review__record')).toBe('record')
    expect(toolName('record')).toBeUndefined()
    expect(toolName('mcp__other__record')).toBeUndefined()
  })
})

type Ran = { argv: readonly string[]; stdin?: string }

/** Stands in for the engine: every `ledger.py` run is kept; `record` and `resolve` answer `out` with `exitCode`. */
function engine(on: Parameters<TestBody>[1], out: string, exitCode = 0) {
  const runs: Ran[] = []
  on('process.run', (_, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin })
    const isStatus = e.argv[e.argv.length - 1] === 'status'
    return {
      value: {
        exitCode: isStatus ? 0 : exitCode,
        stdout: isStatus ? '{"opted_in": false}' : out,
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('ui.status', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'solo-review-findings' } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__solo-review__${e.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return runs
}

const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const

test('the record tool runs ledger.py record with its payload on stdin', async ($, on) => {
  const runs = engine(on, '0 findings. Round 1, quick')
  await $.session.start(START)
  const ran = await $.tool.call({ tool: 'mcp__solo-review__record', candidates: 0, findings: [] })
  const record = runs.find(r => r.argv.includes('record'))
  expect(record?.argv.slice(-1)).toEqual(['record'])
  expect(record?.stdin).toBe('{"candidates":0,"findings":[]}')
  expect(ran.deny).toBeUndefined()
})

test("a ledger.py error comes back to the model as the tool's error", async ($, on) => {
  engine(on, 'record: `findings` must be a list.', 1)
  await $.session.start(START)
  // a call from a test (a plugin's own) reads the model's error result as `{ deny }`
  const ran = await $.tool.call({ tool: 'mcp__solo-review__record', candidates: 0, findings: 'x' })
  expect(ran.deny).toBe('record: `findings` must be a list.')
})

test('a resolve the tool refuses never runs ledger.py', async ($, on) => {
  const runs = engine(on, '')
  await $.session.start(START)
  const ran = await $.tool.call({ tool: 'mcp__solo-review__resolve', ids: ['--all'], outcome: 'fixed', by: 'agent' })
  expect(ran.deny).toBe('`ids` must list finding ids such as F-12.')
  expect(runs.some(r => r.argv.includes('resolve'))).toBe(false)
})
