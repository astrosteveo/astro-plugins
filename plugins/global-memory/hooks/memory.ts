// The files of the global memory: one fact per file, and MEMORY.md, the index of them all.

export const TYPES = ['user', 'feedback', 'reference'] as const
export type MemoryType = (typeof TYPES)[number]

export const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/

// Where the file system ignores case, memory.md is MEMORY.md, the index: no memory may take that name.
const RESERVED = ['memory']
export const isName = (name: string) => SLUG.test(name) && !RESERVED.includes(name)

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

// A title with a bracket would end the index link early.
const plainTitle = (title: string) => oneLine(title).replace(/[[\]]/g, '')

// `modified` is where Claude Code records when it wrote one of its own memories, so a later
// session can tell how current the fact is.
export function memoryFile(entry: { name: string; description: string; type: MemoryType; body: string; modified: number }) {
  return [
    '---',
    `name: ${entry.name}`,
    `description: ${JSON.stringify(oneLine(entry.description))}`,
    'metadata:',
    `  type: ${entry.type}`,
    `  modified: ${new Date(entry.modified).toISOString()}`,
    '---',
    '',
    entry.body.trim(),
    '',
  ].join('\n')
}


// An index line is "- [title](name.md) — description": the name is read from the line's start,
// so a description that mentions another memory's link does not stand for that memory.
const ENTRY = /^\s*[-*] \[([^\]]*)\]\(([a-z0-9-]+)\.md\)/

const entryName = (line: string) => ENTRY.exec(line)?.[2]

export const hasEntry = (index: string, name: string) => index.split('\n').some(l => entryName(l) === name)

// The line the entry gets in the index. A blank title keeps the title of the line it replaces,
// else the name.
export function entryLine(index: string, name: string, title: string, description: string) {
  const kept = ENTRY.exec(index.split('\n').find(l => entryName(l) === name) ?? '')?.[1]
  return `- [${plainTitle(title) || kept || name}](${name}.md) — ${oneLine(description)}`
}

// The index with the entry's line added, or replaced where the entry is already listed. A later
// line for the same name is a duplicate, and goes.
export function withEntry(index: string, name: string, title: string, description: string) {
  const lines = index.split('\n').filter(l => l !== '')
  const at = lines.findIndex(l => entryName(l) === name)
  const line = entryLine(index, name, title, description)
  const out =
    at < 0 ? [...lines, line] : lines.flatMap((l, i) => (i === at ? [line] : entryName(l) === name ? [] : [l]))
  return `${out.join('\n')}\n`
}

export function withoutEntry(index: string, name: string) {
  const lines = index.split('\n').filter(l => l !== '' && entryName(l) !== name)
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

// The index joins every session's system prompt, so it keeps Claude Code's limits for its own
// memory index: a line under 150 characters, and only the first 200 lines and 25 KB are loaded.
// Claude Code warns at 80% of either and asks for 70%. A body over 4 MiB could not be read back.
export const LIMITS = { line: 150, lines: 200, bytes: 25_000, body: 20_000 } as const
const NEAR = 0.8
const TARGET = 0.7

// What is too long about a memory, in words for the model; undefined when nothing is.
export function overLimit(entry: { line: string; body: string }) {
  if (entry.line.length > LIMITS.line)
    return `The index line "${entry.line}" is ${entry.line.length} characters long; the most is ${LIMITS.line}. Shorten the description or the title.`
  const body = entry.body.trim().length
  return body > LIMITS.body ? `The body is ${body} characters long; the most is ${LIMITS.body}. Shorten it.` : undefined
}

const bytesOf = (text: string) => new TextEncoder().encode(text).length
const linesOf = (index: string) => index.split('\n').filter(l => l.trim() !== '')
const kb = (bytes: number) => `${Number((bytes / 1000).toFixed(1))} KB`

// How full the index is, by whichever of its lines and bytes is closer to its limit.
function fullness(index: string) {
  const lines = linesOf(index).length
  const bytes = bytesOf(index)
  const byLines = {
    frac: lines / LIMITS.lines,
    over: lines > LIMITS.lines,
    size: `${lines} lines`,
    cap: `${LIMITS.lines}-line`,
    target: `${Math.floor(LIMITS.lines * TARGET)} lines`,
  }
  const byBytes = {
    frac: bytes / LIMITS.bytes,
    over: bytes > LIMITS.bytes,
    size: kb(bytes),
    cap: kb(LIMITS.bytes),
    target: kb(Math.floor(LIMITS.bytes * TARGET)),
  }
  return { lines, bytes, ...(byBytes.frac > byLines.frac ? byBytes : byLines) }
}

// Why a change may not leave the index as `after`: past a limit, and grown on the way there. A
// change that shrinks an index already past one is let through, so it can be brought back under.
export function indexFull(before: string, after: string) {
  const was = fullness(before)
  const now = fullness(after)
  const grew = now.lines > was.lines || now.bytes > was.bytes
  return now.over && grew
    ? `The global memory index would be ${now.size}, over its ${now.cap} read limit, so nothing was saved. Fold or delete memories, or shorten index lines, to bring it under ${now.target}.`
    : undefined
}

// What a change that leaves the index near or past a limit adds to its answer.
export function indexNote(index: string) {
  const now = fullness(index)
  if (now.frac < NEAR) return ''
  const state = now.over
    ? `over its ${now.cap} read limit, so the lines past it are not loaded`
    : `approaching its ${now.cap} read limit`
  return ` The global memory index is ${now.size}, ${state}. Compact it to under ${now.target} now: keep each index line short, put detail in the memory's body, and fold or delete stale memories.`
}

// The part of the index a session loads, cut where Claude Code cuts its own, and how many
// lines that leaves out.
export function loadedIndex(index: string) {
  const lines = linesOf(index)
  const kept: string[] = []
  let bytes = 0
  for (const line of lines) {
    const size = bytesOf(line) + (kept.length > 0 ? 1 : 0)
    if (kept.length === LIMITS.lines || bytes + size > LIMITS.bytes) break
    kept.push(line)
    bytes += size
  }
  return { text: kept.join('\n'), dropped: lines.length - kept.length }
}

// What the person is asked before a memory is saved: all of what will be stored, the body in part.
export function saveQuestion(entry: {
  name: string
  title: string
  description: string
  type: MemoryType
  body: string
  replacing: boolean
}) {
  const body = entry.body.trim()
  const title = plainTitle(entry.title)
  return [
    `${entry.replacing ? 'Replace' : 'Save'} global memory "${entry.name}" (${entry.type})?`,
    ...(title === '' ? [] : [`Title: ${title}`]),
    `Index line: ${oneLine(entry.description)}`,
    `Body: ${body.length > 300 ? `${body.slice(0, 300)}…` : body}`,
  ].join('\n')
}

// What the system prompt adds to the memory section.
export function guide(dir: string, index: string) {
  const loaded = loadedIndex(index)
  const cut =
    loaded.dropped === 0
      ? ''
      : `\n\n(${loaded.dropped} more lines of the index are past its read limit and not shown. Fold or delete memories to bring it under ${LIMITS.lines} lines and ${kb(LIMITS.bytes)}.)`
  const listing = loaded.text === '' ? '(empty: nothing is saved yet)' : `${loaded.text}${cut}`
  return `# Global memory

Besides the project's memory, you keep a global memory: facts that hold in every project, saved by you on your own. It lives in ${dir}.

Save a global memory the moment the user corrects you, or tells you how they like to work, and the point holds beyond this project: their tools, their style of answers, how they review, what they want done without asking. Ask of each such fact: would it still be true in a different repo? If it would, save it globally. If it names this project's code, layout or decisions, it belongs in the project's memory. When unsure, save it to the project.

Save with mcp__global-memory__global_memory_write (one fact per memory, a short kebab-case name, a one-line description that tells a later session when it applies). Writing a name that exists replaces that memory, so read it first and fold the new point in. A feedback memory states the rule, then a **Why:** line and a **How to apply:** line. Do not save what the project's files, CLAUDE.md or git history already record. Remove one that has proved wrong with mcp__global-memory__global_memory_delete.

The index below is loaded at the start of every session. When an entry looks relevant to the task, open it with mcp__global-memory__global_memory_read before you act.

## Global memory index

${listing}`
}

// A save call's input as its row prints it: the long description cut to a
// line and the body by its size, where the engine would print all of it.
export function briefWrite(input: unknown) {
  const given = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const brief: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(given)) {
    if (key === 'body' && typeof value === 'string') {
      brief[key] = `${value.length} characters`
    } else if (key === 'description' && typeof value === 'string' && value.length > 80) {
      brief[key] = `${value.slice(0, 79).trimEnd()}…`
    } else {
      brief[key] = value
    }
  }

  return brief
}
