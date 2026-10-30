import type { EngineInterface } from 'claude-code'
import { judge } from './judge'
import { type Hit, prose, scan } from './scan'
import { STYLE_FILE, parseStyle } from './style'

// One Claudism to fix: the words, what is wrong, and a plainer form where one is known.
export type Problem = { quote: string; why: string; fix?: string }

// Text shorter than this goes to the word scan alone: a commit subject, a title. The model's
// judgment needs a paragraph to read.
const JUDGED_WORDS = 25
// Past this the model reads only the start; the word scan reads it all.
const JUDGED_CHARS = 40_000

const flat = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
const proseWords = (text: string) => prose(text).join(' ').match(/[\p{L}\p{N}'’-]+/gu)?.length ?? 0

// Hits not already in the text an edit replaces: the edit answers for what it adds, not for what
// was there.
function added(hits: readonly Hit[], before: string): Hit[] {
  if (before === '') return [...hits]
  const had = new Map<string, number>()
  for (const h of scan(before)) {
    const key = `${flat(h.text)}|${h.why}`
    had.set(key, (had.get(key) ?? 0) + 1)
  }
  return hits.filter(h => {
    const key = `${flat(h.text)}|${h.why}`
    const n = had.get(key) ?? 0
    if (n === 0) return true
    had.set(key, n - 1)
    return false
  })
}

// The style's rules, which the model judges by: the output style's body.
async function rules($: EngineInterface) {
  const file = await $.fs.read(`${$.plugin.root}/${STYLE_FILE}`).catch(() => undefined)
  return typeof file === 'string' ? parseStyle(file)?.body : undefined
}

// The Claudisms in a text: each rewrite the word scan finds, then what the model finds, the words
// the scan left for a reader among them. When the model cannot answer, the scan's rewrites stand
// alone. `before` is the text an edit replaces.
export async function problems($: EngineInterface, text: string, before = '', useModel = true): Promise<Problem[]> {
  const hits = added(scan(text), before)
  const found: Problem[] = hits.filter(h => h.tier === 'rewrite').map(h => ({ quote: h.text, why: h.why }))
  if (!useModel || proseWords(text) < JUDGED_WORDS) return found
  const style = await rules($)
  if (style === undefined) return found
  const candidates = hits.filter(h => h.tier === 'check')
  const judged = await judge($, style, text.slice(0, JUDGED_CHARS), candidates).catch(() => undefined)
  if (judged === undefined) return found
  const old = flat(before)
  const covered = (q: string) => found.some(p => flat(p.quote).includes(q) || q.includes(flat(p.quote)))
  for (const f of judged) {
    const q = flat(f.quote)
    if ((old !== '' && old.includes(q)) || covered(q)) continue
    found.push({ quote: f.quote, why: f.why, fix: f.fix })
  }
  return found
}

const MAX_SHOWN = 25

// The problems as lines for the model to act on.
export function list(found: readonly Problem[]): string {
  const rows = found.slice(0, MAX_SHOWN).map(p => {
    const quote = p.quote.length > 80 ? `${p.quote.slice(0, 77)}...` : p.quote
    const fix = p.fix === undefined || p.fix === '' ? '' : ` Plainer: ${p.fix === 'cut' ? 'cut it' : `"${p.fix}"`}.`
    return `- "${quote}": ${p.why.replace(/\.?$/, '.')}${fix}`
  })
  if (found.length > MAX_SHOWN) rows.push(`- ...and ${found.length - MAX_SHOWN} more.`)
  return rows.join('\n')
}
