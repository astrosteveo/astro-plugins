import type { ReviewFinding, ReviewRun, ReviewStatus } from '../types'

/** `ledger.py status` output, or null when it isn't the shape this module reads. */
export function parseStatus(stdout: string): ReviewStatus | null {
  try {
    const value: unknown = JSON.parse(stdout)
    if (typeof value === 'object' && value !== null && typeof (value as { opted_in?: unknown }).opted_in === 'boolean') {
      return value as ReviewStatus
    }
  } catch {
    // not JSON: an error message from the script
  }
  return null
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** The branch's risk tier as words, or undefined when it has none (the default branch, or no commits yet). */
export function riskLabel(s: ReviewStatus): string | undefined {
  if (!s.opted_in || !s.tier) return undefined
  return `${s.tier[0].toUpperCase()}${s.tier.slice(1)} risk`
}

/**
 * The status line for a review state. Undefined clears it: outside an opted-in repo, and on the default branch when
 * nothing is open there. It never says "clean" about code that changed after the round that came back clean. The
 * branch's risk tier follows, since ship lands a Low-risk branch without asking.
 */
export function statusLine(s: ReviewStatus | null): string | undefined {
  if (!s || !s.opted_in) return undefined
  if (s.pending) return `review: round ${s.pending.round} running (${s.pending.depth})`
  const line = reviewState(s)
  const risk = riskLabel(s)
  return line && risk ? `${line} · ${risk}` : line
}

function reviewState(s: Extract<ReviewStatus, { opted_in: true }>): string | undefined {
  const open = s.important + s.nits
  const last = s.last_run
  if (open) {
    const parts = [s.important ? `${s.important} Important` : '', s.nits ? plural(s.nits, 'nit') : '']
    const round = last ? ` · round ${last.round}/${s.max_rounds}` : ''
    return `review: ${open} open (${parts.filter(Boolean).join(', ')})${round}`
  }
  if (s.branch === s.default_branch) return undefined
  if (!last) return 'review: not reviewed yet'
  if (last.changed_since) return `review: changes since round ${last.round}`
  if (last.clean) return `review: clean (round ${last.round})` + (last.thin.length ? ' · thin' : '')
  return `review: findings answered (round ${last.round})`
}

/** One finding as `ledger.py open` prints it: id, severity, where, title. */
export function findingLine(f: ReviewFinding): string {
  return `${f.id} ${f.severity} ${f.file}:${f.line ?? '?'}  ${f.title}`
}

/** The last round in one line: its number and depth, how it ended, its check, and whether it came back thin. */
export function runLine(r: ReviewRun, maxRounds: number): string {
  const parts = [`Last round: ${r.round}/${maxRounds} (${r.depth}), ${r.clean ? 'clean' : 'had findings'}`]
  if (r.check) parts.push(`check ${r.check}`)
  if (r.thin.length) parts.push(`thin: ${r.thin.join(', ')}`)
  if (r.changed_since) parts.push('changed since')
  return parts.join(' · ')
}

/** The findings as plain text, for the command's output row (and surfaces where the pane isn't placed). */
export function summary(s: ReviewStatus | null): string {
  if (!s) return 'solo-review: the review ledger could not be read.'
  if (!s.opted_in) return "solo-review isn't set up in this repo (it has no .review/): run /solo-review:setup."
  const risk = riskLabel(s)
  const where = risk ? `${s.branch} (${risk})` : s.branch
  const head = s.open.length ? `${plural(s.open.length, 'open finding')} on ${where}:` : `No open findings on ${where}.`
  const lines = [head, ...s.open.map(findingLine)]
  if (s.last_run) lines.push(runLine(s.last_run, s.max_rounds))
  if (s.backlog) lines.push(`Backlog: ${s.backlog} deferred pre-existing (/solo-review:review backlog).`)
  return lines.join('\n')
}

/**
 * The desktop notification for where a review stands, with a key that changes when the ledger does, or null when
 * there is nothing to tell: no review yet, a round running, or fixes recorded and the next round still to come.
 */
export function reviewNotice(s: ReviewStatus | null): { key: string; text: string } | null {
  if (!s || !s.opted_in || !s.last_run || s.pending) return null
  const last = s.last_run
  const open = s.important + s.nits
  let text: string
  if (last.clean && !open) text = `Review of ${s.branch} came back clean (round ${last.round}).`
  else if (open && !last.clean && last.round >= s.max_rounds)
    text = `Review of ${s.branch} stopped at the round cap with ${plural(open, 'finding')} open.`
  else if (open) text = `Review of ${s.branch} needs you: ${plural(open, 'finding')} open.`
  else return null
  return { key: `${s.branch}|${last.ts}|${open}`, text }
}
