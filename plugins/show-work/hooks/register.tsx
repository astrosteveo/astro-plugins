import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register } from 'claude-code'

import type {
  Act,
  ActKind,
  ActStatus,
  Note,
  NoteKind,
  Picture,
  Plan,
  Step,
  StepStatus,
  Tab,
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
const pictures = atom({ plugin: 'show-work', key: 'pictures' } as const, [], {
  shape: 'pictures-1',
})
// The picture the pane shows; null shows the newest.
const picked = atom({ plugin: 'show-work', key: 'picked' } as const, null)
const tabAtom = atom({ plugin: 'show-work', key: 'tab' } as const, 'now')
const showEarlier = atom({ plugin: 'show-work', key: 'showEarlier' } as const, false)
// The note opened to show its why, detail and actions; null when none is.
const openNote = atom({ plugin: 'show-work', key: 'openNote' } as const, null)

const KEPT_PICTURES = 30
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i

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
- To show the person a design, mockup, layout, diagram or screenshot, call mcp__show-work__show with an image path or SVG source: it draws the picture in the chat. Reach for it whenever a picture says it faster than words, and before building a visual design, so they can veto it. Give an SVG a background rect and a width of 800 or more. Images you Read land in the pane by themselves.
- One short sentence per note, written to stand alone. The person presses a question to answer it, and opens any other note to read its "why" and "detail", then vetoes, corrects or asks more, or presses OK. So put in "detail" what they need to judge the note: what you saw and where, what it means, what you would do.
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
    'Post a decision, assumption, open question, finding or risk to the Show work pane, where the person can answer a question, or open another note to read more and veto, correct or OK it.',
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
      detail: {
        type: 'string',
        description:
          'Shown when the person opens the note: what you saw and where, what it means, what you would do. Two or three sentences. Optional.',
      },
    },
    required: ['kind', 'text'],
  },
} as const

const SHOW_TOOL = {
  name: 'show',
  description:
    'Draw a picture in the chat for the person: a design, mockup, diagram or screenshot. Give either the path of an image file (PNG, JPEG, GIF, WebP, BMP or SVG) or SVG source.',
  isDeferred: false,
  inputSchema: {
    type: 'object',
    properties: {
      caption: { type: 'string', description: 'What the picture shows, a few words.' },
      path: { type: 'string', description: 'An image file, absolute or relative to the working directory.' },
      svg: { type: 'string', description: 'SVG source, in place of a path.' },
    },
    required: ['caption'],
  },
} as const

// The tag says who wrote the note; the ask says what the person does with it.
const TAGS: Record<NoteKind, { tag: string; ask: string; color: Color }> = {
  decision: { tag: 'I chose', ask: 'veto?', color: 'claude' },
  assumption: { tag: 'I assume', ask: 'correct me?', color: 'warning' },
  question: { tag: 'I ask', ask: 'answer me', color: 'suggestion' },
  finding: { tag: 'I found', ask: 'FYI', color: 'success' },
  risk: { tag: 'Risk', ask: 'heads up', color: 'error' },
}

// What an opened note offers: a reply started in the prompt, then an OK. A
// question has none: pressing it starts the answer at once.
const ACTIONS: Record<Exclude<NoteKind, 'question'>, { reply: string; fill: string; ok: string }> = {
  decision: { reply: 'Veto', fill: "I'd rather ", ok: 'OK' },
  assumption: { reply: 'Correct it', fill: 'Not quite: ', ok: 'Right' },
  finding: { reply: 'Tell me more', fill: 'tell me more.', ok: 'Got it' },
  risk: {
    reply: 'What would you do?',
    fill: 'how likely is it, and what would you do about it?',
    ok: 'Got it',
  },
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

export function replyPrefix(note: Note) {
  const quote = note.text.length > 80 ? note.text.slice(0, 77) + '...' : note.text

  return `About your ${note.kind} "${quote}": `
}

// A prompt replies to a note when it quotes it and says something after.
export function isReplyTo(note: Note, text: string) {
  const prefix = replyPrefix(note)
  const at = text.indexOf(prefix)

  return at >= 0 && text.slice(at + prefix.length).trim() !== ''
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

// Whether a note belongs to the task the plan opened; with no plan, all do.
export function isCurrent(note: Note, since: number | undefined) {
  return since === undefined || (note.at ?? -1) >= since
}

export function absolute(path: string, cwd: string) {
  return path.startsWith('/') || cwd === '' ? path : `${cwd}/${path}`
}

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1)

// Rows a picture takes at a width, a terminal cell being about twice as tall
// as it is wide.
export function rowsFor(picture: Picture, columns: number, most: number) {
  const rows = Math.round((columns * picture.height) / picture.width / 2)

  return Math.max(1, Math.min(most, rows))
}

export function relative(path: string, cwd: string) {
  return cwd !== '' && path.startsWith(cwd + '/') ? path.slice(cwd.length + 1) : path
}

// What the activity log says for one call, or nothing for a quiet one.
export function describe(
  e: { tool: string; [argument: string]: unknown },
  cwd: string,
):
  | { kind: ActKind; label: string; detail?: string; path?: string; image?: string }
  | undefined {
  const tool = String(e.tool)
  if (QUIET.has(tool) || tool.startsWith(OWN)) {
    return undefined
  }

  const path = asText(e.file_path) || asText(e.notebook_path)
  switch (tool) {
    case 'Read':
      return IMAGE.test(path)
        ? { kind: 'read', label: relative(path, cwd), image: path }
        : { kind: 'read', label: relative(path, cwd) }
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

type Source = { path: string } | { svg: string }

// Copies or converts an image into the cache as a PNG, so a later write to
// the same file leaves this picture as it was. Answers why when it can't.
async function freeze(
  $: EngineInterface,
  source: Source,
  id: string,
  caption: string,
  origin: Picture['origin'],
): Promise<Picture | string> {
  const cache = (await $.env.get('XDG_CACHE_HOME')) || `${await $.env.get('HOME')}/.cache`
  const dir = `${cache}/show-work`
  const file = `${dir}/${id}.png`
  await $.process.run(['mkdir', '-p', dir])

  const from = 'path' in source ? source.path : `${dir}/${id}.svg`
  if (from.startsWith(`${dir}/`) && 'path' in source) {
    return 'That picture is already shown.'
  }
  if ('svg' in source) {
    await $.fs.write(from, source.svg)
  } else if (!(await $.fs.exists(from))) {
    return `No image at ${from}.`
  }
  const argv = /\.svg$/i.test(from)
    ? ['rsvg-convert', '-o', file, from]
    : /\.png$/i.test(from)
      ? ['cp', from, file]
      : ['magick', `${from}[0]`, file]
  const made = await $.process.run(argv)
  if (made.exitCode !== 0) {
    return `Could not read the image: ${firstLine(made.stderr) || argv[0]}`
  }

  const size = await $.process.run(['magick', 'identify', '-format', '%w %h', file])
  const [width = 0, height = 0] = size.stdout.split(' ').map(Number)
  const isSized = width > 0 && height > 0

  return isSized
    ? { id, file, width, height, caption, origin }
    : { id, file, width: 16, height: 9, caption, origin }
}

// Keeps the newest pictures and deletes the files of the rest.
async function keep($: EngineInterface, picture: Picture) {
  let dropped: Picture[] = []
  await update($, pictures, list => {
    const all = [...list.filter(one => one.id !== picture.id), picture]
    dropped = all.slice(0, -KEPT_PICTURES)

    return all.slice(-KEPT_PICTURES)
  })
  await update($, picked, () => null)
  if (dropped.length > 0) {
    const files = dropped.flatMap(one => [one.file, one.file.replace(/\.png$/, '.svg')])
    await $.process.run(['rm', '-f', ...files])
  }
}

export const register: Register = on => {
  let cwd = ''

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    await $.tool.register(PLAN_TOOL)
    await $.tool.register(NOTE_TOOL)
    await $.tool.register(SHOW_TOOL)
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

  on('prompt.submit', async ($, e, next) => {
    const entered = await next(e)
    if (entered.drop !== undefined || e.command !== undefined) {
      return entered
    }

    const list = await read($, notes)
    if (list.some(note => !note.isReplied && isReplyTo(note, e.text))) {
      await update($, notes, all =>
        all.map(note => (isReplyTo(note, e.text) ? { ...note, isReplied: true } : note)),
      )
    }

    return entered
  })

  on('command.run', { command: 'work' }, async ($, e) => {
    if (asText(e.args) === 'clear') {
      await update($, plan, () => null)
      await update($, notes, () => [])
      await update($, activity, () => [])
      await update($, changed, () => [])
      await update($, pictures, () => [])
      await update($, picked, () => null)

      return { text: 'Show work cleared.' }
    }
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Show work pane opened.' }
  })

  on('tool.call', { tool: 'mcp__show-work__plan' }, async ($, e) => {
    const goal = asText(e.goal)
    const steps = readSteps(e.steps)
    const now = await $.clock.now()
    await update($, plan, old => ({
      goal,
      steps,
      startedAt: old !== null && old.goal === goal ? (old.startedAt ?? now) : now,
    }))
    await update($, showEarlier, () => false)
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
    const detail = asText(e.detail)
    const note: Note = {
      id: crypto.randomUUID(),
      kind,
      text,
      ...(why === '' ? {} : { why }),
      ...(detail === '' ? {} : { detail }),
      at: await $.clock.now(),
      isReplied: false,
    }
    await update($, notes, list => [...list, note].slice(-100))

    return { result: `Noted (${kind}).` }
  })

  on('tool.call', { tool: 'mcp__show-work__show' }, async ($, e) => {
    const path = asText(e.path)
    const svg = asText(e.svg)
    if (path === '' && svg === '') {
      return { deny: 'Give the path of an image or SVG source.' }
    }

    const source: Source = svg !== '' ? { svg } : { path: absolute(path, cwd) }
    const caption = asText(e.caption) || basename(path) || 'design'
    const id = e.tool_use_id ?? crypto.randomUUID()
    const made = await freeze($, source, id, caption, 'shown')
    if (typeof made === 'string') {
      return { deny: made }
    }
    await keep($, made)

    return {
      result: `Shown in the chat and the pane: ${caption} (${made.width}x${made.height}).`,
    }
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
      const now = await $.clock.now()
      await update($, plan, old => ({
        goal: old?.goal ?? '',
        steps,
        startedAt: old?.startedAt ?? now,
      }))
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
    if (status === 'ok' && what.image !== undefined) {
      const made = await freeze($, { path: what.image }, act.id, what.label, 'read')
      if (typeof made !== 'string') {
        await keep($, made)
      }
    }
    if (status === 'ok' && what.path !== undefined && what.path !== '') {
      const label = what.label
      await update($, changed, list =>
        list.includes(label) ? list : [...list, label],
      )
    }

    return ran
  })

  // A shown picture draws in the chat, under its tool row.
  on(
    'ui.render',
    { component: 'ToolResult', props: { tool: 'mcp__show-work__show' } },
    async ($, e, next) => {
      const picture = (await read($, pictures)).find(
        one => one.id === e.props.tool_use_id,
      )
      if (picture === undefined || e.props.isErrored) {
        return next(e)
      }

      if (e.surface !== 'terminal') {
        const { Text } = $.ui.resolve(e)

        return (
          <Text dimColor>
            {picture.caption}: {picture.file}
          </Text>
        )
      }

      const { Box, Image, Text } = $.ui.resolve(e)
      const columns = Math.max(1, Math.min(100, (e.viewport?.columns ?? 84) - 4))

      return (
        <Box flexDirection="column">
          <Image
            source={{ file: picture.file, format: 'png' }}
            columns={columns}
            rows={rowsFor(picture, columns, 40)}
            alt={picture.caption}
          />
          <Text dimColor>
            {picture.caption} <Text dimColor>{picture.width}x{picture.height}</Text>
          </Text>
        </Box>
      )
    },
  )

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const shown = await read($, plan)
    const allNotes = await read($, notes)
    const acts = await read($, activity)
    const files = await read($, changed)
    const pics = await read($, pictures)
    const pickedId = await read($, picked)
    const tab = await read($, tabAtom)
    const isShowingEarlier = await read($, showEarlier)
    const openId = await read($, openNote)

    if (shown === null && allNotes.length === 0 && acts.length === 0 && pics.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>
            Nothing yet. Claude posts its plan, decisions and questions here as it
            works, and logs the files and commands it touches.
          </Text>
        </Box>
      )
    }

    const since = shown?.startedAt
    const current = allNotes.filter(note => isCurrent(note, since))
    const earlier = allNotes.length - current.length
    const open = current.filter(note => note.kind === 'question' && !note.isReplied)
    const picture = pics.find(one => one.id === pickedId) ?? pics.at(-1)
    const failed = acts.filter(act => act.status === 'failed').length

    // The note turns replied when the prompt is sent, in prompt.submit.
    const reply = (note: Note, fill = '') => async () => {
      await $.prompt.fill({ text: replyPrefix(note) + fill, mode: 'insert' })
      await update($, openNote, () => null)
    }

    const ok = (note: Note) => async () => {
      await update($, notes, list =>
        list.map(one => (one.id === note.id ? { ...one, isOk: true } : one)),
      )
      await update($, openNote, () => null)
    }

    const noteRow = (note: Note) => {
      const isOpen = note.id === openId
      const isDone = note.isReplied || note.isOk === true
      let status = `· ${TAGS[note.kind].ask}`
      if (note.isReplied) {
        status = '↩ replied'
      } else if (note.isOk === true) {
        status = '✓ ok'
      } else if (note.kind !== 'question') {
        status += isOpen ? ' ▾' : ' ▸'
      }
      const press =
        note.kind === 'question'
          ? reply(note)
          : () => update($, openNote, id => (id === note.id ? null : note.id))

      return (
        <Box flexDirection="column">
          <Button key={note.id} plain dimColor={isDone} onPress={press}>
            <Text color={TAGS[note.kind].color} weight="bold">
              {TAGS[note.kind].tag}
            </Text>{' '}
            {note.text} <Text dimColor>{status}</Text>
          </Button>
          {isOpen && note.kind !== 'question' && (
            <Box flexDirection="column" paddingLeft={2}>
              {note.why !== undefined && <Text dimColor>why: {note.why}</Text>}
              {note.detail !== undefined && <Text>{note.detail}</Text>}
              <Box flexDirection="row" gap={1}>
                <Button
                  key={`reply-${note.id}`}
                  variant="primary"
                  onPress={reply(note, ACTIONS[note.kind].fill)}
                >
                  {ACTIONS[note.kind].reply}
                </Button>
                {!isDone && (
                  <Button key={`ok-${note.id}`} variant="secondary" onPress={ok(note)}>
                    {ACTIONS[note.kind].ok}
                  </Button>
                )}
              </Box>
            </Box>
          )}
        </Box>
      )
    }

    const actRow = (act: Act) => (
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
    )

    const planView = () => {
      if (shown === null) {
        return <Text dimColor>No plan posted yet.</Text>
      }
      const done = shown.steps.filter(step => step.status === 'done').length

      return (
        <Box flexDirection="column">
          <Text weight="bold">
            {shown.goal || 'Plan'}{' '}
            <Text dimColor>
              {done}/{shown.steps.length}
            </Text>
          </Text>
          {shown.steps.map(step => (
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
      )
    }

    let body
    if (tab === 'notes') {
      const listed = isShowingEarlier ? allNotes : current
      body = (
        <Box flexDirection="column">
          {listed.length === 0 ? (
            <Text dimColor>No notes for this task yet.</Text>
          ) : (
            <Text dimColor>
              Claude's notes on this task. Press a question to answer it, any
              other note to open it.
            </Text>
          )}
          {listed.slice(-30).map(note => noteRow(note))}
          {earlier > 0 && (
            <Button
              key="earlier"
              plain
              dimColor
              onPress={() => update($, showEarlier, is => !is)}
            >
              {isShowingEarlier ? 'Hide' : 'Show'} {earlier} from earlier tasks
            </Button>
          )}
        </Box>
      )
    } else if (tab === 'pictures') {
      let view
      if (picture !== undefined && e.surface === 'terminal') {
        const { Image } = $.ui.resolve(e)
        const columns = Math.max(1, Math.min(255, e.props.bodyColumns))
        view = (
          <Image
            source={{ file: picture.file, format: 'png' }}
            columns={columns}
            rows={rowsFor(picture, columns, 20)}
            alt={picture.caption}
          />
        )
      }
      body =
        picture === undefined ? (
          <Text dimColor>No pictures yet.</Text>
        ) : (
          <Box flexDirection="column">
            {view ?? <Text dimColor>{picture.file}</Text>}
            <Text italic>{picture.caption}</Text>
            {pics.length > 1 &&
              pics
                .slice(-8)
                .reverse()
                .map(one => (
                  <Button
                    key={`pic-${one.id}`}
                    plain
                    dimColor={one.id !== picture.id}
                    onPress={() => update($, picked, () => one.id)}
                  >
                    {one.id === picture.id ? '▸ ' : '  '}
                    {one.origin === 'shown' ? 'design ' : 'image  '}
                    {one.caption}
                  </Button>
                ))}
          </Box>
        )
    } else if (tab === 'activity') {
      body = (
        <Box flexDirection="column">
          <Text dimColor>
            {acts.length} calls, {files.length} files changed
            {failed > 0 ? `, ${failed} failed` : ''}
          </Text>
          {acts.slice(-40).map(actRow)}
        </Box>
      )
    } else {
      body = (
        <Box flexDirection="column" gap={1}>
          {planView()}
          {open.length > 0 && (
            <Box flexDirection="column">
              <Text weight="bold">
                Waiting on you <Text dimColor>press to reply</Text>
              </Text>
              {open.map(note => noteRow(note))}
            </Box>
          )}
          {acts.length > 0 && (
            <Box flexDirection="column">
              <Text weight="bold">Latest</Text>
              {acts.slice(-3).map(actRow)}
            </Box>
          )}
        </Box>
      )
    }

    const TABS: { id: Tab; label: string; count?: number; hotkey: string }[] = [
      { id: 'now', label: 'Now', hotkey: '1' },
      { id: 'notes', label: 'Notes', count: current.length, hotkey: '2' },
      { id: 'pictures', label: 'Pictures', count: pics.length, hotkey: '3' },
      { id: 'activity', label: 'Activity', count: acts.length, hotkey: '4' },
    ]

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={2} flexWrap="wrap">
          {TABS.map(one => (
            <Button
              key={`tab-${one.id}`}
              plain
              dimColor={one.id !== tab}
              hotkey={one.hotkey}
              onPress={() => update($, tabAtom, () => one.id)}
            >
              <Text weight={one.id === tab ? 'bold' : 'regular'}>{one.label}</Text>
              {one.count === undefined || one.count === 0 ? '' : ` ${one.count}`}
            </Button>
          ))}
        </Box>
        {body}
      </Box>
    )
  })
}
