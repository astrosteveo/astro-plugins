import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register, Timer } from 'claude-code'

import type {
  Act,
  ActKind,
  CommitRow,
  Meter,
  Preview,
  TestRun,
  Touch,
  ActStatus,
  Diff,
  Lane,
  Note,
  NoteKind,
  Picture,
  Plan,
  Step,
  StepStatus,
  Tab,
  Turn,
} from '../types'
import { GREEN, RED, gantt, gauge, legend, parseLog, parseTests, patchCounts, pulse, shareBar } from './charts'
import type { Bar } from './charts'
import { parseStatus } from './explorer'
import { contextView, commitsView, explorerView, filesView, testsView } from './views'

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
// The diff the Activity tab shows; null shows the log.
const diff = atom({ plugin: 'show-work', key: 'diff' } as const, null, {
  shape: 'diff-1',
})
const lanes = atom({ plugin: 'show-work', key: 'lanes' } as const, [], {
  shape: 'lanes-1',
})
const turns = atom({ plugin: 'show-work', key: 'turns' } as const, [], {
  shape: 'turns-1',
})
const meter = atom({ plugin: 'show-work', key: 'meter' } as const, null, {
  shape: 'meter-1',
})
const tests = atom({ plugin: 'show-work', key: 'tests' } as const, [], {
  shape: 'tests-1',
})
const touches = atom({ plugin: 'show-work', key: 'touches' } as const, [], {
  shape: 'touches-1',
})
const commits = atom({ plugin: 'show-work', key: 'commits' } as const, [], {
  shape: 'commits-1',
})
const tree = atom({ plugin: 'show-work', key: 'tree' } as const, [], { shape: 'tree-1' })
const gitStatus = atom({ plugin: 'show-work', key: 'status' } as const, {}, { shape: 'status-1' })
const openDirs = atom({ plugin: 'show-work', key: 'openDirs' } as const, [], { shape: 'openDirs-1' })
const filter = atom({ plugin: 'show-work', key: 'filter' } as const, '')
const preview = atom({ plugin: 'show-work', key: 'preview' } as const, null, { shape: 'preview-1' })
// The picture the pane shows; null shows the newest.
const picked = atom({ plugin: 'show-work', key: 'picked' } as const, null)
const tabAtom = atom({ plugin: 'show-work', key: 'tab' } as const, 'now')
const showEarlier = atom({ plugin: 'show-work', key: 'showEarlier' } as const, false)
// The note opened to show its why, detail and actions; null when none is.
const openNote = atom({ plugin: 'show-work', key: 'openNote' } as const, null)

const KEPT_PICTURES = 30
const KEPT_LANES = 20
const KEPT_TURNS = 50
const KEPT_RUNS = 40
const TREE_FILES = 20_000
const PREVIEW_LINES = 400
const KEPT_TOUCHES = 200
// A test command, by the runner or the word.
const TEST_COMMAND = /\b(tests?|spec|pytest|jest|vitest|mocha|rspec|ctest|gut|gdunit\w*)\b/i
// A git command that moves branches.
const GIT_MOVE = /\bgit\b.*\b(commit|merge|rebase|cherry-pick|reset|checkout|switch|pull|am|revert)\b/
// The pulse: a column per two seconds.
const BEAT = 2000
// How many turns the timeline draws, newest last.
const GANTT_TURNS = 8
const COLORS = {
  turn: 0xd97757,
  live: 0xf0a070,
  lane: 0x5fa8d3,
  failed: 0xe06c75,
}
const DIFF_LINES = 300
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
// A read or edit of a file already listed folds into its row, which moves to
// the end and takes the new call's id, so the call's status lands on it.
export function addAct(list: Act[], act: Act): Act[] {
  const same =
    act.kind === 'read' || act.kind === 'edit'
      ? list.find(
          one =>
            one.kind === act.kind &&
            one.label === act.label &&
            one.isSubagent === act.isSubagent,
        )
      : undefined
  if (same === undefined) {
    return [...list, act].slice(-200)
  }

  return [...list.filter(one => one !== same), { ...act, count: (same.count ?? 1) + 1 }]
}

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

export function duration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))

  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

// The line between two turns in the activity log.
export function divider(turn: Turn | undefined, n: number, now: number) {
  if (turn === undefined) {
    return `── turn ${n} ──`
  }
  const took = turn.end === undefined ? `${duration(now - turn.start)}…` : duration(turn.end - turn.start)
  const calls = `${turn.calls} ${turn.calls === 1 ? 'call' : 'calls'}`
  const failed = turn.failed > 0 ? ` · ${turn.failed} failed` : ''

  return `── turn ${n} · ${took} · ${calls}${failed} ──`
}

// How often a running chart repaints, in ms.
const FRAME = 250
// The color of a diff line by its first character.
export function diffColor(line: string): Color | undefined {
  if (line.startsWith('+++') || line.startsWith('---')) {
    return undefined
  }
  if (line.startsWith('+')) {
    return 'success'
  }
  if (line.startsWith('-')) {
    return 'error'
  }

  return line.startsWith('@@') ? 'suggestion' : undefined
}

// Asks git what changed in a file: against HEAD when it is tracked, against
// nothing when it is new.
async function loadDiff($: EngineInterface, path: string, label: string): Promise<Diff> {
  const dir = path.slice(0, path.lastIndexOf('/')) || '/'
  let out = (await $.process.run(['git', '-C', dir, 'diff', '--no-color', 'HEAD', '--', path])).stdout
  if (out.trim() === '') {
    out = (
      await $.process.run(['git', '-C', dir, 'diff', '--no-color', '--no-index', '/dev/null', path])
    ).stdout
  }
  // The header lines before the first hunk say nothing the title doesn't.
  const all = out.split('\n')
  const hunk = all.findIndex(line => line.startsWith('@@'))
  const lines = (hunk < 0 ? all : all.slice(hunk)).filter((line, i, list) => i < list.length - 1 || line !== '')

  return {
    file: label,
    lines: lines.length === 0 ? [] : lines.slice(0, DIFF_LINES),
    isCut: lines.length > DIFF_LINES,
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

// The Rasters the pane drew that move on their own: the timer repaints each
// while it is live, drops one whose paint is refused, and stops with none.
type Paint = {
  /** The site the Raster is drawn in: the pane, or the band's request id. */
  site: string
  key: string
  draw: (now: number, frame: number) => { columns: number; rows: number; cells: string }
  isLive: (now: number) => boolean
}
const ticker: { paints: Map<string, Paint>; timer?: Timer; frame: number } = {
  paints: new Map(),
  frame: 0,
}

async function tick($: EngineInterface) {
  const now = await $.clock.now()
  const live = [...ticker.paints].filter(([, paint]) => paint.isLive(now))
  if (live.length === 0) {
    ticker.timer?.cancel()
    ticker.timer = undefined

    return
  }
  ticker.frame += 1
  for (const [id, paint] of live) {
    const cells = paint.draw(now, ticker.frame)
    // A refused or failed paint means the Raster is gone.
    const painted = await $.ui
      .blit({ requestId: paint.site, key: paint.key, ...cells })
      .catch(() => ({ deny: 'failed' }))
    if (painted.deny !== undefined) {
      ticker.paints.delete(id)
    }
  }
}

function paint(one: Paint) {
  ticker.paints.set(`${one.site}:${one.key}`, one)
}

function forget(site: string) {
  for (const [id, one] of ticker.paints) {
    if (one.site === site) {
      ticker.paints.delete(id)
    }
  }
}

function startTicking($: EngineInterface, now: number) {
  if (ticker.timer === undefined && [...ticker.paints.values()].some(one => one.isLive(now))) {
    ticker.timer = $.clock.every(FRAME, () => void tick($))
  }
}

// The window, spend and rate limits as the session reports them now.
async function loadMeter($: EngineInterface): Promise<Meter | null> {
  const usage = await $.session.usage({ breakdown: 'summary' }).catch(() => undefined)
  if (usage === undefined) {
    return null
  }
  const categories = usage.context.breakdown?.categories ?? []

  return {
    ...(usage.context.tokens === undefined ? {} : { tokens: usage.context.tokens }),
    window: usage.context.window,
    ...(usage.context.percent === undefined ? {} : { percent: usage.context.percent }),
    ...(usage.cost === undefined ? {} : { usd: usage.cost.usd }),
    ...(() => {
      const buffer = categories.find(one => one.kind === 'buffer')?.tokens

      return buffer === undefined ? {} : { buffer }
    })(),
    categories: categories
      .filter(one => one.kind === 'used' && one.tokens > 0)
      .map(one => ({ name: one.name, tokens: one.tokens })),
    limits: usage.rateLimits.map(one => ({ kind: one.kind, percentUsed: one.percentUsed })),
    at: await $.clock.now(),
  }
}

// The project's files as git sees them, ignored ones left out; where git
// is not, whatever find turns up a few levels down.
async function loadTree($: EngineInterface, cwd: string): Promise<string[]> {
  if (cwd === '') {
    return []
  }
  const listed = await $.process
    .run(['git', '-C', cwd, 'ls-files', '--cached', '--others', '--exclude-standard'])
    .catch(() => undefined)
  if (listed !== undefined && listed.exitCode === 0) {
    return [...new Set(listed.stdout.split('\n').filter(line => line !== ''))].slice(0, TREE_FILES)
  }
  const found = await $.process
    .run(['find', cwd, '-maxdepth', '6', '-type', 'f', '-not', '-path', '*/.git/*', '-not', '-path', '*/node_modules/*'])
    .catch(() => undefined)

  return (found?.stdout ?? '')
    .split('\n')
    .filter(line => line.startsWith(cwd + '/'))
    .map(line => line.slice(cwd.length + 1))
    .slice(0, TREE_FILES)
}

async function loadStatus($: EngineInterface, cwd: string): Promise<Record<string, string>> {
  const ran = await $.process.run(['git', '-C', cwd, 'status', '--porcelain']).catch(() => undefined)

  return ran !== undefined && ran.exitCode === 0 ? parseStatus(ran.stdout) : {}
}

// A file's text for the preview: the head of a long one, none of a binary one.
async function loadPreview($: EngineInterface, cwd: string, file: string): Promise<Preview> {
  const text = await $.fs.read(absolute(file, cwd)).catch(() => '')
  const source = typeof text === 'string' ? text : ''
  if (source.includes('\u0000')) {
    return { file, source: '', lines: 0, isCut: false, isBinary: true }
  }
  const lines = source.split('\n')

  return {
    file,
    source: lines.slice(0, PREVIEW_LINES).join('\n'),
    lines: lines.length,
    isCut: lines.length > PREVIEW_LINES,
    isBinary: false,
  }
}

// This session's commits on every branch: those after the last commit made
// before the session began.
async function loadCommits($: EngineInterface, cwd: string): Promise<CommitRow[]> {
  if (cwd === '') {
    return []
  }
  try {
    const { startedAt } = await $.session.usage()
    const base = await $.process.run([
      'git', '-C', cwd, 'rev-list', '-1', `--before=@${Math.floor(startedAt / 1000)}`, 'HEAD',
    ])
    const sha = base.stdout.trim()
    const log = await $.process.run([
      'git', '-C', cwd, 'log', '--graph', '--color=never', '--branches', '--shortstat',
      '--format=%x1e%h%x1f%s%x1f%cr%x1f%D', '-n', '60',
      ...(base.exitCode === 0 && sha !== '' ? [`^${sha}`] : []),
    ])

    return log.exitCode === 0 ? parseLog(log.stdout) : []
  } catch {
    // Not a repository, or no git: no commits to show.
    return []
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
    const started = await next(e)
    const [shown, rows, files, codes] = await Promise.all([
      loadMeter($),
      loadCommits($, cwd),
      loadTree($, cwd),
      loadStatus($, cwd),
    ])
    if (shown !== null) {
      await update($, meter, () => shown)
    }
    await update($, commits, () => rows)
    await update($, tree, () => files)
    await update($, gitStatus, () => codes)

    return started
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
      await update($, diff, () => null)
      await update($, lanes, () => [])
      await update($, turns, () => [])
      await update($, tests, () => [])
      await update($, touches, () => [])

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

  // Each main-loop turn is a row of the timeline and a divider in the log.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const start = await $.clock.now()
      await update($, turns, list =>
        [
          ...list,
          { id: e.turnId, n: (list.at(-1)?.n ?? 0) + 1, start, calls: 0, failed: 0 },
        ].slice(-KEPT_TURNS),
      )
    }

    return next(e)
  })

  // The turn's end carries its tokens; the session then says how full the
  // window is, which is the turn's mark on the context chart.
  on('turn.complete', async ($, e, next) => {
    const end = await $.clock.now()
    const done = await next(e)
    const isMain = (await read($, turns)).some(one => one.id === e.turnId)
    const shown = isMain ? await loadMeter($) : null
    const used = done.usage
    await update($, turns, list =>
      list.map(one =>
        one.id === e.turnId
          ? {
              ...one,
              end,
              reason: e.reason,
              ...(shown?.tokens === undefined ? {} : { context: shown.tokens }),
              ...(used === undefined
                ? {}
                : {
                    usage: {
                      input: used.input_tokens,
                      output: used.output_tokens,
                      cacheRead: used.cache_read_input_tokens,
                      cacheWrite: used.cache_creation_input_tokens,
                    },
                  }),
            }
          : one,
      ),
    )
    if (shown !== null) {
      await update($, meter, () => shown)
    }

    return done
  })

  // Each subagent gets a lane, keyed by the id its own tool calls carry.
  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (spawned.deny === undefined && spawned.agentId !== undefined) {
      const lane: Lane = {
        id: spawned.agentId,
        toolUseId: e.tool_use_id,
        label: e.description || 'subagent',
        type: e.subagentType,
        status: 'runs',
        calls: 0,
        at: await $.clock.now(),
      }
      await update($, lanes, list =>
        [...list.filter(one => one.id !== lane.id), lane].slice(-KEPT_LANES),
      )
    }

    return spawned
  })

  // An Agent call may return as soon as its subagent starts, so its return
  // only says the subagent failed; SubagentStop says when it is done.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) {
      await update($, lanes, list =>
        list.map(one =>
          one.toolUseId === e.tool_use_id ? { ...one, status: 'failed' as const } : one,
        ),
      )
    }

    return ran
  })

  on('classic.SubagentStop', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, lanes, list =>
      list.map(one =>
        one.id === e.agent_id && one.status === 'runs' ? { ...one, status: 'ok' as const, end: now } : one,
      ),
    )

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const what = describe(e, cwd)
    if (what === undefined) {
      return next(e)
    }
    if (e.agentId !== undefined) {
      await update($, lanes, list =>
        list.map(one =>
          one.id === e.agentId
            ? { ...one, calls: one.calls + 1, last: `${what.kind} ${what.label}` }
            : one,
        ),
      )
    }

    const turn = (await read($, turns)).at(-1)
    const act: Act = {
      id: e.tool_use_id,
      ...(turn === undefined ? {} : { turn: turn.n }),
      at: await $.clock.now(),
      kind: what.kind,
      label: what.label,
      ...(what.detail === undefined ? {} : { detail: what.detail }),
      status: 'runs',
      isSubagent: e.agentId !== undefined,
    }
    await update($, activity, list => addAct(list, act))
    const ran = await next(e)
    const status: ActStatus =
      ran.deny !== undefined || ran.isError === true ? 'failed' : 'ok'
    await update($, activity, list =>
      list.map(one => (one.id === act.id ? { ...one, status } : one)),
    )
    if (turn !== undefined && e.agentId === undefined) {
      await update($, turns, list =>
        list.map(one =>
          one.id === turn.id
            ? { ...one, calls: one.calls + 1, failed: one.failed + (status === 'failed' ? 1 : 0) }
            : one,
        ),
      )
    }
    if (what.kind === 'read' || what.kind === 'edit') {
      const at = act.at ?? 0
      const isEdit = what.kind === 'edit' && status === 'ok'
      await update($, touches, list => {
        const old = list.find(one => one.file === what.label)
        const touch: Touch = {
          file: what.label,
          reads: (old?.reads ?? 0) + (what.kind === 'read' ? 1 : 0),
          edits: (old?.edits ?? 0) + (isEdit ? 1 : 0),
          at,
        }

        return [...list.filter(one => one !== old), touch].slice(-KEPT_TOUCHES)
      })
    }
    if (e.tool === 'Bash' && ran.deny === undefined) {
      const command = asText(e.command)
      const found = TEST_COMMAND.test(command) ? parseTests(ran.text ?? '') : undefined
      if (found !== undefined) {
        const run: TestRun = {
          id: e.tool_use_id,
          at: await $.clock.now(),
          command: what.detail ?? what.label,
          ...found,
          isError: ran.isError === true,
        }
        await update($, tests, list => [...list, run].slice(-KEPT_RUNS))
      }
      if (status === 'ok' && GIT_MOVE.test(command)) {
        const rows = await loadCommits($, cwd)
        await update($, commits, () => rows)
      }
    }
    if (status === 'ok' && what.image !== undefined) {
      const made = await freeze($, { path: what.image }, act.id, what.label, 'read')
      if (typeof made !== 'string') {
        await keep($, made)
      }
    }
    if (status === 'ok' && (what.path !== undefined || (e.tool === 'Bash' && GIT_MOVE.test(asText(e.command))))) {
      const codes = await loadStatus($, cwd)
      await update($, gitStatus, () => codes)
      if (e.tool !== 'Edit') {
        const files = await loadTree($, cwd)
        await update($, tree, () => files)
      }
      const open = await read($, preview)
      if (open !== null && what.path !== undefined && relative(what.path, cwd) === open.file) {
        const fresh = await loadPreview($, cwd, open.file)
        await update($, preview, () => fresh)
      }
    }
    if (status === 'ok' && what.path !== undefined && what.path !== '') {
      const label = what.label
      await update($, changed, list =>
        list.includes(label) ? list : [...list, label],
      )
      // A diff open on this file goes stale with the edit: refresh it.
      const open = await read($, diff)
      if (open !== null && open.file === label) {
        const fresh = await loadDiff($, what.path, label)
        await update($, diff, () => fresh)
      }
    }

    return ran
  })

  // An edit's row in the chat gets a bar of the lines it added and removed.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const own = await next(e)
    if ((e.props.tool !== 'Edit' && e.props.tool !== 'Write') || e.props.isErrored) {
      return own
    }
    const { added, removed } = patchCounts(e.props.output)
    if (added + removed === 0) {
      return own
    }
    const { Box, Text } = $.ui.resolve(e)
    const parts = [
      { n: added, color: GREEN, word: `+${added}` },
      { n: removed, color: RED, word: `−${removed}` },
    ]
    if (e.surface !== 'terminal') {
      return (
        <Box flexDirection="column">
          {own}
          <Text dimColor>{parts.map(part => part.word).join(' ')}</Text>
        </Box>
      )
    }
    const { Raster } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {own}
        <Raster key={`edit-${e.props.tool_use_id}`} {...shareBar(parts, 30)} />
      </Box>
    )
  })

  // A test command's row gets a bar of its passes and failures.
  on('ui.render', { component: 'ToolResult', props: { tool: 'Bash' } }, async ($, e, next) => {
    const run = (await read($, tests)).find(one => one.id === e.props.tool_use_id)
    const own = await next(e)
    if (run === undefined) {
      return own
    }
    const { Box, Text } = $.ui.resolve(e)
    const isGreen = run.failed === 0 && !run.isError
    const parts = [
      { n: run.passed, color: GREEN, word: `${isGreen ? '✓' : '✗'} ${run.passed} pass` },
      { n: run.failed, color: RED, word: `${run.failed} fail` },
    ]
    if (e.surface !== 'terminal') {
      return (
        <Box flexDirection="column">
          {own}
          <Text color={isGreen ? 'success' : 'error'}>{parts.map(part => part.word).join(' · ')}</Text>
        </Box>
      )
    }
    const { Raster } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {own}
        <Raster key={`tests-${run.id}`} {...shareBar(parts, 40)} />
      </Box>
    )
  })

  // While Claude works, a strip above the prompt: the pulse, the context, the
  // step it is on, its agents and what waits on you.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const acts = await read($, activity)
    const shownPlan = await read($, plan)
    const allLanes = await read($, lanes)
    const allNotes = await read($, notes)
    const runs = await read($, tests)
    const shownMeter = await read($, meter)
    const running = allLanes.filter(lane => lane.status === 'runs').length
    const open = allNotes.filter(
      note => note.kind === 'question' && !note.isReplied && isCurrent(note, shownPlan?.startedAt),
    ).length
    forget(e.requestId)
    if (e.props.hasSurvey || (!e.props.isWorking && running === 0 && open === 0)) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const step = shownPlan?.steps.find(one => one.status === 'doing')?.text
    const last = runs.at(-1)
    const bits = [
      ...(shownMeter?.percent === undefined ? [] : [`${shownMeter.percent}%`]),
      ...(step === undefined ? [] : [`▸ ${step}`]),
      ...(running === 0 ? [] : [`${running} agent${running === 1 ? '' : 's'}`]),
      ...(last === undefined ? [] : [last.failed === 0 && !last.isError ? `✓ ${last.passed}` : `✗ ${last.failed} failing`]),
      ...(open === 0 ? [] : [`${open} waiting on you`]),
    ]
    if (e.surface !== 'terminal') {
      return <Text dimColor>{bits.join(' · ')}</Text>
    }

    const { Raster } = $.ui.resolve(e)
    const width = Math.max(8, Math.min(24, Math.floor(e.props.bodyColumns / 4)))
    const beats = acts.map(act => ({ at: act.at ?? 0, kind: act.kind, status: act.status }))
    paint({
      site: e.requestId,
      key: 'hud-pulse',
      draw: at => pulse(beats, at, width, BEAT / 2),
      isLive: () => true,
    })
    startTicking($, now)
    const fraction = (shownMeter?.tokens ?? 0) / Math.max(1, shownMeter?.window ?? 1)

    return (
      <Box flexDirection="row" gap={1}>
        <Raster key="hud-pulse" {...pulse(beats, now, width, BEAT / 2)} />
        {shownMeter !== null && <Raster key="hud-gauge" {...gauge(fraction, 10)} />}
        <Text wrap="truncate-end" dimColor>
          {bits.join(' · ')}
        </Text>
      </Box>
    )
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
    const { Box, Button, Code, Text } = $.ui.resolve(e)
    const shown = await read($, plan)
    const allNotes = await read($, notes)
    const acts = await read($, activity)
    const files = await read($, changed)
    const pics = await read($, pictures)
    const pickedId = await read($, picked)
    const tab = await read($, tabAtom)
    const isShowingEarlier = await read($, showEarlier)
    const openId = await read($, openNote)
    const shownDiff = await read($, diff)
    const allLanes = await read($, lanes)
    const allTurns = await read($, turns)
    const shownMeter = await read($, meter)
    const runs = await read($, tests)
    const touched = await read($, touches)
    const commitRows = await read($, commits)
    const projectFiles = await read($, tree)
    const codes = await read($, gitStatus)
    const opened = await read($, openDirs)
    const filterText = await read($, filter)
    const shownPreview = await read($, preview)
    const now = await $.clock.now()
    // Only what this drawing holds can be repainted between drawings.
    forget(PANE)
    const Raster = e.surface === 'terminal' ? $.ui.resolve(e).Raster : undefined
    // The views draw a Raster only where the surface has one.
    const kit = { Box, Text, Button, ...(Raster === undefined ? {} : { Raster }) }
    const bodyColumns = Math.max(24, Math.min(512, e.props.bodyColumns))

    const isEmpty = [allNotes, acts, pics, allTurns, runs, touched, commitRows, projectFiles].every(list => list.length === 0)
    if (shown === null && isEmpty) {
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
    // Lanes of this task, and any still running from before it.
    const currentLanes = allLanes.filter(
      lane => since === undefined || lane.at >= since || lane.status === 'runs',
    )

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
          {act.kind.padEnd(6)}{' '}
          {act.count === undefined ? '' : <Text weight="bold">×{act.count} </Text>}
          {act.label}
        </Text>
        {act.detail !== undefined && (
          <Text wrap="truncate-end" dimColor>
            {'         $ '}
            {act.detail}
          </Text>
        )}
      </Box>
    )

    const laneRow = (lane: Lane) => (
      <Box key={`lane-${lane.id}`} flexDirection="column">
        <Text wrap="truncate-end" dimColor={lane.status === 'ok'}>
          <Text color={ACT_MARK[lane.status].color}>{ACT_MARK[lane.status].mark}</Text>{' '}
          <Text weight="bold">{lane.label}</Text> <Text dimColor>{lane.type}</Text>
          <Text dimColor>
            {' '}· {lane.calls} {lane.calls === 1 ? 'call' : 'calls'}
          </Text>
        </Text>
        {lane.last !== undefined && lane.status === 'runs' && (
          <Text wrap="truncate-end" dimColor>
            {'  ↳ '}
            {lane.last}
          </Text>
        )}
      </Box>
    )

    const openDiff = (file: string) => async () => {
      const loaded = await loadDiff($, absolute(file, cwd), file)
      await update($, diff, () => loaded)
    }

    const diffView = (shownDiff: Diff) => (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={2}>
          <Text weight="bold">{shownDiff.file}</Text>
          <Button key="diff-close" plain dimColor hotkey="x" onPress={() => update($, diff, () => null)}>
            ✗ close
          </Button>
        </Box>
        {shownDiff.lines.length === 0 ? (
          <Text dimColor>No changes against git HEAD.</Text>
        ) : (
          <Code source={shownDiff.lines.join('\n')} format="diff" path={shownDiff.file} />
        )}
        {shownDiff.isCut && <Text dimColor>… cut at {DIFF_LINES} lines</Text>}
      </Box>
    )

    // The last few turns, each followed by the subagents that started in it.
    const timelineView = () => {
      const shownTurns = allTurns.slice(-GANTT_TURNS)
      const first = shownTurns[0]?.start
      if (first === undefined) {
        return <Text dimColor>No turns yet. Each prompt you send draws a bar here.</Text>
      }
      const bars: Bar[] = []
      for (const turn of shownTurns) {
        const isBad = turn.reason === 'error' || turn.reason === 'aborted' || turn.failed > 0
        bars.push({
          label: `turn ${turn.n}`,
          start: turn.start,
          ...(turn.end === undefined ? {} : { end: turn.end }),
          color: isBad ? COLORS.failed : turn.end === undefined ? COLORS.live : COLORS.turn,
          isSub: false,
        })
        const next = allTurns.find(one => one.n === turn.n + 1)?.start ?? Infinity
        for (const lane of allLanes.filter(one => one.at >= turn.start && one.at < next)) {
          bars.push({
            label: lane.label,
            start: lane.at,
            ...(lane.end === undefined ? {} : { end: lane.end }),
            color: lane.status === 'failed' ? COLORS.failed : COLORS.lane,
            isSub: true,
          })
        }
      }
      const running = shownTurns.filter(one => one.end === undefined).length +
        allLanes.filter(one => one.status === 'runs').length

      if (e.surface !== 'terminal') {
        return (
          <Box flexDirection="column">
            {bars.map(bar => (
              <Text dimColor={bar.isSub}>
                {bar.isSub ? '↳ ' : ''}
                {bar.label} · {duration((bar.end ?? now) - bar.start)}
                {bar.end === undefined ? '…' : ''}
              </Text>
            ))}
          </Box>
        )
      }

      const { Raster } = $.ui.resolve(e)
      const columns = Math.max(24, Math.min(512, e.props.bodyColumns))
      const chart = gantt(bars, now, columns, ticker.frame)
      paint({
        site: PANE,
        key: 'gantt',
        draw: (at, frame) => gantt(bars, at, columns, frame),
        isLive: () => bars.some(bar => bar.end === undefined),
      })
      const key = legend([
        [COLORS.turn, 'turn'],
        [COLORS.lane, 'subagent'],
        [COLORS.failed, 'failed'],
      ])

      return (
        <Box flexDirection="column">
          <Text dimColor>
            {shownTurns.length} turns · {running} running · · ={' '}
            {duration(((now - chart.from) / Math.max(1, columns - 15)) * 6)}
          </Text>
          <Raster key="gantt" columns={columns} rows={chart.rows} cells={chart.cells} />
          <Box flexDirection="row" justifyContent="space-between">
            <Text dimColor>{''.padEnd(15)}0s</Text>
            <Text dimColor>{duration(now - chart.from)} now</Text>
          </Box>
          <Raster key="gantt-key" columns={key.columns} rows={1} cells={key.cells} />
        </Box>
      )
    }

    // Calls over the last stretch, newest on the right, with how full the
    // context is: what Claude is doing at a glance.
    const pulseView = () => {
      const lastAt = acts.at(-1)?.at
      const meterLine =
        shownMeter?.percent === undefined ? '' : ` · context ${shownMeter.percent}%`
      const usd = shownMeter?.usd === undefined ? '' : ` · $${shownMeter.usd.toFixed(2)}`
      if (Raster === undefined || lastAt === undefined) {
        return meterLine === '' ? undefined : <Text dimColor>{meterLine.slice(3) + usd}</Text>
      }
      const beats = acts.map(act => ({ at: act.at ?? 0, kind: act.kind, status: act.status }))
      const span = bodyColumns * BEAT
      paint({
        site: PANE,
        key: 'pulse',
        draw: at => pulse(beats, at, bodyColumns, BEAT),
        isLive: at => at - lastAt < span,
      })

      return (
        <Box flexDirection="column">
          <Raster key="pulse" {...pulse(beats, now, bodyColumns, BEAT)} />
          <Text dimColor>
            calls · last {Math.round(span / 60_000)}m{meterLine}
            {usd}
          </Text>
        </Box>
      )
    }

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
    } else if (tab === 'timeline') {
      body = timelineView()
    } else if (tab === 'context') {
      body = contextView(
        kit,
        { shown: shownMeter, turns: allTurns, columns: bodyColumns },
      )
    } else if (tab === 'tests') {
      body = testsView(
        kit,
        { runs, columns: bodyColumns, now },
      )
    } else if (tab === 'files') {
      body = filesView(
        kit,
        {
          list: touched,
          columns: bodyColumns,
          onOpen: file => async () => {
            const loaded = await loadDiff($, absolute(file, cwd), file)
            await update($, diff, () => loaded)
            await update($, tabAtom, () => 'activity')
          },
        },
      )
    } else if (tab === 'explorer') {
      body = explorerView(
        { ...kit, ...(e.surface === 'mobile' ? {} : { Input: $.ui.resolve(e).Input }), Code },
        {
          files: projectFiles,
          codes,
          touched: touched,
          open: opened,
          filter: filterText,
          preview: shownPreview,
          onFilter: text => update($, filter, () => text),
          onToggle: dir => () =>
            update($, openDirs, list => (list.includes(dir) ? list.filter(one => one !== dir) : [...list, dir])),
          onOpen: file => async () => {
            const loaded = await loadPreview($, cwd, file)
            await update($, preview, () => loaded)
          },
          onClose: () => update($, preview, () => null),
          onMention: file => async () => {
            await $.prompt.fill({ text: `@${file} `, mode: 'insert' })
          },
          onDiff: file => async () => {
            const loaded = await loadDiff($, absolute(file, cwd), file)
            await update($, diff, () => loaded)
            await update($, tabAtom, () => 'activity')
          },
          onRefresh: async () => {
            const [listed, status] = await Promise.all([loadTree($, cwd), loadStatus($, cwd)])
            await update($, tree, () => listed)
            await update($, gitStatus, () => status)
          },
        },
      )
    } else if (tab === 'commits') {
      body = commitsView(
        kit,
        {
          rows: commitRows,
          onRefresh: async () => {
            const rows = await loadCommits($, cwd)
            await update($, commits, () => rows)
          },
        },
      )
    } else if (tab === 'activity' && shownDiff !== null) {
      body = diffView(shownDiff)
    } else if (tab === 'activity') {
      body = (
        <Box flexDirection="column">
          {files.length > 0 && (
            <Box flexDirection="column" marginBottom={1}>
              <Text weight="bold">
                Changed <Text dimColor>press for the diff</Text>
              </Text>
              {files.slice(-12).map(file => (
                <Button key={`file-${file}`} plain onPress={openDiff(file)}>
                  <Text color="warning">±</Text> {file}
                </Button>
              ))}
            </Box>
          )}
          <Text dimColor>
            {acts.reduce((sum, act) => sum + (act.count ?? 1), 0)} calls,{' '}
            {files.length} files changed
            {failed > 0 ? `, ${failed} failed` : ''}
          </Text>
          {acts.slice(-40).flatMap((act, i, list) =>
            act.turn !== undefined && act.turn !== list[i - 1]?.turn
              ? [
                  <Text key={`turn-${act.turn}-${act.id}`} color="claude" dimColor wrap="truncate-end">
                    {divider(
                      allTurns.find(one => one.n === act.turn),
                      act.turn,
                      now,
                    )}
                  </Text>,
                  actRow(act),
                ]
              : [actRow(act)],
          )}
        </Box>
      )
    } else {
      body = (
        <Box flexDirection="column" gap={1}>
          {pulseView()}
          {planView()}
          {open.length > 0 && (
            <Box flexDirection="column">
              <Text weight="bold">
                Waiting on you <Text dimColor>press to reply</Text>
              </Text>
              {open.map(note => noteRow(note))}
            </Box>
          )}
          {currentLanes.length > 0 && (
            <Box flexDirection="column">
              <Text weight="bold">
                Agents{' '}
                <Text dimColor>
                  {currentLanes.filter(lane => lane.status === 'runs').length} running
                </Text>
              </Text>
              {currentLanes.slice(-6).map(laneRow)}
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
      // A note replied to or OK'd is done: it greys out and stops counting.
      { id: 'notes', label: 'Notes', count: current.filter(note => !note.isReplied && note.isOk !== true).length, hotkey: '2' },
      { id: 'pictures', label: 'Pictures', count: pics.length, hotkey: '3' },
      { id: 'activity', label: 'Activity', count: acts.length, hotkey: '4' },
      { id: 'timeline', label: 'Timeline', count: allTurns.length, hotkey: '5' },
      { id: 'context', label: 'Context', hotkey: '6' },
      { id: 'tests', label: 'Tests', count: runs.length, hotkey: '7' },
      { id: 'files', label: 'Files', count: touched.length, hotkey: '8' },
      { id: 'commits', label: 'Commits', count: commitRows.filter(row => row.sha !== undefined).length, hotkey: '9' },
      { id: 'explorer', label: 'Explorer', count: Object.keys(codes).length, hotkey: '0' },
    ]

    startTicking($, now)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" columnGap={2} rowGap={0} flexWrap="wrap">
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
