// A scan of prose for Claudisms: the stock words, set phrases and forms that mark machine-written
// text, after the list at https://claudisms.ai/claudisms.md. A text search finds the words; the
// constructions with a new noun in the slot are left to a reader, as the skill says.

// `rewrite`: almost never right in plain English. `check`: a word that is fine when literal (a
// config lives in a folder, a promise settles), wrong only as a metaphor, so a reader decides.
export type Tier = 'rewrite' | 'check'

export type Hit = { line: number; column: number; text: string; tier: Tier; why: string }

type Rule = { re: RegExp; tier: Tier; why: string }

const A = "['’]"

// A rule's spaces match any run of whitespace, a line break within a paragraph included, so a
// phrase broken across a wrapped line still matches. A space inside a character class stays.
function wrapping(re: RegExp): RegExp {
  let source = ''
  let inClass = false
  for (let i = 0; i < re.source.length; i++) {
    const c = re.source[i]!
    if (c === '\\') {
      source += c + (re.source[i + 1] ?? '')
      i++
      continue
    }
    if (c === '[') inClass = true
    else if (c === ']') inClass = false
    source += c === ' ' && !inClass ? '\\s+' : c
  }
  return new RegExp(source, re.flags)
}

const rewrite = (re: RegExp, why: string): Rule => ({ re: wrapping(re), tier: 'rewrite', why })
const check = (re: RegExp, why: string): Rule => ({ re: wrapping(re), tier: 'check', why })

const RULES: readonly Rule[] = [
  rewrite(/—/g, 'em dash. Use a comma, a colon, parentheses or a new sentence.'),

  // Stock words.
  rewrite(/\bdelv(?:e|es|ed|ing)\b/gi, 'stock AI word. Say "look at", "study" or "explain".'),
  rewrite(/\b(?:deep[- ]dive|div(?:e|es|ed|ing) (?:deep )?into)\b/gi, 'stock AI phrase. Say "look at" or "study", or start with the thing itself.'),
  rewrite(/\bleverag(?:e|es|ed|ing)\b/gi, 'corporate verb. Say "use".'),
  rewrite(/\butiliz(?:e|es|ed|ing|ation)\b/gi, 'say "use".'),
  rewrite(/\b(?:crucial(?:ly)?|pivotal)\b/gi, 'empty intensifier. Say why it matters, or say "important" once.'),
  rewrite(/\b(?:robust(?:ly|ness)?|seamless(?:ly)?|holistic(?:ally)?|intricate|comprehensive)\b/gi, 'empty adjective. Say what it does: "handles a dropped connection", "covers all 12 cases".'),
  rewrite(/\b(?:game[- ]chang\w*|groundbreaking|cutting[- ]edge|transformative)\b/gi, 'hype. Say what changed and by how much.'),
  rewrite(/\brealms?\b/gi, 'say "area" or "field", or name it.'),
  rewrite(/\bfoster(?:s|ed|ing)?\b/gi, 'say "support", "help" or "encourage".'),
  rewrite(/\btestament to\b/gi, 'cliché. Say what it shows.'),
  rewrite(/\bshed(?:s|ding)? (?:some |new )?light on\b/gi, 'cliché. Say "explain" or "show".'),
  rewrite(/\bpav(?:e|es|ed|ing) the way\b/gi, 'cliché. Say what it makes possible.'),
  rewrite(/\bunderscor(?:e|es|ed|ing) (?:the|that|how|why|its|their|our|this|a|an)\b/gi, 'pseudo-emphasis. Say "shows", or cut it.'),
  rewrite(/\bharness(?:es|ed|ing)? the (?:power|potential)\b/gi, 'corporate phrase. Say "use".'),
  rewrite(/\bload[- ]bearing\b/gi, 'engineering metaphor turned tic. Say "essential", or what breaks without it.'),
  rewrite(/\bthroughline\b/gi, 'buzzword. Say "theme" or "common thread", or name it.'),
  rewrite(/\bparadigm shift\b/gi, 'tired phrase. Say what changed.'),
  rewrite(/\blessons learned\b/gi, 'corporate phrase. Say what you found.'),
  rewrite(/\bat the end of the day\b/gi, 'filler. Cut it.'),
  rewrite(/\blean(?:s|ed|ing)? (?:into|in to|out of)\b/gi, 'overused. Say "commit to", "use more" or "accept".'),
  rewrite(/\b(?:north star|true north|strategic imperative|pressure[- ]test\w*|right[- ]siz\w*)\b/gi, 'consultant phrase. Say it in ordinary words.'),
  rewrite(/\bbumped into\b/gi, 'say "ran into" or "found".'),
  rewrite(/\b(?:hits|lands|strikes) (?:the )?hardest\b/gi, 'dramatic. Say "is most affected" or "shows up first".'),

  // Throat-clearing and signposts.
  rewrite(/\b(?:it|this)(?:['’]s| is) (?:worth|important to) (?:noting|note|mentioning|mention)\b/gi, 'throat-clearing. Cut it and state the fact.'),
  rewrite(/(?<!\bnet |['’]s )\bworth (?!\$|\d|more\b|less\b)/gi, 'the "worth ___" construction tells the reader what deserves attention. Cut it and let the thing show it.'),
  rewrite(/\bwhen it comes to\b/gi, 'soft opener. Start with the subject.'),
  rewrite(/\bat (?:its|their|his|her) core\b/gi, 'pseudo-deep framing. Cut it.'),
  rewrite(/\bthis is where [\w ]{1,30}? comes? in\b/gi, 'lecture-hall framing. Say what it does.'),
  rewrite(new RegExp(`\\bhere${A}s (?:where it gets interesting|the thing|the kicker|the catch|the deal)\\b`, 'gi'), 'announces a point instead of making it. Make the point.'),
  rewrite(new RegExp(`\\bhere${A}s (?:the|what) (?:analogy|moment|thing|part|idea) that (?:clicked|hit|landed|stuck)`, 'gi'), 'announces an insight. Start with the insight.'),
  rewrite(new RegExp(`\\blet${A}s (?:break (?:it|this|that) down|dive in|explore|unpack|delve|turn to|take a (?:closer )?look)\\b`, 'gi'), 'signpost. Start with the content.'),
  rewrite(/\b(?:now let['’]s|moving on to)\b/gi, 'signpost. Start the next point.'),
  rewrite(/\b(?:the point is|the bottom line is)\b/gi, 'throat-clearing. Make the point.'),
  rewrite(/\b(?:because it matters|this matters|and that matters|that['’]s what matters)\b/gi, 'tells the reader what to value. Say the thing and let them judge.'),
  rewrite(/\bcannot be overstated\b|\bcan['’]t be overstated\b/gi, 'overclaim. State the size of it.'),
  rewrite(/\b(?:great|good|excellent|fantastic) question\b|\bI love that you asked\b/gi, 'flattery. Answer the question.'),
  rewrite(/\bin today['’]s (?:rapidly|fast|ever|increasingly|digital|modern)\w*/gi, 'sweeping opener. Start with the point.'),
  rewrite(/\b(?:reflect(?:s|ing) a broader (?:trend|shift)|mark(?:s|ing)? a (?:significant|major|pivotal) shift)\b/gi, 'summary-speak. Say what happened.'),
  rewrite(/\b(?:key takeaways?|three things to know)\b/gi, 'consultant summary. Say the points, or end.'),
  rewrite(/\bI['’]m going to (?:make|cover|walk (?:you )?through) (?:two|three|four|five|a few)\b/gi, 'announces the structure. Make the points.'),
  rewrite(/\bI want to be careful here\b|\bwith (?:appropriate|the usual|all the) caveats\b/gi, 'false modesty. State the caveat, or cut it.'),

  // Preamble, flattery and stock closers. A paragraph opens after a full stop in the joined text.
  rewrite(/(?<=^|[.\n]\s*)(?:Sure|Certainly|Absolutely|Of course|Great|Perfect|Got it)(?:!|,(?= I| here| that| let))/g, 'preamble. Start with the answer.'),
  rewrite(new RegExp(`\\byou${A}re (?:absolutely|totally|completely|exactly) (?:right|correct)\\b|\\byou are (?:absolutely|totally|completely) (?:right|correct)\\b`, 'gi'), 'flattery. Say what you will do differently.'),
  rewrite(/\b(?:let me know if|feel free to|don['’]t hesitate to|hope (?:this|that) helps|happy to help|I hope this)\b/gi, 'stock closer. End with the last fact, or a question you need answered.'),
  rewrite(/(?<=^|[.\n]\s*)(?:In summary|In conclusion|To summari[sz]e|To sum up|In short|Overall),/g, 'summary opener. Cut the recap, or start with its point.'),
  rewrite(/\b(?:plays? an? (?:crucial|key|vital|pivotal|important) role|a myriad of|a plethora of|ever[- ](?:evolving|changing))\b/gi, 'stock phrase. Say what it does.'),
  rewrite(/\b(?:empower(?:s|ed|ing)?|(?:supercharg|turbocharg|revolutioni[sz])(?:e|es|ed|ing))\b/gi, 'hype verb. Say what it lets someone do.'),
  check(/\belevat(?:e|es|ed|ing)\b|\bunlock(?:s|ed|ing)? (?:the|new|a|your|its|their)\b/gi, 'hype verb, unless literal (elevated privileges, unlock a mutex). Say what it lets someone do.'),
  rewrite(/\bstreamlin(?:e|es|ed|ing)\b/gi, 'vague verb. Say what got shorter or simpler, and by how much.'),
  rewrite(/\bwhether you['’]re\b/gi, 'marketing opener. Say who it is for.'),
  check(/(?<=^|[.\n]\s*)(?:Additionally|Furthermore|Moreover|Notably|Importantly|Ultimately),/g, 'formal connective. Cut it; the order shows the link.'),
  check(/(?<=^|[.\n]\s*)(?:Here['’]s|Here is) (?:what|how|why|the)\b/g, 'announces what follows. Start with it.'),
  check(/\b(?:arguably|it seems(?: like)?|perhaps|potentially)\b/gi, 'hedge. Commit to the claim, or say once what you are unsure of and why.'),
  check(/\benhanc(?:e|es|ed|ing|ement|ements)\b/gi, 'vague verb. Say what got better, and how.'),
  check(/\bnuanced?\b/gi, 'vague word. Say what the distinction is.'),

  // Negative parallelism, the most cited AI form.
  rewrite(/\b(?:it|this|that)(?:['’]s not| is not| was not| isn['’]t| wasn['’]t) (?:just|only|merely|simply) [^.!?]{1,80}?[,;:—–]\s*(?:it|this|that)(?:['’]s| is| was)\b/gi, 'negative parallelism ("not just X, it\'s Y"). Say Y.'),
  rewrite(/\bnot only\b[^.!?]{1,80}?\bbut(?: also)?\b/gi, 'negative parallelism ("not only X but Y"). Say both plainly.'),
  rewrite(/\bNo [^.!?]{1,40}\. No [^.!?]{1,40}\. Just\b/g, 'staccato negation ("No X. No Y. Just Z."). Say Z.'),
  check(/\b(?:it|this|that) (?:isn['’]t|is not|wasn['’]t|was not) (?:about )?[^.!?]{1,60}?[.;,:—–]\s*(?:it|this|that)(?:['’]s| is| was)\b/gi, 'may be negative parallelism ("this isn\'t X. It\'s Y."). If so, say Y.'),

  // Pseudo-reflection and staged discovery.
  rewrite(/\bsit(?:s|ting)? with (?:it|this|that|the)\b/gi, 'reflective pose. Say what you think, or "hard to get past".'),
  rewrite(/\b(?:keeps?|kept) (?:coming back to|arriving at|returning to)\b/gi, 'pseudo-reflection. State the thought.'),
  rewrite(/\bthe question (?:that )?(?:kept|keeps) coming up\b|\bthe question I keep\b/gi, 'pseudo-reflection. Ask the question.'),
  rewrite(/\bbrings? (?:me|us) back to\b/gi, 'narrates circling back. Make the next point.'),
  rewrite(/\b(?:here['’]s )?where I (?:landed|land|come down)\b/gi, 'narrates reaching a conclusion. State it.'),
  rewrite(/\bwhat I keep (?:running into|noticing|seeing)\b|\bwhere I keep landing\b/gi, 'pseudo-reflection. State the thing.'),
  rewrite(/\bI didn['’]t (?:set out to|plan (?:it|this|that))\b|\bwhat I didn['’]t expect\b|\bcan['’]t unsee\b/gi, 'staged discovery. State the observation.'),
  rewrite(/\bI can['’]t stop thinking about\b/gi, 'false intimacy. Say what you think of it.'),
  rewrite(/\b(?:the (?:thing|part|one) that (?:got|hooked|surprised|struck) (?:me|to me)|what got me|what struck me|if I had to pick one|the part that stuck with me)\b/gi, 'invented reaction and a crowned item. Say the point plainly.'),
  rewrite(/\b(?:hit|hits|struck|strikes) a (?:nerve|chord)\b|\b(?:stuck|stayed) with me\b|\breally landed for me\b/gi, 'borrowed emotion. Say what the reaction was.'),
  rewrite(/\bwhat I (?:keep wanting|want) (?:you|people) to (?:see|take away)\b/gi, 'author desire. Make the point.'),
  rewrite(/\b(?:what I['’]d|I['’]ll|I want to) leave you with\b|\bleaving you with\b/gi, 'announces the close. Say it, or end.'),
  rewrite(/\b(?:seen this (?:movie|one) before|we['’]ve been here before|we have stood here before)\b/gi, 'knowing cliché. Give the precedent.'),
  rewrite(/\b(?:in (?:the|my) chest|in my gut)\b/gi, 'body placement of a feeling. Name the feeling.'),

  // Claims of size, value and candor.
  rewrite(/\bthe (?:whole|entire) (?:game|ballgame)\b/gi, 'totalizing claim. Say what it does, at its true size.'),
  rewrite(/\bthe only (?:thing|\w+) that (?:matters|mattered|counts)\b|\bthat['’]s the entire point\b/gi, 'totalizing claim. Say what counts and why.'),
  rewrite(/\bthe best thing you can do\b|\bthe one that pays off most\b|\bhelps most\b/gi, 'crowned superlative. Give each thing its reason.'),
  rewrite(/\bthe (?:most|least) interesting\b|\bthe (?:useful|interesting) (?:thing|part|bit)\b|\bwhat['’]s useful\b/gi, 'grades the content for the reader. Say the thing.'),
  rewrite(/\bhonestly\b|\bto be honest\b|\b(?:the|an|my) honest (?:version|answer|take|truth|breakdown|snapshot|assessment)\b/gi, 'implies the rest is not honest. Cut it.'),
  rewrite(/\b(?:most people|everyone I['’]ve (?:worked|talked) with|a lot of folks|nobody I know|in my experience)\b/gi, 'an observation nobody made. Cut it, or cite it.'),
  rewrite(/\b(?:first wave of|best operators|top practitioners|dispatches from|field notes from)\b/gi, 'grandiose framing. Say it plainly.'),
  rewrite(/\b(?:nobody|no one) handed\b/gi, 'denies help nobody claimed. Say what was built.'),
  rewrite(/\bhand[- ]?wav(?:e|es|ed|ing)\b|\ba wave of the hand\b/gi, 'gesture for a gap. Say what went unanswered.'),
  rewrite(/\b(?:that['’]s )?the tell\b(?=\s*(?:is|was|here|[.:,!]|$))/gi, 'insider diction. Say what it shows.'),
  rewrite(/\b(?:stays?|what stays) yours\b|\bthe rest is yours\b|\bthe part that stayed (?:mine|\w+)\b/gi, 'ownership glow. Say who decides what.'),
  rewrite(/\bdoing (?:all )?the heavy lifting\b/gi, 'labor metaphor. Say what depends on what.'),
  rewrite(/\bwhat (?:actually )?moved (?:is|was)\b/gi, 'crowns one part of a change. Name the change.'),

  // Words that are fine when literal: a reader decides.
  check(/\bhonest\b/gi, '"honest" implies the rest is not. Cut it, unless it describes someone else ("be honest with yourself").'),
  check(/\bthe shape of\b/gi, 'metaphor for "structure", "feel" or "direction", unless it is a data shape.'),
  check(/\b(?:lives|living) (?:in|at|on|inside|somewhere|between|where)\b/gi, 'placement metaphor. Fine for where a file is kept; otherwise say "is" or "happens".'),
  check(/\bhold(?:s|ing)? (?:a|the|that|this|two) (?:thought|tension|line|idea)s?\b|\bholding (?:them|both|two things) at\b/gi, 'pseudo-weighty verb for an idea. Say "believe" or "keep".'),
  check(/\bcarr(?:y|ies|ying) (?:the )?(?:weight|argument|meaning|costs?|this with you|forward)\b/gi, 'transport metaphor. Say "there are two costs" or "remember".'),
  check(/\b(?:moves|moved) (?:onto|from one|somewhere else|to the next)\b/gi, 'motion metaphor. Say what happens.'),
  check(/\bpoint(?:s|ing)? (?:the same direction|toward|towards|to the same)\b|\b(?:everything|all) (?:is )?pointing\b/gi, 'gesture standing in for a conclusion. State the conclusion.'),
  check(/\bnames (?:the|what|a|an|this|that|it)\b|\bnaming (?:that|it|this)\b/gi, 'writerly verb. Say "says", "states" or "calls it", unless something literally gets a name.'),
  check(/\bsurfac(?:e|es|ed|ing) (?:the|a|an|that|this|those|these|it|them|insights?|patterns?|issues?)\b/gi, 'corporate verb. Say "show", "find" or "raise".'),
  check(/\breal\b(?![- ]?time)/gi, '"real" implies the rest is fake. Say "measured", "actual" or the specific thing, or cut it.'),
  check(/\b(?:all |everything |it all )turns on\b|\bturns on (?:whether|how|what|the question|the word)\b/gi, 'pivot verb. Say "depends on".'),
  check(/\bhands? (?:you|it back|back)\b/gi, 'transfer metaphor. Say "gives", "returns" or "produces".'),
  check(/\brid(?:es|ing) (?:along|on)\b/gi, 'motion metaphor. Say "comes with" or "depends on".'),
  check(/\breach(?:es|ing)? for (?:a|the|gravitas|depth|weight)\b/gi, 'grasping metaphor. Say "wants" or "tries for".'),
  check(/\b(?:quieter|louder) (?:version|claim|argument|point)\b/gi, 'opaque metaphor. Say "less explicit" or "more direct".'),
  check(/\bmature (?:setup|version|approach|stage)\b/gi, 'grades without saying how. Say what it does differently.'),
  check(/\bis the engine\b|\bthe engine (?:of|behind)\b/gi, 'mechanical metaphor. Say what drives what, unless it is an engine.'),
  check(/\b(?:the|different|rules of) physics\b/gi, 'grand metaphor for "how it works", unless it is physics.'),
  check(/\bdoing the work\b/gi, 'labor metaphor for a word or idea, unless someone does the work.'),
  check(/\bthe (?:whole|entire) (?:point|story|lesson|thing|job|diagnosis)\b/gi, 'totalizing intensifier. Cut "whole", or say the size.'),
  check(/\bthe right (?:time|question|way|answer|tool)\b/gi, 'asserts rightness. Say why it fits.'),
  check(/\bquietly\b/gi, 'hidden-drama adverb, unless something runs without output.'),
  check(/\b(?:un)?settled\b/gi, 'manufactures drama about an open question, unless a promise or payment settles.'),
  check(/\bcompound(?:s|ing)\b/gi, 'finance metaphor for "builds" or "adds up", unless it compounds.'),
  check(/\bunpack(?:s|ed|ing)?\b/gi, 'reflective verb. Say "explain", unless an archive is unpacked.'),
  check(/\bnavigat(?:e|es|ed|ing) (?!to\b)(?:the|this|these|a|an|complex|its|their|our)\b/gi, 'figurative "navigate". Say "handle" or "work through", unless it is a route or a menu.'),
  check(/\blandscape\b/gi, 'cosmic framing. Say "field" or "market", unless it is an orientation.'),
  check(/\bdouble[- ]click(?:ing|ed)? on\b/gi, 'corporate-speak, unless you mean the mouse.'),
  check(/\b(?:wreck(?:s|ed)?|shatter(?:s|ed)?|obliterat\w+)\b/gi, 'overdrawn verb. Match it to what happened.'),
]

// One emoji whole: a flag, a keycap, or a pictograph with its variation selector or skin tone and
// any joined to it.
const EMOJI =
  /\p{Regional_Indicator}{2}|[0-9#*]\u{FE0F}?\u{20E3}|\p{Extended_Pictographic}(?:\u{FE0F}|\p{Emoji_Modifier})?(?:\u{200D}\p{Extended_Pictographic}(?:\u{FE0F}|\p{Emoji_Modifier})?)*/gu
// A symbol that draws as text by default (©, ™, ➡, ❤, ⚠) is an emoji only when a variation
// selector, a skin tone, a keycap mark or a join asks for one.
const DRAWN_AS_EMOJI = /\p{Emoji_Presentation}|\p{Emoji_Modifier}|\p{Regional_Indicator}|[\u{FE0F}\u{20E3}\u{200D}]/u

const LIST_MARK = /^\s*(?:[-*+]|\d+[.)])\s+/
const SENTENCE_END = /(?<=[.!?]["'”’)]?)\s+(?=["'“‘(]?[A-Z0-9])/
const RULE_LINE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const BLOCK_START = /^\s*(?:[-*+]|\d+[.)])\s+|^\s{0,3}[#|]/
const HEADING = /^\s{0,3}#/

// Each line with what is not prose blanked out, columns kept: frontmatter, fenced and indented
// code, block quotes, HTML comments, inline code, links' targets, URLs and HTML tags.
export function prose(text: string): string[] {
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  const blank = (s: string) => ' '.repeat(s.length)
  // Frontmatter opens the file with `---`, holds only `key: value` lines and what YAML nests under
  // them, and closes with `---`. A rule at the top followed by prose is prose.
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  const front =
    lines[0]?.trim() === '---' &&
    close > 1 &&
    /^[\w-]+\s*:/.test(lines[1]!) &&
    lines.slice(1, close).every(l => l.trim() === '' || /^[\w-]+\s*:|^\s+\S|^\s*-\s/.test(l))
  let fence: { char: string; size: number } | undefined
  let inComment = false
  let inCode = false
  let inList = false
  let wasBlank = true
  // Inline code goes first, so a `<!--` inside it opens no comment.
  const inline = (s: string) => {
    let t = s.replace(/(`+)(?:(?!\1)[\s\S])+?\1/g, blank).replace(/<!--[\s\S]*?-->/g, blank)
    const open = t.indexOf('<!--')
    if (open !== -1) {
      inComment = true
      t = t.slice(0, open) + blank(t.slice(open))
    }
    return t
      .replace(/\]\([^)]*\)/g, m => `]${blank(m.slice(1))}`)
      .replace(/\b(?:https?|file):\/\/\S+/g, blank)
      .replace(/<\/?[a-zA-Z][^>]*>/g, blank)
  }
  lines.forEach((line, i) => {
    const isBlank = line.trim() === ''
    const afterBlank = wasBlank
    wasBlank = isBlank
    if (front && i <= close) return void out.push(blank(line))
    if (fence !== undefined) {
      const end = /^\s*(`{3,}|~{3,})\s*$/.exec(line)
      if (end !== null && end[1]![0] === fence.char && end[1]!.length >= fence.size) fence = undefined
      return void out.push(blank(line))
    }
    if (inComment) {
      const end = line.indexOf('-->')
      if (end === -1) return void out.push(blank(line))
      inComment = false
      return void out.push(blank(line.slice(0, end + 3)) + inline(line.slice(end + 3)))
    }
    if (isBlank) return void out.push(line)
    // Indented code follows a blank line, or more of it; in a list the indent is the item's.
    if (/^(?: {4}|\t)/.test(line) && !inList && (afterBlank || inCode)) {
      inCode = true
      return void out.push(blank(line))
    }
    inCode = false
    // A fence at any indent, so one inside a list item is code too. A line that opens with
    // backticks and holds more of them is inline code, as CommonMark has it.
    const mark = /^\s*(`{3,}|~{3,})(.*)$/.exec(line)
    if (mark !== null && !(mark[1]![0] === '`' && mark[2]!.includes('`'))) {
      fence = { char: mark[1]![0]!, size: mark[1]!.length }
      return void out.push(blank(line))
    }
    if (LIST_MARK.test(line)) inList = true
    else if (!/^\s/.test(line)) inList = false
    if (/^\s{0,3}>/.test(line)) return void out.push(blank(line))
    out.push(inline(line))
  })
  return out
}

// Whether a line goes on the paragraph of the line before it, as a wrapped line does.
const continues = (prev: string, line: string) =>
  prev.trim() !== '' &&
  line.trim() !== '' &&
  !BLOCK_START.test(line) &&
  !RULE_LINE.test(line) &&
  !RULE_LINE.test(prev) &&
  !HEADING.test(prev)

// Sentences of a paragraph, each with the offset it starts at.
function sentences(text: string): { text: string; start: number }[] {
  const found: { text: string; start: number }[] = []
  let from = 0
  for (const part of text.split(SENTENCE_END)) {
    const start = text.indexOf(part, from)
    if (part.trim() !== '') found.push({ text: part, start })
    from = start + part.length
  }
  return found
}

const words = (s: string) => s.match(/[\p{L}\p{N}'’-]+/gu)?.length ?? 0

type Push = (start: number, length: number, tier: Tier, why: string) => void

// The forms a word list cannot match: emoji, horizontal rules, "**Term**: explanation" lists,
// two spaced dashes in one sentence, and four or more very short sentences in a row. Offsets are
// into the whole text, each line starting where `starts` says.
function forms(lines: string[], matched: string, starts: number[], push: Push) {
  lines.forEach((line, i) => {
    const at = starts[i]!
    for (const m of line.matchAll(EMOJI))
      if (DRAWN_AS_EMOJI.test(m[0])) push(at + m.index, m[0].length, 'rewrite', 'emoji. Cut it; the words carry the meaning.')
    if (RULE_LINE.test(line) && (lines[i - 1] ?? '').trim() === '')
      push(at + line.search(/\S/), line.trim().length, 'check', 'horizontal rule as a section break. Use a heading, or nothing.')
    // A bold or italic label that ends in a colon or a period, or is followed by one or a dash.
    const term = /^(\s*(?:[-*+]|\d+[.)])\s+)((\*\*|__|\*|_)[^*_]+?(?:[:.]\3|\3\s*(?::|[-–—]\s)))/.exec(line)
    if (term !== null) push(at + term[1]!.length, term[2]!.trimEnd().length, 'check', '"**Term**: explanation" list, the most recognised AI list form. Write plain sentences, or plain items.')
  })

  // Sentences run across the wrapped lines of a paragraph.
  for (let first = 0; first < lines.length; ) {
    let last = first
    while (last + 1 < lines.length && continues(lines[last]!, lines[last + 1]!)) last++
    const at = starts[first]!
    const body = matched.slice(at, starts[last]! + lines[last]!.length).replace(LIST_MARK, m => ' '.repeat(m.length))
    first = last + 1
    const parts = sentences(body)
    for (const s of parts) {
      const dashes = [...s.text.matchAll(/(?<=\S)\s[-–]\s(?=\S)/g)]
      if (dashes.length >= 2) push(at + s.start + dashes[1]!.index, dashes[1]![0].length, 'check', 'two dashes in one sentence. Keep one aside, or split the sentence.')
    }
    let run: typeof parts = []
    const close = () => {
      const lead = run[0]
      if (lead !== undefined && run.length >= 4) {
        const indent = lead.text.length - lead.text.trimStart().length
        push(at + lead.start + indent, lead.text.trim().length, 'check', `${run.length} very short sentences in a row. Join some; vary the length.`)
      }
      run = []
    }
    for (const s of parts) {
      if (words(s.text) <= 5 && /[.!?]["'”’)]?\s*$/.test(s.text)) run.push(s)
      else close()
    }
    close()
  }
}

export function scan(text: string): Hit[] {
  const original = text.split(/\r?\n/)
  const whole = original.join('\n')
  const lines = prose(text)
  const starts: number[] = []
  let offset = 0
  for (const line of original) {
    starts.push(offset)
    offset += line.length + 1
  }
  // The lines of one paragraph join with a newline, which a rule's spaces match. Any other break
  // is a full stop, so no phrase runs from one paragraph, list item or heading into the next.
  const matched = lines.map((line, i) => (i === 0 ? '' : continues(lines[i - 1]!, line) ? '\n' : '.') + line).join('')

  const lineOf = (at: number) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid]! <= at) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  const hits: Hit[] = []
  // The spans found so far, by each line they touch. A hit inside one found before it adds nothing
  // ("worth" inside "It is worth noting"). One that only overlaps another still counts: a stock
  // word must not hide the parallelism around it.
  const spans = new Map<number, [number, number][]>()
  // The text shown is the person's own, not the blanked line: inline code stays in it. The column
  // counts characters, so an emoji before a hit takes one column.
  const push: Push = (start, length, tier, why) => {
    const end = start + length
    const first = lineOf(start)
    if ((spans.get(first) ?? []).some(([s, e]) => s <= start && end <= e)) return
    for (let l = first, last = lineOf(Math.max(start, end - 1)); l <= last; l++) {
      const onLine = spans.get(l)
      if (onLine === undefined) spans.set(l, [[start, end]])
      else onLine.push([start, end])
    }
    const column = [...original[first]!.slice(0, start - starts[first]!)].length + 1
    hits.push({ line: first + 1, column, text: whole.slice(start, end).replace(/[ \t]*\n[ \t]*/g, ' '), tier, why })
  }
  // Rewrites are matched first, so a check that lies inside a rewrite's words is dropped, and rules
  // run in their listed order, so a phrase listed before a word it holds is the one reported.
  for (const tier of ['rewrite', 'check'] as const)
    for (const rule of RULES.filter(r => r.tier === tier))
      for (const m of matched.matchAll(rule.re)) push(m.index, m[0].length, rule.tier, rule.why)
  forms(lines, matched, starts, push)
  return hits.sort((a, b) => a.line - b.line || a.column - b.column)
}

const MAX_LISTED = 150

const row = (h: Hit) => `  ${`${h.line}:${h.column}`.padEnd(8)}"${h.text.length > 60 ? `${h.text.slice(0, 57)}...` : h.text}": ${h.why}`

// The scan's answer to the model: each hit by line and column, rewrites first.
export function report(source: string, hits: readonly Hit[]): string {
  const caveat = 'The scan matches words and set phrases. Read the text yourself for the forms it cannot see: see the scan skill.'
  if (hits.length === 0) return `No Claudisms found in ${source}.\n\n${caveat}`
  const rewrites = hits.filter(h => h.tier === 'rewrite')
  const checks = hits.filter(h => h.tier === 'check')
  const shown = [...rewrites, ...checks].slice(0, MAX_LISTED)
  const out = [`${source}: ${rewrites.length} to rewrite, ${checks.length} to check.`]
  const shownRewrites = shown.filter(h => h.tier === 'rewrite').map(row)
  const shownChecks = shown.filter(h => h.tier === 'check').map(row)
  if (shownRewrites.length > 0) out.push('', 'Rewrite:', ...shownRewrites)
  if (shownChecks.length > 0) out.push('', 'Check (fine where the word is literal):', ...shownChecks)
  if (hits.length > shown.length) out.push('', `...and ${hits.length - shown.length} more.`)
  out.push('', caveat)
  return out.join('\n')
}
