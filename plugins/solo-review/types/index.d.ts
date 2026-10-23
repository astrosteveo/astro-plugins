// What `ledger.py status` prints, as the hooks module keeps it in `$.state`.

export type ReviewFinding = {
  id: string
  severity: string
  category: string
  file: string
  line: number | null
  title: string
  fix: string | null
}

export type ReviewRun = {
  round: number
  depth: string
  clean: boolean
  check: string | null
  thin: string[]
  ts: string
  /** Anything outside .review/ changed since the round's snapshot. */
  changed_since: boolean
}

export type ReviewStatus =
  | { opted_in: false }
  | {
      opted_in: true
      branch: string
      default_branch: string | null
      /** The branch's risk tier from its committed files; null on the default branch or before its first commit. */
      tier: 'low' | 'medium' | 'high' | null
      workflow: string
      max_rounds: number
      open: ReviewFinding[]
      important: number
      nits: number
      backlog: number
      last_run: ReviewRun | null
      pending: { round: number; depth: string } | null
    }

declare module 'claude-code' {
  interface PluginState {
    'solo-review': {
      status: ReviewStatus | null
      /** The finding whose answer form is open in the pane, if any. */
      answering: string | null
      /** The answer picked in that form. */
      answer: string
      /** The last action's result or error, shown at the top of the pane. */
      notice: string | null
      /** The key of the review state last notified (or seen as the baseline), so each is notified once. '' is a baseline with nothing to notify; null is no baseline yet. */
      notified: string | null
    }
  }
}
