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

export type Tab = 'now' | 'notes' | 'pictures' | 'activity'

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
      picked: string | null
      tab: Tab
      showEarlier: boolean
      openNote: string | null
    }
  }
}
