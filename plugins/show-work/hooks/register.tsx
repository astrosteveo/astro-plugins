import { atom, read, update } from 'claude-code'
import type {
  Color,
  EngineInterface,
  HookStream,
  ProcessSpawnChunk,
  ProcessSpawnResult,
  Register,
  Timer,
} from 'claude-code'

import type {
  Act,
  ActKind,
  Diagram,
  CommitRow,
  GitState,
  Job,
  Meter,
  Preview,
  Search,
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
import { GREEN, RED, gantt, legend, parseLog, parseTests, patchCounts, pulse, shareBar } from './charts'
import type { Bar } from './charts'
import { parseGit, parseHits, parseStatus, plain } from './explorer'
import {
  FIND_BROWSER,
  LONGEST,
  browserArgs,
  d2Args,
  dotArgs,
  errorLines,
  frame,
  measured,
  mermaidArgs,
  page,
  svgSize,
} from './design'
import type { Drawn } from './design'
import { diagramColumns, hashOf, splitMermaid } from './mermaid'
import { contextView, commitsView, explorerView, filesView, gitView, runView, searchView, testsView } from './views'

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
const diagrams = atom({ plugin: 'show-work', key: 'diagrams' } as const, [], {
  shape: 'diagrams-1',
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
const jobs = atom({ plugin: 'show-work', key: 'jobs' } as const, [], { shape: 'jobs-1' })
const pickedJob = atom({ plugin: 'show-work', key: 'pickedJob' } as const, null)
const git = atom({ plugin: 'show-work', key: 'git' } as const, null, { shape: 'git-1' })
const search = atom({ plugin: 'show-work', key: 'search' } as const, null, { shape: 'search-1' })
// The picture the pane shows; null shows the newest.
const picked = atom({ plugin: 'show-work', key: 'picked' } as const, null)
const tabAtom = atom({ plugin: 'show-work', key: 'tab' } as const, 'now')
const showEarlier = atom({ plugin: 'show-work', key: 'showEarlier' } as const, false)
// The note opened to show its why, detail and actions; null when none is.
const openNote = atom({ plugin: 'show-work', key: 'openNote' } as const, null)

const KEPT_PICTURES = 30
const KEPT_DIAGRAMS = 40
// mmdc draws at this many pixels per CSS pixel, so a diagram stays sharp.
const DIAGRAM_SCALE = 2
// The longest side of a picture handed to the model, as the API scales it.
const MODEL_SIDE = 1568
// The page width of an HTML mockup when Claude gives none.
const PAGE_WIDTH = 1280
// The most an Image takes as bytes: 2 MiB, as base64.
const PNG_BYTES = Math.floor((2 * 1024 * 1024 * 4) / 3)
const KEPT_LANES = 20
const KEPT_TURNS = 50
const KEPT_RUNS = 40
const TREE_FILES = 20_000
const KEPT_JOBS = 12
const JOB_LINES = 500
// How often a running job's output is written to the pane, in ms.
const JOB_FLUSH = 200
const HITS = 200
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
- To show the person a design, call mcp__show-work__show and describe its structure; the tool lays it out. Use d2 for architecture, mermaid for flows, sequences and states, and html with the wireframe classes for a screen, menu or HUD; svg only for a freeform drawing. Show a design before you build it, so they can veto it. The result hands you the picture: fix overlaps and cut or crowded text, and show it again before you go on. Images you Read land in the pane by themselves.
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
  description: `Draw a design in the chat for the person; the result hands you the picture to check. Give one source, and the tool lays it out:
- d2: architecture and systems. Containers nest in braces: \`server: Server { api: API; db: Postgres {shape: cylinder} }\`, \`client -> server.api: HTTPS\`.
- mermaid: flowcharts, sequence, state, class, ER and gantt diagrams.
- dot: Graphviz, for big graphs such as dependencies or scene trees.
- html: a UI mockup (screen, menu, dialog, HUD) laid out by a browser. Set width and height for a fixed screen; leave height out to fit the content. A wireframe kit is loaded, so classes do the styling:
  layout: row, col, grid (style="--cols:4"), grow, wrap, between, center, middle, end, tight, loose, pad;
  parts: box, window (data-title="…"), btn (+ primary or ghost), input, check (+ on), slider and bar (style="--value:60%"), tabs and list (child .on is selected), img (picture placeholder), icon, avatar, lines (text filler, style="--n:3"), tag, hr;
  text: h1-h3, muted, small, bold; annotations: note (callout), mark (numbered pin);
  game screens: stage (a 16:9 view, --aspect to change) or screen (fills the picture), each child placed by an anchor class: tl tc tr ml mc mr bl bc br;
  colors: var(--paper --panel --ink --muted --line --fill --accent --good --bad).
- svg: a freeform drawing; give it a background rect and a width of 800 or more.
- path: an image file that already exists.`,
  isDeferred: false,
  inputSchema: {
    type: 'object',
    properties: {
      caption: { type: 'string', description: 'What the picture shows, a few words.' },
      d2: { type: 'string', description: 'D2 source: an architecture or system diagram.' },
      mermaid: { type: 'string', description: 'Mermaid source, without the fence.' },
      dot: { type: 'string', description: 'Graphviz DOT source.' },
      html: { type: 'string', description: 'HTML for a mockup, using the wireframe classes; a <style> of your own is welcome.' },
      width: { type: 'number', description: 'html: the page width in CSS pixels. Default 1280.' },
      height: { type: 'number', description: 'html: the page height; leave it out to fit the content.' },
      svg: { type: 'string', description: 'SVG source.' },
      path: { type: 'string', description: 'An image file (PNG, JPEG, GIF, WebP, BMP or SVG), absolute or relative to the working directory.' },
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

// The field each tool's tab puts the typing in.
const FIELDS: Partial<Record<Tab, string>> = { explorer: 'ex-filter', run: 'run-cmd', search: 'search-q' }

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
export function rowsFor(picture: Pick<Picture, 'width' | 'height'>, columns: number, most: number) {
  const rows = Math.round((columns * picture.height) / picture.width / 2)

  return Math.max(1, Math.min(most, rows))
}

// The box that shows a whole picture in at most `columns` by `rows`: as wide
// as allowed, narrower when a tall picture would take more rows.
export function fit(picture: Pick<Picture, 'width' | 'height'>, columns: number, rows: number) {
  const tall = rowsFor(picture, columns, Number.POSITIVE_INFINITY)
  if (tall <= rows) {
    return { columns, rows: tall }
  }

  return { columns: Math.max(1, Math.min(columns, Math.round((rows * 2 * picture.width) / picture.height))), rows }
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

type Source = { path: string } | Drawn

const cacheDir = async ($: EngineInterface) =>
  `${(await $.env.get('XDG_CACHE_HOME')) || `${await $.env.get('HOME')}/.cache`}/show-work`

const isLightTheme = async ($: EngineInterface) =>
  /light/i.test(String((await $.config.list()).find(row => row.key === 'theme')?.value ?? ''))

// Runs a renderer; answers what went wrong, or nothing when it drew.
async function draw($: EngineInterface, argv: string[]) {
  const ran = await $.process.run(argv, { timeoutMs: 30_000 }).catch((error: unknown) => String(error))
  if (typeof ran === 'string') {
    return /time|still running/i.test(ran) ? `${argv[0]} took too long.` : `${argv[0]} would not start: is it installed?`
  }

  return ran.exitCode === 0 ? undefined : errorLines(ran.stderr.split('\n').map(plain).join('\n')) || `${argv[0]} failed.`
}

// The headless browser, looked for each time so one installed later is found.
async function findBrowser($: EngineInterface) {
  const found = await $.process.run(['sh', '-c', FIND_BROWSER]).catch(() => undefined)

  return found?.exitCode === 0 ? firstLine(found.stdout) || undefined : undefined
}

// Screenshots a page with a headless browser, `height` tall or as tall as
// its content.
async function shoot(
  $: EngineInterface,
  found: string,
  from: string,
  file: string,
  width: number,
  height?: number,
) {
  const profile = `${file.replace(/\.png$/, '')}-chrome`
  const argv = browserArgs(found, profile)
  const url = `file://${encodeURI(from)}`
  try {
    let tall = height
    if (tall === undefined) {
      const dom = await $.process.run([...argv, `--window-size=${width},100`, '--dump-dom', url], {
        timeoutMs: 30_000,
      })
      tall = measured(dom.stdout) ?? 800
    }

    return await draw($, [...argv, `--window-size=${width},${tall}`, `--screenshot=${file}`, url])
  } finally {
    await $.process.run(['rm', '-rf', profile])
  }
}

// Lays a design out from its source into `file`, with the tool that reads
// it. Answers why when it can't.
async function render($: EngineInterface, source: Drawn, dir: string, id: string, file: string) {
  const isLight = await isLightTheme($)
  const at = `${dir}/${id}`
  if ('svg' in source) {
    await $.fs.write(`${at}.svg`, source.svg)

    return draw($, ['rsvg-convert', '-o', file, `${at}.svg`])
  }
  if ('mermaid' in source) {
    await $.fs.write(`${at}.mmd`, source.mermaid)

    return draw($, mermaidArgs(isLight, `${at}.mmd`, file, DIAGRAM_SCALE))
  }
  if ('dot' in source) {
    await $.fs.write(`${at}.dot`, source.dot)

    return draw($, dotArgs(isLight, `${at}.dot`, file))
  }
  if ('d2' in source) {
    // D2 writes an SVG that only a browser draws whole (rsvg drops its
    // label masks); rsvg stands in where there is none.
    await $.fs.write(`${at}.d2`, source.d2)
    const why = await draw($, d2Args(isLight, `${at}.d2`, `${at}.svg`))
    if (why !== undefined) {
      return why
    }
    const size = svgSize(await $.fs.read(`${at}.svg`))
    const found = await findBrowser($)
    if (size === undefined || found === undefined) {
      return draw($, ['rsvg-convert', '-o', file, `${at}.svg`])
    }
    await $.fs.write(`${at}.html`, frame(`${id}.svg`))

    return shoot($, found, `${at}.html`, file, Math.min(LONGEST, size.width), Math.min(LONGEST, size.height))
  }
  const found = await findBrowser($)
  if (found === undefined) {
    return 'No Chrome or Chromium to lay out the page: install one.'
  }
  await $.fs.write(`${at}.html`, page(source.html, isLight))

  return shoot($, found, `${at}.html`, file, source.width, source.height)
}

// Copies or converts an image into the cache as a PNG, so a later write to
// the same file leaves this picture as it was; a design is laid out into
// one. Answers why when it can't.
async function freeze(
  $: EngineInterface,
  source: Source,
  id: string,
  caption: string,
  origin: Picture['origin'],
): Promise<Picture | string> {
  const dir = await cacheDir($)
  const file = `${dir}/${id}.png`
  await $.process.run(['mkdir', '-p', dir])

  if ('path' in source) {
    if (source.path.startsWith(`${dir}/`)) {
      return 'That picture is already shown.'
    }
    if (!(await $.fs.exists(source.path))) {
      return `No image at ${source.path}.`
    }
    const argv = /\.svg$/i.test(source.path)
      ? ['rsvg-convert', '-o', file, source.path]
      : /\.png$/i.test(source.path)
        ? ['cp', source.path, file]
        : ['magick', `${source.path}[0]`, file]
    const made = await $.process.run(argv)
    if (made.exitCode !== 0) {
      return `Could not read the image: ${firstLine(made.stderr) || argv[0]}`
    }
  } else {
    const why = await render($, source, dir, id, file)
    if (why !== undefined) {
      return why
    }
    if (!(await $.fs.exists(file))) {
      return 'The design drew nothing.'
    }
  }

  const size = await $.process.run(['magick', 'identify', '-format', '%w %h', file])
  const [width = 0, height = 0] = size.stdout.split(' ').map(Number)
  const isSized = width > 0 && height > 0

  return isSized
    ? { id, file, width, height, caption, origin }
    : { id, file, width: 16, height: 9, caption, origin }
}

// The picture as the model reads it: scaled down past the side the API
// would scale it to anyway, so less crosses the wire.
async function lookAt($: EngineInterface, picture: Picture) {
  let file = picture.file
  if (Math.max(picture.width, picture.height) > MODEL_SIDE) {
    file = picture.file.replace(/\.png$/, '-look.png')
    const made = await $.process.run(['magick', picture.file, '-resize', `${MODEL_SIDE}x${MODEL_SIDE}>`, file])
    file = made.exitCode === 0 ? file : picture.file
  }
  const png = await $.fs.read(file, { as: 'bytes' })

  return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.base64 } } as const
}

// Keeps the newest pictures and deletes the files of the rest, with the
// sources and pages they were drawn from.
async function keep($: EngineInterface, picture: Picture) {
  let dropped: Picture[] = []
  await update($, pictures, list => {
    const all = [...list.filter(one => one.id !== picture.id), picture]
    dropped = all.slice(0, -KEPT_PICTURES)

    return all.slice(-KEPT_PICTURES)
  })
  await update($, picked, () => null)
  if (dropped.length > 0) {
    const files = dropped.flatMap(one =>
      ['.png', '-look.png', '.svg', '.d2', '.mmd', '.dot', '.html'].map(end => one.file.replace(/\.png$/, end)),
    )
    await $.process.run(['rm', '-f', ...files])
  }
}

// Renders a mermaid block to a PNG in the cache with mmdc, in the person's
// theme, and keeps the newest. A block that will not render keeps why.
async function drawDiagram($: EngineInterface, source: string, id: string) {
  const dir = await cacheDir($)
  const file = `${dir}/mermaid-${id}.png`
  const made = await $.process
    .run(['mkdir', '-p', dir])
    .then(async () => {
      if (await $.fs.exists(file)) {
        return undefined
      }
      const isLight = await isLightTheme($)
      await $.fs.write(`${dir}/mermaid-${id}.mmd`, source)
      const argv = ['mmdc', '-q', '-i', `${dir}/mermaid-${id}.mmd`, '-o', file]
      const style = ['-t', isLight ? 'default' : 'dark', '-b', 'transparent', '-s', String(DIAGRAM_SCALE)]
      const ran = await $.process.run([...argv, ...style], { timeoutMs: 30_000 })

      return ran.exitCode === 0 ? undefined : firstLine(plain(ran.stderr)) || 'mmdc failed'
    })
    .catch((error: unknown) => (/ENOENT|not found/i.test(String(error)) ? 'mmdc is not installed' : String(error)))
  const size = made === undefined ? await $.process.run(['magick', 'identify', '-format', '%w %h', file]) : undefined
  const [width = 0, height = 0] = (size?.stdout ?? '').split(' ').map(Number)
  const drawn: Diagram =
    made === undefined && width > 0 && height > 0
      ? { id, file, width, height }
      : { id, file, width: 0, height: 0, error: made ?? 'mmdc drew nothing' }
  await update($, diagrams, list => [...list.filter(one => one.id !== id), drawn].slice(-KEPT_DIAGRAMS))
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

// A file's text for the preview: the head of a long one, or the stretch
// around a search hit; none of a binary one.
async function loadPreview($: EngineInterface, cwd: string, file: string, hit?: number): Promise<Preview> {
  const text = await $.fs.read(absolute(file, cwd)).catch(() => '')
  const source = typeof text === 'string' ? text : ''
  if (source.includes('\u0000')) {
    return { file, source: '', lines: 0, isCut: false, isBinary: true }
  }
  const lines = source.split('\n')
  const start = hit === undefined ? 1 : Math.max(1, hit - 10)

  return {
    file,
    source: lines.slice(start - 1, start - 1 + PREVIEW_LINES).join('\n'),
    lines: lines.length,
    isCut: start > 1 || lines.length > start - 1 + PREVIEW_LINES,
    isBinary: false,
    ...(hit === undefined ? {} : { start, hit }),
  }
}

async function loadGit($: EngineInterface, cwd: string, note?: { text: string; isError: boolean }): Promise<GitState | null> {
  const ran = await $.process.run(['git', '-C', cwd, 'status', '--porcelain=v1', '--branch']).catch(() => undefined)
  if (ran === undefined || ran.exitCode !== 0) {
    return null
  }

  return {
    ...parseGit(ran.stdout),
    ...(note === undefined ? {} : { note: note.text, isNoteError: note.isError }),
  }
}

// A git command from the Git tab, then the tab, the Explorer's marks and
// the commit graph read again.
async function gitDo($: EngineInterface, cwd: string, argv: string[], timeoutMs = 30_000) {
  const ran = await $.process.run(['git', '-C', cwd, ...argv], { timeoutMs }).catch((error: unknown) => ({
    exitCode: 1,
    stdout: '',
    stderr: String(error),
  }))
  const said = (ran.exitCode === 0 ? ran.stdout || ran.stderr : ran.stderr || ran.stdout).trim().split('\n')
  const note = { text: `git ${argv[0]}: ${said.at(-1) || (ran.exitCode === 0 ? 'done' : 'failed')}`, isError: ran.exitCode !== 0 }
  const [state, codes, rows] = await Promise.all([loadGit($, cwd, note), loadStatus($, cwd), loadCommits($, cwd)])
  await update($, git, () => state)
  await update($, gitStatus, () => codes)
  await update($, commits, () => rows)
}

// ripgrep where it is, git grep where it is not: smart case, a few hits a file.
async function runSearch($: EngineInterface, cwd: string, query: string): Promise<Search> {
  if (query.trim() === '') {
    return { query, hits: [], isCut: false }
  }
  const rg = await $.process
    .run(['rg', '--line-number', '--no-heading', '--color', 'never', '--smart-case', '--max-count', '20', '--max-columns', '300', '--', query], { cwd })
    .catch(() => undefined)
  const ran =
    rg !== undefined && rg.exitCode !== 2
      ? rg
      : await $.process.run(['git', '-C', cwd, 'grep', '-n', '-I', '-i', '--', query]).catch(() => undefined)
  if (ran === undefined || ran.exitCode > 1) {
    return { query, hits: [], isCut: false, error: (ran?.stderr ?? 'no rg or git').trim().split('\n')[0] ?? '' }
  }

  return { query, ...parseHits(ran.stdout, HITS) }
}

// Children of the Run tab, by job: ending the stream kills the child.
const children = new Map<string, HookStream<ProcessSpawnChunk, ProcessSpawnResult>>()

// Runs a command in a shell and keeps the tail of its output in the job,
// flushed a few times a second; the job ends with the child.
async function runJob($: EngineInterface, cwd: string, command: string) {
  const id = crypto.randomUUID()
  const job: Job = { id, command, status: 'running', start: await $.clock.now(), output: [], total: 0 }
  await update($, jobs, list => [...list, job].slice(-KEPT_JOBS))
  await update($, pickedJob, () => id)
  const child = $.process.spawn({ argv: ['bash', '-lc', command], ...(cwd === '' ? {} : { cwd }) })
  children.set(id, child)
  let carry = ''
  let lines: string[] = []
  let flushedAt = 0
  const flush = async () => {
    const fresh = lines
    lines = []
    flushedAt = await $.clock.now()
    await update($, jobs, list =>
      list.map(one =>
        one.id === id
          ? { ...one, output: [...one.output, ...fresh].slice(-JOB_LINES), total: one.total + fresh.length }
          : one,
      ),
    )
  }
  let result: { code: number | null; signal: string | null } | undefined
  try {
    let step = await child.next()
    while (step.done !== true) {
      const parts = (carry + step.value.text).split('\n')
      carry = parts.pop() ?? ''
      lines.push(...parts.map(plain))
      if ((await $.clock.now()) - flushedAt >= JOB_FLUSH) {
        await flush()
      }
      step = await child.next()
    }
    result = step.value
  } catch (error) {
    lines.push(`(could not run: ${String(error)})`)
  }
  if (carry !== '') {
    lines.push(plain(carry))
  }
  await flush()
  const wasStopped = !children.has(id)
  children.delete(id)
  const end = await $.clock.now()
  await update($, jobs, list =>
    list.map(one =>
      one.id === id
        ? {
            ...one,
            end,
            code: result?.code ?? null,
            status: wasStopped ? 'stopped' : result?.code === 0 ? 'ok' : 'failed',
          }
        : one,
    ),
  )
}

function stopJob(id: string) {
  const child = children.get(id)
  children.delete(id)
  void child?.return({ code: null, signal: 'SIGTERM' })
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
    const state = await loadGit($, cwd)
    await update($, git, () => state)

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
    const width = Math.round(Math.min(LONGEST, Math.max(200, Number(e.width) || PAGE_WIDTH)))
    const height = Number(e.height) > 0 ? Math.round(Math.min(LONGEST, Math.max(50, Number(e.height)))) : undefined
    const drawn: Drawn | undefined = asText(e.d2)
      ? { d2: asText(e.d2) }
      : asText(e.mermaid)
        ? { mermaid: asText(e.mermaid) }
        : asText(e.dot)
          ? { dot: asText(e.dot) }
          : asText(e.html)
            ? { html: asText(e.html), width, ...(height === undefined ? {} : { height }) }
            : asText(e.svg)
              ? { svg: asText(e.svg) }
              : undefined
    if (path === '' && drawn === undefined) {
      return { deny: 'Give a source to draw (d2, mermaid, dot, html or svg) or the path of an image.' }
    }

    const source: Source = drawn ?? { path: absolute(path, cwd) }
    const caption = asText(e.caption) || basename(path) || 'design'
    const id = e.tool_use_id ?? crypto.randomUUID()
    const made = await freeze($, source, id, caption, 'shown')
    if (typeof made === 'string') {
      return { deny: made }
    }
    await keep($, made)
    const said = `Shown in the chat and the pane: ${caption} (${made.width}x${made.height}).`
    if (drawn === undefined) {
      return { result: said }
    }

    // A design Claude wrote comes back as the picture the person sees, so
    // Claude can check its layout.
    return {
      result: [
        { type: 'text', text: `${said} This is what the person sees: fix overlaps and cut or crowded text, and show it again, before you go on.` },
        await lookAt($, made),
      ],
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
      const state = await loadGit($, cwd)
      await update($, git, () => state)
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

  // A reply's ```mermaid blocks draw as diagrams in place: the code shows
  // while one renders, and again under why when it will not.
  const rendering = new Set<string>()
  // Each diagram's PNG, base64: bytes draw inside tmux too, a file name there
  // only its alt.
  const bytes = new Map<string, string>()
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const parts = splitMermaid(e.props.text)
    if (e.surface !== 'terminal' || e.props.isSummary === true || !parts.some(part => part.kind === 'mermaid')) {
      return next(e)
    }
    const drawn = await read($, diagrams)
    for (const diagram of drawn) {
      if (diagram.error === undefined && !bytes.has(diagram.id)) {
        const png = await $.fs.read(diagram.file, { as: 'bytes' }).catch(() => undefined)
        bytes.set(diagram.id, png === undefined || png.base64.length > PNG_BYTES ? '' : png.base64)
      }
    }
    for (const id of bytes.keys()) {
      if (!drawn.some(one => one.id === id)) {
        bytes.delete(id)
      }
    }
    const { Box, Image, Markdown, Text } = $.ui.resolve(e)
    const room = Math.max(1, (e.viewport?.columns ?? 84) - 6)

    // Laid out as the engine's reply row: a blank line above, the reply's
    // bullet, the body two columns in.
    return (
      <Box flexDirection="row" marginTop={1}>
        <Box width={2} flexShrink={0}>
          <Text color="text">{e.props.isFirstOfReply ? '●' : ' '}</Text>
        </Box>
        <Box flexDirection="column" gap={1} flexGrow={1}>
          {parts.map((part, n) => {
            if (part.kind === 'markdown') {
              return <Markdown key={`md-${n}`} text={part.text} />
            }
            const id = hashOf(part.source)
            const diagram = drawn.find(one => one.id === id)
            if (diagram === undefined && !rendering.has(id)) {
              rendering.add(id)
              void drawDiagram($, part.source, id).finally(() => rendering.delete(id))
            }
            if (diagram === undefined || diagram.error !== undefined) {
              return (
                <Box key={`mmd-${n}`} flexDirection="column">
                  <Markdown text={part.fence} />
                  <Text dimColor>{diagram?.error === undefined ? 'Rendering diagram…' : `Diagram: ${diagram.error}`}</Text>
                </Box>
              )
            }
            const columns = diagramColumns(diagram.width, DIAGRAM_SCALE, room)

            return (
              <Image
                key={`mmd-${n}`}
                source={bytes.get(id) ? { png: bytes.get(id) ?? '' } : { file: diagram.file, format: 'png' }}
                columns={columns}
                rows={rowsFor(diagram, columns, 60)}
                alt={`mermaid diagram: ${firstLine(part.source)}`}
              />
            )
          })}
        </Box>
      </Box>
    )
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

  // While Claude works, a strip above the prompt: the pulse, the step it is
  // on, its agents and what waits on you. The context stays in the status
  // line, which shows it already.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const acts = await read($, activity)
    const shownPlan = await read($, plan)
    const allLanes = await read($, lanes)
    const allNotes = await read($, notes)
    const runs = await read($, tests)
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

    return (
      <Box flexDirection="row" gap={1}>
        <Raster key="hud-pulse" {...pulse(beats, now, width, BEAT / 2)} />
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
      const box = fit(picture, Math.max(1, Math.min(100, (e.viewport?.columns ?? 84) - 4)), 40)

      return (
        <Box flexDirection="column">
          <Image source={{ file: picture.file, format: 'png' }} {...box} alt={picture.caption} />
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
    const allJobs = await read($, jobs)
    const pickedJobId = await read($, pickedJob)
    const gitState = await read($, git)
    const found = await read($, search)
    const now = await $.clock.now()
    // Only what this drawing holds can be repainted between drawings.
    forget(PANE)
    const Raster = e.surface === 'terminal' ? $.ui.resolve(e).Raster : undefined
    // The views draw a Raster only where the surface has one.
    const kit = { Box, Text, Button, ...(Raster === undefined ? {} : { Raster }) }
    const bodyColumns = Math.max(24, Math.min(512, e.props.bodyColumns))

    // The tabs always show, the tools among them work from the start; the
    // Now tab says what will come while nothing has.
    const isEmpty = shown === null && [allNotes, acts, pics, allTurns, runs].every(list => list.length === 0)

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

    // Calls over the last stretch, newest on the right: what Claude is doing
    // at a glance. The context and spend stay in the status line.
    const pulseView = () => {
      const lastAt = acts.at(-1)?.at
      if (Raster === undefined || lastAt === undefined) {
        return undefined
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
            calls · last {Math.round(span / 60_000)}m
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
        const box = fit(picture, Math.max(1, Math.min(255, e.props.bodyColumns)), 20)
        view = <Image source={{ file: picture.file, format: 'png' }} {...box} alt={picture.caption} />
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
            await $.ui.focus({ requestId: PANE, key: 'ex-mention' }).catch(() => undefined)
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
    } else if (tab === 'run') {
      body = runView(
        { ...kit, ...(e.surface === 'mobile' ? {} : { Input: $.ui.resolve(e).Input }) },
        {
          jobs: allJobs,
          picked: pickedJobId,
          now,
          onRun: command => () => {
            void runJob($, cwd, command)
            void $.ui.focus({ requestId: PANE, key: 'tab-run' }).catch(() => undefined)
          },
          onPick: id => () => update($, pickedJob, () => id),
          onStop: id => () => stopJob(id),
          onAsk: job => async () => {
            const tail = job.output.slice(-40).join('\n')
            await $.prompt.fill({
              text: `The output of \`${job.command}\` (${job.status}${job.code === undefined || job.code === null ? '' : `, exit ${job.code}`}):\n\`\`\`\n${tail}\n\`\`\`\n`,
              mode: 'insert',
            })
          },
        },
      )
    } else if (tab === 'git') {
      body = gitView(
        { ...kit, ...(e.surface === 'mobile' ? {} : { Input: $.ui.resolve(e).Input }) },
        {
          state: gitState,
          onToggle: file => () =>
            void gitDo($, cwd, file.index !== ' ' && file.index !== '?' ? ['restore', '--staged', '--', file.path] : ['add', '--', file.path]),
          onDiff: file => async () => {
            const loaded = await loadDiff($, absolute(file, cwd), file)
            await update($, diff, () => loaded)
            await update($, tabAtom, () => 'activity')
          },
          onStageAll: () => void gitDo($, cwd, ['add', '-A']),
          onUnstageAll: () => void gitDo($, cwd, ['reset', '-q']),
          onCommit: message => () => void gitDo($, cwd, ['commit', '-m', message]),
          onPush: () => void gitDo($, cwd, ['push'], 120_000),
          onRefresh: async () => {
            const state = await loadGit($, cwd)
            await update($, git, () => state)
          },
        },
      )
    } else if (tab === 'search') {
      body = searchView(
        { ...kit, ...(e.surface === 'mobile' ? {} : { Input: $.ui.resolve(e).Input }) },
        {
          search: found,
          onSearch: query => async () => {
            const result = await runSearch($, cwd, query)
            await update($, search, () => result)
            await $.ui.focus({ requestId: PANE, key: 'tab-search' }).catch(() => undefined)
          },
          onOpen: (file, line) => async () => {
            const loaded = await loadPreview($, cwd, file, line)
            await update($, preview, () => loaded)
            await update($, tabAtom, () => 'explorer')
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
    } else if (isEmpty) {
      body = (
        <Text dimColor>
          Nothing yet. Claude posts its plan, decisions and questions here as it works, and logs the files and
          commands it touches. Meanwhile: 0 explores the files, u runs a command, g is git, f searches.
        </Text>
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
      { id: 'run', label: 'Run', count: allJobs.filter(job => job.status === 'running').length, hotkey: 'u' },
      { id: 'git', label: 'Git', count: gitState?.files.length ?? 0, hotkey: 'g' },
      { id: 'search', label: 'Search', count: found?.hits.length ?? 0, hotkey: 'f' },
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
              onPress={async () => {
                await update($, tabAtom, () => one.id)
                // A tool's tab takes the typing at once; Enter there gives
                // the keys back to the tabs.
                const field = FIELDS[one.id]
                if (field !== undefined) {
                  await $.ui.focus({ requestId: PANE, key: field }).catch(() => undefined)
                }
              }}
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
