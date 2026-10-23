// The status line and the findings pane, from `ledger.py status`, and the ledger tools the review loop calls. The
// branch guard and push gate are the classic hooks in hooks.json, and they run beneath every module's `tool.call`
// hook, so this module hooks `tool.call` only for its own `mcp__solo-review__*` tools, by name: answering any other
// call there would skip them. It never runs REVIEW.md's `check` either, since `$.process.run` skips the permission
// prompt that command must go through; `check_record` only stores a result the model got by running it.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ReviewStatus } from '../types'
import { ANSWERS, fixerPrompt, paneResolveRun } from './actions'
import { findingLine, parseStatus, reviewNotice, riskLabel, runLine, statusLine, summary } from './status'
import { TOOLS, ledgerRun } from './tools'
import type { LedgerTool } from './tools'

const status = atom({ plugin: 'solo-review', key: 'status' } as const, null as ReviewStatus | null)
const answering = atom({ plugin: 'solo-review', key: 'answering' } as const, null as string | null)
const answer = atom({ plugin: 'solo-review', key: 'answer' } as const, ANSWERS[0].value as string)
const notice = atom({ plugin: 'solo-review', key: 'notice' } as const, null as string | null)
const notified = atom({ plugin: 'solo-review', key: 'notified' } as const, null as string | null)
const PANE = 'solo-review-findings'

/**
 * After a main-loop turn, tells the user where a review stands once it has stopped: clean, at the round cap, or
 * waiting on them. A finder, verifier or fixer still running means the loop goes on, so nothing is sent then, and each
 * state is sent once. A notification turned off or with no channel is ignored, like any other failure.
 */
async function notifyIfSettled($: EngineInterface): Promise<void> {
  try {
    const now = await read($, status)
    if (!now) return
    const last = await read($, notified)
    const due = reviewNotice(now)
    if (last === null) {
      // the session start could not read the status: the first state read is the baseline, and is not notified
      await update($, notified, () => due?.key ?? '')
      return
    }
    if (!due || due.key === last) return
    if ((await $.agent.list()).some(a => a.status === 'running')) return
    await update($, notified, () => due.key)
    await $.ui.notify(due.text, { title: 'solo-review' })
  } catch {
    // no agent list or no notifier: the status line still shows the state
  }
}

/** Reads the review state from the ledger and shows it. On any failure the status line stays as it was. */
async function refresh($: EngineInterface): Promise<void> {
  try {
    const ran = await $.process.run(['python3', `${$.plugin.root}/scripts/ledger.py`, 'status'], { timeoutMs: 10_000 })
    const next = ran.exitCode === 0 ? parseStatus(ran.stdout) : null
    if (!next) return
    await update($, status, () => next)
    $.ui.status(statusLine(next))
  } catch {
    // python3 missing, a timeout, a git error: keep what is shown
  }
}

/** Answers a ledger tool call: runs `ledger.py` without a shell, and hands its output back, or its error as a deny. */
async function serve($: EngineInterface, tool: LedgerTool, input: object) {
  const run = ledgerRun(tool, input as Record<string, unknown>)
  if ('error' in run) return { deny: run.error }
  const ran = await $.process.run(['python3', `${$.plugin.root}/scripts/ledger.py`, ...run.argv], {
    stdin: run.stdin,
    timeoutMs: 60_000,
  })
  const out = `${ran.stdout}${ran.stderr}`.trim()
  if (ran.exitCode !== 0) return { deny: out || `ledger.py exited with ${ran.exitCode}.` }
  await refresh($)
  return { result: out }
}

/**
 * Records the answer the user gave in the pane's form, as `--by user --via ui`: the press is theirs, so the label is
 * theirs. A refused answer (no reason, an outcome the ledger rejects) stays in the form with the reason shown.
 */
async function recordAnswer($: EngineInterface, id: string, reason: string): Promise<void> {
  const run = paneResolveRun(id, await read($, answer), reason)
  if ('error' in run) return void (await update($, notice, () => run.error))
  try {
    const ran = await $.process.run(['python3', `${$.plugin.root}/scripts/ledger.py`, ...run.argv], { timeoutMs: 30_000 })
    const out = (ran.exitCode === 0 ? ran.stdout : ran.stderr || ran.stdout).trim()
    await update($, notice, () => out || `ledger.py exited with ${ran.exitCode}.`)
    if (ran.exitCode !== 0) return
    await update($, answering, () => null)
    await refresh($)
  } catch {
    await update($, notice, () => 'ledger.py could not be run.')
  }
}

/** Queues the fixer prompt as the user's own, to run once Claude is idle; the module itself never edits code. */
async function sendToFixer($: EngineInterface, id: string): Promise<void> {
  const text = fixerPrompt(id)
  if (!text) return
  await update($, notice, () => `${id} goes to a fixer when Claude is next idle.`)
  // resolves when that turn starts, which may be a while: nothing here waits on it
  void $.prompt.submit({ text, asUser: true }).catch(() => update($, notice, () => `${id} couldn't be queued.`))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // module commands aren't namespaced by the plugin, so the name carries it; a literal, so `claude plugin
    // validate` can see the command.run hook below answers only its own command
    await $.command.register({
      name: 'solo-review-findings',
      description: "Show this branch's open review findings, the last round and the backlog in a pane",
    })
    for (const spec of Object.values(TOOLS)) await $.tool.register(spec)
    await refresh($)
    // the state the session opens on is already known: only a change after this is notified
    // (null means not yet seeded: a status that could not be read leaves it for the first turn that can)
    const opened = await read($, status)
    if (opened) await update($, notified, () => reviewNotice(opened)?.key ?? '')
    return started
  })

  // only this plugin's own tools, each by its full name, and never `next`: there is no tool beneath them
  on('tool.call', { tool: 'mcp__solo-review__record' }, ($, e) => serve($, 'record', e)).catch(() => ({
    deny: 'record: ledger.py could not be run.',
  }))
  on('tool.call', { tool: 'mcp__solo-review__check_record' }, ($, e) => serve($, 'check_record', e)).catch(() => ({
    deny: 'check_record: ledger.py could not be run.',
  }))
  on('tool.call', { tool: 'mcp__solo-review__resolve' }, ($, e) => serve($, 'resolve', e)).catch(() => ({
    deny: 'resolve: ledger.py could not be run.',
  }))

  on('command.run', { command: 'solo-review-findings' }, async $ => {
    await refresh($)
    const opened = await $.ui.open({ id: PANE, title: 'Review findings' })
    const text = summary(await read($, status))
    return { text: opened.isPlaced ? text : `${text}\n(The findings pane isn't shown here: ${opened.reason}.)` }
  })

  // the ledger changes only through ledger.py; the buttons run it (or queue a prompt), and the state redraws the pane
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    // a surface without text fields (mobile) shows the list and the fixer button, but no answer form
    const form = e.surface !== 'mobile' && 'Input' in ui && 'Select' in ui ? ui : null
    const s = await read($, status)
    if (!s || !s.opted_in) return <Text dimColor>{summary(s)}</Text>
    const [open, picked, note] = [await read($, answering), await read($, answer), await read($, notice)]
    const risk = riskLabel(s)
    return (
      <Box flexDirection="column">
        <Text weight="bold">
          {s.branch} · {s.open.length ? `${s.important} Important, ${s.nits} nit(s) open` : 'nothing open'}
          {risk ? ` · ${risk}` : ''}
        </Text>
        {note && <Text color="suggestion">{note}</Text>}
        {s.pending && <Text color="warning">Round {s.pending.round} is running ({s.pending.depth}).</Text>}
        {s.open.map(f => (
          <Box flexDirection="column" marginTop={1}>
            <Text color={f.severity === 'important' ? 'error' : 'warning'}>{findingLine(f)}</Text>
            {f.fix && <Text dimColor>fix: {f.fix}</Text>}
            {open === f.id && form ? (
              <Box flexDirection="column">
                <form.Select
                  key="answer"
                  label="Answer"
                  options={ANSWERS}
                  value={picked}
                  onSelect={value => void update($, answer, () => value)}
                />
                <form.Input
                  key="reason"
                  label="Reason"
                  placeholder="why this answer"
                  submitLabel="Record"
                  autoFocus
                  onSubmit={value => void recordAnswer($, f.id, value)}
                />
                <Button key="cancel" label="Cancel" onPress={() => void update($, answering, () => null)} />
              </Box>
            ) : (
              <Box flexDirection="row">
                {form && (
                  <Button
                    key={`answer:${f.id}`}
                    label="Answer"
                    onPress={() =>
                      void Promise.all([
                        update($, answering, () => f.id),
                        update($, answer, () => ANSWERS[0].value),
                        update($, notice, () => null),
                      ])
                    }
                  />
                )}
                <Button key={`fixer:${f.id}`} label="Send to fixer" onPress={() => void sendToFixer($, f.id)} />
              </Box>
            )}
          </Box>
        ))}
        {s.last_run && (
          <Box marginTop={1}>
            <Text dimColor>{runLine(s.last_run, s.max_rounds)}</Text>
          </Box>
        )}
        {s.backlog > 0 && <Text dimColor>Backlog: {s.backlog} deferred pre-existing (/solo-review:review backlog)</Text>}
      </Box>
    )
  })

  // every turn's end, a subagent's included, so a review's rounds show while they run
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    await refresh($)
    if (e.agentId === undefined) await notifyIfSettled($)
    return done
  })
}
