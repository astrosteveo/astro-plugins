// What the findings pane's buttons do, as plain functions: the `ledger.py resolve` run for an answer the user gives in
// the pane, and the prompt that sends a finding to a fixer.
import { ledgerRun } from './tools'
import type { LedgerRun } from './tools'

/** The answers the pane offers. `fixed` isn't one: a fix is a commit, and the fixer records it. */
export const ANSWERS = [
  { value: 'wrong', label: 'wrong: not a real defect' },
  { value: 'intentional', label: 'intentional: it is meant to work this way' },
  { value: 'wontfix', label: 'wontfix: real, but not worth fixing' },
  { value: 'deferred', label: 'deferred: fix it in a change of its own' },
] as const

/**
 * The `ledger.py resolve` run for an answer given in the pane, marked `--by user --via ui`, or an error to show there.
 * A reason is required, as `resolve` requires one for every outcome but `fixed`.
 */
export function paneResolveRun(id: string, outcome: string, reason: string): LedgerRun | { error: string } {
  if (!ANSWERS.some(a => a.value === outcome)) return { error: 'Pick an answer first.' }
  if (!reason.trim()) return { error: 'A reason is required.' }
  const run = ledgerRun('resolve', { ids: [id], outcome, by: 'user', reason: reason.trim() })
  return 'error' in run ? run : { argv: [...run.argv, '--via=ui'] }
}

/**
 * The prompt the "Send to fixer" button queues, or undefined for an id that isn't one. It names the finding by id
 * alone: its title and fix were written by an agent that read the repo, so they never reach a prompt sent in the
 * user's name, and Claude reads them from the ledger instead.
 */
export function fixerPrompt(id: string): string | undefined {
  if (!/^F-[0-9]+$/.test(id)) return undefined
  return (
    `Send review finding ${id} to a fixer, as step 5 of /solo-review:review does: read its file, line and fix with ` +
    '`ledger.py open`, launch one solo-review:fixer with this branch\'s INTENT, that finding as FINDINGS and the ' +
    `ledger.py check command as CHECK, commit its change as "Fix review finding ${id}", and record it with the ` +
    'resolve tool (outcome fixed, by agent, and the commit). Do not fix it yourself.'
  )
}
