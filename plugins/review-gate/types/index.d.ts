/** How much a finding weighs: a defect the change made, a small one, or one that was there before. */
export type Severity = 'important' | 'nit' | 'pre-existing'

/** What a finding is about: a defect, a security hole, or a rule of CLAUDE.md or REVIEW.md broken. */
export type FindingKind = 'bug' | 'security' | 'convention'

/** How many reviewers and checkers a round runs. */
export type Depth = 'quick' | 'standard' | 'deep'

/** How much is at stake in a change, as a classifier read it from the code; `high` needs the person's approval at the gate. */
export type Risk = { tier: 'low' | 'medium' | 'high'; why: string[] }

/** One finding the checkers held real, and how it was answered. */
export type Finding = {
  /** `R<round>-<n>`, such as `R2-1`. */
  id: string
  round: number
  kind: FindingKind
  severity: Severity
  file: string
  line: number
  title: string
  detail: string
  evidence: string
  /** How many checkers held it real, of how many answered. */
  votes: { real: number; of: number }
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
  depth: Depth
  risk: Risk
  /** Candidates the reviewers raised, before the vote. */
  raised: number
  /** Findings that passed the vote. */
  kept: number
  /** Earlier findings this round found fixed. */
  fixed: number
  /** Findings open when the round ended, earlier ones included. */
  open: number
  /** Reviewers and checkers whose reply held nothing readable. */
  unread: number
  at: number
  /** How long the round ran, from its start to its record. */
  durationMs?: number
  /** What its agents and the risk check spent: tokens in and out, and the input read from the cache. */
  tokens?: Tokens
  /** Each agent the round ran: how long, how many tool calls, and how it ended. */
  agents?: AgentStat[]
  /**
   * False when the round lost agents it needed, so it found less than it should have: such a round
   * leaves its commit unreviewed.
   */
  complete?: boolean
}

/** One agent of a finished round. */
export type AgentStat = { label: string; ms: number; calls: number; state: 'done' | 'stopped' | 'unread' }

/** Tokens a round spent. `input` counts what was sent at full price, cache writes included. */
export type Tokens = { input: number; output: number; cached: number }

/** A branch's review record, kept in the plugin's own store, outside the repository. */
export type Ledger = {
  version: 1
  branch: string
  rounds: Round[]
  findings: Finding[]
  /** The commit the last round reviewed. */
  reviewed?: string
  /**
   * Who began the branch, and when: its first commit's author and date. A record whose `first` is not
   * the branch's own belongs to an earlier branch of the same name.
   */
  first?: string
  /** The risk the classifier gave the last commit it judged, kept so that commit is not judged twice. */
  riskFor?: { sha: string; risk: Risk }
  /** The round the count toward the cap starts after: the person's `/review-gate more` moves it. */
  streakFrom: number
  /** The person's approval of a high-risk change, good for one commit. */
  approved?: { sha: string; at: number }
}

/** One agent of a round in progress. */
export type AgentRun = {
  id: string
  label: string
  state: 'running' | 'done' | 'stopped'
  startedAt: number
  endedAt?: number
  /** For a reviewer that answered, how many findings it raised. */
  raised?: number
}

/** A round in progress, for the band: its phase, the phase's agents, and the findings raised so far. */
export type Run = {
  round: number
  phase: 'judging' | 'reviewing' | 'checking'
  startedAt: number
  agents: AgentRun[]
  raised: string[]
}

/** What one of the review's agents is doing: its tool calls so far, and its latest. */
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
      /** Each review agent's activity, by its agent id. */
      activity: StateFamily<Activity | null>
    }
  }
}
