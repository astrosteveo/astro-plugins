export type StepStatus = 'todo' | 'doing' | 'done' | 'dropped'
export type Step = { text: string; status: StepStatus }
/** `startedAt`, when this goal was first posted, opens the current task. */
export type Plan = { goal: string; steps: Step[]; startedAt?: number }

/** `find` is not a tab of the bar: the search box brings it up. */
export type Tab = 'now' | 'pictures' | 'changes' | 'tests' | 'git' | 'find'

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
export type Touch = { file: string; reads: number; edits: number; at: number; added?: number; removed?: number }

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
  /** A markdown file, drawn as markdown; `isRaw` shows its source instead. */
  isMarkdown?: boolean
  isRaw?: boolean
  /** An image file, drawn as a picture: its one entry in `images`. */
  isImage?: boolean
  /** The local pictures it draws, each copied into the cache as a PNG. */
  images?: { ref: string; alt: string; file: string; width: number; height: number }[]
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
  /** A sheet's labels, one per tile in order, for the person to pick from. */
  tiles?: string[]
  /** The marks drawn on it, in its own pixels, in their numbered order. */
  marks?: { x: number; y: number; w?: number; h?: number; note: string; detail?: string }[]
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
    'mcp__show-work__show': {
      caption: string
      d2?: string
      mermaid?: string
      dot?: string
      html?: string
      width?: number
      height?: number
      svg?: string
      path?: string
      url?: string
      images?: { src: string; label?: string }[]
      marks?: { x: number; y: number; w?: number; h?: number; note: string; detail?: string }[]
    }
  }
  interface PluginState {
    'show-work': {
      plan: Shaped<Plan | null>
      activity: Shaped<Act[]>
      pictures: Shaped<Picture[]>
      diagrams: Shaped<Diagram[]>
      diff: Shaped<Diff | null>
      lanes: Shaped<Lane[]>
      turns: Shaped<Turn[]>
      tests: Shaped<TestRun[]>
      touches: Shaped<Touch[]>
      tree: Shaped<string[]>
      status: Shaped<Record<string, string>>
      openDirs: Shaped<string[]>
      filter: string
      /** How many times taller than wide the terminal's cells are. */
      cellTall: number
      preview: Shaped<Preview | null>
      git: Shaped<GitState | null>
      search: Shaped<Search | null>
      picked: string | null
      tab: Tab
      /** What the Find tab searches: file names or text. */
      findMode: 'files' | 'text'
      /** Whether the viewers wrap long lines or cut them at the edge. */
      wrapLines: boolean
      /** The lines dragged over in a viewer, 0-based, and which viewer: a file path, or `diff:` and one. */
      /** Quoted lines waiting in the prompt behind a short marker, swapped in on send. */
      refs: { marker: string; text: string }[]
      /** What the person's selection put in the prompt, and where it came from: a file path, `diff:` and one, or `hits`. */
      viewSel: { id: string; label: string } | null
    }
  }
}
