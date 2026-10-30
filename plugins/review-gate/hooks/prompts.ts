import type { Finding, Level, Risk } from '../types'
import { short } from './git'
import { NIT_CAP, nitsLeftFor, whereOf } from './ledger'
import type { Guide, Recheck, Reported } from './ledger'

const FENCE = '```'

/** The name the review's agent records its findings with. */
export const RECORD = 'mcp__review-gate__record'

/**
 * The system prompt of the risk classifier: it reads a change before a round and says how much is
 * at stake, which picks the round's level and whether a person approves the pull request.
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

/** What the risk classifier reads about the change. */
export type Context = {
  branch: string
  head: string
  intent: string
  commits: string
  /** The stat of the branch's whole change. */
  stat: string
  guides: readonly Guide[]
}

const RISK_DIFF = 60_000

const intentLine = (intent: string) => (intent.trim() === '' ? 'not stated; read it from the commits.' : intent.trim())

function guides(list: readonly Guide[]) {
  if (list.length === 0) return ''
  return `\n\nThe repository's review rules, from its REVIEW.md files (a folder's file speaks for that folder):\n\n${list
    .map(guide => `--- ${guide.path}\n${guide.text.trim()}`)
    .join('\n\n')}`
}

/** The classifier's task: everything the branch would merge, `diff` being the branch's whole diff. */
export function riskPrompt(context: Context, diff: string) {
  const cut = diff.slice(0, RISK_DIFF)
  const body =
    diff.length <= RISK_DIFF
      ? `\n\nThe branch's diff:\n\n${FENCE}diff\n${diff.trimEnd()}\n${FENCE}`
      : `\n\nThe branch's diff, cut at ${RISK_DIFF} of its ${diff.length} characters:\n\n${FENCE}diff\n${cut.slice(0, cut.lastIndexOf('\n'))}\n${FENCE}`
  return `Judge the change on branch ${context.branch} at commit ${short(context.head)}: everything it would merge.

What the change is for: ${intentLine(context.intent)}

Commits on the branch:
${context.commits || '(none listed)'}

Files the branch changes:
${context.stat || '(none)'}${guides(context.guides)}${body}`
}

/** What a round tells /code-review on top of its own instructions. */
export type Plan = {
  token: string
  n: number
  branch: string
  /** The repository's root folder. */
  root: string
  head: string
  /** Where the round's diff starts. */
  from: string
  scope: 'full' | 'delta'
  level: Level
  intent: string
  guides: readonly Guide[]
  /** Skip globs from the REVIEW.md files, written from the repository's root. */
  skip: readonly string[]
  /** Every finding the branch has had, in any state. */
  earlier: readonly Finding[]
}

const findingLine = (finding: Finding) =>
  `- ${finding.id} [${finding.status}${finding.status === 'dismissed' && finding.answer !== undefined ? `: ${finding.answer}` : ''}] ${whereOf(finding)} ${finding.title}`

/**
 * The section a round adds to /code-review's prompt: the round's scope, what the branch has had
 * before, the open findings to look at again, and how to hand the findings to the record.
 */
export function reviewSection(plan: Plan) {
  const open = plan.earlier.filter(finding => finding.status === 'open')
  const nits = nitsLeftFor(plan.earlier)
  const scope =
    plan.scope === 'full'
      ? `the whole branch, as its pull request will show it: \`git diff ${plan.from} ${plan.head}\`.`
      : `only the commits since ${short(plan.from)}, which round ${plan.n - 1} reviewed: \`git diff ${plan.from} ${plan.head}\`. Read the code around them as the steps above say.`
  const lines = [
    `## review-gate: round ${plan.n} of ${plan.branch}`,
    '',
    "review-gate keeps this branch's review record, and opens its pull request only once every finding is answered. This section adds to the steps above, and where the two differ, it holds.",
    '',
    `- Review ${scope}`,
    `- The repository is at \`${plan.root}\`, its working tree at ${short(plan.head)}: run git and read files there. Change no file. Leave HEAD where it is: read other commits with git show or git diff, and do not commit, check out or reset, or the round records nothing.`,
    `- What the author says the change is for: ${intentLine(plan.intent)}`,
    nits === 0
      ? `- Report no nits (cleanup, style, reuse, simplification, efficiency): this branch has raised the ${NIT_CAP} it may. Report only defects.`
      : `- Report at most ${nits} nit${nits === 1 ? '' : 's'} (cleanup, style, reuse, simplification, efficiency), the ones most worth an answer: each needs one before the pull request, and a branch raises at most ${NIT_CAP}.`,
  ]
  if (plan.skip.length > 0) lines.push(`- Leave out the files these globs match, as the repository's REVIEW.md asks: ${plan.skip.map(glob => `\`${glob}\``).join(', ')}.`)
  if (plan.guides.length > 0) lines.push('', guides(plan.guides).trimStart())
  if (plan.earlier.length > 0)
    lines.push('', 'Findings this branch has had, in any state. Do not report them again, nor a reworded one:', ...plan.earlier.map(findingLine))
  if (open.length > 0)
    lines.push(
      '',
      `Open findings to look at again. For each, read the code at ${short(plan.head)} and decide whether it is fixed; the fix may be in another file than the one named:`,
      ...open.map(finding => `- ${finding.id} ${whereOf(finding)} ${finding.title}${finding.detail === '' ? '' : `. ${finding.detail}`}`),
    )
  lines.push(
    '',
    `When your list of findings is final, and before you write your answer, call the ${RECORD} tool once, with:`,
    `- round: "${plan.token}"`,
    '- findings: every finding of your final list, with its file, line, summary, short_summary, failure_scenario and category as the steps above describe them, and two more fields. security is true when the defect lets someone do what they should not: read or change data that is not theirs, get past a check, run code, or learn a secret. introduced is false when the defect was there before this branch.',
    `- rechecked: ${open.length === 0 ? 'an empty list.' : 'one entry for each open finding listed above: its id, fixed (true or false), and why, in one line.'}`,
    '',
    'Its reply gives each finding its id. Then finish as the steps above say.',
  )
  return lines.join('\n')
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown, most: number) => (typeof value === 'string' ? value.trim().slice(0, most) : '')

/**
 * The findings and rechecks a record call carries, or why it carries none to read. A path under the
 * repository's `root`, as the review may give one it read there, is made relative to it. A path
 * copied from a diff, such as b/src/app.ts, loses its prefix when that leaves a file the branch
 * changes; one that is itself a changed file, in a folder named a or b, is kept as it is.
 */
export function readRecord(
  input: Record<string, unknown>,
  changed: ReadonlySet<string>,
  root?: string,
): { findings: Reported[]; rechecked: Recheck[] } | string {
  if (!Array.isArray(input.findings)) return 'Give findings as a list, empty when the review found nothing.'
  const under = root === undefined || root === '' ? undefined : `${root.replace(/\/+$/, '')}/`
  const findings = input.findings.flatMap((item): Reported[] => {
    if (!isRecord(item)) return []
    const named = text(item.file, 4_000)
    const given = (under !== undefined && named.startsWith(under) ? named.slice(under.length) : named).replace(/^\.\//, '').slice(0, 400)
    const bare = given.replace(/^[ab]\//, '')
    const file = changed.has(given) || !changed.has(bare) ? given : bare
    const summary = text(item.summary, 2_000)
    if (file === '' || summary === '') return []
    const line = typeof item.line === 'number' && Number.isInteger(item.line) && item.line > 0 ? item.line : 0
    const verdict = text(item.verdict, 20).toLowerCase()
    return [
      {
        file,
        line,
        summary,
        shortSummary: text(item.short_summary, 200),
        scenario: text(item.failure_scenario, 2_000),
        category: text(item.category, 60).toLowerCase(),
        ...(verdict === 'confirmed' || verdict === 'plausible' ? { verdict } : {}),
        security: item.security === true,
        introduced: item.introduced !== false,
      },
    ]
  })
  const rechecked = (Array.isArray(input.rechecked) ? input.rechecked : []).flatMap((item): Recheck[] =>
    isRecord(item) && typeof item.id === 'string' ? [{ id: item.id.trim().toUpperCase(), fixed: item.fixed === true, why: text(item.why, 300) }] : [],
  )
  return { findings, rechecked }
}

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
