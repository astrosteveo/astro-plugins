// The output style's file is the one source of the rules: a subagent reads what the main thread reads.
export const STYLE_FILE = 'output-styles/plain-english.md'

const OPEN = '<plain-english>'
const CLOSE = '</plain-english>'

// The rules are added at the end of a prompt, so a prompt that ends with them has them already. A
// prompt that only mentions the tag, such as one quoting this file, still gets them.
export const hasRules = (prompt: string) => prompt.trimEnd().endsWith(CLOSE)

const SCOPE = 'everything you write: your final report, and any file, code comment, commit message or pull request'

// The style's name from its frontmatter, and its body without it.
export function parseStyle(file: string): { name: string; body: string } | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(file)
  if (m === null) return undefined
  const name = /^name:\s*(.+?)\s*$/m.exec(m[1]!)?.[1]?.replace(/^(['"])(.*)\1$/, '$2')
  const body = m[2]!.trim()
  return name === undefined || body === '' ? undefined : { name, body }
}

// A fork shares the parent's conversation, the style included, so it gets a pointer to it; any
// other agent starts with a prompt of its own and gets the rules whole.
export function withRules(prompt: string, body: string, isFork: boolean): string {
  const rules = isFork
    ? `The Plain English output style in your context applies to ${SCOPE}.`
    : `The person you work for chose the Plain English output style. Its rules apply to ${SCOPE}.\n\n${body}`
  return `${prompt}\n\n${OPEN}\n${rules}\n${CLOSE}`
}
