export type StepStatus = 'todo' | 'doing' | 'done' | 'dropped'
export type Step = { text: string; status: StepStatus }
export type Plan = { goal: string; steps: Step[] }

export type NoteKind = 'decision' | 'assumption' | 'question' | 'finding' | 'risk'
export type Note = {
  id: string
  kind: NoteKind
  text: string
  why?: string
  isReplied: boolean
}

export type ActKind = 'read' | 'edit' | 'run' | 'search' | 'web' | 'agent' | 'tool'
export type ActStatus = 'runs' | 'ok' | 'failed'
export type Act = {
  id: string
  kind: ActKind
  label: string
  status: ActStatus
  isSubagent: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'show-work': {
      plan: Shaped<Plan | null>
      notes: Shaped<Note[]>
      activity: Shaped<Act[]>
      changed: Shaped<string[]>
    }
  }
}
