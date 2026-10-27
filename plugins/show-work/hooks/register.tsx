import { atom, read, update } from 'claude-code'
import type {
  Color,
  EngineInterface,
  Register,
  Timer,
} from 'claude-code'

import type {
  Act,
  ActKind,
  Diagram,
  GitState,
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
  Step,
  StepStatus,
  Tab,
} from '../types'
import { GREEN, RED, parseTests, patchCounts, pulse, shareBar } from './charts'
import { parseGit, parseHits, parseStatus, plain } from './explorer'
import {
  FIND_BROWSER,
  LONGEST,
  SHEET_MOST,
  TILE,
  blowUp,
  browserArgs,
  curlArgs,
  d2Args,
  dotArgs,
  errorLines,
  frame,
  fromHex,
  markArgs,
  markCells,
  measured,
  overlaps,
  wrap,
  mermaidArgs,
  nameOf,
  page,
  sheetArgs,
  sniff,
  svgSize,
} from './design'
import type { Drawn, Mark } from './design'
import { diagramColumns, hashOf, splitMermaid } from './mermaid'
import { explorerView, gitView, searchView, testsView } from './views'

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
const tests = atom({ plugin: 'show-work', key: 'tests' } as const, [], {
  shape: 'tests-1',
})
const touches = atom({ plugin: 'show-work', key: 'touches' } as const, [], {
  shape: 'touches-1',
})
const tree = atom({ plugin: 'show-work', key: 'tree' } as const, [], { shape: 'tree-1' })
const gitStatus = atom({ plugin: 'show-work', key: 'status' } as const, {}, { shape: 'status-1' })
const openDirs = atom({ plugin: 'show-work', key: 'openDirs' } as const, [], { shape: 'openDirs-1' })
const filter = atom({ plugin: 'show-work', key: 'filter' } as const, '')
const preview = atom({ plugin: 'show-work', key: 'preview' } as const, null, { shape: 'preview-1' })
const git = atom({ plugin: 'show-work', key: 'git' } as const, null, { shape: 'git-1' })
const search = atom({ plugin: 'show-work', key: 'search' } as const, null, { shape: 'search-1' })
// How many times taller than wide the terminal's cells are, as read from its
// tty; 2 where the terminal will not say, 0 until read.
const cellTall = atom({ plugin: 'show-work', key: 'cellTall' } as const, 0)
// The picture the pane shows; null shows the newest.
const picked = atom({ plugin: 'show-work', key: 'picked' } as const, null)
const tabAtom = atom({ plugin: 'show-work', key: 'tab' } as const, 'now')
// What the Find tab searches: file names, or the files' text.
const findMode = atom({ plugin: 'show-work', key: 'findMode' } as const, 'files')
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
const HITS = 200
const PREVIEW_LINES = 400
const KEPT_TOUCHES = 200
// A test command, by the runner or the word.
const TEST_COMMAND = /\b(tests?|spec|pytest|jest|vitest|mocha|rspec|ctest|gut|gdunit\w*)\b/i
// A git command that moves branches.
const GIT_MOVE = /\bgit\b.*\b(commit|merge|rebase|cherry-pick|reset|checkout|switch|pull|am|revert)\b/
// The pulse: a column per two seconds.
const BEAT = 2000
const DIFF_LINES = 300
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i
// The most marks one picture takes.
const MARKS_MOST = 12

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
- To show the person an image, call mcp__show-work__show with a path, a url for one on the web (reference art, an asset, a screenshot in docs), or images to set several side by side for them to compare and pick from. Add marks to point at what matters in it: a bug in a screenshot, what changed in a mockup.
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
- path: an image file that already exists.
- url: an image on the web: the image's own address, not the page it sits on. The result hands you what came back, so check it is the picture you meant.
- images: several images (paths or URLs) side by side on one sheet, lettered A, B, C… and labeled, to compare options. The person can press a tile's letter in the pane to pick it, which starts their prompt with "I pick B".
Add marks to any of these to point things out: numbered boxes or rings in the picture's own pixels. Each note is a button in a card under the picture that starts the person's reply about it; a detail shows there while they hover over the mark.`,
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
      url: { type: 'string', description: 'An image on the web (http or https): PNG, JPEG, GIF, WebP, BMP or SVG.' },
      marks: {
        type: 'array',
        description: 'Numbered marks drawn on the picture, in its own pixels, each note listed under it by number.',
        maxItems: MARKS_MOST,
        items: {
          type: 'object',
          properties: {
            x: { type: 'number', description: 'Left of the box, or the spot a ring circles.' },
            y: { type: 'number', description: 'Top of the box, or the spot a ring circles.' },
            w: { type: 'number', description: 'Box width; leave out for a ring.' },
            h: { type: 'number', description: 'Box height; leave out for a ring.' },
            note: { type: 'string', description: 'What the mark points out, in a few words.' },
            detail: { type: 'string', description: 'More on it, a sentence or two, shown while the person hovers over the mark.' },
          },
          required: ['x', 'y', 'note'],
        },
      },
      images: {
        type: 'array',
        description: `2 to ${SHEET_MOST} images to set side by side.`,
        maxItems: SHEET_MOST,
        items: {
          type: 'object',
          properties: {
            src: { type: 'string', description: 'A path or an http(s) URL.' },
            label: { type: 'string', description: 'A few words under it; its file name if left out.' },
          },
          required: ['src'],
        },
      },
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
const FIELDS: Partial<Record<Tab, string>> = { find: 'ex-filter' }

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

// A sheet's tiles go by letters, A first: the digits switch the pane's tabs.
export const letterOf = (n: number) => String.fromCharCode(65 + n)

// What pressing a sheet's tile starts the prompt with.
export function pickText(picture: Pick<Picture, 'caption' | 'tiles'>, n: number) {
  return `I pick ${letterOf(n)} (${picture.tiles?.[n] ?? ''}) from "${picture.caption}". `
}

// What pressing a mark's button starts the prompt with.
export function markText(picture: Pick<Picture, 'caption' | 'marks'>, n: number) {
  const note = picture.marks?.[n]?.note ?? ''
  const quote = note.length > 60 ? `${note.slice(0, 57)}...` : note

  return `About mark ${n + 1} ("${quote}") on "${picture.caption}": `
}

// How wide a picture's card is drawn: as its longest line, a detail
// included, so revealing one never widens it; at most `room`.
export function cardWidth(picture: Pick<Picture, 'tiles' | 'marks'>, room: number) {
  const tiles = picture.tiles ?? []
  const pick = tiles.length === 0 ? 0 : `Pick: ${tiles.map((label, n) => `[ ${letterOf(n)} ${label} ]`).join(' ')}`.length
  const marks = picture.marks ?? []
  const lines = marks.flatMap((mark, n) => [`${n + 1} ${mark.note} ↩`.length, mark.detail?.length ?? 0])
  const hint = marks.some(mark => mark.detail !== undefined) ? 'Point at a mark for its detail.'.length : 0

  // The border and padding take two cells a side.
  return Math.min(room, Math.max(pick, hint, ...lines) + 4)
}

// The hover group of a picture's mark: its spot on the picture and its row
// in the card light together.
export const markScope = (picture: Pick<Picture, 'id'>, n: number) => `mark-${picture.id.slice(-40)}-${n + 1}`

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

// The marks a show call asks for, each with a spot and a note; a box needs
// both its width and height.
export function readMarks(value: unknown): Mark[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap(item => {
    const note = asText(item?.note)
    const detail = asText(item?.detail)
    const [x, y, w, h] = [item?.x, item?.y, item?.w, item?.h].map(Number)
    if (note === '' || !Number.isFinite(x) || !Number.isFinite(y)) {
      return []
    }
    const isBox = Number.isFinite(w) && Number.isFinite(h) && (w ?? 0) > 0 && (h ?? 0) > 0

    return [{ x: x ?? 0, y: y ?? 0, ...(isBox ? { w, h } : {}), note, ...(detail === '' ? {} : { detail }) }]
  })
}

// Whether a note belongs to the task the plan opened; with no plan, all do.
export function isCurrent(note: Note, since: number | undefined) {
  return since === undefined || (note.at ?? -1) >= since
}

export function absolute(path: string, cwd: string) {
  return path.startsWith('/') || cwd === '' ? path : `${cwd}/${path}`
}

// A show call's input as its row prints it: the caption, then each source by
// its size, where the engine would print the source itself. A path or URL
// is short, so it stays; a sheet lists its labels.
export function briefShow(input: unknown) {
  const given = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const brief: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(given)) {
    if (['d2', 'mermaid', 'dot', 'html', 'svg'].includes(key) && typeof value === 'string') {
      const lines = value.trim().split('\n').length
      brief[key] = lines > 1 ? `${lines} lines` : `${value.length} characters`
    } else if (key === 'marks' && Array.isArray(value)) {
      brief[key] = `${value.length} ${value.length === 1 ? 'mark' : 'marks'}`
    } else if (key === 'images' && Array.isArray(value)) {
      brief[key] = value.map(item => asText(item?.label) || nameOf(asText(item?.src))).join(', ')
    } else {
      brief[key] = value
    }
  }

  return brief
}

// A plan call's input as its row prints it: the goal, then the steps by
// their count and status, where the engine would print every step.
export function briefPlan(input: unknown) {
  const given = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const steps = (Array.isArray(given.steps) ? given.steps : []) as Array<Record<string, unknown> | null>
  const done = steps.filter(step => step?.status === 'done').length
  const doing = steps.find(step => step?.status === 'doing')
  const progress = `${done}/${steps.length} done`
  const now = asText(doing?.text)

  return { goal: given.goal, steps: now === '' ? progress : `${progress}, doing: ${now}` }
}

// A note call's input as its row prints it: the kind and the sentence, with
// the longer reasons by their size; the pane and ctrl+o hold them whole.
export function briefNote(input: unknown) {
  const given = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const brief: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(given)) {
    brief[key] = (key === 'why' || key === 'detail') && typeof value === 'string' ? `${value.length} characters` : value
  }

  return brief
}

// Rows a picture takes at a width, a terminal cell being `tall` times as
// tall as it is wide: about twice, or as the terminal says (cellShape).
export function rowsFor(picture: Pick<Picture, 'width' | 'height'>, columns: number, most: number, tall = 2) {
  const rows = Math.round((columns * picture.height) / picture.width / tall)

  return Math.max(1, Math.min(most, rows))
}

// The box that shows a whole picture in at most `columns` by `rows`: as wide
// as allowed, narrower when a tall picture would take more rows. Sized to
// the cells' real shape, the picture fills it, so a mark's cells sit on it.
export function fit(picture: Pick<Picture, 'width' | 'height'>, columns: number, rows: number, tall = 2) {
  const down = rowsFor(picture, columns, Number.POSITIVE_INFINITY, tall)
  if (down <= rows) {
    return { columns, rows: down }
  }

  return { columns: Math.max(1, Math.min(columns, Math.round((rows * tall * picture.width) / picture.height))), rows }
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
  const gitOut = (argv: string[]) =>
    $.process.run(['git', '-C', dir, ...argv]).then(ran => ran.stdout, () => '')
  let out = await gitOut(['diff', '--no-color', 'HEAD', '--', path])
  if (out.trim() === '') {
    out = await gitOut(['diff', '--no-color', '--no-index', '/dev/null', path])
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

// An image at a path or a URL; several of them on one sheet; or a design.
type Source = { src: string } | { sheet: { src: string; label?: string }[] } | Drawn

const WEB = /^https?:\/\//i

const cacheDir = async ($: EngineInterface) =>
  `${(await $.env.get('XDG_CACHE_HOME')) || `${await $.env.get('HOME')}/.cache`}/show-work`

// Reads the terminal's size in pixels from the tty of the nearest process
// above this one that has one, and answers its cells' height over width;
// undefined where there is no /proc or the terminal gives no pixels.
const CELL_SHAPE = `
import fcntl, os, struct, termios
pid = os.getppid()
for _ in range(16):
    tty = next((t for t in (os.readlink(f'/proc/{pid}/fd/{n}') for n in (0, 1, 2) if os.path.exists(f'/proc/{pid}/fd/{n}')) if t.startswith(('/dev/pts/', '/dev/tty'))), None)
    if tty:
        with open(tty, 'rb') as f:
            rows, cols, x, y = struct.unpack('HHHH', fcntl.ioctl(f.fileno(), termios.TIOCGWINSZ, bytes(8)))
        if rows and cols and x and y:
            print((y / rows) / (x / cols))
        break
    pid = int(open(f'/proc/{pid}/stat').read().rsplit(')', 1)[1].split()[1])
    if pid <= 1:
        break
`

async function cellShape($: EngineInterface) {
  const ran = await $.process.run(['python3', '-I', '-c', CELL_SHAPE], { timeoutMs: 5000 }).catch(() => undefined)
  const tall = Number(firstLine(ran?.stdout ?? ''))

  return ran?.exitCode === 0 && tall >= 1 && tall <= 4 ? tall : undefined
}

// The cells' shape for sizing a picture. Unread, as after a reload of the
// plugin mid-session, it is read now and the picture drawn again; 2 till then.
let isReadingCell = false
async function shapeOf($: EngineInterface) {
  const tall = await read($, cellTall)
  if (tall === 0 && !isReadingCell) {
    isReadingCell = true
    void cellShape($)
      .then(found => update($, cellTall, () => found ?? 2))
      .finally(() => {
        isReadingCell = false
      })
  }

  return tall === 0 ? 2 : tall
}

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

// Fetches an image from the web into `${at}.web` and names its format from
// its first bytes. Answers why when it can't.
async function fetchImage($: EngineInterface, url: string, at: string) {
  const file = `${at}.web`
  const ran = await $.process.run(curlArgs(url, file), { timeoutMs: 40_000 }).catch((error: unknown) => String(error))
  if (typeof ran === 'string') {
    return /time|still running/i.test(ran) ? `Fetching ${url} took too long.` : 'curl would not start: is it installed?'
  }
  if (ran.exitCode !== 0) {
    const said = firstLine(plain(ran.stderr)).replace(/^curl: \(\d+\)\s*/, '')

    return `Could not fetch ${url}: ${said || `curl exited ${ran.exitCode}`}.`
  }
  const head = await $.process.run(['od', '-An', '-tx1', '-N512', file])
  const bytes = fromHex(head.stdout)
  const format = sniff(bytes)
  if (format === undefined) {
    await $.process.run(['rm', '-f', file])

    return /<(!doctype )?html/i.test(bytes)
      ? `${url} is a web page: give the address of the image itself.`
      : `${url} is not a PNG, JPEG, GIF, WebP, BMP or SVG image.`
  }

  return { file, format }
}

// Converts the image at a path or URL into a PNG at `to`. Answers why when
// it can't.
async function bring($: EngineInterface, src: string, at: string, to: string) {
  let argv: string[]
  let fetched: string | undefined
  if (WEB.test(src)) {
    const got = await fetchImage($, src, at)
    if (typeof got === 'string') {
      return got
    }
    fetched = got.file
    argv = got.format === 'svg' ? ['rsvg-convert', '-o', to, got.file] : ['magick', `${got.format}:${got.file}[0]`, to]
  } else {
    if (!(await $.fs.exists(src))) {
      return `No image at ${src}.`
    }
    argv = /\.svg$/i.test(src) ? ['rsvg-convert', '-o', to, src] : /\.png$/i.test(src) ? ['cp', src, to] : ['magick', `${src}[0]`, to]
  }
  const made = await $.process.run(argv)
  if (fetched !== undefined) {
    await $.process.run(['rm', '-f', fetched])
  }

  return made.exitCode === 0 ? undefined : `Could not read the image: ${firstLine(made.stderr) || argv[0]}`
}

// The font a sheet's labels are set in: the system's sans; none leaves
// ImageMagick's own.
async function findFont($: EngineInterface) {
  const found = await $.process.run(['fc-match', '-f', '%{file}', 'sans-serif:weight=medium']).catch(() => undefined)

  return found?.exitCode === 0 ? firstLine(found.stdout) || undefined : undefined
}

// Sets several images side by side on one sheet at `to`, each numbered over
// its label; a small one, such as a sprite, is blown up with whole pixels.
// Answers why when it can't.
async function sheet($: EngineInterface, items: { src: string; label?: string }[], at: string, to: string) {
  const tiles: { file: string; label: string }[] = []
  try {
    for (const [n, item] of items.entries()) {
      const file = `${at}-${n + 1}.png`
      tiles.push({ file, label: `${letterOf(n)}  ${item.label || nameOf(item.src)}` })
      const why = await bring($, item.src, `${at}-${n + 1}`, file)
      if (why !== undefined) {
        return `Picture ${n + 1}: ${why}`
      }
      // A sprite is blown up with whole pixels; anything bigger than a tile
      // shrinks to fit one, so the sheet's cells take the pictures' shape.
      const size = await sizeOf($, file)
      const factor = blowUp(size?.width ?? 0, size?.height ?? 0)
      const resize = factor > 1 ? ['-filter', 'point', '-resize', `${factor * 100}%`] : ['-resize', `${TILE}x${TILE}>`]
      await $.process.run(['magick', file, ...resize, file])
    }

    return await draw($, sheetArgs(await isLightTheme($), tiles, to, await findFont($)))
  } finally {
    await $.process.run(['rm', '-f', ...tiles.map(tile => tile.file)])
  }
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
  marks: Mark[] = [],
): Promise<Picture | string> {
  const dir = await cacheDir($)
  const file = `${dir}/${id}.png`
  await $.process.run(['mkdir', '-p', dir])

  if ('src' in source) {
    // Reading a picture from the cache adds no copy; showing one again, as
    // to mark it, does.
    if (origin === 'read' && source.src.startsWith(`${dir}/`)) {
      return 'That picture is already shown.'
    }
    const why = await bring($, source.src, `${dir}/${id}`, file)
    if (why !== undefined) {
      return why
    }
  } else if ('sheet' in source) {
    const why = await sheet($, source.sheet, `${dir}/${id}`, file)
    if (why !== undefined) {
      return why
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

  const size = await sizeOf($, file)
  if (marks.length > 0 && size !== undefined) {
    const why = await draw($, markArgs(file, file, marks, size, await isLightTheme($), await findFont($)))
    if (why !== undefined) {
      return `Could not draw the marks: ${why}`
    }
  }
  const tiles = 'sheet' in source ? { tiles: source.sheet.map(item => item.label || nameOf(item.src)) } : {}

  return { id, file, ...(size ?? { width: 16, height: 9 }), caption, origin, ...tiles, ...(marks.length > 0 ? { marks } : {}) }
}

// A picture's size in pixels, as ImageMagick reads it.
async function sizeOf($: EngineInterface, file: string) {
  const size = await $.process.run(['magick', 'identify', '-format', '%w %h', file])
  const [width = 0, height = 0] = size.stdout.split(' ').map(Number)

  return width > 0 && height > 0 ? { width, height } : undefined
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
    const files = dropped.flatMap(one => [
      ...['.png', '-look.png', '.svg', '.d2', '.mmd', '.dot', '.html'].map(end => one.file.replace(/\.png$/, end)),
    ])
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
const MARKDOWN = /\.(md|markdown|mdx)$/i
const MD_IMAGE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g
const MD_IMAGES_MOST = 8
const MD_CHARS = 100_000

// `dir/ref` with its dots resolved: `a/b` and `../c` make `a/c`.
export function joinPath(dir: string, ref: string) {
  const parts = (ref.startsWith('/') ? ref : `${dir}/${ref}`).split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '..') {
      out.pop()
    } else if (part !== '' && part !== '.') {
      out.push(part)
    }
  }

  return `${ref.startsWith('/') || dir.startsWith('/') ? '/' : ''}${out.join('/')}`
}

// The local pictures a markdown file draws, copied into the cache as PNGs.
async function markdownImages($: EngineInterface, cwd: string, file: string, text: string) {
  const dir = absolute(file, cwd).slice(0, absolute(file, cwd).lastIndexOf('/')) || '/'
  const found: NonNullable<Preview['images']> = []
  for (const match of text.matchAll(MD_IMAGE)) {
    const ref = match[2] ?? ''
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//') || !IMAGE.test(ref) || found.some(one => one.ref === ref)) {
      continue
    }
    if (found.length >= MD_IMAGES_MOST) {
      break
    }
    const path = joinPath(dir, decodeURI(ref))
    if (!(await $.fs.exists(path))) {
      continue
    }
    const made = await freeze($, { src: path }, `md-${hashOf(path)}`, match[1] ?? '', 'read')
    if (typeof made !== 'string') {
      found.push({ ref, alt: match[1] ?? '', file: made.file, width: made.width, height: made.height })
    }
  }

  return found
}

async function loadPreview($: EngineInterface, cwd: string, file: string, hit?: number): Promise<Preview> {
  const text = await $.fs.read(absolute(file, cwd)).catch(() => '')
  const source = typeof text === 'string' ? text : ''
  if (source.includes('\u0000')) {
    return { file, source: '', lines: 0, isCut: false, isBinary: true }
  }
  const lines = source.split('\n')
  if (hit === undefined && MARKDOWN.test(file)) {
    const shown = source.slice(0, MD_CHARS)

    return {
      file,
      source: shown,
      lines: lines.length,
      isCut: source.length > MD_CHARS,
      isBinary: false,
      isMarkdown: true,
      images: await markdownImages($, cwd, file, shown),
    }
  }
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

// A git command from the Git tab, then the tab and the Find marks read again.
async function gitDo($: EngineInterface, cwd: string, argv: string[], timeoutMs = 30_000) {
  const ran = await $.process.run(['git', '-C', cwd, ...argv], { timeoutMs }).catch((error: unknown) => ({
    exitCode: 1,
    stdout: '',
    stderr: String(error),
  }))
  const said = (ran.exitCode === 0 ? ran.stdout || ran.stderr : ran.stderr || ran.stdout).trim().split('\n')
  const note = { text: `git ${argv[0]}: ${said.at(-1) || (ran.exitCode === 0 ? 'done' : 'failed')}`, isError: ran.exitCode !== 0 }
  const [state, codes] = await Promise.all([loadGit($, cwd, note), loadStatus($, cwd)])
  await update($, git, () => state)
  await update($, gitStatus, () => codes)
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
    const [files, codes] = await Promise.all([loadTree($, cwd), loadStatus($, cwd)])
    const tall = await cellShape($)
    await update($, cellTall, () => tall ?? 2)
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
    const url = asText(e.url)
    const items = (Array.isArray(e.images) ? e.images : []).flatMap(item => {
      const src = asText(item?.src)
      const label = asText(item?.label)

      return src === '' ? [] : [{ src: WEB.test(src) ? src : absolute(src, cwd), ...(label === '' ? {} : { label }) }]
    })
    if (items.length > SHEET_MOST) {
      return { deny: `A sheet holds at most ${SHEET_MOST} images.` }
    }
    if (url !== '' && !WEB.test(url)) {
      return { deny: 'Give url an http or https address; a file goes in path.' }
    }
    const marks = readMarks(e.marks)
    if (marks.length > MARKS_MOST) {
      return { deny: `A picture takes at most ${MARKS_MOST} marks.` }
    }
    const source: Source | undefined =
      drawn ??
      (items.length > 1
        ? { sheet: items }
        : items.length === 1
          ? { src: items[0]?.src ?? '' }
          : url !== ''
            ? { src: url }
            : path !== ''
              ? { src: absolute(path, cwd) }
              : undefined)
    if (source === undefined) {
      return { deny: 'Give a source to draw (d2, mermaid, dot, html or svg), or an image: path, url or images.' }
    }

    const named = 'src' in source ? nameOf(source.src) : ''
    const caption = asText(e.caption) || named || 'design'
    const id = e.tool_use_id ?? crypto.randomUUID()
    const made = await freeze($, source, id, caption, 'shown', marks)
    if (typeof made === 'string') {
      return { deny: made }
    }
    await keep($, made)
    const said = `Shown in the chat and the pane: ${caption} (${made.width}x${made.height}).`
    // A file on disk Claude can Read; anything else comes back as the
    // picture the person sees.
    if ('src' in source && !WEB.test(source.src) && marks.length === 0) {
      return { result: said }
    }
    const crossed = overlaps(marks, made)
      .map(([a, b]) => `${a} and ${b}`)
      .join(', ')
    const check =
      drawn !== undefined
        ? 'This is what the person sees: fix overlaps and cut or crowded text, and show it again, before you go on.'
        : marks.length > 0
          ? `This is what the person sees: check each mark sits on what its note names, and show it again if one is off.${
              crossed === '' ? '' : ` Marks ${crossed} overlap; where they do, pointing lands on the smaller one. Tighten them if they need not.`
            }`
          : 'This is what the person sees: check it is the picture you meant.'

    return { result: [{ type: 'text', text: `${said} ${check}` }, await lookAt($, made)] }
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

  // The turn's end closes its row in the log.
  on('turn.complete', async ($, e, next) => {
    const end = await $.clock.now()
    const done = await next(e)
    await update($, turns, list =>
      list.map(one =>
        one.id === e.turnId
          ? {
              ...one,
              end,
              reason: e.reason,
            }
          : one,
      ),
    )

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
        const patch = isEdit && ran.deny === undefined ? patchCounts(ran.result) : { added: 0, removed: 0 }
        const touch: Touch = {
          file: what.label,
          reads: (old?.reads ?? 0) + (what.kind === 'read' ? 1 : 0),
          edits: (old?.edits ?? 0) + (isEdit ? 1 : 0),
          added: (old?.added ?? 0) + patch.added,
          removed: (old?.removed ?? 0) + patch.removed,
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
    }
    if (status === 'ok' && what.image !== undefined) {
      const made = await freeze($, { src: what.image }, act.id, what.label, 'read')
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
      // The Changes tab opens on the latest edit's diff.
      const fresh = await loadDiff($, what.path, label)
      await update($, diff, () => fresh)
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
    const tall = await shapeOf($)

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
                rows={rowsFor(diagram, columns, 60, tall)}
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

  // A call's row to this plugin's tools sums its input up in a few words,
  // where the engine would print all of it; ctrl+o still shows all of it.
  for (const [tool, brief] of [
    ['mcp__show-work__show', briefShow],
    ['mcp__show-work__plan', briefPlan],
    ['mcp__show-work__note', briefNote],
  ] as const) {
    on('ui.render', { component: 'ToolUse', props: { tool } }, async (_, e, next) =>
      e.props.isExpanded === true ? next(e) : next({ ...e, props: { ...e.props, input: brief(e.props.input) } }),
    )
  }

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

      const { Box, Button, Text } = $.ui.resolve(e)
      const fill = (text: string) => () => $.prompt.fill({ text, mode: 'insert' })
      // A card of what the picture asks of the person: a sheet's tiles to
      // pick, a mark to answer. Pressing one starts the reply in the prompt;
      // hovering a mark, on the picture or here, lights its row and shows
      // its detail.
      const tiles = picture.tiles ?? []
      const marks = picture.marks ?? []
      // The transcript's width, less the row's margin; an Image takes 255 at most.
      const room = Math.max(20, Math.min(255, (e.viewport?.columns ?? 84) - 4))
      const width = cardWidth(picture, room)
      // Inside the border and padding.
      const inner = width - 4
      const details = marks.flatMap((mark, n) => (mark.detail === undefined ? [] : [{ n, lines: wrap(mark.detail, inner) }]))
      const detailRows = Math.max(1, ...details.map(one => one.lines.length))
      const card =
        tiles.length + marks.length === 0 ? null : (
          <Box
            flexDirection="column"
            borderStyle="round"
            borderDimColor
            paddingX={1}
            alignSelf="flex-start"
            width={width}
          >
            {tiles.length > 0 && (
              <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
                <Text dimColor>Pick:</Text>
                {tiles.map((label, n) => (
                  <Button key={`pick-${picture.id}-${letterOf(n)}`} onPress={fill(pickText(picture, n))}>
                    <Text weight="bold">{letterOf(n)}</Text> {label}
                  </Button>
                ))}
              </Box>
            )}
            {marks.map((mark, n) => (
              <Box
                key={`row-${picture.id}-${n + 1}`}
                hover={{ scope: markScope(picture, n), backgroundColor: 'subtle' }}
              >
                <Button key={`mark-${picture.id}-${n + 1}`} plain onPress={fill(markText(picture, n))}>
                  <Text color="claude" weight="bold">{n + 1}</Text> {mark.note} <Text dimColor>↩</Text>
                </Button>
              </Box>
            ))}
            {details.length > 0 && (
              // The detail of the mark pointed at, in lines kept for the
              // longest, so the card never changes height and the chat
              // above it never moves.
              <Box key={`details-${picture.id}`} height={detailRows} marginTop={1}>
                <Text dimColor italic>
                  Point at a mark for its detail.
                </Text>
                {details.map(({ n, lines }) => (
                  <Box
                    key={`detail-${picture.id}-${n + 1}`}
                    position="absolute"
                    top={0}
                    left={0}
                    flexDirection="column"
                    display="none"
                    hover={{ scope: markScope(picture, n), display: 'flex' }}
                  >
                    {Array.from({ length: detailRows }, (_, row) => (
                      <Text key={`line-${row}`} dimColor>
                        {(lines[row] ?? '').padEnd(inner)}
                      </Text>
                    ))}
                  </Box>
                ))}
              </Box>
            )}
          </Box>
        )

      if (e.surface !== 'terminal') {
        return (
          <Box flexDirection="column">
            <Text dimColor>
              {picture.caption}: {picture.file}
            </Text>
            {card}
          </Box>
        )
      }

      const { Image } = $.ui.resolve(e)
      // As wide as the transcript, and at most a screen tall.
      const box = fit(picture, room, Math.max(40, Math.min(255, (e.viewport?.rows ?? 40) - 4)), await shapeOf($))
      // Each mark's spot on the picture, the biggest first, so where two
      // overlap the smaller, drawn on top, takes the pointer. Pointing at one
      // lights its row in the card and shows its detail. Nothing is laid over
      // the picture itself: kitty leaves a revealed picture drawn once the
      // chat scrolls.
      const spots = marks
        .map((mark, n) => ({ n, cells: markCells(mark, picture, box) }))
        .sort((a, b) => b.cells.width * b.cells.height - a.cells.width * a.cells.height)

      return (
        <Box flexDirection="column">
          <Box key={`pic-${picture.id}`} width={box.columns} height={box.rows}>
            <Image source={{ file: picture.file, format: 'png' }} {...box} alt={picture.caption} />
            {spots.map(({ n, cells }) => (
              <Box
                key={`spot-${picture.id}-${n + 1}`}
                position="absolute"
                {...cells}
                hover={{ scope: markScope(picture, n) }}
              />
            ))}
          </Box>
          <Text dimColor>
            {picture.caption} <Text dimColor>{picture.width}x{picture.height}</Text>
          </Text>
          {card}
        </Box>
      )
    },
  )

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Code, Text } = $.ui.resolve(e)
    const shown = await read($, plan)
    const allNotes = await read($, notes)
    const acts = await read($, activity)
    const pics = await read($, pictures)
    const pickedId = await read($, picked)
    const tab = await read($, tabAtom)
    const mode = await read($, findMode)
    const isShowingEarlier = await read($, showEarlier)
    const openId = await read($, openNote)
    const shownDiff = await read($, diff)
    const allLanes = await read($, lanes)
    const allTurns = await read($, turns)
    const runs = await read($, tests)
    const touched = await read($, touches)
    const projectFiles = await read($, tree)
    const codes = await read($, gitStatus)
    const opened = await read($, openDirs)
    const filterText = await read($, filter)
    const shownPreview = await read($, preview)
    const gitState = await read($, git)
    const found = await read($, search)
    const tall = await shapeOf($)
    const now = await $.clock.now()
    // Only what this drawing holds can be repainted between drawings.
    forget(PANE)
    const Raster = e.surface === 'terminal' ? $.ui.resolve(e).Raster : undefined
    // The views draw a Raster only where the surface has one.
    const kit = { Box, Text, Button, ...(Raster === undefined ? {} : { Raster }) }

    // The tabs always show, the tools among them work from the start; the
    // Now tab says what will come while nothing has.
    const isEmpty = shown === null && [allNotes, acts, pics, allTurns, runs].every(list => list.length === 0)

    const since = shown?.startedAt
    const current = allNotes.filter(note => isCurrent(note, since))
    const earlier = allNotes.length - current.length
    const open = current.filter(note => note.kind === 'question' && !note.isReplied)
    const picture = pics.find(one => one.id === pickedId) ?? pics.at(-1)
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
        {shownDiff.lines.length === 0 ? (
          <Text dimColor>No changes against git HEAD.</Text>
        ) : (
          <Code source={shownDiff.lines.join('\n')} format="diff" path={shownDiff.file} />
        )}
        {shownDiff.isCut && <Text dimColor>… cut at {DIFF_LINES} lines</Text>}
      </Box>
    )

    // One line on what Claude is doing: working or idle, the call in
    // flight, the agents running and the failures this turn.
    const statusView = () => {
      const turn = allTurns.at(-1)
      const isBusy = turn !== undefined && turn.end === undefined
      const call = acts.findLast(act => act.status === 'runs' && !act.isSubagent)
      const agents = currentLanes.filter(lane => lane.status === 'runs').length
      const broke = acts.filter(act => act.status === 'failed' && turn !== undefined && act.turn === turn.n).length
      const bits = [
        call === undefined ? '' : `${call.kind} ${call.label}`,
        agents === 0 ? '' : `${agents} agent${agents === 1 ? '' : 's'} running`,
        broke === 0 ? '' : `${broke} failed this turn`,
      ].filter(bit => bit !== '')

      return (
        <Text wrap="truncate-end">
          <Text color={isBusy ? 'warning' : 'success'} weight="bold">
            {isBusy ? '● working' : '○ idle'}
          </Text>
          {bits.length === 0 ? '' : <Text dimColor> · {bits.join(' · ')}</Text>}
        </Text>
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

    const findNames = () =>
      explorerView(
        {
          ...kit,
          ...(e.surface === 'mobile' ? {} : { Input: $.ui.resolve(e).Input }),
          Code,
          Markdown: $.ui.resolve(e).Markdown,
          ...(e.surface === 'terminal' ? { Image: $.ui.resolve(e).Image } : {}),
        },
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
          onRaw: () => update($, preview, one => (one === null ? one : { ...one, isRaw: one.isRaw !== true })),
          onLink: href => {
            const target = joinPath(absolute(shownPreview?.file ?? '', cwd).replace(/\/[^/]*$/, '') || '/', decodeURI(href.split('#')[0] ?? ''))
            void loadPreview($, cwd, relative(target, cwd)).then(loaded => update($, preview, () => loaded))
          },
          place: size => fit(size, Math.min(255, e.props.bodyColumns), 18, tall),
          onMention: file => async () => {
            await $.prompt.fill({ text: `@${file} `, mode: 'insert' })
          },
          onDiff: file => async () => {
            const loaded = await loadDiff($, absolute(file, cwd), file)
            await update($, diff, () => loaded)
            await update($, tabAtom, () => 'changes')
          },
          onRefresh: async () => {
            const [listed, status] = await Promise.all([loadTree($, cwd), loadStatus($, cwd)])
            await update($, tree, () => listed)
            await update($, gitStatus, () => status)
          },
        },
      )

    const findText = () =>
      searchView(
        { ...kit, ...(e.surface === 'mobile' ? {} : { Input: $.ui.resolve(e).Input }) },
        {
          search: found,
          onSearch: query => async () => {
            const result = await runSearch($, cwd, query)
            await update($, search, () => result)
            await $.ui.focus({ requestId: PANE, key: 'tab-find' }).catch(() => undefined)
          },
          onOpen: (file, line) => async () => {
            const loaded = await loadPreview($, cwd, file, line)
            await update($, preview, () => loaded)
            await update($, findMode, () => 'files')
            await update($, tabAtom, () => 'find')
          },
        },
      )

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
        const box = fit(picture, Math.max(1, Math.min(255, e.props.bodyColumns)), 20, await shapeOf($))
        view = <Image source={{ file: picture.file, format: 'png' }} {...box} alt={picture.caption} />
      }
      body =
        picture === undefined ? (
          <Text dimColor>No pictures yet.</Text>
        ) : (
          <Box flexDirection="column">
            {view ?? <Text dimColor>{picture.file}</Text>}
            <Text italic>{picture.caption}</Text>
            {picture.tiles !== undefined && (
              <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
                <Text dimColor>Pick:</Text>
                {picture.tiles.map((label, n) => (
                  <Button
                    key={`tile-${letterOf(n)}`}
                    hotkey={letterOf(n).toLowerCase()}
                    onPress={() => $.prompt.fill({ text: pickText(picture, n), mode: 'insert' })}
                  >
                    <Text weight="bold">{letterOf(n)}</Text> {label}
                  </Button>
                ))}
              </Box>
            )}
            {(picture.marks ?? []).map((mark, n) => (
              <Box key={`pane-row-${n + 1}`} hover={{ scope: markScope(picture, n), backgroundColor: 'subtle' }}>
                <Button
                  key={`pane-mark-${n + 1}`}
                  plain
                  onPress={() => $.prompt.fill({ text: markText(picture, n), mode: 'insert' })}
                >
                  <Text color="claude" weight="bold">{n + 1}</Text> {mark.note} <Text dimColor>↩</Text>
                </Button>
              </Box>
            ))}
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
    } else if (tab === 'tests') {
      body = testsView(
        kit,
        {
          runs,
          now,
          onFix: run => async () => {
            const names = run.names.filter(one => !one.ok).map(one => `- ${one.name}`)
            const which = names.length === 0 ? '' : `:\n${names.slice(0, 20).join('\n')}\n`
            await $.prompt.fill({ text: `Fix the failing tests from \`${run.command}\`${which}`, mode: 'insert' })
          },
        },
      )
    } else if (tab === 'find') {
      body = (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" columnGap={2}>
            <Button key="find-files" plain dimColor={mode !== 'files'} hotkey="o" onPress={() => update($, findMode, () => 'files')}>
              <Text weight={mode === 'files' ? 'bold' : 'regular'}>Names</Text>
            </Button>
            <Button key="find-text" plain dimColor={mode !== 'text'} hotkey="t" onPress={() => update($, findMode, () => 'text')}>
              <Text weight={mode === 'text' ? 'bold' : 'regular'}>Text</Text>
            </Button>
          </Box>
          {mode === 'text' ? findText() : findNames()}
        </Box>
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
            await update($, tabAtom, () => 'changes')
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
    } else if (tab === 'changes') {
      // The files Claude edited, newest first, and the diff of the one shown.
      const edited = touched.filter(touch => touch.edits > 0).sort((a, b) => b.at - a.at)
      const names = edited.some(touch => touch.file === shownDiff?.file) || shownDiff === null
        ? edited.map(touch => touch.file)
        : [shownDiff.file, ...edited.map(touch => touch.file)]
      body =
        names.length === 0 ? (
          <Text dimColor>No files edited yet. The diff of each file Claude edits shows here.</Text>
        ) : (
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
              {names.slice(0, 12).map(file => (
                <Button key={`file-${file}`} plain dimColor={file !== shownDiff?.file} onPress={openDiff(file)}>
                  <Text weight={file === shownDiff?.file ? 'bold' : 'regular'}>{file}</Text>
                </Button>
              ))}
            </Box>
            {shownDiff === null ? <Text dimColor>Press a file for its diff.</Text> : diffView(shownDiff)}
          </Box>
        )
    } else if (isEmpty) {
      body = (
        <Text dimColor>
          Nothing yet. Claude posts its plan, decisions and questions here as it works, and logs the files and
          commands it touches. Meanwhile: f finds files and text, g is git.
        </Text>
      )
    } else {
      body = (
        <Box flexDirection="column" gap={1}>
          {open.length > 0 && (
            <Box flexDirection="column">
              <Text color="warning" weight="bold">
                Waiting on you <Text dimColor>press to reply</Text>
              </Text>
              {open.map(note => noteRow(note))}
            </Box>
          )}
          {statusView()}
          {planView()}
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
        </Box>
      )
    }

    // No counts: a dot on Notes says a question waits on you, and that is all.
    const TABS: { id: Tab; label: string; hasAlert?: boolean; hotkey: string }[] = [
      { id: 'now', label: 'Now', hotkey: '1' },
      { id: 'notes', label: 'Notes', hasAlert: open.length > 0, hotkey: '2' },
      { id: 'pictures', label: 'Pictures', hotkey: '3' },
      { id: 'changes', label: 'Changes', hotkey: '4' },
      { id: 'tests', label: 'Tests', hotkey: '5' },
      { id: 'git', label: 'Git', hotkey: 'g' },
      { id: 'find', label: 'Find', hotkey: 'f' },
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
                const field = one.id === 'find' && mode === 'text' ? 'search-q' : FIELDS[one.id]
                if (field !== undefined) {
                  await $.ui.focus({ requestId: PANE, key: field }).catch(() => undefined)
                }
              }}
            >
              <Text weight={one.id === tab ? 'bold' : 'regular'}>{one.label}</Text>
              {one.hasAlert === true && <Text color="warning"> ●</Text>}
            </Button>
          ))}
        </Box>
        {body}
      </Box>
    )
  })
}
