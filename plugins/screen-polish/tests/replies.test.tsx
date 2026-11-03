import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

// Stands for the engine, whose own drawing of a reply is the `engine` node.
function engine(on: On) {
  on('ui.render', () => ({ type: 'engine', ref: 0 }) as never)
}

const VIEWPORT = { columns: 40, rows: 40, isFullscreen: true }

function message(text: string, surface: 'terminal' | 'desktop' = 'terminal') {
  return {
    plugin: 'screen-polish',
    component: 'AssistantMessage',
    requestId: 'm1',
    surface,
    viewport: VIEWPORT,
    props: { text, isFirstOfReply: true },
  } as const
}

// The engine's clipboard, selection and toasts, as the test's hooks answer them.
function desk(on: On, selected?: { text: string; requestId?: string }) {
  const copied: string[] = []
  const toasts: string[] = []
  on('ui.selection', () => ({ value: selected }))
  on('ui.copy', (_, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return { copied, toasts }
}

test('by default inline code sits on a fill, the reply keeps its gutter and bullet, and other redraws are off', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount(message('Use `ls` and **bold**.'))

  expect((await ui.find({ type: 'Text', text: /^ ls $/ }))?.props).toMatchObject({
    backgroundColor: 'userMessageBackground',
    color: 'permission',
  })
  expect((await ui.find({ type: 'Text', text: /^bold$/ }))?.props).toMatchObject({ weight: 'bold' })
  expect((await ui.find({ type: 'Button', key: 'copy' }))?.props).toMatchObject({ label: '●' })
  await ui.unmount()

  const prompt = await $.ui.mount({
    ...message(''),
    component: 'UserMessage',
    props: { text: 'hi', origin: { kind: 'composer' }, isExpanded: false } as never,
  } as never)
  expect(await prompt.findAll({ type: 'Text' })).toEqual([])
  await prompt.unmount()
})

test('a plain reply is drawn the same way, so every reply lines up', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount(message('Plain **bold** words.'))

  expect((await ui.find({ type: 'Markdown' }))?.text).toBe('Plain **bold** words.')
  expect(await ui.find({ type: 'Button', key: 'copy' })).toBeDefined()
  await ui.unmount()
})

test('the bullet copies the whole reply as written when nothing in it is selected', async ($, on) => {
  engine(on)
  const { copied, toasts } = desk(on, { text: 'elsewhere', requestId: 'other' })
  const ui = await $.ui.mount(message('Use `ls` and **bold**.'))
  await ui.press({ key: 'copy' })

  expect(copied).toEqual(['Use `ls` and **bold**.'])
  expect(toasts).toEqual(['Copied the reply'])
  await ui.unmount()
})

test('the bullet copies a selection in its reply without the gutter cells', async ($, on) => {
  engine(on)
  const { copied, toasts } = desk(on, { text: '● First line\n  - item one\n    - nested\n  last', requestId: 'm1' })
  const ui = await $.ui.mount(message('anything'))
  await ui.press({ key: 'copy' })

  expect(copied).toEqual(['First line\n- item one\n  - nested\nlast'])
  expect(toasts).toEqual(['Copied the selection'])
  await ui.unmount()
})

test('a later block of a reply keeps the gutter but has no bullet to press', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...message('Use `ls`.'), props: { text: 'Use `ls`.', isFirstOfReply: false } })

  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  await ui.unmount()
})

test('a summary and other surfaces stay the engine\'s', async ($, on) => {
  engine(on)
  for (const target of [
    message('Use `ls`.', 'desktop'),
    { ...message('Use `ls`.'), props: { text: 'Use `ls`.', isFirstOfReply: true, isSummary: true } },
  ] as const) {
    const ui = await $.ui.mount(target as never)
    expect(await ui.findAll({ type: 'Text' })).toEqual([])
    await ui.unmount()
  }
})

test('inline code off leaves code to Claude Code\'s Markdown', { options: { inlineCode: false } }, async ($, on) => {
  engine(on)
  const ui = await $.ui.mount(message('Use `ls`.'))

  expect((await ui.find({ type: 'Markdown' }))?.text).toBe('Use `ls`.')
  expect(await ui.find({ type: 'Text', text: /^ ls $/ })).toBeUndefined()
  await ui.unmount()
})

test('headings step down, a rule spans the transcript, tasks get marks, quotes a bar', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount(message('# One\n\n### Three\n\n---\n\n- [x] done\n- [ ] open\n\n> said'))

  expect((await ui.find({ type: 'Text', text: /^One$/ }))?.props).toMatchObject({ color: 'claude', underline: true })
  expect((await ui.find({ type: 'Text', text: /^Three$/ }))?.props).not.toHaveProperty('color')
  expect((await ui.find({ type: 'Text', text: /^─+$/ }))?.text).toBe('─'.repeat(36))
  expect((await ui.find({ type: 'Text', text: '✓ ' }))?.props).toMatchObject({ color: 'success' })
  expect((await ui.find({ type: 'Text', text: '○ ' }))?.text).toBe('○ ')
  expect((await ui.find({ type: 'Text', text: '▎' }))?.text).toBe('▎')
  await ui.unmount()
})

const OFF = { inlineCode: false, headings: false, rules: false, taskLists: false, quotes: false }

test('with every reply redraw off, the engine draws replies', { options: OFF }, async ($, on) => {
  engine(on)
  const ui = await $.ui.mount(message('Use `ls`.'))

  expect(await ui.findAll({ type: 'Text' })).toEqual([])
  await ui.unmount()
})

test('a plugin beneath that wraps the reply, as inline-thinking does, keeps its part', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text>thought</Text>
        {{ type: 'engine', ref: 0 } as never}
      </Box>
    )
  })
  const ui = await $.ui.mount(message('Use `ls`.'))

  expect((await ui.findAll({ type: 'Text' })).map(t => t.text).slice(0, 2)).toEqual(['thought', 'Use  ls .'])
  expect(await ui.find({ type: 'Button', key: 'copy' })).toBeDefined()
  await ui.unmount()
})
