import type { Depth, Finding, FindingKind, Ledger, Risk, Round, Severity } from '../types'

/** Rounds in a row that may end with findings open before the review asks the author to step back. */
export const ROUND_CAP = 3

/** The most nits one round reports: past a few, a nit costs an agent author more than it gives. */
export const NIT_CAP = 3

/** How many reviewers, each with its own focus, and how many checkers vote, at each depth. */
export const DEPTHS: Record<Depth, { focuses: readonly string[]; checkers: number }> = {
  quick: { focuses: ['logic', 'security'], checkers: 1 },
  standard: { focuses: ['logic', 'failure', 'fit', 'security'], checkers: 3 },
  deep: { focuses: ['logic', 'failure', 'fit', 'security', 'state'], checkers: 5 },
}

/** The depth a risk calls for: a change that can do more harm gets more eyes. */
export const depthFor = (risk: Risk): Depth => (risk.tier === 'low' ? 'quick' : risk.tier === 'high' ? 'deep' : 'standard')

export const emptyLedger = (branch: string): Ledger => ({ version: 1, branch, rounds: [], findings: [], streakFrom: 0 })

export const ledgerFile = (store: string, branch: string) => `${store}/${encodeURIComponent(branch)}.json`

// A record another version wrote, or a file edited into another shape, reads as none.
export function parseLedger(text: unknown, branch: string): Ledger {
  if (typeof text !== 'string') return emptyLedger(branch)
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null) return emptyLedger(branch)
    const record = value as Partial<Ledger>
    if (record.version !== 1 || !Array.isArray(record.rounds) || !Array.isArray(record.findings)) return emptyLedger(branch)
    return { ...emptyLedger(branch), ...record, branch }
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

/** Why a security finding still standing puts a person in the loop. */
export const securityReason = (findings: readonly Finding[]) =>
  `it has security finding${findings.length === 1 ? '' : 's'} ${findings.map(finding => finding.id).join(', ')} not fixed`

/** A security finding, open or dismissed, puts a person in the loop whatever the paths say. */
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
 * The candidates a majority of the checkers held real, `C1` being the first. A finding most of its
 * yes votes say was there before the change is pre-existing; one most call small is a nit. Its kind
 * is the checkers' too: a reviewer's word that it is a security hole is a claim they check.
 */
export function tally(candidates: readonly Candidate[], replies: readonly CheckerReply[]): Kept[] {
  if (replies.length === 0) return []
  const need = quorum(replies.length)
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
export function fixedIds(open: readonly Finding[], replies: readonly CheckerReply[]) {
  if (replies.length === 0) return []
  const need = quorum(replies.length)
  return open
    .filter(finding => replies.filter(reply => reply.earlier.some(one => one.id === finding.id && one.fixed)).length >= need)
    .map(finding => finding.id)
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
 * A glob as REVIEW.md and .gitignore spell one: `*` stays within a folder, `**` crosses folders, a
 * pattern with no slash matches a name at any depth, and a pattern that names a folder matches
 * everything in it.
 */
export function globTest(pattern: string): (path: string) => boolean {
  let glob = pattern.trim().replace(/^\.\//, '')
  if (glob.startsWith('/')) glob = glob.slice(1)
  else if (!glob.replace(/\/$/, '').includes('/')) glob = `**/${glob}`
  if (glob.endsWith('/')) glob = `${glob}**`
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

/** A REVIEW.md: its text for the reviewers, and the globs under its Skip and Needs a person headings. */
export type Guide = { path: string; text: string; skip: string[]; person: string[] }

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
  const person: string[] = []
  let into: string[] | undefined
  for (const line of text.split('\n')) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (heading !== null) {
      const title = (heading[1] ?? '').trim().toLowerCase()
      into = title.startsWith('skip') ? skip : title.includes('needs a person') ? person : undefined
      continue
    }
    const item = /^\s*[-*+]\s+`?([^`\s]+)`?/.exec(line)
    if (into !== undefined && item?.[1] !== undefined) into.push(scoped(folder, item[1]))
  }
  return { path, text, skip, person }
}

/** Paths whose change a person approves in any repository: CI, installers, releases, auth and secrets. */
export const PERSON_PATHS = [
  '.github/workflows/',
  '.gitlab-ci.yml',
  '.circleci/',
  'Jenkinsfile',
  'install.sh',
  'install.ps1',
  'release.sh',
  'deploy/',
  'Dockerfile',
  'auth/',
  '*secret*',
  '*credential*',
  '.env*',
]

const DOCS = ['*.md', '*.mdx', '*.txt', '*.rst', 'docs/', 'LICENSE*'].map(globTest)

function listed(items: readonly string[], most = 3) {
  return items.length <= most ? items.join(', ') : `${items.slice(0, most).join(', ')} and ${items.length - most} more`
}

/**
 * How much is at stake in a change, by the paths it touches: one that touches a path a person
 * approves is high, one that touches only docs is low, and any other is medium.
 */
export function classify(files: readonly string[], personGlobs: readonly string[]): Risk {
  const rules = [...PERSON_PATHS, ...personGlobs].map(globTest)
  const hits = files.filter(file => rules.some(test => test(file)))
  if (hits.length > 0) return { tier: 'high', why: [`it changes ${listed(hits)}, ${hits.length === 1 ? 'a path' : 'paths'} a person approves`] }
  if (files.length > 0 && files.every(file => DOCS.some(test => test(file)))) return { tier: 'low', why: ['it changes only docs'] }
  return { tier: 'medium', why: [] }
}
