import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

// Nothing sits beneath the plugin: these hooks stand for the engine.
function engine(on: On, { verbose = false }: { verbose?: boolean } = {}) {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('config.list', () => ({ value: [{ key: 'verbose', value: verbose }] as never }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine row'] }) as never)
}

const MODEL = { kind: 'model', model: 'claude-opus-5-5' } as const

async function think($: Engine, uuid: string, thinking: string, agentId?: string) {
  await $.session.append({
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'thinking', thinking, signature: 's' }] },
    door: 'response',
    origin: MODEL,
    uuid,
    ...(agentId === undefined ? {} : { agentId }),
  })
}

async function reply($: Engine, uuid: string, text: string) {
  await $.session.append({
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] },
    door: 'response',
    origin: MODEL,
    uuid,
  })
}

async function call($: Engine, uuid: string, id: string, name: string) {
  await $.session.append({
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] },
    door: 'response',
    origin: MODEL,
    uuid,
  })
}

const REPLY = (requestId: string) =>
  ({
    plugin: 'inline-thinking',
    component: 'AssistantMessage',
    requestId,
    surface: 'terminal',
    props: { text: 'The answer.', isFirstOfReply: true },
  }) as const

const GROUP = (ids: string[], isExpanded = false) =>
  ({
    plugin: 'inline-thinking',
    component: 'ToolGroup',
    requestId: 'collapsed-t1',
    surface: 'terminal',
    props: {
      calls: ids.map(tool_use_id => ({
        tool_use_id,
        tool: 'Read',
        input: {},
        isRunning: false,
        isErrored: false,
        isInterrupted: false,
      })),
      isActive: false,
      isExpanded,
    },
  }) as const

const CALL = (tool_use_id: string, isExpanded?: boolean) =>
  ({
    plugin: 'inline-thinking',
    component: 'ToolUse',
    requestId: tool_use_id,
    surface: 'terminal',
    props: {
      tool_use_id,
      tool: 'Edit',
      input: {},
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
      ...(isExpanded === undefined ? {} : { isExpanded }),
    },
  }) as const

test('thinking draws above the reply it led to, and the reply still draws', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await think($, 't1', '**Weighing it**\n\n9.9 is 9.90,   which beats 9.11.')
  await reply($, 'r1', '9.9')

  const ui = await $.ui.mount(REPLY('r1'))
  const texts = (await ui.findAll({ type: 'Text' })).map(text => text.text)
  expect(texts).toEqual(['∴', 'Weighing it', '9.9 is 9.90, which beats 9.11.', 'engine row'])
  await ui.unmount()
})

test('thinking before each call of a folded group draws above its line, in order', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await think($, 't1', 'Read the README first.')
  await call($, 'c1', 'toolu_1', 'Read')
  await call($, 'c2', 'toolu_2', 'Read')
  await think($, 't2', 'Now the hooks file.')
  await call($, 'c3', 'toolu_3', 'Read')

  const ui = await $.ui.mount(GROUP(['toolu_1', 'toolu_2', 'toolu_3']))
  const texts = (await ui.findAll({ type: 'Text' })).map(text => text.text)
  expect(texts).toEqual(['∴', 'Read the README first.', '∴', 'Now the hooks file.', 'engine row'])
  await ui.unmount()
})

test('a tool row of its own draws the thinking before it', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await think($, 't1', 'Fix the typo.')
  await call($, 'c1', 'toolu_9', 'Edit')

  const ui = await $.ui.mount(CALL('toolu_9'))
  expect(await ui.find({ type: 'Text', text: 'Fix the typo.' })).toBeDefined()
  await ui.unmount()
})

test('each thought draws once: at the row that came next, not the one after', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await think($, 't1', 'Look first.')
  await call($, 'c1', 'toolu_1', 'Read')
  await reply($, 'r1', 'Done.')

  const ui = await $.ui.mount(REPLY('r1'))
  expect((await ui.findAll({ type: 'Text' })).map(text => text.text)).toEqual(['engine row'])
  await ui.unmount()
})

test('ctrl+o, --verbose and unfolded groups draw thinking themselves, so the rows are left alone', async ($, on) => {
  engine(on, { verbose: true })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await think($, 't1', 'Hmm.')
  await reply($, 'r1', 'Yes.')
  await think($, 't2', 'Edit it.')
  await call($, 'c1', 'toolu_1', 'Edit')
  await think($, 't3', 'Read it.')
  await call($, 'c2', 'toolu_2', 'Read')

  for (const site of [REPLY('r1'), CALL('toolu_1', true), GROUP(['toolu_2'], true)]) {
    const ui = await $.ui.mount(site)
    expect((await ui.findAll({ type: 'Text' })).map(text => text.text)).toEqual(['engine row'])
    await ui.unmount()
  }
})

test('turning verbose off in /config brings the thinking back to replies', async ($, on) => {
  engine(on, { verbose: true })
  on('config.set', (_, e) => ({ value: e.value }) as never)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await think($, 't1', 'Hmm.')
  await reply($, 'r1', 'Yes.')
  await $.config.set({
    key: 'verbose',
    value: false,
    previous: true,
    provider: { plugin: 'engine', tier: 'core' },
    origin: { kind: 'composer' },
  })

  const ui = await $.ui.mount(REPLY('r1'))
  expect(await ui.find({ type: 'Text', text: 'Hmm.' })).toBeDefined()
  await ui.unmount()
})

test("a subagent's thinking, and thinking a new prompt cut off, draw nowhere", async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await think($, 'a1', 'Subagent musing.', 'agent-1')
  await think($, 't1', 'Cut off by Esc.')
  await $.session.append({
    message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'never mind' }] },
    door: 'prompt',
    origin: { kind: 'person' } as never,
    uuid: 'p1',
  })
  await reply($, 'r1', 'OK.')

  const ui = await $.ui.mount(REPLY('r1'))
  expect((await ui.findAll({ type: 'Text' })).map(text => text.text)).toEqual(['engine row'])
  await ui.unmount()
})

test('off the terminal, rows draw as the engine does', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await think($, 't1', 'Hmm.')
  await reply($, 'r1', 'Yes.')

  const ui = await $.ui.mount({ ...REPLY('r1'), surface: 'desktop' })
  expect((await ui.findAll({ type: 'Text' })).map(text => text.text)).toEqual(['engine row'])
  await ui.unmount()
})


test('every thought since the last row draws above the next one, in order, blank ones dropped', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await think($, 't1', 'First.')
  await think($, 't2', '  \n\n  ')
  await think($, 't3', 'Second.')
  await reply($, 'r1', 'Done.')

  const ui = await $.ui.mount(REPLY('r1'))
  const texts = (await ui.findAll({ type: 'Text' })).map(text => text.text)
  expect(texts).toEqual(['∴', 'First.', '∴', 'Second.', 'engine row'])
  await ui.unmount()
})

test('thinking that arrives in the same message as its reply draws above it', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.session.append({
    message: {
      type: 'assistant',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Both at once.', signature: 's' },
        { type: 'text', text: 'Yes.' },
      ],
    },
    door: 'response',
    origin: MODEL,
    uuid: 'r1',
  })

  const ui = await $.ui.mount(REPLY('r1'))
  const texts = (await ui.findAll({ type: 'Text' })).map(text => text.text)
  expect(texts).toEqual(['∴', 'Both at once.', 'engine row'])
  await ui.unmount()
})

test('a /config change the engine refuses leaves verbose as it was', async ($, on) => {
  engine(on, { verbose: true })
  on('config.set', () => ({ deny: 'locked by policy' }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await think($, 't1', 'Hmm.')
  await reply($, 'r1', 'Yes.')
  await $.config.set({
    key: 'verbose',
    value: false,
    previous: true,
    provider: { plugin: 'engine', tier: 'core' },
    origin: { kind: 'composer' },
  })

  const ui = await $.ui.mount(REPLY('r1'))
  expect((await ui.findAll({ type: 'Text' })).map(text => text.text)).toEqual(['engine row'])
  await ui.unmount()
})
