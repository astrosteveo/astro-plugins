// The ledger tools the review loop calls instead of writing temp files and running `ledger.py` through Bash. Each
// tool turns its typed input into an argv and a stdin for `ledger.py`, run without a shell, so text that came from the
// repo (a check's output, a finder's evidence) never reaches a command line.
import type { ToolSpec } from 'claude-code'

/** A `ledger.py` run: its arguments after the script, and what goes to its stdin. */
export type LedgerRun = { argv: string[]; stdin?: string }

const FINDING = {
  type: 'object',
  properties: {
    file: { type: 'string' },
    line: { type: ['integer', 'null'] },
    severity: { type: 'string', enum: ['important', 'nit', 'pre-existing'] },
    category: { type: 'string' },
    title: { type: 'string' },
    evidence: { type: 'string' },
    fix: { type: 'string' },
    votes: { type: 'string', description: '"2/3" or "3/3" at deep depth' },
    verified: { type: 'string', description: "the `why` of a vote that called it real" },
  },
  required: ['file', 'title', 'severity'],
}

const COUNT = { type: 'integer', minimum: 0 }

export const TOOLS = {
  record: {
    name: 'record',
    description:
      "solo-review: record the pending review round (after `ledger.py scope`) in the ledger: the round's surviving " +
      'findings and counts. Same payload as `ledger.py record`; prints the round summary.',
    isDeferred: false,
    inputSchema: {
      type: 'object',
      properties: {
        candidates: { ...COUNT, description: 'candidates before verification' },
        findings: { type: 'array', items: FINDING },
        resolved_by_change: { type: 'array', items: { type: 'string' }, description: 'RECHECK ids voted gone' },
        nits_found: { ...COUNT, description: 'nits among the survivors before the nit cap' },
        rejected: { ...COUNT, description: 'candidates voted false' },
        rejected_guide: { ...COUNT, description: 'false votes marked "guide": true' },
        thin: { type: 'array', items: { type: 'string' }, description: 'lenses still suspect after their retry' },
      },
      required: ['candidates', 'findings'],
    },
  },
  check_record: {
    name: 'check_record',
    description:
      "solo-review: store the result of the check command you ran (`ledger.py check` prints it) in the pending round. " +
      'Give its exit status and a one-line summary of its output.',
    isDeferred: false,
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'integer' }, summary: { type: 'string' } },
      required: ['status', 'summary'],
    },
  },
  resolve: {
    name: 'resolve',
    description:
      'solo-review: record an outcome for one or more findings, as `ledger.py resolve` does. A reason is required ' +
      "unless the outcome is fixed; `commit` names a fix's commit.",
    isDeferred: false,
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string', pattern: '^[Ff]?-?[0-9]+$' }, minItems: 1 },
        outcome: { type: 'string', enum: ['fixed', 'wrong', 'intentional', 'wontfix', 'deferred', 'merged-past'] },
        reason: { type: 'string' },
        by: { type: 'string', enum: ['user', 'agent'] },
        commit: { type: 'string' },
      },
      required: ['ids', 'outcome', 'by'],
    },
  },
} as const satisfies Record<string, ToolSpec>

export type LedgerTool = keyof typeof TOOLS

/** The tool's own name from the name the model calls it by, `mcp__solo-review__<name>`. */
export function toolName(full: string): LedgerTool | undefined {
  const name = full.replace(/^mcp__solo-review__/, '')
  return name in TOOLS && full !== name ? (name as LedgerTool) : undefined
}

const RECORD_KEYS = ['candidates', 'findings', 'resolved_by_change', 'nits_found', 'rejected', 'rejected_guide', 'thin']

/**
 * The `ledger.py` run for a tool call, or an error the model reads. Only the schema's own fields are passed on: the
 * call's input also carries the engine's (`tool`, `tool_use_id`, ...).
 */
export function ledgerRun(tool: LedgerTool, input: Record<string, unknown>): LedgerRun | { error: string } {
  if (tool === 'record') {
    const payload = Object.fromEntries(RECORD_KEYS.filter(k => k in input).map(k => [k, input[k]]))
    return { argv: ['record'], stdin: JSON.stringify(payload) }
  }
  if (tool === 'check_record') {
    if (!Number.isInteger(input.status)) return { error: '`status` must be the check\'s exit status, an integer.' }
    return { argv: ['check', '--record', '--status', String(input.status)], stdin: String(input.summary ?? '') }
  }
  const ids = Array.isArray(input.ids) ? input.ids : []
  // an id is a value, never an option: each is rewritten as F-<n>, and anything else is refused
  if (!ids.length || !ids.every(id => typeof id === 'string' && /^[Ff]?-?[0-9]+$/.test(id))) {
    return { error: '`ids` must list finding ids such as F-12.' }
  }
  const commit = typeof input.commit === 'string' ? input.commit : ''
  // ledger.py hands the commit to `git rev-parse`, where a leading `-` would read as an option
  if (commit && !/^[A-Za-z0-9][A-Za-z0-9._/~^@{}-]*$/.test(commit)) return { error: '`commit` must name a commit.' }
  const normalized = (ids as string[]).map(id => `F-${id.replace(/^[Ff]?-?/, '')}`)
  const argv = ['resolve', ...normalized, `--as=${String(input.outcome)}`, `--by=${String(input.by)}`]
  if (typeof input.reason === 'string' && input.reason) argv.push(`--reason=${input.reason}`)
  if (commit) argv.push(`--commit=${commit}`)
  return { argv }
}
