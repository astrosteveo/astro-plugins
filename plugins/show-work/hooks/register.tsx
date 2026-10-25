import { atom, read, update } from 'claude-code'
import type { Color, Register } from 'claude-code'

import type {
  Act,
  ActKind,
  ActStatus,
  Note,
  NoteKind,
  Plan,
  Step,
  StepStatus,
} from '../types'

const PANE = 'show-work'
const TITLE = 'Show work'
const OWN = 'mcp__show-work__'

// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const plan = atom({ plugin: 'show-work', key: 'plan' } as const, null, {
  shape: 'plan-1',
})
const notes = atom({ plugin: 'show-work', key: 'notes' } as const, [], {
  shape: 'notes-1',
})
const activity = atom({ plugin: 'show-work', key: 'activity' } as const, [], {
  shape: 'activity-2',
})
const changed = atom({ plugin: 'show-work', key: 'changed' } as const, [], {
  shape: 'changed-1',
})

const STEP_STATUSES: readonly StepStatus[] = ['todo', 'doing', 'done', 'dropped']
const NOTE_KINDS: readonly NoteKind[] = [
  'decision',
  'assumption',
  'question',
  'finding',
  'risk',
]

// Tools whose calls are bookkeeping, not work worth showing.
const QUIET = new Set([
  'ToolSearch',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'TaskGet',
  'TaskList',
  'AskUserQuestion',
])

const GUIDE = `# Showing your work

The person watches a "Show work" pane beside the chat. Keep it current so they can follow and steer your work without reading every tool call. It already logs your reads, edits and commands by itself.

- For any task of more than a couple of steps, call mcp__show-work__plan first with the goal as you understand it and your steps. Call it again whenever a step starts, finishes or the plan changes; mark exactly one step "doing" while you work.
- Call mcp__show-work__note the moment you:
  - make a choice the person might have made differently ("decision", with the reason in "why");
  - assume something you have not confirmed ("assumption");
  - hit a question only the person can answer ("question"); if you can go on under a stated assumption, note both and keep working rather than stopping;
  - learn something that changes the picture ("finding"), or see a hazard ("risk").
- Give each Bash call a description that says why you run it, not only what it does: the pane shows it as the reason above the command.
- Notes are how you keep the person in the loop without stopping. Once the goal is clear, keep working until it is met; stop only for a question that blocks the work or a snag that needs their direction.
- One short sentence per note. The person can press a note to reply to it, so write each to stand alone.
- Notes do not replace your reply: still say what matters in chat, briefly.`

const PLAN_TOOL = {
  name: 'plan',
  description:
    'Show the person your goal and plan in the Show work pane. Replaces the plan shown. Call it at the start of a multi-step task and whenever a step changes status.',
  isDeferred: false,
  inputSchema: {
    type: 'object',
    properties: {
      goal: {
        type: 'string',
        description: 'The task as you understand it, in one sentence.',
      },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The step, a few words.' },
            status: { type: 'string', enum: STEP_STATUSES },
          },
          required: ['text', 'status'],
        },
      },
    },
    required: ['goal', 'steps'],
  },
} as const

const NOTE_TOOL = {
  name: 'note',
  description:
    'Post a decision, assumption, open question, finding or risk to the Show work pane, where the person can press it to reply.',
  isDeferred: false,
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: NOTE_KINDS },
      text: { type: 'string', description: 'One short sentence.' },
      why: {
        type: 'string',
        description: 'The reason, for a decision or a risk. Optional.',
      },
    },
    required: ['kind', 'text'],
  },
} as const

const TAGS: Record<NoteKind, { tag: string; color: Color }> = {
  decision: { tag: 'decided', color: 'claude' },
  assumption: { tag: 'assume', color: 'warning' },
  question: { tag: 'ask', color: 'suggestion' },
  finding: { tag: 'found', color: 'success' },
  risk: { tag: 'risk', color: 'error' },
}

const STEP_MARK: Record<StepStatus, { mark: string; color?: Color }> = {
  todo: { mark: '·' },
  doing: { mark: '▸', color: 'claude' },
  done: { mark: '✓', color: 'success' },
  dropped: { mark: '✗', color: 'inactive' },
}

const ACT_MARK: Record<ActStatus, { mark: string; color: Color }> = {
  runs: { mark: '…', color: 'warning' },
  ok: { mark: '✓', color: 'success' },
  failed: { mark: '✗', color: 'error' },
}

const firstLine = (text: string) => (text.split('\n')[0] ?? '').trim()

const asText = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

export function readSteps(value: unknown): Step[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap(item => {
    const text = asText(item?.text)
    const status = STEP_STATUSES.includes(item?.status) ? item.status : 'todo'

    return text === '' ? [] : [{ text, status }]
  })
}

export function relative(path: string, cwd: string) {
  return cwd !== '' && path.startsWith(cwd + '/') ? path.slice(cwd.length + 1) : path
}

// What the activity log says for one call, or nothing for a quiet one.
export function describe(
  e: { tool: string; [argument: string]: unknown },
  cwd: string,
): { kind: ActKind; label: string; detail?: string; path?: string } | undefined {
  const tool = String(e.tool)
  if (QUIET.has(tool) || tool.startsWith(OWN)) {
    return undefined
  }

  const path = asText(e.file_path) || asText(e.notebook_path)
  switch (tool) {
    case 'Read':
      return { kind: 'read', label: relative(path, cwd) }
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return { kind: 'edit', label: relative(path, cwd), path }
    case 'Bash': {
      const command = firstLine(asText(e.command))
      const why = asText(e.description)

      return why === ''
        ? { kind: 'run', label: command }
        : { kind: 'run', label: why, detail: command }
    }
    case 'Grep':
    case 'Glob':
      return { kind: 'search', label: asText(e.pattern) }
    case 'WebFetch':
      return { kind: 'web', label: asText(e.url) }
    case 'WebSearch':
      return { kind: 'web', label: asText(e.query) }
    case 'Agent':
      return { kind: 'agent', label: asText(e.description) || 'subagent' }
    default:
      return { kind: 'tool', label: tool.replace(/^mcp__/, '') }
  }
}

export const register: Register = on => {
  let cwd = ''

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    await $.tool.register(PLAN_TOOL)
    await $.tool.register(NOTE_TOOL)
    await $.command.register({
      name: 'work',
      description: "Show Claude's plan, notes and activity in a pane",
      argumentHint: '[clear]',
    })
    void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    return {
      sections: [
        ...composed.sections,
        { id: 'show-work:guide', text: GUIDE, scope: 'session' },
      ],
    }
  })

  on('command.run', { command: 'work' }, async ($, e) => {
    if (asText(e.args) === 'clear') {
      await update($, plan, () => null)
      await update($, notes, () => [])
      await update($, activity, () => [])
      await update($, changed, () => [])

      return { text: 'Show work cleared.' }
    }
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Show work pane opened.' }
  })

  on('tool.call', { tool: 'mcp__show-work__plan' }, async ($, e) => {
    const goal = asText(e.goal)
    const steps = readSteps(e.steps)
    await update($, plan, () => ({ goal, steps }))
    const done = steps.filter(step => step.status === 'done').length

    return { result: `Plan shown: ${done}/${steps.length} steps done.` }
  })

  on('tool.call', { tool: 'mcp__show-work__note' }, async ($, e) => {
    const text = asText(e.text)
    if (text === '') {
      return { deny: 'A note needs text.' }
    }

    const kind = NOTE_KINDS.includes(e.kind as NoteKind)
      ? (e.kind as NoteKind)
      : 'finding'
    const why = asText(e.why)
    const note: Note = {
      id: crypto.randomUUID(),
      kind,
      text,
      ...(why === '' ? {} : { why }),
      isReplied: false,
    }
    await update($, notes, list => [...list, note].slice(-100))

    return { result: `Noted (${kind}).` }
  })

  // A TodoWrite list is a plan too: mirror it while no plan tool call wrote one.
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      const STATUS = { pending: 'todo', in_progress: 'doing', completed: 'done' } as const
      const steps = readSteps(
        (Array.isArray(e.todos) ? e.todos : []).map(todo => ({
          text: todo.content,
          status: STATUS[todo.status as keyof typeof STATUS],
        })),
      )
      await update($, plan, old => ({ goal: old?.goal ?? '', steps }))
    }

    return ran
  })

  on('tool.call', async ($, e, next) => {
    const what = describe(e, cwd)
    if (what === undefined) {
      return next(e)
    }

    const act: Act = {
      id: e.tool_use_id,
      kind: what.kind,
      label: what.label,
      ...(what.detail === undefined ? {} : { detail: what.detail }),
      status: 'runs',
      isSubagent: e.agentId !== undefined,
    }
    await update($, activity, list => [...list, act].slice(-200))
    const ran = await next(e)
    const status: ActStatus =
      ran.deny !== undefined || ran.isError === true ? 'failed' : 'ok'
    await update($, activity, list =>
      list.map(one => (one.id === act.id ? { ...one, status } : one)),
    )
    if (status === 'ok' && what.path !== undefined && what.path !== '') {
      const label = what.label
      await update($, changed, list =>
        list.includes(label) ? list : [...list, label],
      )
    }

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const shown = await read($, plan)
    const noted = await read($, notes)
    const acts = await read($, activity)
    const files = await read($, changed)

    const reply = (note: Note) => async () => {
      const quote = note.text.length > 80 ? note.text.slice(0, 77) + '...' : note.text
      await $.prompt.fill({
        text: `About your ${note.kind} "${quote}": `,
        mode: 'insert',
      })
      await update($, notes, list =>
        list.map(one => (one.id === note.id ? { ...one, isReplied: true } : one)),
      )
    }

    if (shown === null && noted.length === 0 && acts.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>
            Nothing yet. Claude posts its plan, decisions and questions here as it
            works, and logs the files and commands it touches.
          </Text>
        </Box>
      )
    }

    const steps = shown?.steps ?? []
    const done = steps.filter(step => step.status === 'done').length
    const failed = acts.filter(act => act.status === 'failed').length

    return (
      <Box flexDirection="column" gap={1}>
        {shown !== null && (
          <Box flexDirection="column">
            <Text weight="bold">
              Plan{' '}
              <Text dimColor>
                {done}/{steps.length}
              </Text>
            </Text>
            {shown.goal !== '' && <Text italic>{shown.goal}</Text>}
            {steps.map(step => (
              <Text
                dimColor={step.status === 'done'}
                strikethrough={step.status === 'dropped'}
                weight={step.status === 'doing' ? 'bold' : 'regular'}
              >
                <Text color={STEP_MARK[step.status].color}>
                  {STEP_MARK[step.status].mark}
                </Text>{' '}
                {step.text}
              </Text>
            ))}
          </Box>
        )}
        {noted.length > 0 && (
          <Box flexDirection="column">
            <Text weight="bold">
              Notes <Text dimColor>press one to reply</Text>
            </Text>
            {noted.slice(-12).map(note => (
              <Box flexDirection="column">
                <Button key={note.id} plain dimColor={note.isReplied} onPress={reply(note)}>
                  <Text color={TAGS[note.kind].color} weight="bold">
                    {TAGS[note.kind].tag}
                  </Text>{' '}
                  {note.text}
                  {note.isReplied ? ' ↩' : ''}
                </Button>
                {note.why !== undefined && (
                  <Text dimColor>
                    {'  '}why: {note.why}
                  </Text>
                )}
              </Box>
            ))}
          </Box>
        )}
        {acts.length > 0 && (
          <Box flexDirection="column">
            <Text weight="bold">
              Activity{' '}
              <Text dimColor>
                {acts.length} calls, {files.length} files changed
                {failed > 0 ? `, ${failed} failed` : ''}
              </Text>
            </Text>
            {acts.slice(-15).map(act => (
              <Box flexDirection="column">
                <Text wrap="truncate-end" dimColor={act.status === 'ok'}>
                  <Text color={ACT_MARK[act.status].color}>{ACT_MARK[act.status].mark}</Text>{' '}
                  {act.isSubagent ? '↳ ' : ''}
                  {act.kind.padEnd(6)} {act.label}
                </Text>
                {act.detail !== undefined && (
                  <Text wrap="truncate-end" dimColor>
                    {'         $ '}
                    {act.detail}
                  </Text>
                )}
              </Box>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
