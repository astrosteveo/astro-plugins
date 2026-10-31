/** How much a finding weighs: a defect the change made, a small one, or one that was there before. */
export type Severity = 'important' | 'nit' | 'pre-existing'

/** What a finding is about: a defect, a security hole, or a rule of CLAUDE.md or REVIEW.md broken. */
export type FindingKind = 'bug' | 'security' | 'convention'

/** The /code-review effort level a round runs at: a higher one reads more and finds more, for more tokens. */
export type Level = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** How much is at stake in a change, as a classifier read it from the code; `high` needs the person's approval at the gate. */
export type Risk = { tier: 'low' | 'medium' | 'high'; why: string[] }

/** One finding a round's review reported, and how it was answered. */
export type Finding = {
  /** `R<round>-<n>`, such as `R2-1`. */
  id: string
  round: number
  kind: FindingKind
  severity: Severity
  file: string
  line: number
  /** What goes wrong, in a line. */
  title: string
  /** The defect in a sentence, where the title is a shorter label for it. */
  detail: string
  /** The input or state that sets it off, and what goes wrong then. */
  scenario: string
  /** The review's word for the kind of finding, such as correctness or efficiency. */
  category?: string
  /** Set when the review verified the finding. */
  verdict?: 'confirmed' | 'plausible'
  status: 'open' | 'fixed' | 'dismissed'
  /** The reason it was dismissed, or the commit a later round found it fixed at. */
  answer?: string
  /** The round that found it fixed. */
  closedRound?: number
}

/** One review round: what it covered and what came of it. */
export type Round = {
  n: number
  /** The commit the round reviewed. */
  head: string
  /** Where its diff started: the branch's base for a full round, the last reviewed commit for a delta. */
  from: string
  scope: 'full' | 'delta'
  level: Level
  risk: Risk
  /** Findings the review reported, those the branch had had included. */
  raised: number
  /** Findings the round added. */
  kept: number
  /** Nits the round left out, since the branch had raised as many as it may. */
  nitsLeft?: number
  /** Findings the review reported in files REVIEW.md skips, which the round left out. */
  skippedOut?: number
  /** Earlier findings this round found fixed. */
  fixed: number
  /** Findings open when the round ended, earlier ones included. */
  open: number
  at: number
  /** How long the round ran, from its start to its record. */
  durationMs?: number
  /** The review's tool calls. */
  calls?: number
  /** Set when every file the round covers is on a REVIEW.md Skip list, so no review ran. */
  skipped?: boolean
  /** Set when the commits the round covers change no file, so no review ran. */
  unchanged?: boolean
}

/** A branch's review record, kept in the plugin's own store, outside the repository. */
export type Ledger = {
  version: 2
  branch: string
  rounds: Round[]
  findings: Finding[]
  /** The commit the last round reviewed. */
  reviewed?: string
  /** The risk the classifier gave the last commit it judged, kept so that commit is not judged twice. */
  riskFor?: { sha: string; risk: Risk }
  /** The round the count toward the cap starts after: the person's `/review-gate more` moves it. */
  streakFrom: number
  /** The person's approval of a high-risk change, good for one commit. */
  approved?: { sha: string; at: number }
}

/** A round in progress, for the band. */
export type Run = {
  round: number
  phase: 'judging' | 'reviewing'
  /** The level the review runs at, once the risk has picked it. */
  level?: Level
  startedAt: number
  /** The review's agent, once it has made a tool call. */
  agentId?: string
  /** Rounds the cap left when this one started, this one included, as `capLeftAtStart` gives them. */
  left?: number
}

/** What the review's agent is doing: its tool calls so far, and its latest. */
export type Activity = { calls: number; doing: string }

/** Where the session's repository stands, for the band. */
export type Repo = { branch: string; head: string; main: string; isDefault: boolean; ahead: number }

declare module 'claude-code' {
  interface PluginState {
    'review-gate': {
      repo: Shaped<Repo | null>
      /** The current branch's record, as last loaded or saved. */
      ledger: Shaped<Ledger | null>
      run: Shaped<Run | null>
      /** The review agent's activity, by its agent id. */
      activity: StateFamily<Activity | null>
    }
  }
}
