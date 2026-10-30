import type { Finding, FindingKind, Ledger, Level, Risk, Round, Severity } from '../types'

/** Rounds in a row that may end with findings open before the review asks the author to step back. */
export const ROUND_CAP = 3

/** The /code-review levels, least to most: a person may pick any, the model all but max. */
export const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly Level[]

/** The verdict when the classifier gives none: a person looks, as a gate that cannot tell refuses. */
export const UNJUDGED: Risk = { tier: 'high', why: ['the classifier gave no verdict on its risk, so a person looks'] }

/** The level a risk calls for: a change that can do more harm gets a deeper read. */
export const levelFor = (risk: Risk): Level => (risk.tier === 'low' ? 'medium' : risk.tier === 'high' ? 'xhigh' : 'high')

/** `level`, held to `most` at the deepest. */
export const atMost = (level: Level, most: Level): Level => (LEVELS.indexOf(level) > LEVELS.indexOf(most) ? most : level)

export const emptyLedger = (branch: string): Ledger => ({ version: 2, branch, rounds: [], findings: [], streakFrom: 0 })

/** A branch's key in the plugin's own store, named by its repository's git folder and the branch. */
export const recordPrefix = (store: string) => `record:${store}:`
export const recordKey = (store: string, branch: string) => `${recordPrefix(store)}${branch}`

// A record another version wrote, or one edited into another shape, reads as none.
export function toLedger(value: unknown, branch: string): Ledger {
  if (typeof value !== 'object' || value === null) return emptyLedger(branch)
  const record = value as Partial<Ledger>
  if (record.version !== 2 || !Array.isArray(record.rounds) || !Array.isArray(record.findings)) return emptyLedger(branch)
  return { ...emptyLedger(branch), ...record, branch }
}

export const openFindings = (ledger: Ledger) => ledger.findings.filter(finding => finding.status === 'open')

/** Whether a review run with --fix says it fixed an open finding, which a later round has yet to confirm. */
export const isApplied = (finding: Finding) => finding.status === 'open' && finding.fix?.applied === true


/** Rounds in a row, counted back from the last, that ended with findings open: what the cap reads. */
export function streak(ledger: Ledger) {
  let count = 0
  for (const round of ledger.rounds.slice(ledger.streakFrom).reverse()) {
    if (round.open === 0) break
    count += 1
  }
  return count
}

export const lastRound = (ledger: Ledger): Round | undefined => ledger.rounds[ledger.rounds.length - 1]

/** Whether a round's review reported as many findings as its level lets it, so it may have left some out. */
export const isCapped = (round: Round | undefined) => round?.cap !== undefined && round.raised >= round.cap

/**
 * Whether the branch's commit wants a second read before the gate vouches for it: its last round
 * reported as many findings as its level allows, and was the first to read that commit. A second read
 * settles it, capped or not, so the gate never waits for ever.
 */
export function wantsReread(ledger: Ledger) {
  const last = lastRound(ledger)
  return isCapped(last) && ledger.rounds[ledger.rounds.length - 2]?.head !== last?.head
}

const compact = (count: number) => (count >= 1e6 ? `${(count / 1e6).toFixed(1)}M` : count >= 1e3 ? `${Math.round(count / 1e3)}k` : String(count))

/** A length of time as `4m 12s`, or `9s` under a minute. */
export function duration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`
}

/** What a round cost, as `4m 12s · 820k tokens, 610k from the cache`; empty for a round that kept no count. */
export function spent(round: Round) {
  const parts: string[] = []
  if (round.durationMs !== undefined) parts.push(duration(round.durationMs))
  if (round.tokens !== undefined) {
    const total = round.tokens.input + round.tokens.output + round.tokens.cached
    parts.push(`${compact(total)} tokens${round.tokens.cached > 0 ? `, ${compact(round.tokens.cached)} from the cache` : ''}`)
  }
  return parts.join(' · ')
}

/** Why a security finding still standing puts a person in the loop. */
export const securityReason = (findings: readonly Finding[]) =>
  `it has security finding${findings.length === 1 ? '' : 's'} ${findings.map(finding => finding.id).join(', ')} not fixed`

/** A security finding, open or dismissed, puts a person in the loop whatever the classifier said. */
export function riskWith(risk: Risk, findings: readonly Finding[]): Risk {
  const security = findings.filter(finding => finding.kind === 'security' && finding.status !== 'fixed')
  if (security.length === 0 || risk.tier === 'high') return risk
  return { tier: 'high', why: [...risk.why, securityReason(security)] }
}

export function riskNow(ledger: Ledger): Risk | undefined {
  const risk = lastRound(ledger)?.risk
  return risk === undefined ? undefined : riskWith(risk, ledger.findings)
}

/** A finding as the review reported it through the record tool, before the round gives it an id. */
export type Reported = {
  file: string
  line: number
  summary: string
  shortSummary: string
  scenario: string
  category: string
  verdict?: 'confirmed' | 'plausible'
  security: boolean
  introduced: boolean
}

/** What the review said of an open finding it looked at again. */
export type Recheck = { id: string; fixed: boolean; why: string }

// The review's own words for findings that cost upkeep rather than break behaviour, as the first
// whole word of its category. A deadlock, a deadline, a Dockerfile or a duplicated side effect is not
// cleanup, though its word starts like one.
const CLEANUP =
  /^(?:reuse|simplif(?:y|ication)|efficien(?:cy|t)|altitude|style|naming|readab(?:ility|le)|maintainab(?:ility|le)|tests?|testing|docs?|documentation|dead[-_ ]code|duplication|duplicated?[-_ ]code|cleanup)(?:$|[-_ ])/

// The review's words for a security hole. A memory or resource leak, dependency or fault injection
// and an author are not one; a leak or disclosure of data, a secret or a token is, and so is a hole
// in access control, privileges, permissions or a sandbox. A word that also names a thing counts
// alone or with the hole named (sandbox, a sandbox escape; traversal, a path traversal), not as part
// of another thing's name, such as a permission prompt, a sandbox's setup or a tree's traversal.
const SECURITY =
  /secur|(?<!(?:dependency|fault)[-_ ])inject|(?:^|[-_ ])o?auth(?:n|z|entication|ori[sz]ation)?(?:[-_ ]|$)|secret|credential|privilege|^permissions?$|permissions?[-_ ](?:bypass|check|escalation)|access[-_ ]control|^sandbox(?:ing)?$|sandbox[-_ ](?:escape|bypass)|(?:^|[-_ ])rce(?:[-_ ]|$)|code[-_ ]execution|(?:data|info|information|pii|token|key|password)s?[-_ ](?:leak|disclosure|exposure)|xss|ssrf|csrf|^traversal$|(?:path|directory|file)[-_ ]traversal/

export function kindOf(reported: Reported): FindingKind {
  if (reported.security || SECURITY.test(reported.category)) return 'security'
  return /convention|claude/.test(reported.category) ? 'convention' : 'bug'
}

export function severityOf(reported: Reported): Severity {
  if (!reported.introduced) return 'pre-existing'
  return CLEANUP.test(reported.category) ? 'nit' : 'important'
}

// Words that say nothing of a defect, so two findings that share only these are not alike.
const STOP = new Set(
  'the and are but for not nor its was were has had have this that these those then than when what which while with from into onto over under once only also each every any all one two can may will would could should does did doing been being their there they them his her our out off own same some such too very just more most other about after before again'.split(
    ' ',
  ),
)

const words = (text: string) => new Set((text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []).filter(word => !STOP.has(word)))

/** How much two texts share, by their words: 0 for nothing, 1 for the same words. */
export function overlap(a: string, b: string) {
  const left = words(a)
  const right = words(b)
  if (left.size === 0 || right.size === 0) return 0
  let both = 0
  for (const word of left) if (right.has(word)) both += 1
  return both / (left.size + right.size - both)
}

type Located = { file: string; line: number; title: string; detail: string }

/**
 * Two reports of one defect: in the same file, and lines a few apart that say something alike, or
 * words that say much the same wherever the lines have moved to.
 */
export function sameDefect(a: Located, b: Located) {
  if (a.file !== b.file) return false
  const alike = overlap(`${a.title} ${a.detail}`, `${b.title} ${b.detail}`)
  return (Math.abs(a.line - b.line) <= 3 && alike >= 0.15) || alike >= 0.45
}

/** Where a finding is, as `src/app.ts:12`, or the file alone when it names no line. */
export const whereOf = (finding: { file: string; line: number }) => (finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file)

/** What the review called a finding, as `correctness, confirmed`; empty when it said nothing. */
export const aboutOf = (finding: Finding) => [finding.category, finding.verdict].filter(word => word !== undefined && word !== '').join(', ')

const RANK: Record<Severity, number> = { important: 0, 'pre-existing': 1, nit: 2 }

/** The most nits a round raises: each one raised needs an answer before the pull request. */
export const NIT_CAP = 3

/**
 * Round `n`'s new findings, gravest first and security first among equals, leaving out those the
 * branch has had before in any state, so a round never raises a finding twice, and the nits past
 * NIT_CAP. The review's list is otherwise kept whole: it has merged its repeats already, and two
 * findings a few lines apart can differ. Gives how many were repeats and how many nits were left out.
 */
export function sortOut(reported: readonly Reported[], n: number, earlier: readonly Finding[]) {
  const fresh = graded(reported, n, earlier)
  const added = fresh.filter((finding, at) => finding.severity !== 'nit' || fresh.slice(0, at).filter(one => one.severity === 'nit').length < NIT_CAP)
  return {
    added: added.map((finding, index) => ({ id: `R${n}-${index + 1}`, ...finding })),
    repeats: reported.length - fresh.length,
    nitsLeft: fresh.length - added.length,
  }
}

/** Round `n`'s new findings, as sortOut keeps them. */
export const newFindings = (reported: readonly Reported[], n: number, earlier: readonly Finding[]): Finding[] => sortOut(reported, n, earlier).added

function graded(reported: readonly Reported[], n: number, earlier: readonly Finding[]): Omit<Finding, 'id'>[] {
  const kept: Omit<Finding, 'id'>[] = []
  for (const one of reported) {
    const title = (one.shortSummary || one.summary).slice(0, 200)
    const finding: Omit<Finding, 'id'> = {
      round: n,
      kind: kindOf(one),
      severity: severityOf(one),
      file: one.file,
      line: one.line,
      title,
      detail: title === one.summary ? '' : one.summary,
      scenario: one.scenario,
      ...(one.category === '' ? {} : { category: one.category }),
      ...(one.verdict === undefined ? {} : { verdict: one.verdict }),
      status: 'open',
    }
    if (!earlier.some(other => sameDefect(other, finding))) kept.push(finding)
  }
  return kept.sort((a, b) => RANK[a.severity] - RANK[b.severity] || Number(b.kind === 'security') - Number(a.kind === 'security'))
}

/**
 * A glob as REVIEW.md and .gitignore spell one, written out from the repository's root: a pattern
 * with no slash matches a name at any depth, a leading slash anchors it, and a trailing slash takes
 * a folder's contents.
 */
export function normalGlob(pattern: string) {
  let glob = pattern.trim().replace(/^\.\//, '')
  if (glob.startsWith('/')) glob = glob.slice(1)
  else if (!glob.replace(/\/$/, '').includes('/')) glob = `**/${glob}`
  return glob.endsWith('/') ? `${glob}**` : glob
}

/**
 * A glob as REVIEW.md and .gitignore spell one: `*` stays within a folder, `**` crosses folders, a
 * pattern with no slash matches a name at any depth, and a pattern that names a folder matches
 * everything in it.
 */
export function globTest(pattern: string): (path: string) => boolean {
  const glob = normalGlob(pattern)
  let source = ''
  for (let at = 0; at < glob.length; at++) {
    const char = glob[at]
    if (char === '*' && glob[at + 1] === '*') {
      // `**/` is any number of folders, none included; `**` anywhere else is anything.
      if (glob[at + 2] === '/') {
        source += '(?:.*/)?'
        at += 2
      } else {
        source += '.*'
        at += 1
      }
    } else if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else source += (char ?? '').replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  const match = new RegExp(`^${source}$`)
  return path => {
    const parts = path.split('/')
    return parts.some((_, end) => match.test(parts.slice(0, end + 1).join('/')))
  }
}

/** A REVIEW.md: its text for the review, and the globs under its Skip heading. */
export type Guide = { path: string; text: string; skip: string[] }

// A glob in a folder's REVIEW.md speaks for that folder: a bare name matches at any depth below it,
// a path is taken from it.
function scoped(folder: string, pattern: string) {
  if (folder === '') return pattern
  if (pattern.replace(/\/$/, '').includes('/')) return `/${folder}/${pattern.replace(/^\//, '')}`
  return `/${folder}/**/${pattern}`
}

export function parseGuide(path: string, text: string): Guide {
  const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  const skip: string[] = []
  let into: string[] | undefined
  for (const line of text.split('\n')) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (heading !== null) {
      const title = (heading[1] ?? '').trim().toLowerCase()
      into = title.startsWith('skip') ? skip : undefined
      continue
    }
    const item = /^\s*[-*+]\s+`?([^`\s]+)`?/.exec(line)
    if (into !== undefined && item?.[1] !== undefined) into.push(scoped(folder, item[1]))
  }
  return { path, text, skip }
}
