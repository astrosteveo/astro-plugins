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

test('by default inline code sits on a fill, the bullet stays, and other redraws are off', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount(message('Use `ls` and **bold**.'))

  expect((await ui.find({ type: 'Text', text: /^ ls $/ }))?.props).toMatchObject({
    backgroundColor: 'userMessageBackground',
    color: 'permission',
  })
  expect((await ui.find({ type: 'Text', text: /^bold$/ }))?.props).toMatchObject({ weight: 'bold' })
  expect((await ui.find({ type: 'Text', text: '●' }))?.text).toBe('●')
  await ui.unmount()

  const prompt = await $.ui.mount({
    ...message(''),
    component: 'UserMessage',
    props: { text: 'hi', origin: { kind: 'composer' }, isExpanded: false } as never,
  } as never)
  expect(await prompt.findAll({ type: 'Text' })).toEqual([])
  await prompt.unmount()
})

test('a reply with nothing to draw, a summary and other surfaces stay the engine\'s', async ($, on) => {
  engine(on)
  for (const target of [
    message('Plain **bold** words.'),
    message('Use `ls`.', 'desktop'),
    { ...message('Use `ls`.'), props: { text: 'Use `ls`.', isFirstOfReply: true, isSummary: true } },
  ] as const) {
    const ui = await $.ui.mount(target as never)
    expect(await ui.findAll({ type: 'Text' })).toEqual([])
    await ui.unmount()
  }
})

test('inline code off leaves code to the engine', { options: { inlineCode: false } }, async ($, on) => {
  engine(on)
  const ui = await $.ui.mount(message('Use `ls`.'))

  expect(await ui.findAll({ type: 'Text' })).toEqual([])
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

test('without the bullet a reply is only indented, even with nothing else to draw', { options: { replyBullet: false } }, async ($, on) => {
  engine(on)
  const ui = await $.ui.mount(message('Plain words.'))

  expect((await ui.find({ type: 'Markdown' }))?.text).toBe('Plain words.')
  expect(await ui.find({ type: 'Text', text: '●' })).toBeUndefined()
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

  expect((await ui.findAll({ type: 'Text' })).map(t => t.text).slice(0, 2)).toEqual(['thought', '●'])
  await ui.unmount()
})
