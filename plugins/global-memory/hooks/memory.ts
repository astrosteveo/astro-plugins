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

// The memories the index lists, in its order: each line's title, name and the description after it.
export function entries(index: string) {
  return index.split('\n').flatMap(line => {
    const found = ENTRY.exec(line)
    if (found === null) return []
    const [whole, title = '', name = ''] = found
    return [{ name, title: title || name, description: line.slice(whole.length).replace(/^\s*—\s*/, '').trim() }]
  })
}

// A memory file's type, when it was written and its body, read back from the front matter
// memoryFile writes. A file without that front matter is all body.
export function memoryParts(file: string) {
  const front = /^---\n([\s\S]*?)\n---\n/.exec(file)
  const field = (key: string) => front?.[1]?.match(new RegExp(`^\\s*${key}: *(.*)$`, 'm'))?.[1]?.trim()
  return {
    type: field('type'),
    modified: field('modified'),
    body: (front === null ? file : file.slice(front[0].length)).trim(),
  }
}

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
// A memory file keeps to what Claude Code's memory recall shows of one: its first 4,096 bytes
// and 200 lines, front matter included. Claude Code warns at 80% of a limit and asks for 70%.
export const LIMITS = { line: 150, lines: 200, bytes: 25_000, fileLines: 200, fileBytes: 4096 } as const
const NEAR = 0.8
const TARGET = 0.7

const bytesOf = (text: string) => new TextEncoder().encode(text).length
const linesOf = (index: string) => index.split('\n').filter(l => l.trim() !== '')
const kb = (bytes: number) => `${Number((bytes / 1000).toFixed(1))} KB`
const exact = (bytes: number) => bytes.toLocaleString('en-US')

// How full a text is, by whichever of its lines and bytes is closer to its limit, in words.
function fullness(lines: number, bytes: number, cap: { lines: number; bytes: number }, inKb: boolean) {
  const byLines = {
    frac: lines / cap.lines,
    over: lines > cap.lines,
    size: `${lines} lines`,
    cap: `${cap.lines}-line`,
    target: `${Math.floor(cap.lines * TARGET)} lines`,
  }
  const size = (n: number) => (inKb ? kb(n) : `${exact(n)} bytes`)
  const byBytes = {
    frac: bytes / cap.bytes,
    over: bytes > cap.bytes,
    size: size(bytes),
    cap: inKb ? kb(cap.bytes) : `${exact(cap.bytes)}-byte`,
    target: size(Math.floor(cap.bytes * TARGET)),
  }
  return { lines, bytes, ...(byBytes.frac > byLines.frac ? byBytes : byLines) }
}

const indexFullness = (index: string) =>
  fullness(linesOf(index).length, bytesOf(index), { lines: LIMITS.lines, bytes: LIMITS.bytes }, true)

const fileFullness = (file: string) =>
  fullness(file.replace(/\n$/, '').split('\n').length, bytesOf(file), { lines: LIMITS.fileLines, bytes: LIMITS.fileBytes }, false)

// What is too long about a memory, its index line or its whole file, in words for the model;
// undefined when nothing is.
export function overLimit(entry: { line: string; file: string }) {
  if (entry.line.length > LIMITS.line)
    return `The index line "${entry.line}" is ${entry.line.length} characters long; the most is ${LIMITS.line}. Shorten the description or the title.`
  const now = fileFullness(entry.file)
  return now.over
    ? `The memory file would be ${now.size}, over the ${now.cap} limit recall shows of a memory, so nothing was saved. Keep it to one fact under ${now.target}: split distinct facts into their own memories, and summarize rather than append.`
    : undefined
}

// What a save that leaves its file near the limit adds to its answer.
export function fileNote(file: string) {
  const now = fileFullness(file)
  return now.frac < NEAR
    ? ''
    : ` The memory file is ${now.size}, approaching the ${now.cap} limit recall shows of a memory. Keep it under ${now.target}: one fact per file, split distinct facts into their own memories, and summarize rather than append.`
}

// How much of its read limits the index takes, in words for the person.
export function indexUsage(index: string) {
  const lines = linesOf(index).length
  return `${lines} of ${LIMITS.lines} lines, ${kb(bytesOf(index))} of ${kb(LIMITS.bytes)}`
}

// Why a change may not leave the index as `after`: past a limit, and grown on the way there. A
// change that shrinks an index already past one is let through, so it can be brought back under.
export function indexFull(before: string, after: string) {
  const was = indexFullness(before)
  const now = indexFullness(after)
  const grew = now.lines > was.lines || now.bytes > was.bytes
  return now.over && grew
    ? `The global memory index would be ${now.size}, over its ${now.cap} read limit, so nothing was saved. Fold or delete memories, or shorten index lines, to bring it under ${now.target}.`
    : undefined
}

// What a change that leaves the index near or past a limit adds to its answer.
export function indexNote(index: string) {
  const now = indexFullness(index)
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

// What the index file the first message carries holds: the part a session loads, and how many
// lines that leaves out. Empty when there is nothing to load.
export function indexContent(index: string) {
  const loaded = loadedIndex(index)
  if (loaded.text === '') return ''
  return loaded.dropped === 0
    ? loaded.text
    : `${loaded.text}\n\n(${loaded.dropped} more lines of the index are past its read limit and not shown. Fold or delete memories to bring it under ${LIMITS.lines} lines and ${kb(LIMITS.bytes)}.)`
}

// What the system prompt adds to the memory section. It follows Claude Code's own memory section,
// which says what to save and how to write it and changes as Claude Code does, so it states only
// where a global memory differs. It holds no index, so it reads the same as memories change.
export function guide(dir: string) {
  return `# Global memory

Besides the project's memory, you keep a global memory: facts that hold in every project, saved by you on your own. It lives in ${dir}.

When you would save a memory, ask of the fact: would it still be true in a different repo? Who the user is, how they like to work, their tools, how they want answers and what they want done without asking usually would: save those globally. If it names this project's code, layout or decisions, it belongs in the project's memory. When unsure, save it to the project.

Write a global memory as the memory section above says to write a memory: what to save and what not to, one fact per file, its name and description, its type and body, and its \`[[name]]\` links. Only these differ:
- Save and replace one with mcp__global-memory__global_memory_write, and delete one with mcp__global-memory__global_memory_delete, never with file tools: they also write its index line. Writing a name that exists replaces that memory, so read it first and fold the new point in.
- There is no \`project\` type: a project's ongoing work belongs in that project's memory.
- A \`[[name]]\` link names another global memory.

Its index, ${dir}/MEMORY.md, is loaded into context with the instruction files when a conversation starts and after a compaction, once it holds any memories. When an entry looks relevant to the task, open it with mcp__global-memory__global_memory_read before you act.`
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
