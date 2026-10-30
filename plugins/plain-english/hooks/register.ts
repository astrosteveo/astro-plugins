import type { EngineInterface, Register } from 'claude-code'
import { list, problems } from './check'
import { type Piece, gh, pieces } from './gate'
import { report, scan } from './scan'
import { STYLE_FILE, hasRules, parseStyle, withRules } from './style'

const SCAN = 'mcp__plain-english__scan'

const SCAN_TOOL = {
  name: 'scan',
  description:
    'Scan prose for Claudisms: the stock words, set phrases and forms that mark machine-written text. Give a file path, or text, or neither to scan the reply that ended your last turn. To check a draft before you send it, pass the draft as text; a subagent always does. Lists each word-scan hit by line and column, as one to rewrite or one to check by eye, then the forms a model found that a word search cannot see, each with a plainer form. The word scan skips code, block quotes and URLs, but not text in quotation marks.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'A file to scan: absolute, under ~, or relative to the working directory.' },
      text: { type: 'string', description: 'Text to scan, in place of a file.' },
    },
  },
}

const LAST_REPLY = { plugin: 'plain-english', key: 'lastReply' } as const

const asText = (value: unknown) => (typeof value === 'string' ? value : '')

// The absolute path, or undefined for a path under ~ when HOME is not set.
async function resolve($: EngineInterface, path: string) {
  if (path.startsWith('/')) return path
  if (path === '~' || path.startsWith('~/')) {
    const home = await $.env.get('HOME')
    return home === undefined || home === '' ? undefined : `${home}${path.slice(1)}`
  }
  return `${await $.session.cwd()}/${path}`
}

// A file's text, read only where the person's rules let Claude read it; elsewhere the model reads
// it with Read, which asks, and passes the text.
async function readFile($: EngineInterface, path: string): Promise<{ text: string } | { deny: string }> {
  const file = await resolve($, path)
  if (file === undefined) return { deny: `HOME is not set, so ${path} has no place. Give an absolute path.` }
  const verdict = await $.tool.check({ tool: 'Read', input: { file_path: file } })
  if (verdict.decision !== 'allow')
    return { deny: `Reading ${path} is not allowed without asking. Read it with the Read tool and pass its text as text.` }
  const body = await $.fs.read(file).catch(() => undefined)
  return typeof body === 'string' ? { text: body } : { deny: `Could not read ${path} as text.` }
}

const readable = async ($: EngineInterface, path: string) => {
  const read = await readFile($, path)
  return 'text' in read ? read.text : undefined
}

async function scanFile($: EngineInterface, path: string): Promise<Answer> {
  const read = await readFile($, path)
  return 'text' in read ? { result: await judged($, path, read.text) } : read
}

// The word scan's report, and under it what the model found that the scan did not.
async function judged($: EngineInterface, source: string, text: string) {
  const base = report(source, scan(text))
  const found = (await problems($, text)).filter(p => p.fix !== undefined)
  return found.length === 0 ? base : `${base}\n\nFound by a model reading the text:\n${list(found)}`
}

const flat = (s: string) => s.replace(/\s+/g, ' ').trim()

// An Edit applied to the file's text, or undefined where the old text is not in it.
function applied(file: string, edit: { old: string; new: string; all: boolean }) {
  if (edit.old === '' || !file.includes(edit.old)) return undefined
  return edit.all ? file.split(edit.old).join(edit.new) : file.replace(edit.old, () => edit.new)
}

// A piece's text, what it replaces, and what the model reads of it. An Edit is scanned as the file
// it leaves, so code fences around it keep their meaning, and the model reads only its new words.
async function prepare($: EngineInterface, piece: Piece) {
  const text = piece.text ?? (piece.file === undefined ? undefined : await readable($, piece.file))
  if (text === undefined) return undefined
  const file = piece.beforeFile === undefined ? undefined : await readable($, piece.beforeFile)
  if (piece.edit !== undefined) {
    const after = file === undefined ? undefined : applied(file, piece.edit)
    return after === undefined ? { text, scanned: text, before: piece.edit.old } : { text, scanned: after, before: file!, judged: piece.edit.new }
  }
  return { text, scanned: text, before: piece.before ?? file ?? '' }
}

type Answer = { result: string } | { deny: string }

// A file, a text, or with neither the main thread's last reply.
async function scanFor($: EngineInterface, e: { path?: unknown; text?: unknown; agentId?: string }): Promise<Answer> {
  const path = asText(e.path).trim()
  const text = asText(e.text)
  if (path !== '' && text !== '') return { deny: 'Give a path or text, not both.' }
  if (path !== '') return scanFile($, path)
  if (text !== '') return { result: await judged($, 'the text', text) }
  // The stored reply is the main thread's. A subagent's own draft is not stored, and the main
  // thread's text is not the subagent's to correct.
  if (e.agentId !== undefined) return { deny: 'In a subagent, pass your draft as text, or a path.' }
  const { value } = await $.state.get(LAST_REPLY)
  if (value === undefined || value === '') return { deny: 'There is no earlier reply to scan. Pass a path or text.' }
  return { result: await judged($, 'your last reply', value) }
}

type Memory = {
  // The calls the gate refused, by what they carry. The same call made again goes through: the
  // model read the findings and judged them wrong, as for a word used literally. A pass is kept
  // until the call runs, so a call another hook refuses keeps it.
  held: Set<string>
  // Texts that passed, so the gh that review-gate runs for a pull request already checked here
  // costs no second model call.
  cleared: Set<string>
}

// The refusal for a call's pieces, if any, and the key the call is held by.
async function gate($: EngineInterface, { held, cleared }: Memory, kind: string, found: readonly Piece[]) {
  const ready = (await Promise.all(found.map(p => prepare($, p)))).map((p, i) => (p === undefined ? undefined : { ...p, what: found[i]!.what }))
  const known = ready.filter(p => p !== undefined)
  const key = `${kind}|${known.map(p => `${p.what}\u0000${flat(p.text)}`).join('\u0001')}`
  if (known.length === 0) return { key }
  if (held.has(key)) {
    for (const p of known) cleared.add(flat(p.text))
    return { key, passed: true }
  }
  const refusals: string[] = []
  for (const p of known) {
    if (cleared.has(flat(p.text))) continue
    const problem = await problems($, p.scanned, { before: p.before, judged: p.judged })
    if (problem.length === 0) cleared.add(flat(p.text))
    else refusals.push(`In ${p.what}:\n${list(problem)}`)
  }
  if (refusals.length === 0) return { key }
  held.add(key)
  return {
    key,
    deny: `plain-english held this call: its prose has Claudisms. Rewrite them in plain English and make the call again.\n\n${refusals.join('\n\n')}\n\nIf a finding is wrong, such as a word used literally, make the same call again unchanged and it goes through.`,
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register(SCAN_TOOL)
    return next(e)
  })

  // Every agent the session starts writes under the style too. The style is forced while the mod is
  // on, so no setting is checked. A hook that fails leaves the spawn as it was, so a fault here
  // never stops the work.
  on('agent.spawn', async ($, e, next) => {
    // A resumed run keeps its prompt, and one that holds the rules already is left as it is.
    if (e.resume !== undefined || hasRules(e.prompt)) return next(e)
    const file = await $.fs.read(`${$.plugin.root}/${STYLE_FILE}`)
    const style = typeof file === 'string' ? parseStyle(file) : undefined
    if (style === undefined) return next(e)
    return next({ ...e, prompt: withRules(e.prompt, style.body, e.fork) })
  }).catch((_, e, next) => next(e))

  // Whether the main thread ran a scan this turn: its answer is then a scan's report, not prose to
  // check, so a second scan reads the reply the first one read.
  let scannedThisTurn = false

  // The main thread's last answer, so a scan with nothing given reads the reply before it.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const isReport = scannedThisTurn
      scannedThisTurn = false
      if (!isReport && e.reason === 'answer' && e.answer.trim() !== '') await $.state.set(LAST_REPLY, e.answer)
    }
    return next(e)
  })

  const memory: Memory = { held: new Set(), cleared: new Set() }

  // A commit message, a pull request or issue, or a prose file is checked before it is written,
  // and a call that would publish Claudisms is refused with the list to fix. A check that fails
  // lets the call through.
  on('tool.call', async ($, e, next) => {
    const found = pieces(e.tool, e as unknown as Record<string, unknown>, await $.session.cwd())
    if (found.length === 0) return next(e)
    const checked = await gate($, memory, e.tool, found)
    if (checked.deny !== undefined) return { deny: checked.deny }
    const result = await next(e)
    if (checked.passed === true && result.deny === undefined) memory.held.delete(checked.key)
    return result
  }).catch((_, e, next) => next(e))

  // review-gate opens a pull request by running gh itself, from its own tool's hook, which may sit
  // outside this mod's: the title and body are checked here too, as gh is run.
  on('process.run', async ($, e, next) => {
    const program = e.argv[0] ?? ''
    if (program !== 'gh' && !program.endsWith('/gh')) return next(e)
    const cwd = await $.session.cwd()
    const dir = e.init?.cwd === undefined ? cwd : e.init.cwd.startsWith('/') ? e.init.cwd : `${cwd}/${e.init.cwd}`
    const found = gh(['gh', ...e.argv.slice(1)], dir, e.init?.stdin)
    if (found.length === 0) return next(e)
    const checked = await gate($, memory, 'gh', found)
    if (checked.deny !== undefined) return { deny: checked.deny }
    const result = await next(e)
    if (checked.passed === true) memory.held.delete(checked.key)
    return result
  }).catch((_, e, next) => next(e))

  // A subagent's report is checked as it finishes, and sent back once to be rewritten. Text in
  // quotation marks is left alone: a review quotes what it found.
  on('classic.SubagentStop', async ($, e, next) => {
    const result = await next(e)
    const text = e.last_assistant_message ?? ''
    if (e.stop_hook_active || result.block !== undefined || text.trim() === '' || /^\s*[[{]/.test(text)) return result
    const problem = await problems($, text, { skipQuotes: true })
    if (problem.length === 0) return result
    return {
      ...result,
      block: `Your report has Claudisms. Send it again as your final message, rewritten in plain English, with these fixed:\n\n${list(problem)}`,
    }
  }).catch((_, e, next) => next(e))

  on('tool.call', { tool: SCAN }, async ($, e) => {
    const answer = await scanFor($, e)
    // Only a report counts: a refused scan leaves the turn's answer to be stored.
    if (e.agentId === undefined && 'result' in answer) scannedThisTurn = true
    return answer
  }).catch(() => ({ deny: 'plain-english: the scan failed.' }))
}
