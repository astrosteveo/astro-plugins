import type { EngineInterface } from 'claude-code'
import type { Hit } from './scan'

// A finding the model made: the words as written, what is wrong with them, and a plainer form.
export type Finding = { quote: string; why: string; fix: string }

// The model's brief. The rules it judges by follow it, from the output style itself.
export const BRIEF = `You check prose written by an AI model for Claudisms: the stock words, set phrases and sentence forms that mark machine-written text. A reader who spots them stops trusting the text.

Flag a passage only when it clearly is one of these:
- Negative parallelism in any wording: "not X, but Y", "this isn't X. It's Y", "X, not Y" used for drama, "No X. No Y. Just Z."
- A crowned superlative or totalizing claim: "the one thing that", "the real fix", "the whole point", "the key insight", "the big one".
- Announced structure or signposting: "Here's what changed:", "Three things to know", "Let's look at", a sentence that only says what comes next.
- Throat-clearing, preamble and stock closers: "Sure!", "Great question", "Let me know if", "Hope this helps", "Feel free to".
- Staged reflection or invented experience: "what struck me", "I keep coming back to", "most people", "in my experience".
- A metaphor in place of a plain verb: an idea that lives, sits, carries, moves, points, lands, surfaces or has a shape; "the heavy lifting", "load-bearing", "the engine of".
- Hype and empty intensifiers: robust, seamless, comprehensive, crucial, powerful, elevate, unlock, streamline, enhance (with no measure).
- Hedges and qualifiers that commit to nothing: "arguably", "it seems", "quite", "rather", "perhaps", stacked "may potentially".
- Telling the reader what to value: "worth noting", "this matters", "importantly", "notably", "honestly".
- A **Bold label:** opening a list item or paragraph where a plain sentence would do.
- A run of very short sentence fragments for effect: "Fast. Simple. Done."

Do not flag:
- Literal uses: a file that lives in a folder, a promise that settles, the shape of a JSON object, a real number.
- Technical terms, names, code, commands, paths and quoted text.
- Plain, specific prose that merely sounds formal. When in doubt, leave it out: a false flag costs more than a miss.

Answer with a JSON array and nothing else. Each element is {"quote": the exact words from the text, at most 12 words, copied character for character; "why": what form it is, in a few words; "fix": the plainer wording, or "cut"}. Answer [] when the text is clean.`

// The JSON array in a reply, kept only where each quote is really in the text.
export function parseFindings(reply: string, text: string): Finding[] {
  const open = reply.indexOf('[')
  const close = reply.lastIndexOf(']')
  if (open === -1 || close < open) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(reply.slice(open, close + 1))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const flat = (s: string) => s.replace(/\s+/g, ' ').toLowerCase()
  const haystack = flat(text)
  const found: Finding[] = []
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue
    const { quote, why, fix } = item as Record<string, unknown>
    if (typeof quote !== 'string' || quote.trim() === '' || !haystack.includes(flat(quote.trim()))) continue
    found.push({ quote: quote.trim(), why: typeof why === 'string' ? why : '', fix: typeof fix === 'string' ? fix : '' })
  }
  return found
}

// The model's prompt: the brief and the rules first, marked for the cache since every call opens
// with them, then the text and any words the regex scan left for a reader to decide.
export function prompt(rules: string, text: string, candidates: readonly Hit[]) {
  const asks =
    candidates.length === 0
      ? ''
      : `\n\nA word search marked these as possible Claudisms that are fine when literal. Flag each one only if it is used as a figure of speech or for effect:\n${candidates.map(h => `- "${h.text}": ${h.why}`).join('\n')}`
  return [
    { text: `${BRIEF}\n\nThe style the text must follow:\n\n${rules}`, cache: true as const },
    { text: `The text to check:\n\n<text>\n${text}\n</text>${asks}` },
  ]
}

// The model's findings, or undefined when it gave none to use: an API error, a timeout, a reply
// that is not JSON. A check that cannot run lets the text through.
export async function judge($: EngineInterface, rules: string, text: string, candidates: readonly Hit[]) {
  const r = await $.model.complete({ model: 'haiku', prompt: prompt(rules, text, candidates), maxTokens: 1500, timeoutMs: 30_000 })
  if (!r.isAnswered) return undefined
  return parseFindings(r.text, text)
}
