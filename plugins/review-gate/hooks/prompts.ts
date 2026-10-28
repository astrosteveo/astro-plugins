import type { Finding, FindingKind, Risk } from '../types'
import { short } from './git'
import type { Candidate, CheckerReply, Guide, Recheck, Verdict } from './ledger'

const FENCE = '```'

// The rule both agent types share: they look and never touch, and the session refuses the rest.
const READ_ONLY =
  'You only read. Open files with Read, and run commands that look: git log, show, diff, blame and grep, rg, grep, find, ls, cat, head, tail, wc and sed -n. Never edit a file, stage, commit, switch branches, or run the project, its tests or its scripts: the session refuses commands that could change anything. The working tree matches the commit under review.'

/** The system prompt of a reviewer: it hunts one kind of defect in a change. */
export const REVIEWER = `You review one change to a git repository and report the defects you find in it.

${READ_ONLY}

Report a defect only when you can show it: the code does the wrong thing for an input, a state or an order of events that can happen. Before you report one, open the file, read the code around the line, and find what sets it off. Leave out anything you could not confirm.

Leave out style, naming, formatting, comments, logging, missing tests, and refactors you would prefer: the author will act on every finding, so each one must be worth a change. When one mistake recurs, report it once, as a class, and list in its detail every place it occurs, so the author fixes them all.

Each finding gives:
- file: its path from the repository's root
- line: the line at the commit under review
- title: one line saying what goes wrong
- detail: when it goes wrong and what a user or caller sees; for a class, every place it occurs
- evidence: the code that shows it, quoted
- severity: "important" when it breaks behaviour, loses or leaks data, or opens a hole; "nit" when it is small but still a defect
- introduced: true when the change causes it, false when it was there before
- kind: "bug", "security", or "convention" for a broken rule of CLAUDE.md or REVIEW.md

End your reply with one fenced json block and nothing after it:

${FENCE}json
{"findings": [{"file": "src/app.ts", "line": 12, "title": "...", "detail": "...", "evidence": "...", "severity": "important", "introduced": true, "kind": "bug"}]}
${FENCE}

An empty list is the right answer when you find nothing.`

/** The system prompt of a checker: it votes on what the reviewers raised. */
export const CHECKER = `You check findings that reviewers raised on a change to a git repository, and say which are real.

${READ_ONLY}

Judge each finding on the code, not on how it is written up. Open the file at the line it names, read around it, and look for the input or state that sets it off. A finding is real when the code goes wrong as it says, for something that can happen. It is not real when the code already handles the case, the input cannot occur, the quoted code is not there, it is about style, naming, tests or taste, or it repeats an earlier finding in the list (keep the first and call the repeat not real).

For each real finding, say whether the change introduced it (the faulty line, or the contract it breaks, comes from the change) or it was there before; whether it is "important" (it breaks behaviour, loses or leaks data, or opens a hole) or a "nit" (small but still a defect); and its kind: "security" only when someone else's input or access can use it against the user or the system, "convention" for a broken rule of CLAUDE.md or REVIEW.md, and "bug" for any other defect.

For each earlier finding listed as open, say whether the code at the commit under review still has it.

End your reply with one fenced json block and nothing after it:

${FENCE}json
{"verdicts": [{"id": "C1", "real": true, "introduced": true, "severity": "important", "kind": "bug", "why": "one line"}], "earlier": [{"id": "R1-2", "fixed": false, "why": "one line"}]}
${FENCE}

Give a verdict for every finding and every earlier one listed.`

/**
 * The system prompt of the risk classifier: it reads a change before a round and says how much is
 * at stake, which picks the round's depth and whether a person approves the pull request.
 */
export const RISK = `You judge how much is at stake in one change to a git repository by reading its code, so that the review it gets, and the attention a person gives it, match what could go wrong.

Pick one tier:
- low: nothing that runs can break. Docs, comments, tests alone, text people read, or code nothing calls yet.
- medium: an ordinary change to behaviour, such as a feature, a fix or a refactor, where a defect that slips through means a bug report and a quick fix.
- high: a defect that slips through could do lasting harm or reach beyond this code, so a person should look before it merges. That is code that decides what someone or something may do (authentication, permissions, a gate, a guard, a sandbox), runs commands or reads input from outside, handles secrets, moves money, deletes or migrates data, changes how the project is built, tested, released, installed or updated, or sets a pattern other code will copy. A change too large to review well is high too.

Judge the code, not the names of the files: renaming a variable in auth.ts is low, and one line that builds a shell command from its input is high.

Answer with one fenced json block and nothing else:

${FENCE}json
{"tier": "medium", "why": ["src/pay.ts sends the refund amount the request names"]}
${FENCE}

Give one to three reasons, each one short sentence of at most twenty words that names a file and what in it carries the risk.`

/** What each reviewer looks for: each round sends one reviewer per focus its depth names. */
export const FOCUS: Record<string, { label: string; text: string; kind: FindingKind }> = {
  logic: {
    label: 'correctness',
    kind: 'bug',
    text: 'Correctness. Does the code do what the change means it to? Look for conditions that test the wrong thing or the opposite thing, off-by-one bounds, the wrong variable or field, a return or break in the wrong place, an API used against its contract, and state left wrong when a function returns early.',
  },
  failure: {
    label: 'failure paths',
    kind: 'bug',
    text: 'Failure paths. Follow what happens when a call fails or returns nothing; when input is empty, missing, huge or malformed; when a file, folder, process or network is not there; when a timeout hits; and when two things run at once. Look for errors swallowed or reported as success, writes left half done, and resources never released.',
  },
  fit: {
    label: 'fit',
    kind: 'bug',
    text: 'Fit with the rest of the code. Find the callers, tests and docs of what the change touches. Look for callers it breaks, types and contracts it changes without updating their users, rules of CLAUDE.md or REVIEW.md it breaks, and docs, help text or comments it makes untrue, a line of CLAUDE.md included. Check too that it does all of what its intent says.',
  },
  security: {
    label: 'security',
    kind: 'security',
    text: 'Security. Follow input from outside (people, files, the network, other processes, environment variables) to where it is used: a shell command, a file path, a query, a template, eval, a URL fetched. Look for secrets written to code, logs or errors; checks a caller can skip; temp files or permissions others can reach; and data sent where it should not go.',
  },
  state: {
    label: 'state and data',
    kind: 'bug',
    text: 'State and data over time. Look at what the change stores, caches, migrates or sends: formats old data no longer fits, caches that go stale, events handled out of order, values that outlive a reload or restart, and ids or counters that can collide.',
  },
}

/** What a round tells its agents about the change. */
export type Context = {
  branch: string
  head: string
  /** Where the round's diff starts. */
  from: string
  scope: 'full' | 'delta'
  intent: string
  commits: string
  /** The stat of the branch's whole change. */
  stat: string
  /** The round's diff. */
  diff: string
  guides: readonly Guide[]
  /** Every finding the branch has had, in any state. */
  earlier: readonly Finding[]
}

const REVIEWER_DIFF = 80_000
const RISK_DIFF = 60_000
const CHECKER_DIFF = 30_000

function scopeLine(context: Context) {
  return context.scope === 'full'
    ? `the whole branch: git diff ${short(context.from)} ${short(context.head)}`
    : `only the commits since ${short(context.from)}, which an earlier round reviewed: git diff ${short(context.from)} ${short(context.head)}`
}

function guides(context: Context) {
  if (context.guides.length === 0) return ''
  return `\n\nThe repository's review rules, from its REVIEW.md files (a folder's file speaks for that folder):\n\n${context.guides
    .map(guide => `--- ${guide.path}\n${guide.text.trim()}`)
    .join('\n\n')}`
}

function diffBlock(context: Context, most: number) {
  const command = `git diff ${short(context.from)} ${short(context.head)}`
  if (context.diff.length <= most) return `\n\nThe diff under review (${command}):\n\n${FENCE}diff\n${context.diff.trimEnd()}\n${FENCE}`
  const cut = context.diff.slice(0, most)
  return `\n\nThe diff under review (${command}), cut at ${most} of its ${context.diff.length} characters: read the rest with ${command} -- <file>.\n\n${FENCE}diff\n${cut.slice(0, cut.lastIndexOf('\n'))}\n${FENCE}`
}

const findingLine = (finding: Finding) =>
  `- ${finding.id} [${finding.status}] ${finding.file}:${finding.line} ${finding.title}${
    finding.status === 'dismissed' && finding.answer !== undefined ? ` (dismissed: ${finding.answer})` : ''
  }`

/** The classifier's task: everything the branch would merge, `diff` being the branch's whole diff. */
export function riskPrompt(context: Context, diff: string) {
  return `Judge the change on branch ${context.branch} at commit ${short(context.head)}: everything it would merge.

What the change is for: ${context.intent.trim() === '' ? 'not stated; read it from the commits.' : context.intent.trim()}

Commits on the branch:
${context.commits || '(none listed)'}

Files the branch changes:
${context.stat || '(none)'}${guides(context)}${diffBlock({ ...context, diff }, RISK_DIFF)}`
}

/** A reviewer's task: the change, and the one focus it hunts in. */
export function reviewerPrompt(context: Context, focus: string) {
  const area = FOCUS[focus] ?? FOCUS.logic
  const earlier =
    context.earlier.length === 0
      ? ''
      : `\n\nFindings this branch already had, in any state. Do not raise them again, nor a reworded one:\n${context.earlier.map(findingLine).join('\n')}`
  return `Review the change on branch ${context.branch} at commit ${short(context.head)}. This round covers ${scopeLine(context)}.

Your focus: ${area?.text ?? ''} Other reviewers cover the other areas, so stay on yours.

What the change is for: ${context.intent.trim() === '' ? 'not stated; read it from the commits.' : context.intent.trim()}

Commits on the branch:
${context.commits || '(none listed)'}

Files the branch changes:
${context.stat || '(none)'}${earlier}${guides(context)}${diffBlock(context, REVIEWER_DIFF)}`
}

/** A checker's task: the candidates to vote on, and the earlier findings to look for again. */
export function checkerPrompt(
  context: Context,
  candidates: readonly Candidate[],
  open: readonly Finding[],
  changed: (file: string, line: number) => boolean,
) {
  const listed = candidates
    .map(
      (candidate, index) => `C${index + 1}. ${candidate.file}:${candidate.line} (${
        changed(candidate.file, candidate.line) ? 'a line this branch changes' : 'a line this branch does not change'
      }; raised as ${candidate.kind}, ${candidate.severity}, by ${candidate.raisedBy} reviewer${candidate.raisedBy === 1 ? '' : 's'})
   ${candidate.title}
   ${candidate.detail}
   Evidence: ${candidate.evidence || '(none quoted)'}`,
    )
    .join('\n\n')
  const recheck =
    open.length === 0
      ? ''
      : `\n\nEarlier findings still open. Say whether the code at ${short(context.head)} still has each one:\n\n${open
          .map(finding => `${finding.id}. ${finding.file}:${finding.line} ${finding.title}\n   ${finding.detail}`)
          .join('\n\n')}`
  return `Check the findings raised on branch ${context.branch} at commit ${short(context.head)}. The round covered ${scopeLine(context)}.

What the change is for: ${context.intent.trim() === '' ? 'not stated; read it from the commits.' : context.intent.trim()}

Commits on the branch:
${context.commits || '(none listed)'}

Files the branch changes:
${context.stat || '(none)'}${guides(context)}

Findings to check:

${listed || '(none)'}${recheck}${context.diff.length <= CHECKER_DIFF ? diffBlock(context, CHECKER_DIFF) : ''}`
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown, most: number) => (typeof value === 'string' ? value.trim().slice(0, most) : '')

/** The last json object in a reply: its last fenced block that parses, else its last {...} that does. */
export function lastJson(reply: string): unknown {
  const fences = [...reply.matchAll(/```[a-zA-Z]*\s*\n([\s\S]*?)```/g)].reverse()
  for (const fence of fences) {
    try {
      return JSON.parse(fence[1] ?? '')
    } catch {
      // Not json: try the fence before it.
    }
  }
  const end = reply.lastIndexOf('}')
  for (let start = reply.lastIndexOf('{', end), tries = 0; start >= 0 && tries < 200; start = reply.lastIndexOf('{', start - 1), tries++) {
    try {
      return JSON.parse(reply.slice(start, end + 1))
    } catch {
      // Not a whole object yet: widen to the brace before.
    }
  }
  return undefined
}

/** A reviewer's findings, or undefined when its reply holds no list to read. */
export function readFindings(reply: string, focus: string): Candidate[] | undefined {
  const value = lastJson(reply)
  if (!isRecord(value) || !Array.isArray(value.findings)) return undefined
  const fallback = FOCUS[focus]?.kind ?? 'bug'
  return value.findings.flatMap(item => {
    if (!isRecord(item)) return []
    const file = text(item.file, 400).replace(/^(\.\/|[ab]\/)/, '')
    const title = text(item.title, 200)
    if (file === '' || title === '') return []
    const line = typeof item.line === 'number' && Number.isInteger(item.line) && item.line > 0 ? item.line : 0
    const kind: FindingKind = item.kind === 'security' || item.kind === 'convention' || item.kind === 'bug' ? item.kind : fallback
    return [
      {
        file,
        line,
        title,
        detail: text(item.detail, 2_000),
        evidence: text(item.evidence, 600),
        severity: item.severity === 'nit' ? 'nit' : 'important',
        introduced: item.introduced !== false,
        kind,
        focus,
        raisedBy: 1,
      } satisfies Candidate,
    ]
  })
}

const TIERS = new Set(['low', 'medium', 'high'])

/** The classifier's verdict, or undefined when its reply names no tier. */
export function readRisk(reply: string): Risk | undefined {
  const value = lastJson(reply)
  if (!isRecord(value) || typeof value.tier !== 'string' || !TIERS.has(value.tier)) return undefined
  // A reason is its first sentence, without the full stop, so reasons join into one line.
  const why = (Array.isArray(value.why) ? value.why : [])
    .map(reason => (text(reason, 1_000).split(/(?<=[.!?])\s/)[0] ?? '').slice(0, 200).replace(/[.\s]+$/, ''))
    .filter(reason => reason !== '')
    .slice(0, 3)
  return { tier: value.tier as Risk['tier'], why }
}

/** A checker's votes, or undefined when its reply holds none to read. */
export function readVerdicts(reply: string): CheckerReply | undefined {
  const value = lastJson(reply)
  if (!isRecord(value) || (!Array.isArray(value.verdicts) && !Array.isArray(value.earlier))) return undefined
  const verdicts = (Array.isArray(value.verdicts) ? value.verdicts : []).flatMap((item): Verdict[] =>
    isRecord(item) && typeof item.id === 'string'
      ? [
          {
            id: item.id.trim(),
            real: item.real === true,
            severity: item.severity === 'nit' ? 'nit' : 'important',
            introduced: item.introduced !== false,
            ...(item.kind === 'bug' || item.kind === 'security' || item.kind === 'convention' ? { kind: item.kind } : {}),
            why: text(item.why, 300),
          },
        ]
      : [],
  )
  const earlier = (Array.isArray(value.earlier) ? value.earlier : []).flatMap((item): Recheck[] =>
    isRecord(item) && typeof item.id === 'string' ? [{ id: item.id.trim(), fixed: item.fixed === true, why: text(item.why, 300) }] : [],
  )
  return { verdicts, earlier }
}
