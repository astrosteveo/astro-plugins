import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { across, blowUp, errorLines, fromHex, literal, markArgs, markCells, measured, overlaps, wrap, nameOf, page, sheetArgs, sniff, svgSize } from '../hooks/design'
import { hashOf, splitMermaid } from '../hooks/mermaid'
import { briefNote, briefPlan, briefShow, cardWidth, fit, markScope, markText, pickText, readMarks } from '../hooks/register'

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

// What reached the engine as sent prompts, in order.
const SENT: string[] = []

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
  on('prompt.submit', (_, e) => {
    SENT.push(e.text)

    return { text: e.text }
  })
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

test('a note without text is refused', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ran = await $.tool.call({ tool: 'mcp__show-work__note', kind: 'risk', text: ' ' })
  expect(ran.deny).toBe('A note needs text.')
})

test('changes list the edited files and nothing else', async ($, on) => {
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
    expect((await ui.find({ type: 'Text', text: /idle/ }))?.text).toBe('○ idle')
    await ui.press({ key: 'tab-changes' })
    expect(await ui.find({ type: 'Button', key: 'file-scripts/pause.gd' })).toBeDefined()
    // Reads and commands are not Changes' business.
    expect(await ui.find({ type: 'Text', text: /main\.tscn/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Run the tests/ })).toBeUndefined()
    await ui.press({ key: 'tab-now' })
    await ui.unmount()
  }
})

test('repeated edits of a file make one chip', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const edit = { tool: 'Edit', file_path: '/proj/scripts/pause.gd', old_string: 'a', new_string: 'b' } as const
  await $.tool.call(edit)
  await $.tool.call({ tool: 'Read', file_path: '/proj/scenes/main.tscn' })
  await $.tool.call(edit)
  await $.tool.call(edit)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-changes' })
  expect((await ui.findAll({ type: 'Button', text: /\.gd$/ })).map(one => one.text)).toEqual(['scripts/pause.gd'])
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

test('a brief plan input counts its steps, and a brief note input sizes its reasons', () => {
  expect(
    briefPlan({
      goal: 'Ship it',
      steps: [
        { text: 'Build', status: 'done' },
        { text: 'Film the scene', status: 'doing' },
        { text: 'Review', status: 'todo' },
      ],
    }),
  ).toEqual({ goal: 'Ship it', steps: '1/3 done, doing: Film the scene' })
  expect(briefPlan({ goal: 'x', steps: [{ text: 'a', status: 'done' }] })).toEqual({ goal: 'x', steps: '1/1 done' })
  expect(briefPlan(undefined)).toEqual({ goal: undefined, steps: '0/0 done' })
  expect(briefNote({ kind: 'decision', text: 'Use X.', why: 'Because.', detail: 'Longer.' })).toEqual({
    kind: 'decision',
    text: 'Use X.',
    why: '8 characters',
    detail: '7 characters',
  })
})

test('pressing a tile of a sheet starts the prompt with the pick',async ($, on) => {
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

test('smaller spots sit on top, and nothing is laid over the picture', async ($, on) => {
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
  // kitty leaves a revealed picture drawn once the chat scrolls, so no lit
  // copies are made or laid over it.
  expect(ran.some(argv => argv.some(arg => arg.includes('-lit-')))).toBe(false)

  const chat = await $.ui.mount({ ...RESULT('toolu_l1'), surface: 'terminal' })
  const picture = await chat.find({ type: 'Box', key: 'pic-toolu_l1' })
  expect(JSON.stringify(picture).match(/"type":"Image"/g)).toHaveLength(1)
  const tree = JSON.stringify(picture)
  expect(tree.indexOf('spot-toolu_l1-1')).toBeLessThan(tree.indexOf('spot-toolu_l1-2'))
  await chat.unmount()
})

test("a card is as wide as its longest line, so a revealed detail never widens it", () => {
  const picture = { marks: [{ x: 0, y: 0, note: 'Short', detail: 'A detail that runs longer than the note.' }] }
  expect(cardWidth(picture, 100)).toBe('A detail that runs longer than the note.'.length + 4)
  expect(cardWidth(picture, 30)).toBe(30)
  expect(cardWidth({ tiles: ['Logo', 'Bug page'] }, 100)).toBe('Pick: [ A Logo ] [ B Bug page ]'.length + 4)
})

test('overlapping marks are found, and details wrap to the card', () => {
  const size = { width: 1280, height: 600 }
  const marks = [
    { x: 665, y: 250, w: 360, h: 75, note: 'a' },
    { x: 1200, y: 180, w: 78, h: 168, note: 'c' },
    { x: 1060, y: 308, w: 200, h: 272, note: 'd' },
  ]
  expect(overlaps(marks, size)).toEqual([[2, 3]])
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

test("pictures are sized to the terminal's real cell shape, read once at the start", async ($, on) => {
  engine(on)
  const { ran } = host(on, { answer: argv => (argv[0] === 'python3' ? { stdout: '2.5\n' } : undefined) })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  expect(ran.filter(argv => argv[0] === 'python3')).toHaveLength(1)
  await $.tool.call({ tool: 'mcp__show-work__show', tool_use_id: 'toolu_t1', caption: 'Wide', path: '/proj/w.png' })
  const chat = await $.ui.mount({ ...RESULT('toolu_t1'), surface: 'terminal' })
  // 1600x900 across 80 columns of cells 2.5 times taller than wide: 18 rows.
  expect((await chat.find({ type: 'Image' }))?.props).toMatchObject({ columns: 80, rows: 18 })
  await chat.unmount()
  expect(fit({ width: 1600, height: 900 }, 100, 40, 2.5)).toEqual({ columns: 100, rows: 23 })
  expect(fit({ width: 390, height: 844 }, 100, 40, 2.5)).toEqual({ columns: 46, rows: 40 })
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
  expect((await ui.find({ type: 'Button', key: 'tab-pictures' }))?.text).toBe('Pictures')
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

const DIFF = `diff --git a/src/menu.gd b/src/menu.gd
--- a/src/menu.gd
+++ b/src/menu.gd
@@ -1,2 +1,2 @@
 extends Control
-var open = false
+var is_open := false
`

test('Changes opens on the latest edit, colored, and a chip shows its diff', async ($, on) => {
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
  await ui.press({ key: 'tab-changes' })
  // The latest edit's diff is already open; pressing its chip loads it again.
  expect(await ui.find({ type: 'Code', in: 'viewer-diff' })).toBeDefined()
  await ui.press({ key: 'file-src/menu.gd' })
  expect(asked.at(-1)).toEqual(['git', '-C', '/proj/src', 'diff', '--no-color', 'HEAD', '--', '/proj/src/menu.gd'])
  // The hunks go to Code as a diff, which highlights them; the headers do not.
  const code = await ui.find({ type: 'Code', in: 'viewer-diff' })
  expect(code?.props).toMatchObject({ format: 'diff', path: 'src/menu.gd' })
  expect(code?.props.source).toBe('@@ -1,2 +1,2 @@\n extends Control\n-var open = false\n+var is_open := false')
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
  await ui.press({ key: 'tab-changes' })
  await ui.press({ key: 'file-new.txt' })
  expect((await ui.find({ type: 'Code', in: 'viewer-diff' }))?.props.source).toBe('@@ -0,0 +1 @@\n+hello')
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

import { askDiffText, askText, duration, expandRefs, joinPath, markerRuns } from '../hooks/register'
import { blockAt, hitItems, hitRowText, hitsQuote, mdBlocks, locateDiffRows, locateSelection, splitFences } from '../hooks/explorer'
import { gutterWidth, lineAtRow, lineRows, rowOf, rowsIn, shownRows } from '../hooks/lines'
import {
  base64,
  patchCounts,
  shareBar,
  glyphs,
  parseTests,
  pulse,
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

test('durations read plainly, and a path joins with its dots resolved', () => {
  expect([duration(38_000), duration(252_000), duration(60_000)]).toEqual(['38s', '4m12s', '1m00s'])
  expect(joinPath('/proj/docs', '../img/a.png')).toBe('/proj/img/a.png')
  expect(joinPath('/proj/docs', './b.md')).toBe('/proj/docs/b.md')
  expect(joinPath('/proj/docs', '/abs/c.md')).toBe('/abs/c.md')
})

test('labels a Raster cannot draw turn to ?', () => {
  expect(String.fromCharCode(...glyphs('fix 🐛 バグ ↳'))).toBe('fix ? ?? ↳')
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

const BUN_OUT = (jump: boolean) =>
  `(pass) dash [1ms]\n(${jump ? 'pass' : 'fail'}) jump [2ms]\n\n ${jump ? 2 : 1} pass\n ${jump ? 0 : 1} fail\n`

test('test commands land on the Tests tab as runs', async ($, on) => {
  let jump = true
  const filled = engine(on, {
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
    expect(await ui.find({ type: 'Button', key: 'tests-fix' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^✓\s+2 pass/ })).toBeDefined()
    await ui.press({ key: 'tests-fix' })
    expect(filled.at(-1)).toMatch(/^Fix the failing tests from `bun test`/)
    await ui.press({ key: 'tab-now' })
    await ui.unmount()
  }
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
  expect(decode(bar?.props.cells as string, bar?.props.columns as number, 1).lines[0]).toMatch(/^\+2 −1 █+$/)
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
      expect(decode(bar?.props.cells as string, bar?.props.columns as number, 1).lines[0]).toMatch(/^✗ 1 pass 1 fail █+$/)
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
  on('clock.every', () => ({ value: undefined }))
  on('session.usage', () => ({ value: USAGE as never }))
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
  await ui.press({ key: 'tab-find' })
  expect((await ui.find({ type: 'Button', key: 'tab-find' }))?.text).toBe('find')
  expect((await ui.find({ type: 'Text', text: /files/ }))?.text).toBe('5 files · 1 changed')
  await ui.press({ key: 'ex-hooks' })
  expect((await ui.find({ type: 'Button', key: 'ex-hooks/register.tsx' }))?.text).toBe('    register.tsx M')

  await ui.input({ key: 'ex-filter', text: 'chts', kind: 'change' })
  expect((await ui.findAll({ type: 'Button', text: /charts/ })).map(one => one.key)).toEqual(['ex-hooks/charts.ts'])
  await ui.input({ key: 'ex-filter', text: 'reg', kind: 'submit' })
  const code = await ui.find({ type: 'Code', in: 'viewer-source' })
  expect(code?.props).toMatchObject({ path: 'hooks/register.tsx', startLine: 1 })
  expect(code?.props.source).toMatch(/^export const register = 1/)
  expect(await ui.find({ type: 'Button', key: 'ex-diff' })).toBeDefined()
  await ui.press({ key: 'ex-mention' })
  expect(filled).toEqual(['@hooks/register.tsx '])
  await ui.press({ key: 'ex-close' })
  expect(await ui.find({ type: 'Client', key: 'viewer-source' })).toBeUndefined()
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
  await ui.press({ key: 'tab-find' })
  await ui.press({ key: 'find-text' })
  await ui.input({ key: 'search-q', text: 'jump', kind: 'submit' })
  expect((await ui.find({ type: 'Text', text: /hits in/ }))?.text).toBe('3 hits in 2 files')
  // The results are a list the pointer drags over; a click on a hit posts it open.
  expect(await ui.find({ type: 'Client', key: 'search-hits' })).toBeDefined()
  await ui.post({ open: 'hooks/a.ts', line: 42 }, { in: 'search-hits' })
  const code = await ui.find({ type: 'Code', in: 'viewer-source' })
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

test('a markdown file previews as markdown, with a button for its source', async ($, on) => {
  engine(on)
  on('process.run', (_, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv.includes('ls-files') ? 'README.md\nsrc/a.ts\n' : '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('fs.read', () => ({ value: '# Title\n\nSee [the guide](docs/guide.md) and [the web](https://example.com).\n' }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-find' })
  await ui.press({ key: 'ex-README.md' })
  const md = await ui.find({ type: 'Markdown', in: 'md-block-0' })
  expect(md?.props.text).toMatch(/^# Title/)
  // A block cannot answer a link, so the file's local links are buttons below it.
  expect((await ui.find({ type: 'Button', key: 'md-link-docs/guide.md' }))?.text).toBe('→ docs/guide.md')
  expect(await ui.find({ type: 'Button', key: 'md-link-https://example.com' })).toBeUndefined()
  expect(await ui.find({ type: 'Client', key: 'viewer-source' })).toBeUndefined()
  await ui.press({ key: 'ex-raw' })
  expect(await ui.find({ type: 'Client', key: 'md-block-0' })).toBeUndefined()
  expect((await ui.find({ type: 'Code', in: 'viewer-source' }))?.props.source).toMatch(/^# Title/)
  expect((await ui.find({ type: 'Button', key: 'ex-raw' }))?.text).toBe('rendered')
  await ui.unmount()
})

test('a selection is found in its file by lines, with or without the gutter, and quoted whole', () => {
  const source = 'import x\n\nexport function add() {\n  return a + b\n}\n'
  // A partial line quotes the whole line.
  expect(locateSelection(source, 'function add() {\n  return')).toEqual({
    from: 3,
    to: 4,
    text: 'export function add() {\n  return a + b',
  })
  // The gutter's numbers come off.
  expect(locateSelection(source, ' 3 export function add() {\n 4   return a + b')).toMatchObject({ from: 3, to: 4 })
  // Rendered text that is not in the source is quoted as it is, with no lines.
  expect(locateSelection('# Title\n\nSome **bold** words here.\n', 'Title\n\nSome bold words here.')).toEqual({
    from: undefined,
    to: undefined,
    text: 'Title\n\nSome bold words here.',
  })
  expect(locateSelection('# Title\n\nSome **bold** words here.\n', 'Title')).toMatchObject({ from: 1, to: 1 })
  expect(locateSelection(source, '   \n')).toBeUndefined()
  expect(locateSelection(source, 'nowhere to be found')).toEqual({ from: undefined, to: undefined, text: 'nowhere to be found' })
})

test('the prompt starts with the file, its lines and the quoted text', () => {
  expect(askText('src/a.ts', { from: 3, to: 4, text: 'a\nb' })).toBe('About `src/a.ts`, lines 3 to 4:\n```ts\na\nb\n```\n')
  expect(askText('README.md', { from: 7, to: 7, text: 'x' })).toBe('About `README.md`, line 7:\n```md\nx\n```\n')
  expect(askText('a.md', { from: undefined, to: undefined, text: 'has ``` inside' })).toContain('````md')
})

test('pressing ask puts the selected lines in the prompt, or says what to do', async ($, on) => {
  const filled = engine(on)
  const toasts: string[] = []
  let picked: { text: string } | undefined
  on('process.run', (_, e) => ({
    value: { exitCode: 0, stdout: e.argv.includes('ls-files') ? 'a.ts\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('fs.read', () => ({ value: 'one\ntwo\nthree\n' }))
  on('ui.selection', () => ({ value: picked }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-find' })
  await ui.press({ key: 'ex-a.ts' })
  await ui.press({ key: 'ex-ask' })
  expect(filled).toEqual([])
  expect(toasts).toHaveLength(1)
  picked = { text: 'two' }
  await ui.press({ key: 'ex-ask' })
  expect(filled).toEqual(['[a.ts line 2] '])
  await ui.unmount()
})

test('markdown splits into prose and fenced code, and a diff pick finds its rows', () => {
  expect(splitFences('Intro\n\n```ts\nconst a = 1\n```\n\nOutro\n')).toEqual([
    { text: 'Intro\n\n' },
    { code: 'const a = 1', lang: 'ts' },
    { text: '\n\nOutro\n' },
  ])
  expect(splitFences('no fences here')).toEqual([{ text: 'no fences here' }])
  expect(splitFences('````md\n```\nnested\n```\n````\n')[0]).toEqual({ code: '```\nnested\n```', lang: 'md' })
  const rows = ['-old line one', '+new line one', ' same', '+added']
  // Whole rows come back with their markers, though the pick had none.
  expect(locateDiffRows(rows, 'line one\nnew line')).toBe('-old line one\n+new line one')
  expect(locateDiffRows(rows, 'same')).toBe(' same')
  expect(locateDiffRows(rows, 'nowhere')).toBeUndefined()
  expect(askDiffText('src/a.ts', '-a\n+b')).toBe('About my change to `src/a.ts`:\n```diff\n-a\n+b\n```\n')
})

test('the wrap button turns wrapping off and on in the preview and the diff', async ($, on) => {
  engine(on)
  on('process.run', (_, e) => ({
    value: { exitCode: 0, stdout: e.argv.includes('ls-files') ? 'a.ts\n' : e.argv.includes('HEAD') ? DIFF : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('fs.read', () => ({ value: 'one\ntwo\n' }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: '/proj/a.ts', old_string: 'a', new_string: 'b' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-find' })
  await ui.press({ key: 'ex-a.ts' })
  expect((await ui.find({ type: 'Code', in: 'viewer-source' }))?.props.wrap).toBe('wrap')
  expect((await ui.find({ type: 'Button', key: 'ex-wrap' }))?.text).toBe('wrap: on')
  await ui.press({ key: 'ex-wrap' })
  expect((await ui.find({ type: 'Code', in: 'viewer-source' }))?.props.wrap).toBe('truncate-end')
  expect((await ui.find({ type: 'Button', key: 'ex-wrap' }))?.text).toBe('wrap: off')
  await ui.press({ key: 'tab-changes' })
  expect((await ui.find({ type: 'Code', in: 'viewer-diff' }))?.props.wrap).toBe('truncate-end')
  await ui.press({ key: 'diff-wrap' })
  expect((await ui.find({ type: 'Code', in: 'viewer-diff' }))?.props.wrap).toBe('wrap')
  await ui.unmount()
})

test('a markdown fence draws as highlighted code between prose', async ($, on) => {
  engine(on)
  on('process.run', (_, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv.includes('ls-files') ? 'logo.png\nREADME.md\n' : e.argv.includes('identify') ? '64 32' : '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: 'Text\n\n```ts\nconst a = 1\n```\n' }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-find' })
  await ui.press({ key: 'ex-README.md' })
  const code = await ui.find({ type: 'Code', in: 'md-block-1' })
  expect(code?.props).toMatchObject({ source: 'const a = 1', language: 'ts' })
  expect((await ui.find({ type: 'Markdown', in: 'md-block-0' }))?.props.text).toBe('Text')
  await ui.unmount()
})

test('rows map to lines, wrapped or cut, and a diff hides its hunk headers', () => {
  const lines = ['short', 'x'.repeat(25), '']
  expect(lineRows(lines, 10, false)).toEqual([1, 1, 1])
  expect(lineRows(lines, 10, true)).toEqual([1, 3, 1])
  const rows = [1, 3, 1]
  expect([0, 1, 3, 4, 9].map(y => lineAtRow(rows, y))).toEqual([0, 1, 1, 2, 2])
  expect(rowOf(rows, 2)).toBe(4)
  expect(rowsIn(rows, 1, 2)).toBe(4)
  expect(gutterWidth(9)).toBe(2)
  expect(gutterWidth(120, true)).toBe(5)
  expect(shownRows(['@@ -1 +1 @@', '-a', '+b'])).toEqual(['-a', '+b'])
})

test('a marker is painted in the draft and swapped for its quote on send', () => {
  const list = [{ marker: '[a.ts lines 1 to 2]', text: 'About `a.ts`, lines 1 to 2:\n```ts\none\ntwo\n```\n' }]
  expect(markerRuns('see [a.ts lines 1 to 2] why', list)).toEqual([
    { start: 4, end: 23, color: 'claude', underline: true },
  ])
  expect(markerRuns('no marker', list)).toEqual([])
  // The quote takes lines of its own, and the words around it stay.
  expect(expandRefs('Why [a.ts lines 1 to 2] ?', list)).toEqual({
    text: 'Why\nAbout `a.ts`, lines 1 to 2:\n```ts\none\ntwo\n```\n?',
    used: ['[a.ts lines 1 to 2]'],
  })
  expect(expandRefs('[a.ts lines 1 to 2] why?', list).text).toBe('About `a.ts`, lines 1 to 2:\n```ts\none\ntwo\n```\nwhy?')
  expect(expandRefs('a marker was deleted', list)).toEqual({ text: 'a marker was deleted', used: [] })
})

test('sending a draft with the marker puts the quoted lines in the prompt', async ($, on) => {
  engine(on)
  const sent = SENT
  sent.length = 0
  on('process.run', (_, e) => ({
    value: { exitCode: 0, stdout: e.argv.includes('ls-files') ? 'a.ts\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('fs.read', () => ({ value: 'one\ntwo\nthree\n' }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-find' })
  await ui.press({ key: 'ex-a.ts' })
  await ui.post({ id: 'a.ts', from: 1, to: 1 }, { in: 'viewer-source' })
  await $.prompt.submit({ text: '[a.ts line 2] is this right?', wait: false, origin: { kind: 'composer' } })
  expect(sent).toEqual(['About `a.ts`, line 2:\n```ts\ntwo\n```\nis this right?'])
  // The reference is spent: the same marker typed again is only text.
  await $.prompt.submit({ text: '[a.ts line 2] again', wait: false, origin: { kind: 'composer' } })
  expect(sent.at(-1)).toBe('[a.ts line 2] again')
  await ui.unmount()
})

test('letting go of a drag puts a marker in the prompt, and a later drag takes its place', async ($, on) => {
  const filled = engine(on)
  let draft = { text: '', cursor: 0 }
  on('prompt.read', () => ({ value: draft }))
  on('process.run', (_, e) => ({
    value: { exitCode: 0, stdout: e.argv.includes('ls-files') ? 'a.ts\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('fs.read', () => ({ value: 'one\ntwo\nthree\n' }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-find' })
  await ui.press({ key: 'ex-a.ts' })
  expect(await ui.find({ type: 'Button', key: 'chip-clear' })).toBeUndefined()
  await ui.post({ id: 'a.ts', from: 1, to: 2 }, { in: 'viewer-source' })
  expect(filled).toEqual(['[a.ts lines 2 to 3] '])
  expect((await ui.find({ type: 'Text', text: /In your prompt/ }))?.text).toBe('In your prompt: lines 2 to 3')
  // The person types after it; the next drag swaps the marker and keeps the words.
  draft = { text: '[a.ts lines 2 to 3] why', cursor: 23 }
  await ui.post({ id: 'a.ts', from: 0, to: 0 }, { in: 'viewer-source' })
  expect(filled.at(-1)).toBe('[a.ts line 1] why')
  // Dropping it takes the marker out of the box.
  draft = { text: '[a.ts line 1] why', cursor: 17 }
  await ui.press({ key: 'chip-clear' })
  expect(filled.at(-1)).toBe(' why')
  expect(await ui.find({ type: 'Button', key: 'chip-clear' })).toBeUndefined()
  // A drag taken in another file puts nothing in the prompt.
  const before = filled.length
  await ui.post({ id: 'other.ts', from: 0, to: 0 }, { in: 'viewer-source' })
  expect(filled).toHaveLength(before)
  await ui.unmount()
})

test('search hits list by file, and a drag over them quotes the hits with their places', () => {
  const items = hitItems([
    { file: 'a.ts', line: 42, text: 'jump()' },
    { file: 'a.ts', line: 50, text: 'jump(2)' },
    { file: 'b.md', line: 3, text: 'jump here' },
  ])
  expect(items.map(hitRowText)).toEqual(['a.ts 2', '   42 jump()', '   50 jump(2)', 'b.md 1', '    3 jump here'])
  // A drag from the second row to the fourth picks two hits; the file rows add none.
  expect(hitsQuote('jump', items, 1, 3)).toEqual({
    marker: '[search "jump" 2 hits]',
    text: 'About these search hits for `jump`:\n```\na.ts:42: jump()\na.ts:50: jump(2)\n```\n',
  })
  expect(hitsQuote('jump', items, 4, 4)?.marker).toBe('[search "jump" 1 hit]')
  expect(hitsQuote('jump', items, 0, 0)).toBeUndefined()
})

test('a drag over the hit list puts a marker in the prompt', async ($, on) => {
  const filled = engine(on)
  on('process.run', (_, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv[0] === 'rg' ? 'hooks/a.ts:42:  jump()\nhooks/a.ts:50:jump(2)\n' : '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-find' })
  await ui.press({ key: 'find-text' })
  await ui.input({ key: 'search-q', text: 'jump', kind: 'submit' })
  await ui.post({ id: 'hits', from: 1, to: 2 }, { in: 'search-hits' })
  expect(filled).toEqual(['[search "jump" 2 hits] '])
  await ui.unmount()
})

test('markdown is cut into blocks with their source lines, and a drag finds the block it ends in', () => {
  const source = '# Title\n\nFirst para\nstill first\n\n```ts\nconst a = 1\n```\n\n![The banner](docs/shot.png)\n\n| a | b |\n| - | - |\n| 1 | 2 |\n'
  expect(mdBlocks(source, ['docs/shot.png'])).toEqual([
    { kind: 'md', text: '# Title', from: 0, to: 0 },
    { kind: 'md', text: 'First para\nstill first', from: 2, to: 3 },
    { kind: 'code', text: 'const a = 1', lang: 'ts', from: 5, to: 7 },
    { kind: 'image', ref: 'docs/shot.png', alt: 'The banner', from: 9, to: 9 },
    { kind: 'md', text: '| a | b |\n| - | - |\n| 1 | 2 |', from: 11, to: 13 },
  ])
  // A picture the file names but is not here stays in its prose.
  expect(mdBlocks('See ![x](nope.png) here\n', []).map(block => block.kind)).toEqual(['md'])
  // Blocks 1, 3 and 1 rows tall with a row of gap between: from block 1, rows 0 to 2 are its own,
  // row 3 is the gap and counts with the block below, and past the last block stays in it.
  const heights = [1, 3, 1]
  expect([-2, 0, 2, 3, 4, 9].map(y => blockAt(heights, 1, y))).toEqual([0, 1, 1, 2, 2, 2])
  expect(blockAt(heights, 0, -4)).toBe(0)
})

test('a drag over blocks of rendered markdown puts the whole lines in the prompt', async ($, on) => {
  const filled = engine(on)
  on('process.run', (_, e) => ({
    value: { exitCode: 0, stdout: e.argv.includes('ls-files') ? 'README.md\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('fs.read', () => ({ value: '# Title\n\nFirst para\nstill first\n\nLast para\n' }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-find' })
  await ui.press({ key: 'ex-README.md' })
  // The blocks tell the hooks how tall they drew.
  await ui.post({ file: 'README.md', index: 0, rows: 1 }, { in: 'md-block-0' })
  await ui.post({ id: 'README.md#md', from: 1, to: 2 }, { in: 'md-block-0' })
  expect(filled).toEqual(['[README.md lines 3 to 6] '])
  await ui.unmount()
})

test('notes ride above the prompt as cards: a question to answer, a decision to veto or OK', async ($, on) => {
  const filled = engine(on)
  on('ui.render', ENGINE_ROW)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'mcp__show-work__note',
    kind: 'decision',
    text: 'Use a CanvasLayer for the menu',
    why: 'It draws above the game camera',
  })
  await $.tool.call({ tool: 'mcp__show-work__note', kind: 'question', text: 'Should Esc also close the menu?' })
  await $.tool.call({ tool: 'mcp__show-work__note', kind: 'finding', text: 'The save system writes to user://' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ ...BAND(false), surface })
    // Idle, and still there: what needs an answer is not hidden. Questions come first.
    const buttons = (await band.findAll({ type: 'Button' })).map(one => one.text)
    expect(buttons).toEqual(['Answer', '✗', 'Veto', 'OK', 'Tell me more', 'Got it'])
    expect(await band.find({ type: 'Text', text: /It draws above the game camera/ })).toBeDefined()
    await band.unmount()
  }

  const band = await $.ui.mount({ ...BAND(false), surface: 'terminal' })
  const answer = await band.find({ type: 'Button', text: 'Answer' })
  await band.press({ key: answer?.key ?? '' })
  expect(filled).toEqual(['About your question "Should Esc also close the menu?": '])
  // Pressing alone is no reply; sending words after the quote is.
  expect(await band.find({ type: 'Button', text: 'Answer' })).toBeDefined()
  await $.prompt.submit({ text: `${filled[0]}Yes.`, wait: false, origin: { kind: 'composer' } })
  expect(await band.find({ type: 'Button', text: 'Answer' })).toBeUndefined()
  // Veto starts a reply; OK puts the card away without one.
  const veto = await band.find({ type: 'Button', text: 'Veto' })
  await band.press({ key: veto?.key ?? '' })
  expect(filled.at(-1)).toBe(`About your decision "Use a CanvasLayer for the menu": I'd rather `)
  const ok = await band.find({ type: 'Button', text: 'Got it' })
  await band.press({ key: ok?.key ?? '' })
  expect((await band.findAll({ type: 'Button' })).map(one => one.text)).toEqual(['Veto', 'OK'])
  await band.unmount()
})

test('Now keeps a log of the task\'s notes, opened to their reasons, and a new goal hides the old', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__show-work__plan', goal: 'First', steps: [] })
  await $.tool.call({ tool: 'mcp__show-work__note', kind: 'finding', text: 'Old news' })
  await $.tool.call({ tool: 'mcp__show-work__plan', goal: 'Second', steps: [] })
  await $.tool.call({
    tool: 'mcp__show-work__note',
    kind: 'decision',
    text: 'Fresh call',
    why: 'Because',
    detail: 'More about it.',
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', text: /Old news/ })).toBeUndefined()
  const row = await ui.find({ type: 'Button', text: /Fresh call/ })
  expect(row?.text).toBe('I chose Fresh call · veto? ▸')
  expect(await ui.find({ type: 'Text', text: /More about it/ })).toBeUndefined()
  await ui.press({ key: row?.key ?? '' })
  expect(await ui.find({ type: 'Text', text: /More about it/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /why: Because/ })).toBeDefined()
  await ui.unmount()
})

test('the tabs are Now, Pictures, Changes, Tests and Git; the search box brings up Find when focused', async ($, on) => {
  engine(on)
  on('process.run', (_, e) => ({
    value: { exitCode: 0, stdout: e.argv.includes('ls-files') ? 'a.ts\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('ui.focus', () => ({}))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const tabs = (await ui.findAll({ type: 'Button', text: /^(Now|Pictures|Changes|Tests|Git|Notes|Find)$/ })).map(one => one.text)
  expect(tabs).toEqual(['Now', 'Pictures', 'Changes', 'Tests', 'Git'])
  // Nothing of Find shows until the search box is used.
  expect(await ui.find({ type: 'Text', text: /^\d+ files/ })).toBeUndefined()
  await $.ui.focus({ component: 'Pane', requestId: 'show-work', element: 'ex-filter', origin: { kind: 'person' } } as never)
  expect((await ui.find({ type: 'Text', text: /^\d+ files/ }))?.text).toBe('1 files')
  await ui.press({ key: 'tab-now' })
  expect(await ui.find({ type: 'Text', text: /^\d+ files/ })).toBeUndefined()
  // The f hotkey lives on the box's own button, and brings Find up.
  await ui.press({ key: 'tab-find' })
  expect(await ui.find({ type: 'Text', text: /^\d+ files/ })).toBeDefined()
  await ui.unmount()
})
