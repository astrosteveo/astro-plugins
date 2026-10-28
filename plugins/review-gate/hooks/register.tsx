import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput } from 'claude-code'
import type { Depth, Ledger } from '../types'
import { locate, short } from './git'
import type { Place } from './git'
import { prCommand, reviewerRefusal } from './guard'
import type { PrCommand } from './guard'
import { ROUND_CAP, emptyLedger, ledgerFile, openFindings, parseLedger, riskNow } from './ledger'
import { CHECKER, REVIEWER } from './prompts'
import { CHECKER_TYPE, REVIEWER_TYPE, mailbox, runRound, summary } from './review'
import type { RoundAsk } from './review'
import { band, card } from './views'

const REVIEW = 'mcp__review-gate__review'
const DISMISS = 'mcp__review-gate__dismiss'
const COMMAND = 'review-gate'

const repo = atom({ plugin: 'review-gate', key: 'repo' } as const, null, { shape: 'repo-1' })
const ledgerState = atom({ plugin: 'review-gate', key: 'ledger' } as const, null, { shape: 'ledger-1' })
const run = atom({ plugin: 'review-gate', key: 'run' } as const, null, { shape: 'run-1' })

const DEPTH_NAMES = ['quick', 'standard', 'deep'] as const

const PATH = {
  type: 'string',
  description: "A folder in the repository, when the session's working directory is not in it.",
}

const REVIEW_TOOL = {
  name: 'review',
  description:
    "Review the current branch's commits, as its pull request would show them, before you open the pull request. Reviewer agents, each with its own focus, look for defects in parallel; checker agents then vote, and only findings most of them hold real are kept. Call it once the change is committed and its checks pass: `gh pr create` and `gh pr merge` are refused until the branch's latest commit has been reviewed and every finding answered. Answer each finding: fix it and commit, then review again (later rounds read only the new commits and confirm the fix); or dismiss it with the reason it can stay. After three rounds in a row end with findings open, it stops and asks you to step back with the user. A round takes minutes.",
  isDeferred: false,
  inputSchema: {
    type: 'object',
    properties: {
      intent: {
        type: 'string',
        description: 'What the change is for, in a sentence or two: the problem it solves and how. Reviewers check the change against it.',
      },
      depth: {
        type: 'string',
        enum: [...DEPTH_NAMES],
        description: "Leave it out and the change's risk picks: quick runs 2 reviewers and 1 checker, standard 4 and 3, deep 5 and 5.",
      },
      path: PATH,
    },
  },
}

const DISMISS_TOOL = {
  name: 'dismiss',
  description:
    "Answer review findings you will not fix, with the reason: the finding is wrong, or the code is fine as it is. A finding you fix is closed by the next review round, not by this. The user sees each reason in the review's card, and a dismissed security finding makes the pull request wait for the user's approval.",
  isDeferred: false,
  inputSchema: {
    type: 'object',
    properties: {
      ids: { type: 'array', items: { type: 'string' }, description: 'The findings to dismiss, such as ["R2-1"].' },
      reason: { type: 'string', description: 'Why each can stay, in a sentence or more.' },
      path: PATH,
    },
    required: ['ids', 'reason'],
  },
}

const USAGE = `/review-gate runs a review round on this branch now; /review-gate quick, standard or deep picks its depth. /review-gate status shows where the review stands, /review-gate more allows ${ROUND_CAP} more rounds after the cap, and /review-gate reset forgets this branch's review record.`

const asText = (value: unknown) => (typeof value === 'string' ? value : '')

const why = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function cwdOf($: EngineInterface, path: unknown) {
  const given = asText(path).trim()
  const cwd = await $.session.cwd()
  if (given === '') return cwd
  return given.startsWith('/') ? given : `${cwd}/${given}`
}

async function load($: EngineInterface, place: Place, branch = place.branch) {
  const text = await $.fs.read(ledgerFile(place.store, branch)).catch(() => undefined)
  return parseLedger(text, branch)
}

// The record is written whole or not at all: to a file beside it, then moved over it.
async function save($: EngineInterface, place: Place, ledger: Ledger) {
  const file = ledgerFile(place.store, ledger.branch)
  const made = await $.process.run(['mkdir', '-p', '--', place.store])
  if (made.exitCode !== 0) throw new Error(`could not make ${place.store}: ${made.stderr.trim()}`)
  await $.fs.write(`${file}.tmp`, `${JSON.stringify(ledger, null, 2)}\n`)
  const moved = await $.process.run(['mv', '-f', '--', `${file}.tmp`, file])
  if (moved.exitCode !== 0) throw new Error(`could not write ${file}: ${moved.stderr.trim()}`)
  if (ledger.branch === (await read($, repo))?.branch) await update($, ledgerState, () => ledger)
}

// Where the session's repository stands, for the band: read after git commands and at each turn's end.
async function refresh($: EngineInterface) {
  await show($, await locate($, await $.session.cwd()))
}

// A repository as the band and the cards draw it: its branch, and that branch's record.
async function show($: EngineInterface, place: Place | string) {
  if (typeof place === 'string' || place.branch === '') {
    await update($, repo, () => null)
    await update($, ledgerState, () => null)
    return
  }
  const isDefault = place.branch === place.main
  await update($, repo, () => ({ branch: place.branch, head: place.head, main: place.main, isDefault, ahead: place.ahead }))
  const record = isDefault ? null : await load($, place)
  await update($, ledgerState, () => record)
}

function nothingOpen(ledger: Ledger, head: string) {
  if (ledger.reviewed !== head) return `Nothing is open, but the commits since ${short(ledger.reviewed ?? '')} have not been reviewed.`
  const high = riskNow(ledger)?.tier === 'high' && ledger.approved?.sha !== head
  return `Nothing is open. ${ledger.branch} at ${short(head)} is ready for a pull request${high ? ', once the user approves it at the gate: it is high risk' : ''}.`
}

/**
 * Why a pull request command may not run yet, or undefined when it may: the commit it proposes was
 * reviewed, no finding is open, and a high-risk change has the person's approval for that commit.
 */
async function gate($: EngineInterface, pr: PrCommand): Promise<string | undefined> {
  const cwd = await $.session.cwd()
  const place = await locate($, pr.cd === undefined ? cwd : pr.cd.startsWith('/') ? pr.cd : `${cwd}/${pr.cd}`)
  if (typeof place === 'string') return undefined
  let branch = place.branch
  let sha = place.head
  if (pr.kind === 'merge') {
    // What merges is the pull request's head on GitHub, so that is the commit to vouch for.
    const view = await $.process
      .run(['gh', 'pr', 'view', ...(pr.target === undefined ? [] : [pr.target]), '--json', 'headRefName,headRefOid'], {
        cwd: place.root,
        timeoutMs: 30_000,
      })
      .catch(error => ({ exitCode: 1, stdout: '', stderr: why(error) }))
    const head = view.exitCode === 0 ? (JSON.parse(view.stdout) as { headRefName?: string; headRefOid?: string }) : undefined
    if (head?.headRefName === undefined || head.headRefOid === undefined)
      return `review-gate could not look up the pull request (${view.stderr.trim() || 'gh gave no head'}), so it cannot tell whether its commit was reviewed. Check gh works, then run this again.`
    branch = head.headRefName
    sha = head.headRefOid
  } else if (pr.head !== undefined) {
    branch = pr.head.slice(pr.head.indexOf(':') + 1)
    const ref = await place.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    if (!ref.ok) return undefined
    sha = ref.out.trim()
  }
  if (branch === '' || branch === place.main) return undefined

  const ledger = await load($, place, branch)
  if (ledger.reviewed !== sha)
    return `Review first: ${branch} at ${short(sha)} has not been reviewed${
      ledger.reviewed === undefined ? '' : ` (the last round covered ${short(ledger.reviewed)})`
    }. Call ${REVIEW} with what the change is for, answer each finding, then run this again.`
  const open = openFindings(ledger)
  if (open.length > 0)
    return `${branch} has ${open.length} open review finding${open.length === 1 ? '' : 's'}: ${open
      .map(finding => `${finding.id} (${finding.file}:${finding.line} ${finding.title})`)
      .join('; ')}. Fix each and commit, then call ${REVIEW} again; or dismiss it with ${DISMISS} and a reason.`
  const risk = riskNow(ledger)
  if (risk?.tier !== 'high' || ledger.approved?.sha === sha) return undefined

  // A person's approval: the dialog is theirs to answer, never the model's.
  const dismissed = ledger.findings.filter(finding => finding.status === 'dismissed')
  const action = pr.kind === 'create' ? 'opening its pull request' : 'merging it'
  const question = `The review of ${branch} passed, and it needs your approval: ${risk.why.join(', and ')}.${
    dismissed.length === 0 ? '' : ` Dismissed findings: ${dismissed.map(finding => `${finding.id} ${finding.title} (${finding.answer ?? ''})`).join('; ')}.`
  } Do you approve ${action} at ${short(sha)}?`
  const answer = await $.ui.ask(question, { options: ['Approve', 'Not yet'], header: 'Review' }).catch(() => undefined)
  if (answer !== 'Approve')
    return `The user has not approved ${branch} at ${short(sha)}, which needs a person: ${risk.why.join(', and ')}. Ask them what they want changed.`
  await save($, place, { ...ledger, approved: { sha, at: await $.clock.now() } })
  return undefined
}

// The agents' replies, the review's own agents, and whether a round runs: the session's, kept here.
const mail = mailbox()
const reviewers = new Set<string>()
let busy = false

async function isReviewer($: EngineInterface, agentId: string) {
  if (reviewers.has(agentId)) return true
  const agents = await $.agent.list()
  return agents.some(agent => agent.id === agentId && (agent.type === REVIEWER_TYPE || agent.type === CHECKER_TYPE))
}

type Settings = { depthOption: 'auto' | Depth; model?: string }

// One round, for the tool and the command alike; a second is refused while one runs.
async function round($: EngineInterface, place: Place, settings: Settings, ask: Pick<RoundAsk, 'intent' | 'depth' | 'force' | 'signal'>) {
  if (busy) return { ok: false as const, text: 'A review round is running already: wait for it to finish.' }
  busy = true
  try {
    return await runRound($, {
      ...ask,
      ...settings,
      place,
      ledger: await load($, place),
      mail,
      reviewers,
      progress: async value => {
        await update($, run, () => value)
      },
      save: ledger => save($, place, ledger),
    })
  } finally {
    busy = false
    await update($, run, () => null)
    await refresh($).catch(() => undefined)
  }
}

// A plugin tool's result as its row holds it: the text, or text blocks.
function textOf(output: unknown): string {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) return output.map(textOf).join('\n')
  if (typeof output === 'object' && output !== null && 'text' in output && typeof output.text === 'string') return output.text
  return ''
}

// A round's text opens with its number, branch and commit (a command's row puts the plugin's name
// first); its card draws from the branch's record.
async function roundCard($: EngineInterface, e: RenderInput, text: string) {
  const named = /(?:^|: )Review round (\d+) of (\S+) at /.exec(text)
  const record = await read($, ledgerState)
  if (named === null || record === null || record.branch !== named[2]) return undefined
  return card($, e, record, Number(named[1]), await read($, repo))
}

export const register: Register = (on, options) => {
  const model = typeof options.model === 'string' && options.model !== 'inherit' ? options.model : undefined
  const settings: Settings = {
    depthOption: DEPTH_NAMES.find(name => name === options.depth) ?? 'auto',
    ...(model === undefined ? {} : { model }),
  }

  on('session.start', async ($, e, next) => {
    await $.tool.register(REVIEW_TOOL)
    await $.tool.register(DISMISS_TOOL)
    const agent = { tools: ['Read', 'Bash'], model: 'inherit', maxTurns: 80 }
    await $.agent.register({ name: 'reviewer', description: 'Reviews a change for one kind of defect. review-gate runs it.', prompt: REVIEWER, ...agent })
    await $.agent.register({ name: 'checker', description: 'Votes on review findings. review-gate runs it.', prompt: CHECKER, ...agent })
    await $.command.register({
      name: COMMAND,
      description: 'Review this branch now, or see where its review stands',
      argumentHint: '[quick | standard | deep | status | more | reset]',
    })
    // A round a reload cut short left its progress behind.
    await update($, run, () => null)
    await refresh($).catch(() => undefined)
    return next(e)
  })

  // The review's own agents are its to run: the model is not offered them.
  on('agent.offer', { agent: 'review-gate:reviewer' }, () => ({ isOffered: false })).catch(() => ({ isOffered: false }))
  on('agent.offer', { agent: 'review-gate:checker' }, () => ({ isOffered: false })).catch(() => ({ isOffered: false }))

  // A subagent's reply is its turn's end; the main thread's end is a moment to look at git again.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) mail.settle(e.agentId, e.answer)
    else await refresh($).catch(() => undefined)
    return next(e)
  })

  // The review's agents read the repository and change nothing in it.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.agentId === undefined || !(await isReviewer($, e.agentId))) return next(e)
    const refusal = reviewerRefusal(e.command, e.run_in_background === true)
    return refusal === undefined ? next(e) : { deny: refusal }
  }).catch((_, e, next) =>
    next.called || !reviewers.has(e.agentId ?? '') ? next(e) : { deny: 'review-gate: the check on a reviewer command failed, so it was refused.' },
  )

  // The gate: a pull request is opened or merged only for a reviewed commit with nothing open.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const pr = prCommand(e.command)
    if (pr === undefined) return next(e)
    const refusal = await gate($, pr)
    return refusal === undefined ? next(e) : { deny: refusal }
  }).catch((_, e, next) =>
    next.called || prCommand(e.command) === undefined
      ? next(e)
      : { deny: 'review-gate: the review gate failed, so the pull request command was refused.' },
  )

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined && /\b(git|gh)\b/.test(e.command)) await refresh($)
    return ran
  }).catch((_, e, next) => next(e))

  on('tool.call', { tool: REVIEW }, async ($, e, next) => {
    const place = await locate($, await cwdOf($, e.path))
    if (typeof place === 'string') return { deny: place }
    const depth = DEPTH_NAMES.find(name => name === e.depth)
    const outcome = await round($, place, settings, {
      intent: asText(e.intent),
      ...(depth === undefined ? {} : { depth }),
      force: false,
      signal: next.signal,
    })
    return outcome.ok ? { result: outcome.text } : { deny: outcome.text }
  }).catch((_, e, next) => ({ deny: `review-gate: the review failed${next.error?.message ? `: ${next.error.message}` : ''}. Nothing was recorded.` }))

  on('tool.call', { tool: DISMISS }, async ($, e) => {
    const ids = (Array.isArray(e.ids) ? e.ids : [e.ids]).map(id => asText(id).trim().toUpperCase()).filter(id => id !== '')
    const reason = asText(e.reason).trim()
    if (ids.length === 0) return { deny: 'Name the findings to dismiss, such as ["R2-1"].' }
    if (reason.length < 12) return { deny: 'Give the reason in a sentence: why the finding is wrong, or why the code is fine as it is.' }
    const place = await locate($, await cwdOf($, e.path))
    if (typeof place === 'string') return { deny: place }
    await show($, place)
    const ledger = await load($, place)
    const unknown = ids.filter(id => !ledger.findings.some(finding => finding.id === id))
    if (unknown.length > 0) return { deny: `${place.branch} has no finding ${unknown.join(', ')}.` }
    const closed = ids.filter(id => ledger.findings.find(finding => finding.id === id)?.status !== 'open')
    if (closed.length > 0) return { deny: `${closed.join(', ')} ${closed.length === 1 ? 'is' : 'are'} not open.` }
    const next: Ledger = {
      ...ledger,
      findings: ledger.findings.map(finding => (ids.includes(finding.id) ? { ...finding, status: 'dismissed' as const, answer: reason } : finding)),
    }
    await save($, place, next)
    const open = openFindings(next)
    return {
      result: `Dismissed ${ids.join(', ')}: ${reason}\n${
        open.length > 0 ? `Still open: ${open.map(finding => finding.id).join(', ')}.` : nothingOpen(next, place.head)
      }`,
    }
  }).catch(() => ({ deny: 'review-gate: the dismissal failed, so nothing changed.' }))

  on('command.run', { command: COMMAND }, async ($, e, next) => {
    const verb = e.args.trim().split(/\s+/)[0]?.toLowerCase() || 'run'
    const isPerson = e.origin?.kind === 'composer' || e.origin?.kind === 'bridge'
    const place = await locate($, await $.session.cwd())
    if (typeof place === 'string') return { text: place }
    // The branch may have changed outside the session: the card draws from the record shown.
    await show($, place)
    const ledger = await load($, place)
    const last = ledger.rounds[ledger.rounds.length - 1]
    if (verb === 'status') {
      if (place.branch === '' || place.branch === place.main) return { text: `${place.branch || 'HEAD'} is not a branch to review.` }
      if (last === undefined) return { text: `${place.branch} has not been reviewed: ${place.ahead} commit${place.ahead === 1 ? '' : 's'} past ${place.main}.` }
      return { text: summary(ledger, last.n) }
    }
    if (verb === 'more' || verb === 'reset') {
      if (!isPerson) return { text: `Only the person at the keyboard can run /review-gate ${verb}.` }
      if (last === undefined) return { text: `${place.branch} has no review record.` }
      if (verb === 'more') {
        await save($, place, { ...ledger, streakFrom: ledger.rounds.length })
        return { text: `${place.branch} may run ${ROUND_CAP} more rounds.` }
      }
      await $.process.run(['rm', '-f', '--', ledgerFile(place.store, place.branch)])
      await update($, ledgerState, () => emptyLedger(place.branch))
      return { text: `Forgot ${place.branch}'s review record: ${ledger.rounds.length} rounds and ${ledger.findings.length} findings.` }
    }
    const depth = DEPTH_NAMES.find(name => name === verb)
    if (verb !== 'run' && depth === undefined) return { text: USAGE }
    const outcome = await round($, place, settings, { intent: '', ...(depth === undefined ? {} : { depth }), force: isPerson, signal: next.signal })
    return { text: outcome.text }
  }).catch((_, e, next) => ({ text: `review-gate: the command failed${next.error?.message ? `: ${next.error.message}` : ''}.` }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const mine = band($, e, await read($, repo), await read($, ledgerState), await read($, run))
    if (mine === undefined) return below
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {mine}
        {below}
      </Box>
    )
  })

  // A review's row in the chat draws as its card; ctrl+o still shows the text the model read.
  on('ui.render', { component: 'ToolResult', props: { tool: REVIEW } }, async ($, e, next) => {
    if (e.props.isErrored || e.props.isExpanded === true) return next(e)
    return (await roundCard($, e, textOf(e.props.output))) ?? next(e)
  })

  on('ui.render', { component: 'CommandOutput', props: { command: COMMAND } }, async ($, e, next) =>
    (await roundCard($, e, e.props.text)) ?? next(e),
  )
}
