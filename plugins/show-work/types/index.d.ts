export type StepStatus = 'todo' | 'doing' | 'done' | 'dropped'
export type Step = { text: string; status: StepStatus }
/** `startedAt`, when this goal was first posted, opens the current task. */
export type Plan = { goal: string; steps: Step[]; startedAt?: number }

export type NoteKind = 'decision' | 'assumption' | 'question' | 'finding' | 'risk'
export type Note = {
  id: string
  kind: NoteKind
  text: string
  why?: string
  /** More for whoever opens the note: what Claude saw, where, what it means. */
  detail?: string
  /** When it was posted; a note from before the current task has none or less. */
  at?: number
  isReplied: boolean
  /** The person read it and pressed OK: no reply needed. */
  isOk?: boolean
}

export type Tab =
  | 'now'
  | 'notes'
  | 'pictures'
  | 'activity'
  | 'timeline'
  | 'context'
  | 'tests'
  | 'files'
  | 'commits'
  | 'explorer'
  | 'run'
  | 'git'
  | 'search'

export type ActKind = 'read' | 'edit' | 'run' | 'search' | 'web' | 'agent' | 'tool'
export type ActStatus = 'runs' | 'ok' | 'failed'
export type Act = {
  id: string
  kind: ActKind
  label: string
  /** The command itself, shown under a Bash call's description. */
  detail?: string
  status: ActStatus
  isSubagent: boolean
  /** Calls folded into this row: repeated reads or edits of one file. */
  count?: number
  /** The main-loop turn it ran in, by number. */
  turn?: number
  /** When it started. */
  at?: number
}

/** A turn of the main loop: from the prompt to the answer. */
export type Turn = {
  id: string
  /** Its number in the session, from 1. */
  n: number
  start: number
  end?: number
  reason?: 'answer' | 'aborted' | 'refusal' | 'error'
  calls: number
  failed: number
  /** Tokens in the context window when it ended. */
  context?: number
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number }
}

/** The context window and spend as the session last reported them. */
export type Meter = {
  tokens?: number
  window: number
  percent?: number
  usd?: number
  /** The autocompact buffer: compaction comes at window minus this. */
  buffer?: number
  categories: { name: string; tokens: number }[]
  limits: { kind: string; percentUsed: number }[]
  at: number
}

/** One test run read from a test command's output. */
export type TestRun = {
  id: string
  at: number
  command: string
  passed: number
  failed: number
  /** The command itself failed. */
  isError: boolean
  /** Each test the output named, where it names them. */
  names: { name: string; ok: boolean }[]
}

/** How often a file was read and edited. */
export type Touch = { file: string; reads: number; edits: number; at: number }

/** A file open in the Explorer's preview. */
export type Preview = {
  file: string
  source: string
  lines: number
  isCut: boolean
  isBinary: boolean
  /** The file's line the preview starts at, when it opened at a search hit. */
  start?: number
  /** The line a search hit landed on. */
  hit?: number
}

/** A command run from the Run tab, with the tail of its output. */
export type Job = {
  id: string
  command: string
  status: 'running' | 'ok' | 'failed' | 'stopped'
  code?: number | null
  start: number
  end?: number
  output: string[]
  /** Lines written in all, kept or not. */
  total: number
}

/** A file `git status` names: its index and worktree columns. */
export type GitFile = { path: string; index: string; worktree: string }

export type GitState = {
  branch: string
  ahead: number
  behind: number
  files: GitFile[]
  /** What the last action from the tab came to. */
  note?: string
  isNoteError?: boolean
}

export type Hit = { file: string; line: number; text: string }

export type Search = { query: string; hits: Hit[]; isCut: boolean; error?: string }

/** A row of `git log --graph`: a commit, or a line of the graph alone. */
export type CommitRow = {
  graph: string
  sha?: string
  subject?: string
  when?: string
  refs?: string
  added?: number
  removed?: number
}

/** A changed file's diff, as git gave it when the person pressed the file. */
export type Diff = { file: string; lines: string[]; isCut: boolean }

/** A subagent's lane: its task and what it is doing now. */
export type Lane = {
  /** The subagent's id, which its own tool calls carry as `agentId`. */
  id: string
  /** The Agent call that spawned it. */
  toolUseId: string
  label: string
  type: string
  status: ActStatus
  calls: number
  /** Its latest call, as the activity log words it. */
  last?: string
  at: number
  /** When it stopped. */
  end?: number
}

/** An image frozen as a PNG in the cache, as it was when shown or read. */
export type Picture = {
  id: string
  file: string
  width: number
  height: number
  caption: string
  origin: 'shown' | 'read'
}

/** A ```mermaid block of a reply, rendered once; `error` when it would not. */
export type Diagram = {
  id: string
  file: string
  width: number
  height: number
  error?: string
}

declare module 'claude-code' {
  interface McpToolInputs {
    'mcp__show-work__plan': { goal: string; steps: Step[] }
    'mcp__show-work__note': { kind: NoteKind; text: string; why?: string; detail?: string }
    'mcp__show-work__show': { caption: string; path?: string; svg?: string }
  }
  interface PluginState {
    'show-work': {
      plan: Shaped<Plan | null>
      notes: Shaped<Note[]>
      activity: Shaped<Act[]>
      changed: Shaped<string[]>
      pictures: Shaped<Picture[]>
      diagrams: Shaped<Diagram[]>
      diff: Shaped<Diff | null>
      lanes: Shaped<Lane[]>
      turns: Shaped<Turn[]>
      meter: Shaped<Meter | null>
      tests: Shaped<TestRun[]>
      touches: Shaped<Touch[]>
      commits: Shaped<CommitRow[]>
      tree: Shaped<string[]>
      status: Shaped<Record<string, string>>
      openDirs: Shaped<string[]>
      filter: string
      preview: Shaped<Preview | null>
      jobs: Shaped<Job[]>
      pickedJob: string | null
      git: Shaped<GitState | null>
      search: Shaped<Search | null>
      picked: string | null
      tab: Tab
      showEarlier: boolean
      openNote: string | null
    }
  }
}
