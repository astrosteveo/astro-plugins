import type { AgentSpawnInput, On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, test } from 'claude-code/testing'
import { prose, report, scan } from '../hooks/scan'
import { parseStyle, withRules } from '../hooks/style'

const STYLE = '---\nname: Plain English\ndescription: Plain words\nkeep-coding-instructions: true\n---\n\n# Plain English\n\nWrite plainly.\n'

type World = {
  style?: string
  home?: string
  files: Map<string, string>
  verdict: 'allow' | 'ask' | 'deny'
  spawned: AgentSpawnInput[]
  registered: string[]
}

const world = (over: Partial<World> = {}): World => ({
  style: STYLE,
  home: '/home/u',
  files: new Map(),
  verdict: 'allow',
  spawned: [],
  registered: [],
  ...over,
})

// Each hook stands for the engine beneath the plugin.
function engine(on: On, w: World) {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/work' }))
  on('env.get', () => ({ value: w.home }))
  on('tool.check', () => ({ decision: w.verdict }))
  on('tool.register', (_, e) => {
    w.registered.push(e.name)
    return { value: { tool: `mcp__plain-english__${e.name}` } }
  })
  on('fs.read', (_, e) => {
    const path = String(e.path)
    const text = path.endsWith('/output-styles/plain-english.md') ? w.style : w.files.get(path)
    if (text === undefined) throw new Error(`ENOENT: ${path}`)
    return { value: text }
  })
  on('agent.spawn', (_, e) => {
    w.spawned.push(e)
    return { model: 'claude-opus-5-5', agentId: `a${w.spawned.length}` }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
}

const SPAWN: AgentSpawnInput = {
  tool_use_id: 'toolu_1',
  prompt: 'Find the login handler.',
  description: 'find handler',
  subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  background: false,
  fork: false,
}

const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
const SCAN = 'mcp__plain-english__scan'
// The kit's types for `$.tool.call` do not know the mod's own tool.
const call = ($: Engine, input: Record<string, unknown>) =>
  ($.tool as any).call({ tool: SCAN, ...input }) as Promise<{ result?: string; text?: string; deny?: string; isError?: boolean }>
const answer = (r: { result?: string; text?: string; deny?: string }) => r.result ?? r.deny ?? r.text ?? ''

// The spawn hook

test('a subagent gets the rules whole after its task', async ($, on) => {
  const w = world()
  engine(on, w)
  await $.agent.spawn(SPAWN)
  const prompt = w.spawned[0]!.prompt
  expect(prompt.startsWith('Find the login handler.\n\n<plain-english>\n')).toBe(true)
  expect(prompt).toContain('chose the Plain English output style')
  expect(prompt).toContain('# Plain English\n\nWrite plainly.')
  expect(prompt).not.toContain('keep-coding-instructions')
  expect(prompt.endsWith('</plain-english>')).toBe(true)
})

test('a fork, which shares the style already, gets a pointer to it', async ($, on) => {
  const w = world()
  engine(on, w)
  await $.agent.spawn({ ...SPAWN, subagentType: 'fork', fork: true })
  const prompt = w.spawned[0]!.prompt
  expect(prompt).toContain('The Plain English output style in your context applies to everything you write')
  expect(prompt).not.toContain('Write plainly.')
})

for (const [why, over] of [
  ['the style file is missing', { style: undefined }],
  ['the style file has no frontmatter', { style: '# Plain English\n\nWrite plainly.\n' }],
] as const)
  test(`when ${why}, the prompt is left as it was`, async ($, on) => {
    const w = world(over)
    engine(on, w)
    await $.agent.spawn(SPAWN)
    expect(w.spawned[0]!.prompt).toBe(SPAWN.prompt)
  })

test('a resumed run and a prompt that holds the rules already are left as they were', async ($, on) => {
  const w = world()
  engine(on, w)
  await $.agent.spawn({ ...SPAWN, prompt: 'Go on.', resume: { agentId: 'a9' } })
  const once = withRules(SPAWN.prompt, 'Write plainly.', false)
  await $.agent.spawn({ ...SPAWN, prompt: once })
  expect(w.spawned.map(s => s.prompt)).toEqual(['Go on.', once])
})

test('a prompt that only mentions the tag still gets the rules', async ($, on) => {
  const w = world()
  engine(on, w)
  await $.agent.spawn({ ...SPAWN, prompt: 'Review style.ts, which wraps the rules in <plain-english>.' })
  expect(w.spawned[0]!.prompt).toContain('Write plainly.')
})

test('a workflow agent and a nested subagent get the rules too', async ($, on) => {
  const w = world()
  engine(on, w)
  await $.agent.spawn({ ...SPAWN, workflow: { runId: 'wf_abc123', agentIndex: 1 } })
  await $.agent.spawn({ ...SPAWN, parentAgentId: 'a1' })
  expect(w.spawned.every(s => s.prompt.includes('Write plainly.'))).toBe(true)
})

test('the style is parsed from its own frontmatter', () => {
  expect(parseStyle(STYLE)).toEqual({ name: 'Plain English', body: '# Plain English\n\nWrite plainly.' })
  expect(parseStyle('---\nname: "Plain English"\n---\nBody')).toEqual({ name: 'Plain English', body: 'Body' })
  expect(parseStyle('---\ndescription: x\n---\nBody')).toBeUndefined()
})

// The scan tool

test('the scan tool is registered at the start', async ($, on) => {
  const w = world()
  engine(on, w)
  await $.session.start(START)
  expect(w.registered).toEqual(['scan'])
})

test('a file the person may read is scanned, by a path relative to the working directory', async ($, on) => {
  const w = world({ files: new Map([['/work/README.md', 'We delve into it.\n']]) })
  engine(on, w)
  await $.session.start(START)
  const out = answer(await call($, { path: 'README.md' }))
  expect(out).toContain('README.md: 1 to rewrite, 0 to check.')
  expect(out).toContain('1:4     "delve"')
})

test('a path under ~ is read from the home folder', async ($, on) => {
  const w = world({ files: new Map([['/home/u/notes.md', 'Fine words.\n']]) })
  engine(on, w)
  await $.session.start(START)
  expect(answer(await call($, { path: '~/notes.md' }))).toContain('No Claudisms found in ~/notes.md.')
})

test('with HOME unset, a path under ~ is refused, not read from /', async ($, on) => {
  const w = world({ home: undefined, files: new Map([['/notes.md', 'We delve.\n']]) })
  engine(on, w)
  await $.session.start(START)
  const out = await call($, { path: '~/notes.md' })
  expect(out.deny ?? out.text).toContain('HOME is not set')
})

for (const verdict of ['ask', 'deny'] as const)
  test(`a file the person's rules ${verdict === 'ask' ? 'would ask about' : 'deny'} is not read`, async ($, on) => {
    const w = world({ verdict, files: new Map([['/etc/secret.md', 'delve']]) })
    engine(on, w)
    await $.session.start(START)
    const out = await call($, { path: '/etc/secret.md' })
    expect(out.deny ?? out.text).toContain('Read it with the Read tool')
  })

test('text is scanned as given, and a path with text is refused', async ($, on) => {
  const w = world()
  engine(on, w)
  await $.session.start(START)
  expect(answer(await call($, { text: 'Let us leverage it.' }))).toContain('"leverage"')
  const both = await call($, { path: 'a.md', text: 'x' })
  expect(both.deny ?? both.text).toContain('not both')
})

test('with nothing given, the main thread\'s last answer is scanned, never a subagent\'s', async ($, on) => {
  const w = world()
  engine(on, w)
  await $.session.start(START)
  const none = await call($, {})
  expect(none.deny ?? none.text).toContain('no earlier reply')
  const turn = { durationMs: 1, isAborted: false, reason: 'answer' } as const
  await $.turn.complete({ ...turn, turnId: 't1', answer: 'Great question. It is robust.' })
  await $.turn.complete({ ...turn, turnId: 't2', answer: 'A subagent delves.', agentId: 'a1' })
  const out = answer(await call($, {}))
  expect(out).toContain('your last reply: 2 to rewrite')
  expect(out).not.toContain('delves')
})

test('a turn that ran a scan stores no reply, so a second scan reads the same reply, not the report', async ($, on) => {
  const w = world()
  engine(on, w)
  await $.session.start(START)
  const turn = { durationMs: 1, isAborted: false, reason: 'answer' } as const
  await $.turn.complete({ ...turn, turnId: 't1', answer: 'We delve.' })
  await call($, {})
  await $.turn.complete({ ...turn, turnId: 't2', answer: 'Rewrite: "robust" at 1:4.' })
  const again = answer(await call($, {}))
  expect(again).toContain('"delve"')
  expect(again).not.toContain('robust')
  // A turn with no scan in it stores its answer again.
  await $.turn.complete({ ...turn, turnId: 't3', answer: 'It is seamless.' })
  await $.turn.complete({ ...turn, turnId: 't4', answer: 'It is seamless.' })
  expect(answer(await call($, {}))).toContain('"seamless"')
})

test('a subagent with nothing given is refused the main thread\'s reply', async ($, on) => {
  const w = world()
  engine(on, w)
  await $.session.start(START)
  await $.turn.complete({ durationMs: 1, isAborted: false, reason: 'answer', turnId: 't1', answer: 'It is robust.' })
  const out = await call($, { agentId: 'a1' })
  expect(out.deny ?? out.text).toContain('pass your draft as text')
})

// The scanner

const found = (text: string) => scan(text).map(h => `${h.tier} ${h.text}`)

test('em dashes and emoji are flagged; text symbols are not', () => {
  expect(found('Fast — and small.')).toEqual(['rewrite —'])
  expect(found('Shipped 🚀 and ✅ done.')).toEqual(['rewrite 🚀', 'rewrite ✅'])
  expect(found('Watch out ⚠️ here.')).toEqual(['rewrite ⚠️'])
  expect(found('© 2026 Acme™. Press ▶ or ↔ to move. ✔ passed.')).toEqual([])
  expect(found('Press ▶️ now.')).toEqual(['rewrite ▶️'])
})

test('code, quotes, URLs, link targets, tags and frontmatter are not prose', () => {
  const text = [
    '---',
    'title: We delve',
    '---',
    'Run `leverage --robust` first.',
    '```',
    'const delve = "robust — seamless"',
    '```',
    '> A quote can delve.',
    'See https://example.com/delve and [the docs](https://x.io/robust).',
    '<plain-english>',
  ].join('\n')
  expect(scan(text)).toEqual([])
  expect(prose('a `b` c')[0]).toBe('a     c')
})

test('a fence closes only on its own kind and length', () => {
  expect(found('````\n```\ndelve\n```\n````\nrobust')).toEqual(['rewrite robust'])
  expect(found('~~~\ndelve\n```\nmore\n~~~\nseamless')).toEqual(['rewrite seamless'])
})

test('literal uses are only checked, and rewrites win over checks on the same words', () => {
  const hits = scan('The config lives in ~/.claude, and that is real.')
  expect(hits.map(h => h.tier)).toEqual(['check', 'check'])
  expect(found('It is worth noting this.')).toEqual(['rewrite It is worth noting'])
})

test('"honest" on its own is checked; its set phrases are rewritten once', () => {
  expect(found('Words with honest literal uses.')).toEqual(['check honest'])
  expect(found('Here is the honest version.')).toEqual(['rewrite the honest version'])
  expect(found('Honestly, it works.')).toEqual(['rewrite Honestly'])
})

test('negative parallelism and staccato negation are flagged', () => {
  expect(found("It's not just a tool, it's a habit.")[0]).toMatch(/^rewrite It's not just/)
  expect(found('Not only fast but small.')[0]).toMatch(/^rewrite Not only/)
  expect(found('No setup. No config. Just run it.')[0]).toMatch(/^rewrite No setup/)
})

test('forms a word list misses: rules, bold-term lists, stacked dashes, staccato runs', () => {
  expect(found('Intro.\n\n---\n\nMore.')).toEqual(['check ---'])
  expect(found('Title\n---')).toEqual([])
  expect(found('- **Speed**: it is fast.')).toEqual(['check **Speed**:'])
  expect(found('- **Speed:** it is fast.')).toEqual(['check **Speed:**'])
  expect(found('- **Speed.** It is fast.')).toEqual(['check **Speed.**'])
  expect(found('1. *Speed*: it is fast.')).toEqual(['check *Speed*:'])
  expect(found('- __Speed__ - it is fast.')).toEqual(['check __Speed__ -'])
  expect(found('- **Never** run it twice.')).toEqual([])
  expect(found('It ran - slowly - and then it stopped.')).toEqual(['check  - '])
  expect(found('It broke. We looked. We fixed it. It works. Then we wrote a long note about why it broke.')).toEqual([
    'check It broke.',
  ])
  expect(found('Short one. Another one. And a long sentence that goes on for a good while here.')).toEqual([])
})

test('columns count from 1, on the line the words are on', () => {
  expect(scan('Fine.\n  We delve.').map(h => [h.line, h.column])).toEqual([[2, 6]])
  expect(scan('- Go. Run. Stop. Now.').map(h => [h.column, h.text])).toEqual([[3, 'Go.']])
})

test('a word or dash inside a longer form does not hide the form', () => {
  expect(found("It's not just a tool — it's a habit.")).toEqual(["rewrite It's not just a tool — it's", 'rewrite —'])
  expect(found("It's not just robust, it's fast.")).toEqual(["rewrite It's not just robust, it's", 'rewrite robust'])
  expect(found('Not only robust but fast.')).toEqual(['rewrite Not only robust but', 'rewrite robust'])
  expect(found('We delve. It works. Go now. Fine.')).toEqual(['check We delve.', 'rewrite delve'])
  expect(found('- **Speed** — it is fast.')).toEqual(['check **Speed** —', 'rewrite —'])
})

test('emoji drawn as emoji by default are flagged, whole', () => {
  expect(found('Waiting ⏳ and ⌛ and ◾ here.')).toEqual(['rewrite ⏳', 'rewrite ⌛', 'rewrite ◾'])
  expect(found('Team 👨‍💻 coded. Thumbs 👍🏽 up.')).toEqual(['rewrite 👨‍💻', 'rewrite 👍🏽'])
})

test('a rule at the top is prose, and a fence in a list item is code', () => {
  expect(found('---\nNot frontmatter, a rule.\n\nWe delve.')).toEqual(['check ---', 'rewrite delve'])
  expect(found('---\nWe delve.\n---')).toContain('rewrite delve')
  expect(found('1. Step\n\n    ```\n    const delve = 1\n    ```\n')).toEqual([])
})

test('a line that opens with backticks and closes them is inline code, not a fence that eats the rest', () => {
  expect(found('```js``` is inline.\n\nWe delve into it.\n\nIt is robust.')).toEqual(['rewrite delve', 'rewrite robust'])
  expect(found('```js\nconst delve = 1\n```\nIt is robust.')).toEqual(['rewrite robust'])
})

test('frontmatter holds only YAML; a rule, a "Note:" line and prose up to a later rule are prose', () => {
  const hits = scan('---\nNote: we delve here.\n\nMore delve.\n\n---\nEnd delve.').filter(h => h.tier === 'rewrite')
  expect(hits.map(h => h.line)).toEqual([2, 4, 7])
  expect(found('---\ntitle: A\ntags:\n  - x\n- y\n\nsummary: we delve\n---\nIt is robust.')).toEqual(['rewrite robust'])
})

test('a phrase broken across the wrapped lines of a paragraph is found, on the line it starts', () => {
  expect(found('It is worth\nnoting that this is robust.')).toEqual(['rewrite It is worth noting', 'rewrite robust'])
  expect(found('This is well worth\nthe effort.')).toEqual(['rewrite worth '])
  expect(found('- It is not only fast\n  but small.')[0]).toBe('rewrite not only fast but')
  expect(scan('Fine.\nIt is not just a tool,\nit is a habit.').map(h => [h.line, h.column])).toEqual([[2, 1]])
  expect(found('It broke.\nWe looked.\nWe fixed it.\nIt works.')).toEqual(['check It broke.'])
})

test('no phrase runs from one paragraph, list item or heading into the next', () => {
  expect(found('It is not only fast\n\nbut small.')).toEqual([])
  expect(found('- It is not only fast\n- but small.')).toEqual([])
  expect(found('# At the end\nof the day')).toEqual([])
})

test('indented code and HTML comments are not prose; an indented paragraph in a list is', () => {
  expect(found('Text.\n\n    const robust = leverage()\n')).toEqual([])
  expect(found('<!-- we delve -->')).toEqual([])
  expect(found('<!--\nwe delve\n-->\nIt is robust.')).toEqual(['rewrite robust'])
  expect(found('Run `<!--` first. It is robust.')).toEqual(['rewrite robust'])
  expect(found('1. Step\n\n    It is robust.')).toEqual(['rewrite robust'])
  expect(found('Para\n    robust continued.')).toEqual(['rewrite robust'])
})

test('"worth" as a value is left alone; "worth it" is still rewritten', () => {
  expect(found('The house is worth more than the car. Is it worth less?')).toEqual([])
  expect(found('Is it worth it?')).toEqual(['rewrite worth '])
})

test('symbols drawn as text are left alone; flags and keycaps are emoji', () => {
  expect(found('Press ➡ or ⬆ to move. ❤ ⚠ ☑')).toEqual([])
  expect(found('Made in 🇺🇸 and step 1️⃣ done.')).toEqual(['rewrite 🇺🇸', 'rewrite 1️⃣'])
  expect(found('Love ❤️ it.')).toEqual(['rewrite ❤️'])
})

test('columns count characters, so an emoji takes one', () => {
  expect(scan('🚀 We delve.').map(h => [h.text, h.column])).toEqual([['🚀', 1], ['delve', 6]])
  expect(scan('👨‍💻 We delve.').map(h => h.column)).toEqual([1, 8])
})

test('a large file with many hits is scanned well inside the hook budget', () => {
  const text = 'We delve into a robust, seamless realm at its core.\n\n'.repeat(15_000)
  const begun = Date.now()
  const hits = scan(text)
  expect(hits.length).toBe(15_000 * 5)
  expect(Date.now() - begun).toBeLessThan(4_000)
})

test('a form shows the words as written, inline code included', () => {
  expect(found('Run `x`. Done. Ok. Go.')).toEqual(['check Run `x`.'])
})

test('a report lists rewrites first and says what it cannot see', () => {
  const out = report('a.md', scan('The real point. We delve.'))
  expect(out.indexOf('Rewrite:')).toBeLessThan(out.indexOf('Check'))
  expect(out).toContain('Read the text yourself')
  expect(report('b.md', [])).toContain('No Claudisms found in b.md.')
})

test('a long report is cut with a count of the rest', () => {
  const out = report('long.md', scan('We delve.\n\n'.repeat(200)))
  expect(out).toContain('200 to rewrite')
  expect(out).toContain('...and 50 more.')
})
