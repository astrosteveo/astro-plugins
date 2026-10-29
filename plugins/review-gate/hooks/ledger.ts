import type { Depth, Finding, FindingKind, Ledger, Risk, Round, Severity } from '../types'

/** Rounds in a row that may end with findings open before the review asks the author to step back. */
export const ROUND_CAP = 3

/** The most nits one round reports: past a few, a nit costs an agent author more than it gives. */
export const NIT_CAP = 3

/** How many reviewers, each with its own focus, and how many checkers vote, at each depth. */
export const DEPTHS: Record<Depth, { focuses: readonly string[]; checkers: number }> = {
  quick: { focuses: ['logic', 'security'], checkers: 1 },
  standard: { focuses: ['logic', 'failure', 'fit', 'security'], checkers: 3 },
  deep: { focuses: ['logic', 'failure', 'fit', 'security', 'state'], checkers: 3 },
}

/** The verdict when the classifier gives none: a person looks, as a gate that cannot tell refuses. */
export const UNJUDGED: Risk = { tier: 'high', why: ['the classifier gave no verdict on its risk, so a person looks'] }

/** The depth a risk calls for: a change that can do more harm gets more eyes. */
export const depthFor = (risk: Risk): Depth => (risk.tier === 'low' ? 'quick' : risk.tier === 'high' ? 'deep' : 'standard')

export const emptyLedger = (branch: string): Ledger => ({ version: 1, branch, rounds: [], findings: [], streakFrom: 0 })

/** Where a record lived before it moved into the plugin's store: read once, to bring it across. */
export const ledgerFile = (store: string, branch: string) => `${store}/${encodeURIComponent(branch)}.json`

/** A branch's record in the plugin's own store, under its repository's git folder. */
export const recordPrefix = (store: string) => `record:${store}:`
export const recordKey = (store: string, branch: string) => `${recordPrefix(store)}${branch}`

// A record another version wrote, or one edited into another shape, reads as none.
export function toLedger(value: unknown, branch: string): Ledger {
  if (typeof value !== 'object' || value === null) return emptyLedger(branch)
  const record = value as Partial<Ledger>
  if (record.version !== 1 || !Array.isArray(record.rounds) || !Array.isArray(record.findings)) return emptyLedger(branch)
  return { ...emptyLedger(branch), ...record, branch }
}

export function parseLedger(text: unknown, branch: string): Ledger {
  if (typeof text !== 'string') return emptyLedger(branch)
  try {
    return toLedger(JSON.parse(text), branch)
  } catch {
    return emptyLedger(branch)
  }
}

export const openFindings = (ledger: Ledger) => ledger.findings.filter(finding => finding.status === 'open')

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

const compact = (count: number) => (count >= 1e6 ? `${(count / 1e6).toFixed(1)}M` : count >= 1e3 ? `${Math.round(count / 1e3)}k` : String(count))

/** What a round cost, as `4m 12s · 820k tokens, 610k from the cache`; empty for a round that kept no count. */
export function spent(round: Round) {
  const parts: string[] = []
  if (round.durationMs !== undefined) {
    const seconds = Math.round(round.durationMs / 1000)
    parts.push(seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`)
  }
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
export function riskNow(ledger: Ledger): Risk | undefined {
  const risk = lastRound(ledger)?.risk
  if (risk === undefined) return undefined
  const security = ledger.findings.filter(finding => finding.kind === 'security' && finding.status !== 'fixed')
  if (security.length === 0 || risk.tier === 'high') return risk
  return { tier: 'high', why: [...risk.why, securityReason(security)] }
}

/** A defect a reviewer raised, before the checkers vote on it. */
export type Candidate = {
  file: string
  line: number
  title: string
  detail: string
  evidence: string
  severity: 'important' | 'nit'
  introduced: boolean
  kind: FindingKind
  /** The focus of the reviewer that raised it first. */
  focus: string
  /** How many reviewers raised it. */
  raisedBy: number
}

const words = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [])

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

/** One candidate per defect: a defect raised by several reviewers keeps the gravest word on it. */
export function merge(list: readonly Candidate[]) {
  const kept: Candidate[] = []
  for (const candidate of list) {
    const twin = kept.find(other => sameDefect(other, candidate))
    if (twin === undefined) {
      kept.push({ ...candidate })
      continue
    }
    twin.raisedBy += candidate.raisedBy
    if (candidate.severity === 'important') twin.severity = 'important'
    if (candidate.kind === 'security') twin.kind = 'security'
    if (candidate.introduced) twin.introduced = true
  }
  return kept
}

/** Candidates the branch has not had before, in any state: a round never raises a finding twice. */
export const fresh = (list: readonly Candidate[], earlier: readonly Finding[]) =>
  list.filter(candidate => !earlier.some(finding => sameDefect(finding, candidate)))

export type Verdict = { id: string; real: boolean; severity: 'important' | 'nit'; introduced: boolean; kind?: FindingKind; why: string }
export type Recheck = { id: string; fixed: boolean; why: string }
export type CheckerReply = { verdicts: Verdict[]; earlier: Recheck[] }

/** A majority of the checkers that answered. */
export const quorum = (answered: number) => Math.floor(answered / 2) + 1

export type Kept = Candidate & { votes: { real: number; of: number }; grade: Severity }

// The kind most yes votes name; where none has the most, the kind it was raised as.
function kindOf(candidate: Candidate, yes: readonly Verdict[]): FindingKind {
  const counts = new Map<FindingKind, number>()
  for (const verdict of yes) if (verdict.kind !== undefined) counts.set(verdict.kind, (counts.get(verdict.kind) ?? 0) + 1)
  const most = Math.max(0, ...counts.values())
  const leaders = [...counts.keys()].filter(kind => counts.get(kind) === most)
  return leaders.length === 1 && leaders[0] !== undefined ? leaders[0] : candidate.kind
}

/**
 * The candidates a majority of the checkers held real, `C1` being the first, the majority counted
 * over the checkers `started` (a phase that stopped once the vote was decided has fewer replies). A
 * finding most of its yes votes say was there before the change is pre-existing; one most call
 * small is a nit. Its kind is the checkers' too: a reviewer's word that it is a security hole is a
 * claim they check.
 */
export function tally(candidates: readonly Candidate[], replies: readonly CheckerReply[], started = replies.length): Kept[] {
  if (replies.length === 0) return []
  const need = quorum(started)
  return candidates.flatMap((candidate, index) => {
    const id = `C${index + 1}`
    const yes = replies.flatMap(reply => {
      const verdict = reply.verdicts.find(one => one.id === id)
      return verdict?.real === true ? [verdict] : []
    })
    if (yes.length < need) return []
    const before = yes.filter(verdict => !verdict.introduced).length * 2 > yes.length
    const small = yes.filter(verdict => verdict.severity === 'nit').length * 2 > yes.length
    const grade: Severity = before ? 'pre-existing' : small ? 'nit' : 'important'
    return [{ ...candidate, kind: kindOf(candidate, yes), votes: { real: yes.length, of: replies.length }, grade }]
  })
}

/** The earlier open findings a majority of the checkers found fixed at the reviewed commit. */
export function fixedIds(open: readonly Finding[], replies: readonly CheckerReply[], started = replies.length) {
  if (replies.length === 0) return []
  const need = quorum(started)
  return open
    .filter(finding => replies.filter(reply => reply.earlier.some(one => one.id === finding.id && one.fixed)).length >= need)
    .map(finding => finding.id)
}

/**
 * Whether the replies so far settle every vote, so the checkers still at work could change nothing:
 * each candidate and each earlier finding has the yes votes it needs, or too few checkers are left
 * for it to get them.
 */
export function decided(candidates: number, open: readonly string[], replies: readonly CheckerReply[], started: number) {
  const need = quorum(started)
  const left = started - replies.length
  const settles = (yes: number) => yes >= need || yes + left < need
  for (let index = 1; index <= candidates; index++) {
    const yes = replies.filter(reply => reply.verdicts.some(verdict => verdict.id === `C${index}` && verdict.real)).length
    if (!settles(yes)) return false
  }
  return open.every(id => settles(replies.filter(reply => reply.earlier.some(one => one.id === id && one.fixed)).length))
}

const RANK: Record<Severity, number> = { important: 0, 'pre-existing': 1, nit: 2 }

/** Gravest first, security first among equals; nits past the cap dropped, the best-agreed kept. */
export function rank(list: readonly Kept[], nitCap = NIT_CAP) {
  const nits = list
    .filter(finding => finding.grade === 'nit')
    .sort((a, b) => b.votes.real - a.votes.real)
    .slice(0, nitCap)
  return list
    .filter(finding => finding.grade !== 'nit' || nits.includes(finding))
    .sort(
      (a, b) =>
        RANK[a.grade] - RANK[b.grade] ||
        Number(b.kind === 'security') - Number(a.kind === 'security') ||
        b.votes.real - a.votes.real,
    )
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

/** Pathspecs that leave the globs' files out of a git diff, a folder's contents with the folder. */
export const excludes = (globs: readonly string[]) =>
  globs.flatMap(pattern => {
    const glob = normalGlob(pattern)
    return glob.endsWith('/**') ? [`:(exclude,glob)${glob}`] : [`:(exclude,glob)${glob}`, `:(exclude,glob)${glob}/**`]
  })

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

/** A REVIEW.md: its text for the agents, and the globs under its Skip heading. */
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
