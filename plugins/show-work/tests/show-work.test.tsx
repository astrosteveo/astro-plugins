import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { across, blowUp, errorLines, fromHex, litArgs, literal, markArgs, markCells, measured, overlaps, wrap, nameOf, page, sheetArgs, sniff, svgSize } from '../hooks/design'
import { hashOf, splitMermaid } from '../hooks/mermaid'
import { briefShow, cardWidth, fit, markScope, markText, pickText, readMarks } from '../hooks/register'

const PANE = {
  plugin: 'show-work',
  component: 'Pane',
  requestId: 'show-work',
  props: {
    title: 'Show work',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

// Nothing sits beneath the plugin: each hook here stands for the engine.
function engine(
  on: On,
  {
    isTicking = true,
    bash,
  }: { isTicking?: boolean; bash?: (command: string, id: string) => { text: string; isError?: boolean } | undefined } = {},
) {
  const filled: string[] = []
  let now = 0
  if (isTicking) {
    on('clock.now', () => ({ value: (now += 1000) }))
  }
  on('tool.register', (_, e) => ({ value: { tool: `mcp__show-work__${e.name}` } }))
  on('command.register', () => ({ value: { command: 'work' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.fill', (_, e) => {
    filled.push(e.text)

    return { isFilled: true }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('tool.call', (_, e) => {
    const said = e.tool === 'Bash' ? bash?.(String(e.command), e.tool_use_id) : undefined
    if (said !== undefined) {
      return said.isError === true
        ? { isError: true, result: said.text, text: said.text }
        : { result: {}, text: said.text }
    }

    return e.tool === 'Bash' && String(e.command).startsWith('false')
      ? { isError: true, result: 'exit 1', text: 'exit 1' }
      : { result: {} }
  })

  return filled
}

test('an empty pane says what will show there', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Nothing yet/ }))?.text).toMatch(
      /plan, decisions and questions/,
    )
    await ui.unmount()
  }
})

test('the plan tool draws the goal and steps', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ran = await $.tool.call({
    tool: 'mcp__show-work__plan',
    goal: 'Add a pause menu',
    steps: [
      { text: 'Read the scene', status: 'done' },
      { text: 'Build the menu', status: 'doing' },
      { text: 'Playtest it', status: 'todo' },
      { text: '', status: 'todo' },
    ],
  })
  expect(ran.result).toBe('Plan shown: 1/3 steps done.')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^Add a pause menu/ }))?.text).toBe(
      'Add a pause menu 1/3',
    )
    expect((await ui.find({ type: 'Text', text: /Build the menu/ }))?.text).toBe(
      '▸ Build the menu',
    )
    await ui.unmount()
  }
})

test('pressing a note quotes it into the prompt; sending a reply marks it', async ($, on) => {
  const filled = engine(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'mcp__show-work__note',
    kind: 'decision',
    text: 'Use a CanvasLayer for the menu',
    why: 'It draws above the game camera',
  })
  await $.tool.call({
    tool: 'mcp__show-work__note',
    kind: 'question',
    text: 'Should Esc also close the menu?',
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // Now holds the open question and no decision.
    const ask = await ui.find({ type: 'Button', text: /Esc also close/ })
    expect(ask?.text).toBe('I ask Should Esc also close the menu? · answer me')
    expect(await ui.find({ type: 'Button', text: /CanvasLayer/ })).toBeUndefined()
    await ui.press({ key: 'tab-notes' })
    expect(await ui.find({ type: 'Text', text: /Press a question to answer/ })).toBeDefined()
    expect((await ui.find({ type: 'Button', text: /CanvasLayer/ }))?.text).toBe(
      'I chose Use a CanvasLayer for the menu · veto? ▸',
    )
    await ui.press({ key: 'tab-now' })
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const ask = await ui.find({ type: 'Button', text: /Esc also close/ })
  await ui.press({ key: ask?.key ?? '' })
  expect(filled).toEqual(['About your question "Should Esc also close the menu?": '])
  // Pressing alone, or sending the quote with nothing after it, is no reply.
  expect(await ui.find({ type: 'Button', text: /Esc also close/ })).toBeDefined()
  await $.prompt.submit({ text: filled[0] ?? '' })
  expect(await ui.find({ type: 'Button', text: /Esc also close/ })).toBeDefined()
  await $.prompt.submit({ text: `${filled[0]}Yes, and Start too.` })
  expect(await ui.find({ type: 'Button', text: /Esc also close/ })).toBeUndefined()
  await ui.press({ key: 'tab-notes' })
  expect((await ui.find({ type: 'Button', text: /Esc also close/ }))?.text).toMatch(/↩ replied$/)
  await ui.unmount()
})

test('pressing another note opens it to its why, detail and actions', async ($, on) => {
  const filled = engine(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'mcp__show-work__note',
    kind: 'decision',
    text: 'Use a CanvasLayer for the menu',
    why: 'It draws above the game camera',
    detail: 'A Control under the camera would scroll with the level.',
  })
  await $.tool.call({
    tool: 'mcp__show-work__note',
    kind: 'finding',
    text: 'The save system already writes to user://',
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-notes' })
  expect((await ui.find({ type: 'Button', key: 'tab-notes' }))?.text).toBe('Notes 2')
  expect(await ui.find({ type: 'Text', text: /why: It draws above/ })).toBeUndefined()

  const decision = await ui.find({ type: 'Button', text: /CanvasLayer/ })
  await ui.press({ key: decision?.key ?? '' })
  expect((await ui.find({ type: 'Button', text: /CanvasLayer/ }))?.text).toMatch(/veto\? ▾$/)
  expect(await ui.find({ type: 'Text', text: /why: It draws above/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /would scroll with the level/ })).toBeDefined()
  expect(filled).toEqual([])

  // Veto starts a reply and closes the note; sending it marks it replied.
  await ui.press({ key: `reply-${decision?.key}` })
  expect(filled).toEqual([`About your decision "Use a CanvasLayer for the menu": I'd rather `])
  expect(await ui.find({ type: 'Text', text: /why: It draws above/ })).toBeUndefined()
  await $.prompt.submit({ text: `${filled[0]}use a Control.` })
  expect((await ui.find({ type: 'Button', text: /CanvasLayer/ }))?.text).toMatch(/↩ replied$/)
  expect((await ui.find({ type: 'Button', key: 'tab-notes' }))?.text).toBe('Notes 1')

  // Got it marks the finding read without a reply.
  const finding = await ui.find({ type: 'Button', text: /user:\/\// })
  await ui.press({ key: finding?.key ?? '' })
  await ui.press({ key: `ok-${finding?.key}` })
  expect((await ui.find({ type: 'Button', text: /user:\/\// }))?.text).toMatch(/✓ ok$/)
  // Every note is done, so the tab shows no count.
  expect((await ui.find({ type: 'Button', key: 'tab-notes' }))?.text).toBe('Notes')
  expect(filled).toHaveLength(1)
  await ui.unmount()
})

test('a note without text is refused', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ran = await $.tool.call({ tool: 'mcp__show-work__note', kind: 'risk', text: ' ' })
  expect(ran.deny).toBe('A note needs text.')
})

test('activity logs reads, edits and failed commands', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: '/proj/scenes/main.tscn' })
  await $.tool.call({
    tool: 'Edit',
    file_path: '/proj/scripts/pause.gd',
    old_string: 'a',
    new_string: 'b',
  })
  await $.tool.call({ tool: 'Bash', command: 'false && echo', description: 'Run the tests' })
  await $.tool.call({ tool: 'ToolSearch', query: 'x', max_results: 1 })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /main\.tscn/ })).toBeDefined()
    await ui.press({ key: 'tab-activity' })
    expect((await ui.find({ type: 'Text', text: /calls,/ }))?.text).toBe(
      '3 calls, 1 files changed, 1 failed',
    )
    expect((await ui.find({ type: 'Text', text: /main\.tscn/ }))?.text).toBe(
      '✓ read   scenes/main.tscn',
    )
    expect((await ui.find({ type: 'Text', text: /Run the tests/ }))?.text).toBe(
      '✗ run    Run the tests',
    )
    expect((await ui.find({ type: 'Text', text: /\$ false/ }))?.text).toBe(
      '         $ false && echo',
    )
    await ui.press({ key: 'tab-now' })
    await ui.unmount()
  }
})

test('repeated edits of a file fold into one row with a count', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const edit = { tool: 'Edit', file_path: '/proj/scripts/pause.gd', old_string: 'a', new_string: 'b' }
  await $.tool.call(edit)
  await $.tool.call({ tool: 'Read', file_path: '/proj/scenes/main.tscn' })
  await $.tool.call(edit)
  await $.tool.call(edit)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-activity' })
  expect((await ui.find({ type: 'Text', text: /calls,/ }))?.text).toBe(
    '4 calls, 1 files changed',
  )
  const rows = await ui.findAll({ type: 'Text', text: /^✓ (read|edit)/ })
  expect(rows.map(row => row.text)).toEqual([
    '✓ read   scenes/main.tscn',
    '✓ edit   ×3 scripts/pause.gd',
  ])
  await ui.unmount()
})

test('the guide joins the system prompt last', async ($, on) => {
  engine(on)
  on('prompt.compose', () => ({
    sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' }],
  }))
  const { sections } = await $.prompt.compose({
    model: 'claude-opus-5-5',
    promptModel: 'claude-opus-5-5',
    surfaces: ['terminal'],
    tools: [],
    outputStyle: null,
    traits: [],
  })
  expect(sections.map(section => section.id)).toEqual(['intro', 'show-work:guide'])
  expect(sections[1]?.text).toMatch(/mcp__show-work__plan/)
})

test('/work clear empties the pane', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: '/proj/a.gd' })
  const ran = await $.command.run({
    command: 'work',
    args: 'clear',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
  expect(ran).toMatchObject({ text: 'Show work cleared.' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Nothing yet/ })).toBeDefined()
  await ui.unmount()
})

test('a TodoWrite list shows as the plan', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Write the shader', status: 'completed', activeForm: 'Writing' },
      { content: 'Tune the glow', status: 'in_progress', activeForm: 'Tuning' },
    ],
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^Plan/ }))?.text).toBe('Plan 1/2')
  expect((await ui.find({ type: 'Text', text: /Tune the glow/ }))?.text).toBe('▸ Tune the glow')
  await ui.unmount()
})

// The host beneath freeze: a cache under HOME, files that exist, and the
// image tools answering as they would for a 1600x900 picture. `answer`
// stands in for a renderer's own reply.
function host(
  on: On,
  {
    theme = 'dark',
    answer,
  }: {
    theme?: string
    answer?: (argv: readonly string[]) => { exitCode?: number; stdout?: string; stderr?: string } | 'absent' | undefined
  } = {},
) {
  const ran: string[][] = []
  const written: Record<string, string> = {}
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('config.list', () => ({ value: [{ key: 'theme', value: theme }] as never }))
  on('fs.exists', (_, e) => ({ value: !String(e.path).includes('missing') }))
  on('fs.write', (_, e) => {
    written[e.path] = e.text

    return { value: undefined }
  })
  on('fs.read', (_, e) =>
    e.path.endsWith('.svg')
      ? { value: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1225 400" width="1225" height="400"><svg>' }
      : { value: { base64: ONE_PIXEL } },
  )
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    const said = answer?.(e.argv)
    if (said === 'absent') {
      throw new Error(`spawn ${e.argv[0]} ENOENT`)
    }
    const stdout = said?.stdout ?? (e.argv[1] === 'identify' ? '1600 900' : '')

    return {
      value: {
        exitCode: said?.exitCode ?? 0,
        stdout,
        stderr: said?.stderr ?? '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })

  return { ran, written }
}

// A browser on PATH that measures any page as 640 pixels tall.
const CHROMIUM = (argv: readonly string[]) =>
  argv[0] === 'sh'
    ? { stdout: '/usr/bin/chromium\n' }
    : argv.includes('--dump-dom')
      ? { stdout: '<html data-theme="dark" data-height="640"><head>' }
      : undefined

const RESULT = (tool_use_id: string) =>
  ({
    plugin: 'show-work',
    component: 'ToolResult',
    requestId: tool_use_id,
    props: { tool_use_id, tool: 'mcp__show-work__show', output: '', isErrored: false },
  }) as const

test('a shown SVG is converted, drawn in the chat and handed back to Claude', async ($, on) => {
  engine(on)
  const { ran, written } = host(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const shown = await $.tool.call({
    tool: 'mcp__show-work__show',
    tool_use_id: 'toolu_a',
    caption: 'Pause menu layout',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450"/>',
  })
  expect(Object.keys(written)).toEqual(['/home/u/.cache/show-work/toolu_a.svg'])
  expect(ran).toContainEqual([
    'rsvg-convert',
    '-o',
    '/home/u/.cache/show-work/toolu_a.png',
    '/home/u/.cache/show-work/toolu_a.svg',
  ])
  // The picture comes back as Claude reads it, scaled to the API's side.
  expect(shown.result).toEqual([
    { type: 'text', text: expect.stringMatching(/^Shown in the chat and the pane: Pause menu layout \(1600x900\)\. This is what the person sees/) },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: ONE_PIXEL } },
  ])
  expect(ran).toContainEqual([
    'magick',
    '/home/u/.cache/show-work/toolu_a.png',
    '-resize',
    '1568x1568>',
    '/home/u/.cache/show-work/toolu_a-look.png',
  ])

  const chat = await $.ui.mount({ ...RESULT('toolu_a'), surface: 'terminal' })
  const image = await chat.find({ type: 'Image' })
  expect(image?.props).toMatchObject({
    source: { file: '/home/u/.cache/show-work/toolu_a.png', format: 'png' },
    alt: 'Pause menu layout',
  })
  await chat.unmount()

  const desk = await $.ui.mount({ ...RESULT('toolu_a'), surface: 'desktop' })
  expect((await desk.find({ type: 'Text' }))?.text).toBe(
    'Pause menu layout: /home/u/.cache/show-work/toolu_a.png',
  )
  await desk.unmount()
})

test('an html mockup is laid out by a headless browser in the wireframe kit, as tall as its content', async ($, on) => {
  engine(on)
  const { ran, written } = host(on, { answer: CHROMIUM })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const shown = await $.tool.call({
    tool: 'mcp__show-work__show',
    tool_use_id: 'toolu_h',
    caption: 'Settings menu',
    html: '<div class="row"><div class="box grow">Audio</div></div>',
  })
  expect(shown.deny).toBeUndefined()
  const html = written['/home/u/.cache/show-work/toolu_h.html'] ?? ''
  expect(html).toContain('<html data-theme="dark">')
  expect(html).toContain('.row,.col{display:flex')
  expect(html).toContain('<div class="row"><div class="box grow">Audio</div></div>')

  const browser = ran.filter(argv => argv[0] === '/usr/bin/chromium')
  expect(browser).toHaveLength(2)
  expect(browser[0]).toContain('--dump-dom')
  expect(browser[0]).toContain('--window-size=1280,100')
  expect(browser[1]).toContain('--window-size=1280,640')
  expect(browser[1]).toContain('--screenshot=/home/u/.cache/show-work/toolu_h.png')
  expect(browser[1]).toContain('--user-data-dir=/home/u/.cache/show-work/toolu_h-chrome')
  expect(browser[1]?.at(-1)).toBe('file:///home/u/.cache/show-work/toolu_h.html')
  expect(ran).toContainEqual(['rm', '-rf', '/home/u/.cache/show-work/toolu_h-chrome'])
})

test('an html mockup with a height is one screenshot of that screen', async ($, on) => {
  engine(on)
  const { ran } = host(on, { answer: CHROMIUM })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'mcp__show-work__show',
    tool_use_id: 'toolu_s',
    caption: 'HUD',
    html: '<div class="screen"><div class="tl bar"></div></div>',
    width: 1920,
    height: 1080,
  })
  const browser = ran.filter(argv => argv[0] === '/usr/bin/chromium')
  expect(browser).toHaveLength(1)
  expect(browser[0]).toContain('--window-size=1920,1080')
})

test('with no browser an html mockup says so', async ($, on) => {
  engine(on)
  host(on, { answer: argv => (argv[0] === 'sh' ? { exitCode: 1 } : undefined) })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const shown = await $.tool.call({ tool: 'mcp__show-work__show', caption: 'x', html: '<p>hi</p>' })
  expect(shown.deny).toBe('No Chrome or Chromium to lay out the page: install one.')
})

test('a d2 diagram becomes an SVG the browser draws at its own size', async ($, on) => {
  engine(on)
  const { ran, written } = host(on, { answer: CHROMIUM })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'mcp__show-work__show',
    tool_use_id: 'toolu_d',
    caption: 'Netcode',
    d2: 'client -> server: UDP',
  })
  expect(written['/home/u/.cache/show-work/toolu_d.d2']).toBe('client -> server: UDP')
  expect(ran).toContainEqual([
    'd2',
    '--theme=200',
    '--pad=40',
    '--scale=1',
    '/home/u/.cache/show-work/toolu_d.d2',
    '/home/u/.cache/show-work/toolu_d.svg',
  ])
  expect(written['/home/u/.cache/show-work/toolu_d.html']).toContain('<img src="toolu_d.svg">')
  const browser = ran.filter(argv => argv[0] === '/usr/bin/chromium')
  expect(browser).toHaveLength(1)
  expect(browser[0]).toContain('--window-size=1225,400')
})

test('mermaid and dot draw in the light theme on its paper', async ($, on) => {
  engine(on)
  const { ran } = host(on, { theme: 'light' })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__show-work__show', tool_use_id: 'toolu_m', caption: 'Flow', mermaid: 'graph LR\n  A-->B' })
  await $.tool.call({ tool: 'mcp__show-work__show', tool_use_id: 'toolu_g', caption: 'Deps', dot: 'digraph { a -> b }' })
  const mmdc = ran.find(argv => argv[0] === 'mmdc') ?? []
  expect(mmdc.slice(mmdc.indexOf('-t'), mmdc.indexOf('-t') + 4)).toEqual(['-t', 'default', '-b', '#ffffff'])
  expect(mmdc).toContain('/home/u/.cache/show-work/toolu_m.mmd')
  const dot = ran.find(argv => argv[0] === 'dot') ?? []
  expect(dot).toContain('-Gbgcolor=#f6f5f1')
  expect(dot).toContain('-Nshape=box')
  expect(dot.slice(-3)).toEqual(['-o', '/home/u/.cache/show-work/toolu_g.png', '/home/u/.cache/show-work/toolu_g.dot'])
})

test("a source that won't parse comes back to Claude with the renderer's words", async ($, on) => {
  engine(on)
  host(on, {
    answer: argv =>
      argv[0] === 'dot'
        ? { exitCode: 1, stderr: "Error: /home/u/.cache/show-work/x.dot: syntax error in line 2 near '->'\n" }
        : undefined,
  })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const shown = await $.tool.call({ tool: 'mcp__show-work__show', caption: 'x', dot: 'digraph { -> }' })
  expect(shown.deny).toBe("Error: /home/u/.cache/show-work/x.dot: syntax error in line 2 near '->'")
})

test('a renderer that will not start asks whether it is installed', async ($, on) => {
  engine(on)
  host(on, { answer: argv => (argv[0] === 'd2' ? 'absent' : undefined) })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const shown = await $.tool.call({ tool: 'mcp__show-work__show', caption: 'x', d2: 'a -> b' })
  expect(shown.deny).toBe('d2 would not start: is it installed?')
})

test('show refuses a missing image and an empty call', async ($, on) => {
  engine(on)
  host(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const missing = await $.tool.call({
    tool: 'mcp__show-work__show',
    caption: 'x',
    path: 'missing.png',
  })
  expect(missing.deny).toBe('No image at /proj/missing.png.')
  const empty = await $.tool.call({ tool: 'mcp__show-work__show', caption: 'x' })
  expect(empty.deny).toBe('Give a source to draw (d2, mermaid, dot, html or svg), or an image: path, url or images.')
  const file = await $.tool.call({ tool: 'mcp__show-work__show', caption: 'Menu', path: '/proj/menu.png' })
  expect(file.result).toBe('Shown in the chat and the pane: Menu (1600x900).')
})

// The first bytes `od` prints for a PNG and for a web page.
const PNG_HEAD = ' 89 50 4e 47 0d 0a 1a 0a 00 00 00 0d 49 48 44 52\n'
const HTML_HEAD = ' 3c 21 64 6f 63 74 79 70 65 20 68 74 6d 6c 3e 0a\n'

test('an image from the web is fetched, read by the coder its bytes name, and handed back to Claude', async ($, on) => {
  engine(on)
  const { ran } = host(on, { answer: argv => (argv[0] === 'od' ? { stdout: PNG_HEAD } : undefined) })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const shown = await $.tool.call({
    tool: 'mcp__show-work__show',
    tool_use_id: 'toolu_w',
    caption: 'Godot logo',
    url: 'https://example.com/art/logo.png?v=2',
  })
  const curl = ran.find(argv => argv[0] === 'curl') ?? []
  expect(curl).toContain('=http,https')
  expect(curl.slice(-3)).toEqual(['-o', '/home/u/.cache/show-work/toolu_w.web', 'https://example.com/art/logo.png?v=2'])
  expect(ran).toContainEqual([
    'magick',
    'png:/home/u/.cache/show-work/toolu_w.web[0]',
    '/home/u/.cache/show-work/toolu_w.png',
  ])
  expect(ran).toContainEqual(['rm', '-f', '/home/u/.cache/show-work/toolu_w.web'])
  expect(shown.result).toEqual([
    { type: 'text', text: 'Shown in the chat and the pane: Godot logo (1600x900). This is what the person sees: check it is the picture you meant.' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: ONE_PIXEL } },
  ])

  const chat = await $.ui.mount({ ...RESULT('toolu_w'), surface: 'terminal' })
  expect((await chat.find({ type: 'Image' }))?.props).toMatchObject({ alt: 'Godot logo' })
  await chat.unmount()
})

test('show refuses a web page, a failed fetch and a url that is no web address', async ($, on) => {
  engine(on)
  host(on, {
    answer: argv =>
      argv[0] === 'od'
        ? { stdout: HTML_HEAD }
        : argv[0] === 'curl' && argv.at(-1)?.includes('gone')
          ? { exitCode: 22, stderr: 'curl: (22) The requested URL returned error: 404\n' }
          : undefined,
  })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const page = await $.tool.call({ tool: 'mcp__show-work__show', caption: 'x', url: 'https://example.com/wiki/Logo' })
  expect(page.deny).toBe('https://example.com/wiki/Logo is a web page: give the address of the image itself.')
  const gone = await $.tool.call({ tool: 'mcp__show-work__show', caption: 'x', url: 'https://example.com/gone.png' })
  expect(gone.deny).toBe('Could not fetch https://example.com/gone.png: The requested URL returned error: 404.')
  const file = await $.tool.call({ tool: 'mcp__show-work__show', caption: 'x', url: 'file:///etc/passwd' })
  expect(file.deny).toBe('Give url an http or https address; a file goes in path.')
})

test('several images are set side by side on one sheet, lettered and labeled, a sprite blown up', async ($, on) => {
  engine(on)
  const { ran } = host(on, {
    theme: 'light',
    answer: argv =>
      argv[0] === 'od'
        ? { stdout: PNG_HEAD }
        : argv[0] === 'fc-match'
          ? { stdout: '/usr/share/fonts/noto/NotoSans-Medium.ttf' }
          : argv[1] === 'identify' && argv.at(-1)?.endsWith('-2.png')
            ? { stdout: '32 16' }
            : undefined,
  })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const shown = await $.tool.call({
    tool: 'mcp__show-work__show',
    tool_use_id: 'toolu_s',
    caption: 'Two hero styles',
    images: [
      { src: 'art/hero-painted.jpg', label: 'Painted' },
      { src: 'https://example.com/sprites/hero.png' },
    ],
  })
  expect(ran).toContainEqual(['magick', '/proj/art/hero-painted.jpg[0]', '/home/u/.cache/show-work/toolu_s-1.png'])
  expect(ran).toContainEqual([
    'magick',
    'png:/home/u/.cache/show-work/toolu_s-2.web[0]',
    '/home/u/.cache/show-work/toolu_s-2.png',
  ])
  expect(ran).toContainEqual([
    'magick',
    '/home/u/.cache/show-work/toolu_s-2.png',
    '-filter',
    'point',
    '-resize',
    '700%',
    '/home/u/.cache/show-work/toolu_s-2.png',
  ])
  expect(ran).toContainEqual(
    sheetArgs(
      true,
      [
        { file: '/home/u/.cache/show-work/toolu_s-1.png', label: 'A  Painted' },
        { file: '/home/u/.cache/show-work/toolu_s-2.png', label: 'B  hero.png' },
      ],
      '/home/u/.cache/show-work/toolu_s.png',
      '/usr/share/fonts/noto/NotoSans-Medium.ttf',
    ),
  )
  expect(ran).toContainEqual(['rm', '-f', '/home/u/.cache/show-work/toolu_s-1.png', '/home/u/.cache/show-work/toolu_s-2.png'])
  expect(Array.isArray(shown.result) && shown.result[1]).toMatchObject({ type: 'image' })
})

test('a sheet names the picture it could not read', async ($, on) => {
  engine(on)
  host(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const shown = await $.tool.call({
    tool: 'mcp__show-work__show',
    caption: 'x',
    images: [{ src: '/proj/a.png' }, { src: '/proj/missing.png' }],
  })
  expect(shown.deny).toBe('Picture 2: No image at /proj/missing.png.')
  const many = await $.tool.call({
    tool: 'mcp__show-work__show',
    caption: 'x',
    images: Array.from({ length: 10 }, (_, n) => ({ src: `/proj/${n}.png` })),
  })
  expect(many.deny).toBe('A sheet holds at most 9 images.')
})

test("a show call's row names its source by size, and ctrl+o shows it whole", async ($, on) => {
  engine(on)
  // The engine's row, standing in: it prints the input it is handed.
  on('ui.render', (_, e) => ({ type: 'Text', props: {}, children: [JSON.stringify((e.props as { input?: unknown }).input)] }) as never)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const html = '<div class="window">\n  <p>hi</p>\n</div>'
  const row = (isExpanded: boolean) =>
    ({
      plugin: 'show-work',
      component: 'ToolUse',
      requestId: 'toolu_u',
      props: {
        tool_use_id: 'toolu_u',
        tool: 'mcp__show-work__show',
        input: { caption: 'Dashboard', width: 1280, html },
        isRunning: false,
        isErrored: false,
        isInterrupted: false,
        isExpanded,
      },
    }) as const
  const compact = await $.ui.mount({ ...row(false), surface: 'terminal' })
  expect((await compact.find({ type: 'Text' }))?.text).toBe('{"caption":"Dashboard","width":1280,"html":"3 lines"}')
  await compact.unmount()
  const full = await $.ui.mount({ ...row(true), surface: 'terminal' })
  expect((await full.find({ type: 'Text' }))?.text).toContain('<p>hi</p>')
  await full.unmount()
})

test('a brief show input keeps paths and URLs, and lists a sheet by its labels', () => {
  expect(briefShow({ caption: 'Logo', url: 'https://example.com/a.svg' })).toEqual({ caption: 'Logo', url: 'https://example.com/a.svg' })
  expect(briefShow({ caption: 'x', svg: '<svg width="800"/>' })).toEqual({ caption: 'x', svg: '18 characters' })
  expect(
    briefShow({ caption: 'Pick', images: [{ src: '/p/a.png', label: 'Painted' }, { src: 'https://e.com/s/hero.png' }] }),
  ).toEqual({ caption: 'Pick', images: 'Painted, hero.png' })
  expect(briefShow(undefined)).toEqual({})
})

test('pressing a tile of a sheet starts the prompt with the pick', async ($, on) => {
  const filled = engine(on)
  host(on, { answer: argv => (argv[0] === 'od' ? { stdout: PNG_HEAD } : undefined) })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'mcp__show-work__show',
    tool_use_id: 'toolu_p',
    caption: 'Hero styles',
    images: [{ src: '/proj/a.png', label: 'Painted' }, { src: '/proj/pixel.png' }],
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-pictures' })
  const tile = await ui.find({ type: 'Button', key: 'tile-B' })
  expect(tile?.text).toBe('B pixel.png')
  expect(tile?.props).toMatchObject({ hotkey: 'b' })
  await ui.press({ key: 'tile-B' })
  expect(filled).toEqual(['I pick B (pixel.png) from "Hero styles". '])
  await ui.unmount()
})

test("a card under the chat's picture picks a tile or answers a mark, on any surface", async ($, on) => {
  const filled = engine(on)
  host(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'mcp__show-work__show',
    tool_use_id: 'toolu_c1',
    caption: 'Hero styles',
    images: [{ src: '/proj/a.png', label: 'Painted' }, { src: '/proj/b.png', label: 'Pixel' }],
  })
  await $.tool.call({
    tool: 'mcp__show-work__show',
    tool_use_id: 'toolu_c2',
    caption: 'Level 2',
    path: '/proj/level2.png',
    marks: [{ x: 1, y: 2, note: 'The slope' }, { x: 3, y: 4, w: 5, h: 6, note: 'Score jumps here' }],
  })

  const sheet = await $.ui.mount({ ...RESULT('toolu_c1'), surface: 'terminal' })
  expect((await sheet.find({ type: 'Button', key: 'pick-toolu_c1-B' }))?.text).toBe('B Pixel')
  await sheet.press({ key: 'pick-toolu_c1-B' })
  await sheet.unmount()

  const marked = await $.ui.mount({ ...RESULT('toolu_c2'), surface: 'desktop' })
  expect((await marked.find({ type: 'Button', key: 'mark-toolu_c2-2' }))?.text).toBe('2 Score jumps here ↩')
  await marked.press({ key: 'mark-toolu_c2-2' })
  await marked.unmount()

  expect(filled).toEqual(['I pick B (Pixel) from "Hero styles". ', 'About mark 2 ("Score jumps here") on "Level 2": '])
  expect(markText({ caption: 'x', marks: [{ x: 0, y: 0, note: 'a'.repeat(70) }] }, 0)).toBe(`About mark 1 ("${'a'.repeat(57)}...") on "x": `)

  // A plain picture asks nothing: no card.
  await $.tool.call({ tool: 'mcp__show-work__show', tool_use_id: 'toolu_c3', caption: 'Plain', path: '/proj/c.png' })
  const plain = await $.ui.mount({ ...RESULT('toolu_c3'), surface: 'terminal' })
  expect(await plain.find({ type: 'Button' })).toBeUndefined()
  await plain.unmount()
})

test("hovering a mark's spot on the chat's picture lights its card row and shows its detail", async ($, on) => {
  engine(on)
  host(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'mcp__show-work__show',
    tool_use_id: 'toolu_h1',
    caption: 'Level 2',
    path: '/proj/level2.png',
    marks: [{ x: 800, y: 450, w: 160, h: 90, note: 'The slope', detail: 'The normal flips the one-way check.' }],
  })
  const chat = await $.ui.mount({ ...RESULT('toolu_h1'), surface: 'terminal' })
  // The kit's snapshot leaves hover out, so this checks where the spot sits
  // and that the detail waits hidden; a live session checks the hover.
  const spot = await chat.find({ type: 'Box', key: 'spot-toolu_h1-1' })
  expect(spot?.props).toMatchObject({ position: 'absolute', left: 38, top: 10, width: 10, height: 4 })
  expect(await chat.find({ type: 'Box', key: 'row-toolu_h1-1' })).toBeDefined()
  // The detail waits hidden in the lines kept for it, over the hint.
  const detail = await chat.find({ type: 'Box', key: 'detail-toolu_h1-1' })
  expect(detail?.props).toMatchObject({ position: 'absolute', display: 'none' })
  expect(detail?.text.trim()).toBe('The normal flips the one-way check.')
  expect((await chat.find({ type: 'Box', key: 'details-toolu_h1' }))?.props).toMatchObject({ height: 1 })
  expect(await chat.find({ type: 'Text', text: 'Point at a mark for its detail.' })).toBeDefined()
  expect(markScope({ id: 'toolu_h1' }, 0)).toBe('mark-toolu_h1-1')
  await chat.unmount()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-pictures' })
  expect((await ui.find({ type: 'Button', key: 'pane-mark-1' }))?.text).toBe('1 The slope ↩')
  await ui.unmount()
})

test('each mark gets a whole lit copy, laid under the spots, and smaller spots sit on top', async ($, on) => {
  engine(on)
  const { ran } = host(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const marks = [
    { x: 100, y: 100, w: 1200, h: 600, note: 'Big' },
    { x: 200, y: 200, w: 100, h: 50, note: 'Small' },
  ]
  const shown = await $.tool.call({ tool: 'mcp__show-work__show', tool_use_id: 'toolu_l1', caption: 'Lit', path: '/proj/l.png', marks })
  expect(Array.isArray(shown.result) && shown.result[0]).toMatchObject({
    text: expect.stringContaining('Marks 1 and 2 overlap; where they do, pointing lands on the smaller one.'),
  })
  const lighting = ran.filter(argv => argv[0] === 'magick' && argv.at(-1) === 'null:')
  expect(lighting).toHaveLength(1)
  expect(lighting[0]?.[1]).toBe('/home/u/.cache/show-work/toolu_l1.png')
  expect(lighting[0]).toContain('/home/u/.cache/show-work/toolu_l1-lit-2.png')

  const chat = await $.ui.mount({ ...RESULT('toolu_l1'), surface: 'terminal' })
  const lit = await chat.find({ type: 'Box', key: 'lit-toolu_l1-2' })
  expect(lit?.props).toMatchObject({ position: 'absolute', top: 0, left: 0, display: 'none' })
  expect(lit?.children[0]).toMatchObject({
    type: 'Image',
    props: { source: { file: '/home/u/.cache/show-work/toolu_l1-lit-2.png' }, columns: 80, rows: 23 },
  })
  // The copies first, then the spots, the big one before the small.
  const tree = JSON.stringify(await chat.find({ type: 'Box', key: 'pic-toolu_l1' }))
  expect(tree.indexOf('lit-toolu_l1-2')).toBeLessThan(tree.indexOf('spot-toolu_l1-1'))
  expect(tree.indexOf('spot-toolu_l1-1')).toBeLessThan(tree.indexOf('spot-toolu_l1-2'))
  await chat.unmount()
})

test("a card is as wide as its longest line, so a revealed detail never widens it", () => {
  const picture = { marks: [{ x: 0, y: 0, note: 'Short', detail: 'A detail that runs longer than the note.' }] }
  expect(cardWidth(picture, 100)).toBe('A detail that runs longer than the note.'.length + 4)
  expect(cardWidth(picture, 30)).toBe(30)
  expect(cardWidth({ tiles: ['Logo', 'Bug page'] }, 100)).toBe('Pick: [ A Logo ] [ B Bug page ]'.length + 4)
})

test('overlapping marks are found, lit copies are whole, and details wrap to the card', () => {
  const size = { width: 1280, height: 600 }
  const marks = [
    { x: 665, y: 250, w: 360, h: 75, note: 'a' },
    { x: 1200, y: 180, w: 78, h: 168, note: 'c' },
    { x: 1060, y: 308, w: 200, h: 272, note: 'd' },
  ]
  expect(overlaps(marks, size)).toEqual([[2, 3]])
  const argv = litArgs('in.png', marks, size, ['o1.png', 'o2.png', 'o3.png'], false)
  expect(argv.filter(arg => arg === '-write')).toHaveLength(3)
  expect(argv.includes('-crop')).toBe(false)
  expect(argv.at(-1)).toBe('null:')
  expect(wrap('No contact shadow under it, so it reads as floating.', 20)).toEqual([
    'No contact shadow',
    'under it, so it',
    'reads as floating.',
  ])
  expect(wrap('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
})

test('marks are drawn on a picture and the marked picture comes back to Claude', async ($, on) => {
  engine(on)
  const { ran } = host(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const shown = await $.tool.call({
    tool: 'mcp__show-work__show',
    tool_use_id: 'toolu_k',
    caption: 'Where it clips',
    path: '/proj/shots/level2.png',
    marks: [
      { x: 100, y: 200, w: 300, h: 120, note: 'The slope' },
      { x: 900, y: 40, note: 'Score jumps here' },
      { x: 5, y: 5, note: ' ' },
    ],
  })
  const drawn = ran.find(argv => argv[0] === 'magick' && argv.includes('-annotate')) ?? []
  expect(drawn).toEqual(
    markArgs(
      '/home/u/.cache/show-work/toolu_k.png',
      '/home/u/.cache/show-work/toolu_k.png',
      [
        { x: 100, y: 200, w: 300, h: 120, note: 'The slope' },
        { x: 900, y: 40, note: 'Score jumps here' },
      ],
      { width: 1600, height: 900 },
      false,
      undefined,
    ),
  )
  expect(shown.result).toEqual([
    { type: 'text', text: expect.stringMatching(/check each mark sits on what its note names/) },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: ONE_PIXEL } },
  ])
  const many = await $.tool.call({
    tool: 'mcp__show-work__show',
    caption: 'x',
    path: '/proj/a.png',
    marks: Array.from({ length: 13 }, (_, n) => ({ x: n, y: n, note: `m${n}` })),
  })
  expect(many.deny).toBe('A picture takes at most 12 marks.')
  // A picture already shown can be shown again, marked.
  const again = await $.tool.call({
    tool: 'mcp__show-work__show',
    tool_use_id: 'toolu_k2',
    caption: 'Marked',
    path: '/home/u/.cache/show-work/toolu_k.png',
    marks: [{ x: 1, y: 2, note: 'here' }],
  })
  expect(again.deny).toBeUndefined()
  expect(ran).toContainEqual(['cp', '/home/u/.cache/show-work/toolu_k.png', '/home/u/.cache/show-work/toolu_k2.png'])
})

test('marks read plainly, and badges stay inside the picture', () => {
  expect(readMarks([{ x: '10', y: 20, w: 0, h: 5, note: 'ring' }, { x: 1, note: 'no y' }, 'junk'])).toEqual([
    { x: 10, y: 20, note: 'ring' },
  ])
  expect(readMarks(undefined)).toEqual([])
  const argv = markArgs('in.png', 'out.png', [{ x: 0, y: 0, w: 50, h: 50, note: '100% @here' }], { width: 600, height: 300 }, true)
  // r is 12 for a 600-pixel picture: the badge at the corner moves in by it.
  expect(argv).toContain('circle 12,12 24,12')
  expect(argv).toContain('-288-138')
  expect(argv.at(-1)).toBe('out.png')
  expect(argv.some(arg => arg.startsWith('caption:'))).toBe(false)
  // A 1600x900 picture drawn 100 by 28: a box, and a ring with its badge.
  expect(markCells({ x: 800, y: 450, w: 160, h: 90, note: 'box' }, { width: 1600, height: 900 }, { columns: 100, rows: 28 })).toEqual({
    left: 48,
    top: 13,
    width: 12,
    height: 4,
  })
  expect(markCells({ x: 1599, y: 0, note: 'ring' }, { width: 1600, height: 900 }, { columns: 100, rows: 28 })).toEqual({
    left: 97,
    top: 0,
    width: 3,
    height: 2,
  })
  expect(briefShow({ caption: 'x', path: 'a.png', marks: [{}, {}] })).toEqual({ caption: 'x', path: 'a.png', marks: '2 marks' })
  expect(pickText({ caption: 'Heroes', tiles: ['Painted'] }, 0)).toBe('I pick A (Painted) from "Heroes". ')
})

test('the image helpers name formats, files and layouts plainly', () => {
  expect(sniff(fromHex(PNG_HEAD))).toBe('png')
  expect(sniff('\xff\xd8\xff\xe0')).toBe('jpeg')
  expect(sniff('GIF89a')).toBe('gif')
  expect(sniff('RIFF\x00\x00\x00\x00WEBPVP8 ')).toBe('webp')
  expect(sniff('BM6')).toBe('bmp')
  expect(sniff('\xef\xbb\xbf<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg">')).toBe('svg')
  expect(sniff(fromHex(HTML_HEAD))).toBeUndefined()
  expect(sniff('push graphic-context')).toBeUndefined()
  expect(nameOf('https://upload.wikimedia.org/a/b/Godot%20icon.svg?x=1')).toBe('Godot icon.svg')
  expect(nameOf('https://example.com/')).toBe('example.com')
  expect(nameOf('/proj/art/hero.png')).toBe('hero.png')
  expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map(across)).toEqual([1, 2, 3, 4, 3, 3, 4, 4, 3])
  expect(blowUp(32, 16)).toBe(7)
  expect(blowUp(300, 200)).toBe(1)
  expect(literal('@secrets 100%')).toBe('\\@secrets 100%%')
})

test('the design helpers read sizes and errors plainly', () => {
  expect(measured('<html data-height="912">')).toBe(912)
  expect(measured('<html data-height="99999">')).toBe(6000)
  expect(measured('<html>')).toBeUndefined()
  expect(svgSize('<?xml?><svg viewBox="0 0 10 10" width="1225.5" height="400"><svg width="1">')).toEqual({ width: 1226, height: 400 })
  expect(svgSize('<svg viewBox="0 0 10 10">')).toBeUndefined()
  expect(
    errorLines('Error: Parse error on line 2:\ngraph TD A-->-B\n----------^\n    at Parser.parseError (x.js:1)\n[1025/191802.897872:WARNING:components/dbus/xdg/portal.cc:126] noise\n'),
  ).toBe('Error: Parse error on line 2:\ngraph TD A-->-B\n----------^')
  expect(page('<p>hi</p>', true)).toContain('<html data-theme="light">')
})

test('a tall picture narrows to keep its shape', () => {
  expect(fit({ width: 1600, height: 900 }, 100, 40)).toEqual({ columns: 100, rows: 28 })
  expect(fit({ width: 390, height: 844 }, 100, 40)).toEqual({ columns: 37, rows: 40 })
})

test('a screenshot Claude reads lands in the pane, and the list picks one', async ($, on) => {
  engine(on)
  const { ran } = host(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Read', tool_use_id: 'toolu_r1', file_path: '/proj/shots/menu.png' })
  await $.tool.call({ tool: 'Read', tool_use_id: 'toolu_r2', file_path: '/proj/shots/hud.jpg' })
  expect(ran).toContainEqual(['cp', '/proj/shots/menu.png', '/home/u/.cache/show-work/toolu_r1.png'])
  expect(ran).toContainEqual([
    'magick',
    '/proj/shots/hud.jpg[0]',
    '/home/u/.cache/show-work/toolu_r2.png',
  ])

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Button', key: 'tab-pictures' }))?.text).toBe('Pictures 2')
  await ui.press({ key: 'tab-pictures' })
  expect((await ui.find({ type: 'Image' }))?.props).toMatchObject({
    source: { file: '/home/u/.cache/show-work/toolu_r2.png' },
    columns: 60,
    rows: 17,
  })
  await ui.press({ key: 'pic-toolu_r1' })
  expect((await ui.find({ type: 'Image' }))?.props).toMatchObject({
    source: { file: '/home/u/.cache/show-work/toolu_r1.png' },
  })
  await ui.unmount()

  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await desk.find({ type: 'Text', text: '/home/u/.cache/show-work/toolu_r1.png' })).toBeDefined()
  await desk.unmount()
})

test('reading a picture already in the cache adds no copy', async ($, on) => {
  engine(on)
  const { ran } = host(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: '/home/u/.cache/show-work/toolu_a.png' })
  expect(ran.some(argv => argv[0] === 'cp')).toBe(false)
})

test('a new goal starts a new task and hides the old notes', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__show-work__plan', goal: 'First', steps: [] })
  await $.tool.call({ tool: 'mcp__show-work__note', kind: 'finding', text: 'Old news' })
  await $.tool.call({ tool: 'mcp__show-work__plan', goal: 'First', steps: [] })
  await $.tool.call({ tool: 'mcp__show-work__note', kind: 'finding', text: 'Same task' })
  await $.tool.call({ tool: 'mcp__show-work__plan', goal: 'Second', steps: [] })
  await $.tool.call({ tool: 'mcp__show-work__note', kind: 'risk', text: 'Fresh' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Button', key: 'tab-notes' }))?.text).toBe('Notes 1')
  await ui.press({ key: 'tab-notes' })
  expect(await ui.find({ type: 'Button', text: /Old news/ })).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 'earlier' }))?.text).toBe(
    'Show 2 from earlier tasks',
  )
  await ui.press({ key: 'earlier' })
  expect(await ui.find({ type: 'Button', text: /Old news/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Same task/ })).toBeDefined()
  await ui.unmount()
})

const DIFF = `diff --git a/src/menu.gd b/src/menu.gd
--- a/src/menu.gd
+++ b/src/menu.gd
@@ -1,2 +1,2 @@
 extends Control
-var open = false
+var is_open := false
`

test('pressing a changed file shows its diff, colored, and close returns', async ($, on) => {
  engine(on)
  const asked: string[][] = []
  on('process.run', (_, e) => {
    asked.push([...e.argv])
    const stdout = e.argv.includes('HEAD') ? DIFF : ''

    return {
      value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: '/proj/src/menu.gd', old_string: 'a', new_string: 'b' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-activity' })
  await ui.press({ key: 'file-src/menu.gd' })
  expect(asked.at(-1)).toEqual(['git', '-C', '/proj/src', 'diff', '--no-color', 'HEAD', '--', '/proj/src/menu.gd'])
  // The hunks go to Code as a diff, which highlights them; the headers do not.
  const code = await ui.find({ type: 'Code' })
  expect(code?.props).toMatchObject({ format: 'diff', path: 'src/menu.gd' })
  expect(code?.props.source).toBe('@@ -1,2 +1,2 @@\n extends Control\n-var open = false\n+var is_open := false')
  await ui.press({ key: 'diff-close' })
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', text: /menu\.gd/ })).toBeDefined()
  await ui.unmount()
})

test('a new file diffs against nothing', async ($, on) => {
  engine(on)
  on('process.run', (_, e) => ({
    value: {
      exitCode: 1,
      stdout: e.argv.includes('--no-index') ? '@@ -0,0 +1 @@\n+hello\n' : '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Write', file_path: '/proj/new.txt', content: 'hello' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-activity' })
  await ui.press({ key: 'file-new.txt' })
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe('@@ -0,0 +1 @@\n+hello')
  await ui.unmount()
})

test('a subagent gets a lane with its latest call, done when it stops', async ($, on) => {
  engine(on)
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'ag1' }))
  on('classic.SubagentStop', () => ({}))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({
    tool_use_id: 'toolu_a1',
    prompt: 'Find the menu scene',
    description: 'Find menu scene',
    subagentType: 'Explore',
  } as never)
  await $.tool.call({ tool: 'Read', file_path: '/proj/menu.tscn', agentId: 'ag1' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^Agents/ }))?.text).toBe('Agents 1 running')
  expect((await ui.find({ type: 'Text', text: /Find menu scene/ }))?.text).toBe(
    '… Find menu scene Explore · 1 call',
  )
  expect((await ui.find({ type: 'Text', text: /↳ read/ }))?.text).toBe('  ↳ read menu.tscn')
  // The Agent call returns while the subagent still runs.
  await $.tool.call({ tool: 'Agent', description: 'Find menu scene', prompt: 'x', tool_use_id: 'toolu_a1' } as never)
  expect((await ui.find({ type: 'Text', text: /^Agents/ }))?.text).toBe('Agents 1 running')
  await $.classic.SubagentStop({ agent_id: 'ag1', agent_type: 'Explore' } as never)
  expect((await ui.find({ type: 'Text', text: /^Agents/ }))?.text).toBe('Agents 0 running')
  expect((await ui.find({ type: 'Text', text: /Find menu scene/ }))?.text).toMatch(/^✓/)
  await ui.unmount()
})

import { divider, duration } from '../hooks/register'
import {
  area,
  base64,
  patchCounts,
  shareBar,
  flaky,
  gantt,
  gauge,
  glyphs,
  legend,
  parseLog,
  parseTests,
  pulse,
  scoreboard,
  treemap,
} from '../hooks/charts'

const decode = (cells: string, columns: number, rows: number) => {
  const bin = atob(cells)
  const bytes = Uint8Array.from(bin, ch => ch.charCodeAt(0))
  const words = new Uint32Array(bytes.buffer)
  const lines: string[] = []
  for (let row = 0; row < rows; row++) {
    let line = ''
    for (let col = 0; col < columns; col++) {
      line += String.fromCharCode(words[(row * columns + col) * 3] ?? 0)
    }
    lines.push(line)
  }

  return { lines, words }
}

test('base64 matches the standard padded form', () => {
  const enc = (text: string) => base64(Uint8Array.from(text, ch => ch.charCodeAt(0)))
  expect([enc(''), enc('f'), enc('fo'), enc('foo'), enc('foob')]).toEqual(['', 'Zg==', 'Zm8=', 'Zm9v', 'Zm9vYg=='])
})

test('durations and turn dividers read plainly', () => {
  expect([duration(38_000), duration(252_000), duration(60_000)]).toEqual(['38s', '4m12s', '1m00s'])
  const turn = { id: 't', n: 4, start: 0, end: 38_000, calls: 12, failed: 1 }
  expect(divider(turn, 4, 99_000)).toBe('── turn 4 · 38s · 12 calls · 1 failed ──')
  expect(divider({ ...turn, end: undefined, failed: 0 }, 4, 5_000)).toBe('── turn 4 · 5s… · 12 calls ──')
})

test('the gantt lays bars across time with half-cell ends', () => {
  const columns = 35 // a 14-column label, a gap, 20 columns of bars
  const chart = gantt(
    [
      { label: 'turn 1', start: 0, end: 10_000, color: 0xd97757, isSub: false },
      { label: 'Find menu', start: 5_000, end: 7_500, color: 0x5fa8d3, isSub: true },
      { label: 'turn 2', start: 15_000, color: 0xf0a070, isSub: false },
    ],
    20_000,
    columns,
  )
  const { lines, words } = decode(chart.cells, columns, chart.rows)
  // 20s over 20 columns: a column is a second, a half column half of one.
  expect(lines).toEqual([
    'turn 1         ██████████  ·     · ',
    '↳ Find menu    ·    ██▌    ·     · ',
    'turn 2         ·     ·     ·  █████',
  ])
  // A bar's cells carry its color; a label's do not.
  expect(words[(0 * columns + 15) * 3 + 1]).toBe(0xd97757)
})

test('turns draw dividers in Activity and bars on the Timeline', async ($, on) => {
  engine(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'fix it', turnId: 'turn-a' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/proj/a.gd' })
  await $.tool.call({ tool: 'Bash', command: 'false' })
  await $.turn.complete({ turnId: 'turn-a', reason: 'answer', answer: '', durationMs: 0, isAborted: false } as never)
  await $.turn.start({ text: 'again', turnId: 'turn-b' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/proj/b.gd' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-activity' })
  expect((await ui.find({ type: 'Text', text: /── turn 1/ }))?.text).toMatch(/^── turn 1 · \ds · 2 calls · 1 failed ──$/)
  expect((await ui.find({ type: 'Text', text: /── turn 2/ }))?.text).toMatch(/^── turn 2 · \ds… · 1 call ──$/)
  await ui.press({ key: 'tab-timeline' })
  expect((await ui.find({ type: 'Text', text: /turns ·/ }))?.text).toMatch(/^2 turns · 1 running/)
  const raster = await ui.find({ type: 'Raster' })
  expect(raster?.props.rows).toBe(2)
  await ui.unmount()

  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await desk.press({ key: 'tab-timeline' })
  expect((await desk.find({ type: 'Text', text: /^turn 2/ }))?.text).toMatch(/…$/)
  await desk.unmount()
})

test('the legend swatches use the chart colors', () => {
  const key = legend([
    [0xd97757, 'turn'],
    [0x5fa8d3, 'subagent'],
  ])
  const { lines, words } = decode(key.cells, key.columns, 1)
  expect(lines[0]).toBe('█ turn  █ subagent')
  expect(words[1]).toBe(0xd97757)
  expect(words[8 * 3 + 1]).toBe(0x5fa8d3)
})

test('a running bar grows between redraws, repainted by blit, and stops when done', async ($, on) => {
  engine(on, { isTicking: false })
  const clock = mock.clock(on, { now: 1_000 })
  const blits: { cells: string; columns: number; rows: number }[] = []
  on('ui.blit', (_, e) => {
    if ('cells' in e && e.cells !== undefined) {
      blits.push({ cells: e.cells, columns: e.columns ?? 0, rows: e.rows ?? 0 })
    }

    return { value: {} }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 'turn-a' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-timeline' })
  await clock.advance(10_000)
  const count = blits.length
  expect(count).toBeGreaterThan(30)
  // The bar fills its row by now, and the leading cell pulses frame to frame.
  const last = decode(blits.at(-1)!.cells, blits.at(-1)!.columns, 1)
  expect(last.lines[0]?.slice(15).trim()).toMatch(/^█+$/)
  const heads = blits.slice(-2).map(one => {
    const words = decode(one.cells, one.columns, 1).words
    return words[(one.columns - 1) * 3 + 1]
  })
  expect(new Set(heads).size).toBe(2)

  await $.turn.complete({ turnId: 'turn-a', reason: 'answer', answer: '', durationMs: 0, isAborted: false } as never)
  await clock.advance(2_000)
  const after = blits.length
  await clock.advance(5_000)
  expect(blits.length).toBe(after)
  await ui.unmount()
})

test('labels a Raster cannot draw turn to ?, and a narrow pane still fits', () => {
  expect(String.fromCharCode(...glyphs('fix 🐛 バグ ↳'))).toBe('fix ? ?? ↳')
  const chart = gantt([{ label: 'ship 🚀', start: 0, end: 500, color: 0xd97757, isSub: true }], 1_000, 8)
  expect(chart.columns).toBe(19)
  const { lines } = decode(chart.cells, chart.columns, chart.rows)
  expect(lines[0]?.slice(0, 9)).toBe('↳ ship ? ')
  expect(gantt([], 1_000, 40)).toMatchObject({ rows: 0, cells: '' })
})

test('test output from five runners is read for counts and names', () => {
  expect(parseTests('(pass) adds [1ms]\n(fail) subtracts [2ms]\n\n 1 pass\n 1 fail\n')).toEqual({
    passed: 1,
    failed: 1,
    names: [
      { name: 'adds', ok: true },
      { name: 'subtracts', ok: false },
    ],
  })
  expect(parseTests(' ✓ renders (5 ms)\n ✕ clicks\nTests: 1 failed, 1 passed, 2 total')).toMatchObject({
    passed: 1,
    failed: 1,
    names: [{ name: 'renders', ok: true }, { name: 'clicks', ok: false }],
  })
  expect(parseTests('tests/a.py::test_x PASSED  [ 50%]\n=== 1 passed in 0.1s ===')?.names).toEqual([
    { name: 'tests/a.py::test_x', ok: true },
  ])
  expect(parseTests('test a::b ... ok\ntest result: ok. 1 passed; 0 failed')).toMatchObject({ passed: 1, failed: 0 })
  expect(parseTests('--- FAIL: TestJump (0.00s)')).toMatchObject({ passed: 0, failed: 1 })
  expect(parseTests('compiled fine')).toBeUndefined()
})

const run = (id: string, names: [string, boolean][], extra = {}) => ({
  id,
  at: 0,
  command: 'bun test',
  passed: names.filter(([, ok]) => ok).length,
  failed: names.filter(([, ok]) => !ok).length,
  isError: false,
  names: names.map(([name, ok]) => ({ name, ok })),
  ...extra,
})

test('the scoreboard puts failing tests first and flags flips as flaky', () => {
  const runs = [
    run('r1', [['jump', true], ['dash', true]]),
    run('r2', [['jump', false], ['dash', true]]),
    run('r3', [['jump', true], ['dash', false]]),
  ]
  expect([...flaky(runs)]).toEqual(['jump'])
  const board = scoreboard(runs, 40, 10)
  expect(board.names).toEqual(['dash', 'jump'])
  const { lines, words } = decode(board.cells, board.columns, board.rows)
  expect(lines).toEqual(['runs           █ █ █ ', 'dash           ▆ ▆ ▆ ', 'jump           ▆ ▆ ▆ '])
  const fg = (row: number, col: number) => words[(row * board.columns + col) * 3 + 1]
  expect([fg(0, 15), fg(0, 17), fg(0, 19)]).toEqual([0x6cc070, 0xe06c75, 0xe06c75])
  expect([fg(1, 15), fg(1, 19)]).toEqual([0x6cc070, 0xe06c75])
  expect(fg(2, 0)).toBe(0xe0a040)
})

test('the pulse stacks calls into buckets, newest on the right', () => {
  const beats = [
    { at: 9_500, kind: 'read', status: 'ok' },
    { at: 9_800, kind: 'edit', status: 'ok' },
    { at: 5_000, kind: 'run', status: 'failed' },
  ]
  const strip = pulse(beats, 10_000, 6, 1000)
  const { lines, words } = decode(strip.cells, 6, 1)
  // Two calls in the last second, one five seconds back; four fill a cell.
  expect(lines[0]).toBe('▂▁▁▁▁▄')
  expect(words[5 * 3 + 1]).toBe(0xe0a040)
  expect(words[0 * 3 + 1]).toBe(0xe06c75)
})

test('the gauge fills by fraction, colors by level and marks compaction', () => {
  const { lines, words } = decode(gauge(0.6, 10, 0.8).cells, 10, 1)
  expect(lines[0]).toBe('██████░░┃░')
  expect(words[1]).toBe(0xe0a040)
})

test('the area chart rises in eighths and draws the compaction line', () => {
  const chart = area([0.25, 0.5, 1], 9, 4, 0.75)
  expect(decode(chart.cells, 9, 4).lines).toEqual([
    '──────██─',
    '      ██ ',
    '   ██ ██ ',
    '██ ██ ██ ',
  ])
})

test('the treemap covers the box and labels the tiles that fit', () => {
  const map = treemap(
    [
      { label: 'player.gd', weight: 6, color: 0xb4532f },
      { label: 'menu.gd', weight: 3, color: 0x2f5f80 },
      { label: 'x', weight: 1, color: 0x2f5f80 },
    ],
    30,
    6,
  )
  expect(map.placed.map(one => one.tile.label)).toEqual(['player.gd', 'menu.gd', 'x'])
  const biggest = map.placed[0]!
  expect(biggest.width * biggest.height).toBeGreaterThan(80)
  const { lines, words } = decode(map.cells, 30, 6)
  expect(lines[biggest.row]?.slice(biggest.col, biggest.col + 9)).toBe('player.gd')
  expect(words[(biggest.row * 30 + biggest.col) * 3 + 2]).toBe(0xb4532f)
})

test('git log --graph reads into commits with stats and forks', () => {
  const out = [
    '* \x1e3d4035d\x1fadd timeline\x1f2 hours ago\x1fHEAD -> work',
    '|  2 files changed, 418 insertions(+), 4 deletions(-)',
    '| * \x1eabc1234\x1fside fix\x1f3 hours ago\x1f',
    '|/  ',
    '|  1 file changed, 1 deletion(-)',
    '* \x1e0f88d45\x1freadme\x1f4 hours ago\x1f',
  ].join('\n')
  expect(parseLog(out)).toEqual([
    { graph: '*', sha: '3d4035d', subject: 'add timeline', when: '2 hours ago', refs: 'HEAD -> work', added: 418, removed: 4 },
    { graph: '| *', sha: 'abc1234', subject: 'side fix', when: '3 hours ago', added: 0, removed: 1 },
    { graph: '|/' },
    { graph: '*', sha: '0f88d45', subject: 'readme', when: '4 hours ago' },
  ])
})

const USAGE = {
  startedAt: 0,
  context: {
    tokens: 120_000,
    window: 200_000,
    percent: 60,
    breakdown: {
      categories: [
        { name: 'System prompt', tokens: 20_000, color: 'promptBorder', isDeferred: false, kind: 'used' },
        { name: 'Messages', tokens: 100_000, color: 'permission', isDeferred: false, kind: 'used' },
        { name: 'Free space', tokens: 47_000, color: 'inactive', isDeferred: false, kind: 'free' },
        { name: 'Autocompact buffer', tokens: 33_000, color: 'inactive', isDeferred: false, kind: 'buffer' },
      ],
    },
  },
  rateLimits: [{ kind: 'five_hour', percentUsed: 23 }],
  cost: { usd: 4.2 },
}

test('the Context tab shows the gauge, what fills it and each turn', async ($, on) => {
  engine(on)
  on('session.usage', () => ({ value: USAGE }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({
    text: '',
    usage: { model: 'm', input_tokens: 12_300, output_tokens: 1_200, cache_read_input_tokens: 98_000, cache_creation_input_tokens: 3_100 },
  }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 'turn-a' } as never)
  await $.turn.complete({ turnId: 'turn-a', reason: 'answer', answer: '', durationMs: 0, isAborted: false } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-context' })
  expect((await ui.find({ type: 'Text', text: /compacts at/ }))?.text).toBe(
    'Context 60% 120k / 200k · compacts at 167k · $4.20 so far',
  )
  expect(await ui.find({ type: 'Raster', key: 'ctx-gauge' })).toBeDefined()
  expect(await ui.find({ type: 'Raster', key: 'ctx-area' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^turn 1:/ }))?.text).toBe(
    'turn 1: 12.3k in · 1.2k out · 98.0k cache read · 3.1k cache write',
  )
  expect((await ui.find({ type: 'Text', text: /^limits/ }))?.text).toBe('limits: five hour 23%')
  await ui.press({ key: 'tab-now' })
  // The status line shows the context and spend; the Now tab leaves them out.
  expect(await ui.find({ type: 'Text', text: /context 60%|\$4\.20/ })).toBeUndefined()
  await ui.unmount()

  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await desk.press({ key: 'tab-context' })
  expect((await desk.find({ type: 'Text', text: /^Messages/ }))?.text).toBe('Messages 100k')
  await desk.unmount()
})

const BUN_OUT = (jump: boolean) =>
  `(pass) dash [1ms]\n(${jump ? 'pass' : 'fail'}) jump [2ms]\n\n ${jump ? 2 : 1} pass\n ${jump ? 0 : 1} fail\n`

test('test commands land on the Tests tab as runs', async ($, on) => {
  let jump = true
  engine(on, {
    bash: command =>
      command.startsWith('bun test') ? { text: BUN_OUT(jump), isError: !jump } : undefined,
  })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'bun test', description: 'Run the suite' })
  jump = false
  await $.tool.call({ tool: 'Bash', command: 'bun test', description: 'Run the suite' })
  await $.tool.call({ tool: 'Bash', command: 'ls', description: 'List' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab-tests' })
    expect((await ui.find({ type: 'Text', text: /pass · \d fail/ }))?.text).toMatch(/^✗ 1 pass · 1 fail bun test · \d+s ago$/)
    expect((await ui.find({ type: 'Raster', key: 'tests-board' })) !== undefined).toBe(surface === 'terminal')
    expect(await ui.find({ type: 'Text', text: /^✓\s+2 pass/ })).toBeDefined()
    await ui.press({ key: 'tab-now' })
    await ui.unmount()
  }
})

test('files read and edited draw as tiles; pressing one opens its diff', async ($, on) => {
  engine(on)
  on('process.run', () => ({
    value: { exitCode: 0, stdout: '@@ -1 +1 @@\n-a\n+b\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: '/proj/player.gd' })
  await $.tool.call({ tool: 'Edit', file_path: '/proj/player.gd', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Read', file_path: '/proj/menu.gd' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-files' })
  expect(await ui.find({ type: 'Raster', key: 'files-map' })).toBeDefined()
  expect((await ui.find({ type: 'Button', text: /player\.gd/ }))?.text).toBe('± player.gd 1 read · 1 edit')
  await ui.press({ key: 'touch-player.gd' })
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe('@@ -1 +1 @@\n-a\n+b')
  await ui.unmount()
})

test("the Commits tab draws this session's graph and refreshes after a commit", async ($, on) => {
  let log = '* \x1e1111111\x1ffirst\x1f1 minute ago\x1fHEAD -> work\n|  1 file changed, 2 insertions(+)\n'
  const asked: string[][] = []
  engine(on)
  on('session.usage', () => ({ value: { ...USAGE, startedAt: 1_700_000_000_000 } }))
  on('process.run', (_, e) => {
    asked.push([...e.argv])
    const stdout = e.argv.includes('rev-list') ? 'basesha\n' : e.argv.includes('log') ? log : ''

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  expect(asked.find(argv => argv.includes('rev-list'))).toEqual(['git', '-C', '/proj', 'rev-list', '-1', '--before=@1700000000', 'HEAD'])
  expect(asked.find(argv => argv.includes('log'))?.at(-1)).toBe('^basesha')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-commits' })
  expect((await ui.find({ type: 'Text', text: /1111111/ }))?.text).toBe('● 1111111 first (HEAD -> work) +2 −0 1 minute ago')
  log = '* \x1e2222222\x1fsecond\x1fnow\x1fHEAD -> work\n' + log.replace('HEAD -> work', '')
  await $.tool.call({ tool: 'Bash', command: 'git commit -m second', description: 'Commit' })
  expect((await ui.find({ type: 'Text', text: /^This session's commits/ }))?.text).toBe("This session's commits 2")
  await ui.unmount()
})

test('a share bar keeps its parts in proportion and shows each that has any', () => {
  const bar = shareBar(
    [
      { n: 30, color: 0x6cc070, word: '+30' },
      { n: 1, color: 0xe06c75, word: '−1' },
    ],
    10,
  )
  const { lines, words } = decode(bar.cells, bar.columns, 1)
  expect(lines[0]).toBe('+30 −1 ██████████')
  expect(words[(bar.columns - 1) * 3 + 1]).toBe(0xe06c75)
  expect(patchCounts({ structuredPatch: [{ lines: [' a', '-b', '+c', '+d'] }] })).toEqual({ added: 2, removed: 1 })
  expect(patchCounts({ type: 'create', content: 'a\nb\nc', structuredPatch: [] })).toEqual({ added: 3, removed: 0 })
})

// Stands for the engine's own drawing of a row or the band.
const ENGINE_ROW = () => ({ type: 'Text', props: {}, children: ['engine row'] }) as never

const TOOL_RESULT = (tool_use_id: string, tool: string, output: unknown) =>
  ({
    plugin: 'show-work',
    component: 'ToolResult',
    requestId: tool_use_id,
    props: { tool_use_id, tool, output, isErrored: false },
  }) as const

test("an edit's row in the chat gets a bar of lines added and removed", async ($, on) => {
  engine(on)
  on('ui.render', ENGINE_ROW)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({
    ...TOOL_RESULT('toolu_e1', 'Edit', { structuredPatch: [{ lines: ['-a', '+b', '+c'] }] }),
    surface: 'terminal',
  })
  const bar = await ui.find({ type: 'Raster', key: 'edit-toolu_e1' })
  expect(decode(bar?.props.cells, bar?.props.columns, 1).lines[0]).toMatch(/^\+2 −1 █+$/)
  await ui.unmount()
})

test("a test command's row in the chat gets a pass and fail bar", async ($, on) => {
  let id = ''
  engine(on, {
    bash: (command, callId) => {
      id = callId

      return command === 'bun test' ? { text: BUN_OUT(false), isError: true } : undefined
    },
  })
  on('ui.render', ENGINE_ROW)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'bun test', description: 'Run the suite' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...TOOL_RESULT(id, 'Bash', { stdout: '' }), surface })
    if (surface === 'terminal') {
      const bar = await ui.find({ type: 'Raster', key: `tests-${id}` })
      expect(decode(bar?.props.cells, bar?.props.columns, 1).lines[0]).toMatch(/^✗ 1 pass 1 fail █+$/)
    } else {
      expect((await ui.find({ type: 'Text', text: /pass/ }))?.text).toBe('✗ 1 pass · 1 fail')
    }
    await ui.unmount()
  }
})

const BAND = (isWorking: boolean) =>
  ({
    plugin: 'show-work',
    component: 'AbovePrompt',
    requestId: 'band',
    props: { hasSurvey: false, isWorking, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  }) as const

test('the band shows the pulse and step while Claude works, and nothing idle', async ($, on) => {
  engine(on)
  on('clock.every', () => ({ value: { cancel: () => {} } }))
  on('session.usage', () => ({ value: USAGE }))
  on('ui.render', ENGINE_ROW)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'mcp__show-work__plan',
    goal: 'Ship it',
    steps: [{ text: 'Write the band', status: 'doing' }],
  })
  await $.tool.call({ tool: 'Read', file_path: '/proj/a.gd' })

  const idle = await $.ui.mount({ ...BAND(false), surface: 'terminal' })
  expect(await idle.find({ type: 'Raster' })).toBeUndefined()
  await idle.unmount()

  const ui = await $.ui.mount({ ...BAND(true), surface: 'terminal' })
  expect(await ui.find({ type: 'Raster', key: 'hud-pulse' })).toBeDefined()
  // The context is the status line's to show.
  expect(await ui.find({ type: 'Raster', key: 'hud-gauge' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /▸/ }))?.text).toBe('▸ Write the band')
  await ui.unmount()
})

import { matches, parseStatus, treeRows } from '../hooks/explorer'

const FILES = ['README.md', 'hooks/register.tsx', 'hooks/charts.ts', 'tests/show-work.test.tsx', 'types/index.d.ts']

test('the tree lists folders first and opens only the open ones', () => {
  const closed = treeRows(FILES, new Set())
  expect(closed.map(row => row.path)).toEqual(['hooks', 'tests', 'types', 'README.md'])
  const open = treeRows(FILES, new Set(['hooks']))
  expect(open.map(row => `${'  '.repeat(row.depth)}${row.name}`)).toEqual([
    'hooks',
    '  charts.ts',
    '  register.tsx',
    'tests',
    'types',
    'README.md',
  ])
})

test('a filter finds files by a few letters, name hits first', () => {
  expect(matches(FILES, 'reg', 5)[0]).toBe('hooks/register.tsx')
  expect(matches(FILES, 'hct', 5)).toEqual(['hooks/charts.ts'])
  expect(matches(FILES, 'zzz', 5)).toEqual([])
  expect(parseStatus(' M hooks/register.tsx\n?? hooks/explorer.ts\nR  a.ts -> b.ts\n')).toEqual({
    'hooks/register.tsx': 'M',
    'hooks/explorer.ts': '??',
    'b.ts': 'R',
  })
})

test('the Explorer walks the tree, filters, previews a file and mentions it', async ($, on) => {
  const filled = engine(on)
  on('process.run', (_, e) => {
    const stdout = e.argv.includes('ls-files')
      ? FILES.join('\n') + '\n'
      : e.argv.includes('status')
        ? ' M hooks/register.tsx\n'
        : ''

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', () => ({ value: 'export const register = 1\nexport const two = 2\n' }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-explorer' })
  expect((await ui.find({ type: 'Button', key: 'tab-explorer' }))?.text).toBe('Explorer 1')
  expect((await ui.find({ type: 'Text', text: /files/ }))?.text).toBe('5 files · 1 changed')
  await ui.press({ key: 'ex-hooks' })
  expect((await ui.find({ type: 'Button', key: 'ex-hooks/register.tsx' }))?.text).toBe('    register.tsx M')

  await ui.input({ key: 'ex-filter', text: 'chts', kind: 'change' })
  expect((await ui.findAll({ type: 'Button', text: /charts/ })).map(one => one.key)).toEqual(['ex-hooks/charts.ts'])
  await ui.input({ key: 'ex-filter', text: 'reg', kind: 'submit' })
  const code = await ui.find({ type: 'Code' })
  expect(code?.props).toMatchObject({ path: 'hooks/register.tsx', startLine: 1 })
  expect(code?.props.source).toMatch(/^export const register = 1/)
  expect(await ui.find({ type: 'Button', key: 'ex-diff' })).toBeDefined()
  await ui.press({ key: 'ex-mention' })
  expect(filled).toEqual(['@hooks/register.tsx '])
  await ui.press({ key: 'ex-close' })
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  await ui.unmount()
})

import { parseGit, parseHits, plain } from '../hooks/explorer'

test('git status, grep hits and coloured output are read plainly', () => {
  expect(parseGit('## main [ahead 3]\n').branch).toBe('main')
  expect(parseGit('## work...origin/work [ahead 2, behind 1]\nM  a.ts\n M b.ts\n?? c.ts\n')).toEqual({
    branch: 'work',
    ahead: 2,
    behind: 1,
    files: [
      { path: 'a.ts', index: 'M', worktree: ' ' },
      { path: 'b.ts', index: ' ', worktree: 'M' },
      { path: 'c.ts', index: '?', worktree: '?' },
    ],
  })
  expect(parseHits('a.ts:3:  const x = 1\nb/c.ts:10:x()\nnot a hit\n', 1)).toEqual({
    hits: [{ file: 'a.ts', line: 3, text: 'const x = 1' }],
    isCut: true,
  })
  expect(plain('\x1b[32m✓ ok\x1b[0m')).toBe('✓ ok')
  expect(plain('10%\r50%\r100% done')).toBe('100% done')
})

test('the Run tab streams a command, keeps its tail and hands it to Claude', async ($, on) => {
  const filled = engine(on)
  const spawned: string[][] = []
  on('process.spawn', async function* ($, e, next) {
    spawned.push([...e.argv])
    yield { stream: 'stdout' as const, text: 'building\n\x1b[31merror: x\x1b[0m\npart' }
    yield { stream: 'stderr' as const, text: 'ial\n' }

    return { value: { code: 1, signal: null } } as never
  })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-run' })
  await ui.input({ key: 'run-cmd', text: 'make build', kind: 'submit' })
  expect(spawned).toEqual([['bash', '-lc', 'make build']])
  expect((await ui.find({ type: 'Button', text: /^. make build/ }))?.text).toMatch(/^✗ make build \d+s · exit 1$/)
  expect((await ui.findAll({ type: 'Text', text: /building|error|partial/ })).map(one => [one.text, one.props.color])).toEqual([
    ['building', undefined],
    ['error: x', 'error'],
    ['partial', undefined],
  ])
  await ui.press({ key: 'run-ask' })
  expect(filled[0]).toBe('The output of `make build` (failed, exit 1):\n```\nbuilding\nerror: x\npartial\n```\n')
  await ui.unmount()
})

test('the Git tab stages a file, commits with a message and shows what git said', async ($, on) => {
  engine(on)
  const ran: string[][] = []
  let status = '## work\n M a.ts\n?? b.ts\n'
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    if (e.argv.includes('add')) {
      status = '## work\nM  a.ts\n?? b.ts\n'
    }
    if (e.argv.includes('commit')) {
      status = '## work [ahead 1]\n?? b.ts\n'
    }
    const stdout = e.argv.includes('--branch') ? status : e.argv.includes('commit') ? '[work 1234567] Fix a\n' : ''

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-git' })
  expect((await ui.find({ type: 'Button', key: 'git-w-a.ts' }))?.text).toBe('○ a.ts modified')
  expect(await ui.find({ type: 'Input', key: 'git-msg' })).toBeUndefined()
  await ui.press({ key: 'git-w-a.ts' })
  expect(ran.find(argv => argv.includes('add'))).toEqual(['git', '-C', '/proj', 'add', '--', 'a.ts'])
  expect((await ui.find({ type: 'Button', key: 'git-s-a.ts' }))?.text).toBe('● a.ts modified')
  await ui.input({ key: 'git-msg', text: 'Fix a', kind: 'submit' })
  expect(ran.find(argv => argv.includes('commit'))).toEqual(['git', '-C', '/proj', 'commit', '-m', 'Fix a'])
  expect((await ui.find({ type: 'Text', text: /^git commit/ }))?.text).toBe('git commit: [work 1234567] Fix a')
  expect((await ui.find({ type: 'Text', text: /⎇/ }))?.text).toBe('⎇ work ↑1')
  expect(await ui.find({ type: 'Button', key: 'git-push' })).toBeDefined()
  await ui.unmount()
})

test('the Search tab finds text and a hit opens the file at that line', async ($, on) => {
  engine(on)
  on('process.run', (_, e) => {
    const stdout = e.argv[0] === 'rg' ? 'hooks/a.ts:42:  jump()\nhooks/a.ts:50:jump(2)\nREADME.md:3:jump here\n' : ''

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', () => ({ value: Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join('\n') }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-search' })
  await ui.input({ key: 'search-q', text: 'jump', kind: 'submit' })
  expect((await ui.find({ type: 'Text', text: /hits in/ }))?.text).toBe('3 hits in 2 files')
  expect((await ui.find({ type: 'Button', key: 'hit-hooks/a.ts:42' }))?.text).toBe('   42 jump()')
  await ui.press({ key: 'hit-hooks/a.ts:42' })
  const code = await ui.find({ type: 'Code' })
  expect(code?.props).toMatchObject({ path: 'hooks/a.ts', startLine: 32 })
  expect(code?.props.source).toMatch(/^line 32\n/)
  expect((await ui.find({ type: 'Text', text: /line 42 of/ }))?.text).toBe('hooks/a.ts line 42 of 80')
  await ui.unmount()
})

test('closed mermaid blocks split from the text; open or nested ones stay text', () => {
  const reply = ['Here:', '```mermaid', 'graph LR', '  A-->B', '```', 'Done.'].join('\n')
  expect(splitMermaid(reply)).toEqual([
    { kind: 'markdown', text: 'Here:' },
    {
      kind: 'mermaid',
      source: 'graph LR\n  A-->B',
      fence: '```mermaid\ngraph LR\n  A-->B\n```',
    },
    { kind: 'markdown', text: 'Done.' },
  ])
  expect(splitMermaid('Soon:\n```mermaid\ngraph LR')).toEqual([
    { kind: 'markdown', text: 'Soon:\n```mermaid\ngraph LR' },
  ])
  const nested = '````markdown\n```mermaid\ngraph LR\n```\n````'
  expect(splitMermaid(nested)).toEqual([{ kind: 'markdown', text: nested }])
  expect(hashOf('graph LR')).toBe(hashOf('graph LR'))
  expect(hashOf('graph LR')).not.toBe(hashOf('graph TD'))
})

// A 1x1 white PNG.
const ONE_PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAMAAAAoyzS7AAAAA1BMVEX///+nxBvIAAAACklEQVQI12NgAAAAAgAB4iG8MwAAAABJRU5ErkJggg=='

const REPLY = (text: string) =>
  ({
    plugin: 'show-work',
    component: 'AssistantMessage',
    requestId: 'msg-1',
    props: { text, isFirstOfReply: true },
  }) as const

test("a reply's mermaid block renders with mmdc and draws as a picture in place", async ($, on) => {
  engine(on)
  const ran: string[][] = []
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    const stdout = e.argv[1] === 'identify' ? '1600 900' : ''

    return {
      value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('config.list', () => ({ value: [{ key: 'theme', value: 'light' }] as never }))
  on('fs.read', () => ({ value: { base64: ONE_PIXEL } }))
  on('ui.render', ENGINE_ROW)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({
    ...REPLY('The flow:\n```mermaid\ngraph LR\n  A-->B\n```\nThat is all.'),
    surface: 'terminal',
    viewport: { columns: 120, rows: 40 },
  })
  let picture = await ui.find({ type: 'Image' })
  for (let tries = 0; picture === undefined && tries < 50; tries += 1) {
    await Promise.resolve()
    picture = await ui.find({ type: 'Image' })
  }
  const mmdc = ran.find(argv => argv[0] === 'mmdc')
  expect(mmdc).toContain('default')
  expect(mmdc?.at(mmdc.indexOf('-o') + 1)).toMatch(/^\/home\/u\/\.cache\/show-work\/mermaid-[0-9a-f]{8}\.png$/)
  // 1600x900 pixels at 2x is 800 CSS pixels: 100 columns, 28 rows.
  expect(picture?.props.columns).toBe(100)
  expect(picture?.props.rows).toBe(28)
  expect(picture?.props.source).toEqual({ png: ONE_PIXEL })
  expect((await ui.find({ type: 'Markdown', text: /That is all/ }))).toBeDefined()
  expect(ran.filter(argv => argv[0] === 'mmdc')).toHaveLength(1)
  await ui.unmount()
})

test('a reply with no mermaid, or off the terminal, draws as the engine does', async ($, on) => {
  engine(on)
  on('ui.render', ENGINE_ROW)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const plainReply = await $.ui.mount({ ...REPLY('No pictures here.'), surface: 'terminal' })
  expect((await plainReply.find({ type: 'Text', text: 'engine row' }))).toBeDefined()
  await plainReply.unmount()
  const desktop = await $.ui.mount({ ...REPLY('```mermaid\ngraph LR\n```'), surface: 'desktop' })
  expect((await desktop.find({ type: 'Text', text: 'engine row' }))).toBeDefined()
  await desktop.unmount()
})

test('a mermaid block that will not render shows its code and why', async ($, on) => {
  engine(on)
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('config.list', () => ({ value: [] }))
  on('process.run', (_, e) => ({
    value: {
      exitCode: e.argv[0] === 'mmdc' ? 1 : 0,
      stdout: '',
      stderr: e.argv[0] === 'mmdc' ? 'Error: Parse error on line 2\nmore' : '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...REPLY('```mermaid\ngraph LR\n  A-->\n```'), surface: 'terminal' })
  let why = await ui.find({ type: 'Text', text: /^Diagram:/ })
  for (let tries = 0; why === undefined && tries < 50; tries += 1) {
    await Promise.resolve()
    why = await ui.find({ type: 'Text', text: /^Diagram:/ })
  }
  expect(why?.text).toBe('Diagram: Error: Parse error on line 2')
  expect((await ui.find({ type: 'Markdown' }))?.props.text).toBe('```mermaid\ngraph LR\n  A-->\n```')
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  await ui.unmount()
})
