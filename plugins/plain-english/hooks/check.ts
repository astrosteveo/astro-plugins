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

// Text in quotation marks blanked out, columns kept: a report that quotes what it found.
export const unquoted = (text: string) => text.replace(/"[^"\n]{1,300}"|“[^”\n]{1,300}”/g, m => ' '.repeat(m.length))

// What the model reads: the prose alone, code and block quotes blanked as the word scan does, with
// runs of blank lines closed up.
const forModel = (text: string) =>
  prose(text)
    .map(l => l.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

export type Options = {
  // The text a write replaces: its Claudisms are not the write's to answer for.
  before?: string
  // What the model reads in place of the whole text: an edit's new words, not the file around them.
  judged?: string
  // Leave text in quotation marks alone, as in a report that quotes what it found.
  skipQuotes?: boolean
}

// The Claudisms in a text: each rewrite the word scan finds, then what the model finds, the words
// the scan left for a reader among them. When the model cannot answer, the scan's rewrites stand
// alone.
export async function problems($: EngineInterface, given: string, options: Options = {}): Promise<Problem[]> {
  const strip = (t: string) => (options.skipQuotes === true ? unquoted(t) : t)
  const text = strip(given)
  const before = options.before ?? ''
  const hits = added(scan(text), before)
  const found: Problem[] = hits.filter(h => h.tier === 'rewrite').map(h => ({ quote: h.text, why: h.why }))
  const read = forModel(strip(options.judged ?? given))
  const candidates = hits.filter(h => h.tier === 'check')
  // A short text goes to the model only when the scan left words for a reader to decide.
  if (proseWords(read) < JUDGED_WORDS && candidates.length === 0) return found
  const style = await rules($)
  if (style === undefined) return found
  const judged = await judge($, style, read.slice(0, JUDGED_CHARS), candidates).catch(() => undefined)
  if (judged === undefined) return found
  const old = flat(before)
  const now = flat(text)
  const count = (s: string, q: string) => s.split(q).length - 1
  // A finding inside words the scan already reported adds nothing; one that holds them says more.
  const covered = (q: string) => found.some(p => flat(p.quote).includes(q))
  for (const f of judged) {
    const q = flat(f.quote)
    // Words the text had before are not the write's, unless it adds another of them.
    if ((old !== '' && count(old, q) >= Math.max(1, count(now, q))) || covered(q)) continue
    found.push({ quote: f.quote, why: f.why, fix: f.fix })
  }
  return found
}

const MAX_SHOWN = 25

// The problems as lines for the model to act on.
export function list(found: readonly Problem[]): string {
  // A word used twice is one fix, listed once.
  const seen = new Set<string>()
  const unique = found.filter(p => {
    const key = `${flat(p.quote)}|${p.why}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const rows = unique.slice(0, MAX_SHOWN).map(p => {
    const quote = p.quote.length > 80 ? `${p.quote.slice(0, 77)}...` : p.quote
    const fix = p.fix === undefined || p.fix === '' ? '' : ` Plainer: ${p.fix === 'cut' ? 'cut it' : `"${p.fix}"`}.`
    return `- "${quote}": ${p.why.replace(/\.?$/, '.')}${fix}`
  })
  if (unique.length > MAX_SHOWN) rows.push(`- ...and ${unique.length - MAX_SHOWN} more.`)
  return rows.join('\n')
}
