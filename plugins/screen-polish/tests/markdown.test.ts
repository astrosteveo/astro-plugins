import { expect, test } from 'claude-code/testing'

import { inline, segments, type Features } from '../hooks/markdown'

const ALL: Features = { code: true, headings: true, rules: true, tasks: true, quotes: true }
const NONE: Features = { code: false, headings: false, rules: false, tasks: false, quotes: false }

test('inline code, bold and italic are told apart', async () => {
  expect(inline('run `bun test` and **then** *look*')).toEqual([
    { text: 'run ' },
    { text: 'bun test', code: true },
    { text: ' and ' },
    { text: 'then', bold: true },
    { text: ' ' },
    { text: 'look', italic: true },
  ])
})

test('code inside bold keeps both, and a double-backtick span holds a backtick', async () => {
  expect(inline('**see `x`**')).toEqual([
    { text: 'see ', bold: true },
    { text: 'x', bold: true, code: true },
  ])
  expect(inline('`` a`b ``')).toEqual([{ text: 'a`b', code: true }])
})

test('stars inside code do not open emphasis, and snake_case stays as written', async () => {
  expect(inline('`a*b*c` my_var_name')).toEqual([{ text: 'a*b*c', code: true }, { text: ' my_var_name' }])
})

test('italic around bold closes on its own star; strikethrough and links keep their parts', async () => {
  expect(inline('*a **b** c*')).toEqual([
    { text: 'a ', italic: true },
    { text: 'b', italic: true, bold: true },
    { text: ' c', italic: true },
  ])
  expect(inline('~~old~~ [docs](https://x.dev)')).toEqual([
    { text: 'old', strike: true },
    { text: ' ' },
    { text: 'docs', href: 'https://x.dev' },
  ])
})

test('a reply with nothing to draw, or every feature off, is left to the engine', async () => {
  expect(segments('**bold** only\n\n```\n`not inline`\n# not a heading\n```', ALL)).toBeNull()
  expect(segments('# Title\n\nRun `x`.\n\n---\n\n- [x] done\n\n> said', NONE)).toBeNull()
})

test('fences and tables stay markdown; a paragraph and a list with code are drawn', async () => {
  const text = 'Run `x`.\n\n```sh\nls\n\n`y`\n```\n\n| a | `b` |\n| - | - |\n\n- item `z`\n  - nested `w`'
  expect(segments(text, ALL)).toEqual([
    { kind: 'rich', lines: [{ kind: 'text', indent: 0, spans: [{ text: 'Run ' }, { text: 'x', code: true }, { text: '.' }] }] },
    { kind: 'markdown', text: '```sh\nls\n\n`y`\n```\n\n| a | `b` |\n| - | - |' },
    {
      kind: 'rich',
      lines: [
        { kind: 'item', indent: 0, marker: '-', spans: [{ text: 'item ' }, { text: 'z', code: true }] },
        { kind: 'item', indent: 2, marker: '-', spans: [{ text: 'nested ' }, { text: 'w', code: true }] },
      ],
    },
  ])
})

test('a line under an item or a paragraph joins it, as markdown does', async () => {
  expect(segments('1. first `a`\n   more\n2. second', ALL)).toEqual([
    {
      kind: 'rich',
      lines: [
        { kind: 'item', indent: 0, marker: '1.', spans: [{ text: 'first ' }, { text: 'a', code: true }, { text: ' more' }] },
        { kind: 'item', indent: 0, marker: '2.', spans: [{ text: 'second' }] },
      ],
    },
  ])
})

test('headings, rules, task items and quotes each come out of their own setting', async () => {
  const text = '## Plan\n\n---\n\n- [ ] write it\n- [x] test it\n\n> a `quote`\ncontinued'
  expect(segments(text, ALL)).toEqual([
    { kind: 'rich', lines: [{ kind: 'heading', depth: 2, spans: [{ text: 'Plan' }] }] },
    { kind: 'rich', lines: [{ kind: 'rule' }] },
    {
      kind: 'rich',
      lines: [
        { kind: 'item', indent: 0, marker: '-', task: 'open', spans: [{ text: 'write it' }] },
        { kind: 'item', indent: 0, marker: '-', task: 'done', spans: [{ text: 'test it' }] },
      ],
    },
    { kind: 'rich', lines: [{ kind: 'quote', spans: [{ text: 'a ' }, { text: 'quote', code: true }, { text: ' continued' }] }] },
  ])
  expect(segments(text, { ...NONE, rules: true })).toEqual([
    { kind: 'markdown', text: '## Plan' },
    { kind: 'rich', lines: [{ kind: 'rule' }] },
    { kind: 'markdown', text: '- [ ] write it\n- [x] test it\n\n> a `quote`\ncontinued' },
  ])
})

test('a dashed line under text is a setext heading, left to the engine', async () => {
  expect(segments('Title with `code`\n---', ALL)).toBeNull()
})

test('a fence four spaces deep in a nested list item stays with the engine', async () => {
  const text = '- Setup `x`:\n  - Install:\n    ```sh\n    npm install\n    ```'

  expect(segments(text, ALL)).toBeNull()
  expect(segments(`${text}\n\nThen run \`y\`.`, ALL)).toEqual([
    { kind: 'markdown', text },
    { kind: 'rich', lines: [{ kind: 'text', indent: 0, spans: [{ text: 'Then run ' }, { text: 'y', code: true }, { text: '.' }] }] },
  ])
})

test('a fence line indented 4 or more spaces past its opener is code, not the closer', async () => {
  expect(segments('```md\n- a\n    ```\n\nrun `x`\n\n```', ALL)).toBeNull()
})

test('a fenced code block inside a quote is not joined into one line', async () => {
  expect(segments('> Output:\n> ```\n> error: boom\n> exit 1\n> ```', ALL)).toBeNull()
})

test('a list inside a quote keeps its items apart', async () => {
  expect(segments('> Steps:\n> - one\n> - two', ALL)).not.toEqual([
    { kind: 'rich', lines: [{ kind: 'quote', spans: [{ text: 'Steps: - one - two' }] }] },
  ])
})

test('a nested item after a blank line stays nested', async () => {
  const parts = segments('- a `x`\n\n  - b `y`', ALL)
  const last = parts?.at(-1)

  expect(last?.kind === 'rich' ? last.lines[0] : undefined).toMatchObject({ kind: 'item', indent: 2 })
})

// The first line of the reply's last part, which the tests below draw.
function lastFirst(text: string) {
  const last = segments(text, ALL)?.at(-1)
  return last?.kind === 'rich' ? last.lines[0] : undefined
}

test('after a blank line, an item sits as deep as its indent puts it', async () => {
  expect(lastFirst('- a `x`\n  - b `y`\n\n    - c `z`')).toMatchObject({ kind: 'item', indent: 4 })
  expect(lastFirst('- a `x`\n  - b `y`\n\n  - c `z`')).toMatchObject({ kind: 'item', indent: 2 })
})

test('after a blank line, an unindented item or one after a paragraph starts at the left again', async () => {
  expect(lastFirst('- a `x`\n\n- b `y`')).toMatchObject({ kind: 'item', indent: 0 })
  expect(lastFirst('- a `x`\n\nAbout `a`.\n\n  - b `y`')).toMatchObject({ kind: 'item', indent: 0 })
  expect(lastFirst('- a `x`\n\n```\ncode\n```\n\n  - b `y`')).toMatchObject({ kind: 'item', indent: 0 })
})
