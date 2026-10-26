// The files of the global memory: one fact per file, and MEMORY.md, the index of them all.

export const TYPES = ['user', 'feedback', 'reference'] as const
export type MemoryType = (typeof TYPES)[number]

export const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

export function memoryFile(entry: { name: string; description: string; type: MemoryType; body: string }) {
  return [
    '---',
    `name: ${entry.name}`,
    `description: ${oneLine(entry.description)}`,
    'metadata:',
    `  type: ${entry.type}`,
    '---',
    '',
    entry.body.trim(),
    '',
  ].join('\n')
}

const indexLine = (name: string, title: string, description: string) =>
  `- [${oneLine(title)}](${name}.md) — ${oneLine(description)}`

const pointsTo = (name: string) => (line: string) => line.includes(`](${name}.md)`)

// The index with the entry's line added, or replaced where the entry is already listed.
export function withEntry(index: string, name: string, title: string, description: string) {
  const line = indexLine(name, title, description)
  const lines = index.split('\n').filter(l => l !== '')
  const at = lines.findIndex(pointsTo(name))
  if (at < 0) lines.push(line)
  else lines[at] = line
  return `${lines.join('\n')}\n`
}

export function withoutEntry(index: string, name: string) {
  const lines = index.split('\n').filter(l => l !== '' && !pointsTo(name)(l))
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

// What the system prompt adds to the memory section.
export function guide(dir: string, index: string) {
  const listing = index.trim() === '' ? '(empty: nothing is saved yet)' : index.trim()
  return `# Global memory

Besides the project's memory, you keep a global memory: facts that hold in every project, saved by you on your own. It lives in ${dir}. The user's own instructions in ~/.claude/CLAUDE.md are theirs; never edit that file.

Save a global memory the moment the user corrects you, or tells you how they like to work, and the point holds beyond this project: their tools, their style of answers, how they review, what they want done without asking. Ask of each such fact: would it still be true in a different repo? If it would, save it globally. If it names this project's code, layout or decisions, it belongs in the project's memory. When unsure, save it to the project.

Save with mcp__global-memory__global_memory_write (one fact per memory, a short kebab-case name, a one-line description that tells a later session when it applies). Writing a name that exists replaces that memory, so read it first and fold the new point in. A feedback memory states the rule, then a **Why:** line and a **How to apply:** line. Do not save what the project's files, CLAUDE.md or git history already record. Remove one that has proved wrong with mcp__global-memory__global_memory_delete.

The index below is loaded at the start of every session. When an entry looks relevant to the task, open it with mcp__global-memory__global_memory_read before you act.

## Global memory index

${listing}`
}
