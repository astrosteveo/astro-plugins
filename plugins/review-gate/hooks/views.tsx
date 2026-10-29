import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'
import type { Activity, AgentRun, Finding, Ledger, Repo, Run } from '../types'
import { short } from './git'
import { DEPTHS, ROUND_CAP, duration, openFindings, riskNow, spent, streak } from './ledger'

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

const cut = (text: string, most: number) => (text.length <= most ? text : `${text.slice(0, most - 1)}…`)

// What a running round's agent shows after its time and calls: its latest action, or how it ended.
function agentTail(agent: AgentRun, doing: Activity | null | undefined) {
  if (agent.state === 'running') return cut(doing?.doing ?? 'starting', 60)
  if (agent.state === 'stopped') return 'stopped'
  return agent.raised === undefined ? 'done' : `raised ${agent.raised}`
}

/**
 * The band while a round runs: a line for the round, a line per agent of its phase (done or running,
 * its time and tool calls, what it is doing now, and a button that opens its transcript), and the
 * findings the reviewers have raised so far.
 */
export function liveBand($: EngineInterface, e: RenderInput, run: Run, doing: ReadonlyMap<string, Activity | null>, now: number): RenderElement {
  const { Box, Button, Text } = $.ui.resolve(e)
  const finished = run.agents.filter(agent => agent.state !== 'running').length
  const phase =
    run.phase === 'judging'
      ? "judging the change's risk"
      : `${run.phase === 'reviewing' ? 'reviewing' : 'checking'} ${finished} of ${run.agents.length}`
  const raised = run.raised.slice(0, 3).map(title => cut(title, 50))
  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor>review · </Text>
        <Text color="suggestion">
          round {run.round} · {phase} · {duration(now - run.startedAt)}
        </Text>
      </Text>
      {run.agents.map(agent => {
        const activity = doing.get(agent.id)
        const color = agent.state === 'running' ? 'suggestion' : agent.state === 'done' ? 'success' : 'inactive'
        return (
          <Box key={agent.id} flexDirection="row">
            <Text>
              {'  '}
              <Text color={color}>{agent.state === 'running' ? '●' : agent.state === 'done' ? '✓' : '–'}</Text> {agent.label.padEnd(14)}{' '}
              <Text dimColor>
                {duration((agent.endedAt ?? now) - agent.startedAt).padStart(7)} · {activity?.calls ?? 0} calls ·{' '}
              </Text>
              {agentTail(agent, activity)}{' '}
            </Text>
            {agent.state === 'running' && <Button key={`watch-${agent.id}`} label="watch" onPress={() => $.ui.view({ agentId: agent.id })} />}
          </Box>
        )
      })}
      {raised.length > 0 && (
        <Text dimColor>
          {'  '}raised so far: {raised.join(' · ')}
          {run.raised.length > raised.length ? ` and ${run.raised.length - raised.length} more` : ''}
        </Text>
      )}
    </Box>
  )
}

/**
 * The band above the prompt while a branch has something to say: a round running, shown agent by
 * agent; findings open; commits not reviewed yet; or a commit ready for its pull request. Nothing
 * on the default branch.
 */
export function band(
  $: EngineInterface,
  e: RenderInput,
  repo: Repo | null,
  ledger: Ledger | null,
  run: Run | null,
  doing: ReadonlyMap<string, Activity | null>,
  now: number,
): RenderElement | undefined {
  const { Box, Text } = $.ui.resolve(e)
  const label = <Text dimColor>review · </Text>
  if (run !== null) return liveBand($, e, run, doing, now)
  if (repo === null || repo.isDefault || ledger === null || ledger.branch !== repo.branch) return undefined
  if (ledger.rounds.length === 0) {
    if (repo.ahead === 0) return undefined
    return (
      <Box flexDirection="row">
        {label}
        <Text color="warning">○ {plural(repo.ahead, 'commit')} not reviewed</Text>
      </Box>
    )
  }
  const open = openFindings(ledger)
  const isCurrent = ledger.reviewed === repo.head
  const risk = riskNow(ledger)
  const needsYou = isCurrent && open.length === 0 && risk?.tier === 'high' && ledger.approved?.sha !== repo.head
  return (
    <Box flexDirection="row" flexWrap="wrap">
      {label}
      {open.length > 0 && (
        <Text color="error">
          ✗ {open.length} open: {open.map(finding => finding.id).join(' ')}
        </Text>
      )}
      {open.length > 0 && <Text dimColor> · fix and commit, or dismiss with a reason</Text>}
      {open.length > 0 && streak(ledger) >= ROUND_CAP && <Text color="warning"> · {ROUND_CAP} rounds without converging: step back</Text>}
      {!isCurrent && <Text color="warning">{open.length > 0 ? ' · ' : ''}○ new commits since {short(ledger.reviewed ?? '')}</Text>}
      {isCurrent && open.length === 0 && <Text color="success">✓ {short(repo.head)} reviewed, ready for a pull request</Text>}
      {needsYou && <Text color="warning"> · high risk: you approve it at the gate</Text>}
    </Box>
  )
}

function mark(finding: Finding) {
  if (finding.status === 'fixed') return { glyph: '✓', color: 'success' as const }
  if (finding.status === 'dismissed') return { glyph: '–', color: 'inactive' as const }
  if (finding.severity === 'nit') return { glyph: '✗', color: 'warning' as const }
  return { glyph: '✗', color: finding.severity === 'pre-existing' ? ('warning' as const) : ('error' as const) }
}

const ORDER: Record<Finding['status'], number> = { open: 0, dismissed: 1, fixed: 2 }

/**
 * A round as a card in the chat: what it covered, each finding it raised or looked at again with
 * where that finding stands now, and what is left to do.
 */
export function card($: EngineInterface, e: RenderInput, ledger: Ledger, n: number, repo: Repo | null): RenderElement | undefined {
  const round = ledger.rounds.find(one => one.n === n)
  if (round === undefined) return undefined
  const { Box, Text } = $.ui.resolve(e)
  const isLast = ledger.rounds[ledger.rounds.length - 1]?.n === n
  const rows = ledger.findings
    .filter(finding => finding.round === n || finding.closedRound === n || (isLast && finding.round < n && finding.status === 'open'))
    .sort((a, b) => ORDER[a.status] - ORDER[b.status])
  const open = openFindings(ledger)
  const risk = riskNow(ledger) ?? round.risk
  const plan = DEPTHS[round.depth]
  const moved = isLast && repo !== null && repo.branch === ledger.branch && repo.head !== round.head
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text>
        <Text weight="bold">Review round {n}</Text>
        <Text dimColor>
          {' '}
          · {ledger.branch} at {short(round.head)}
        </Text>
      </Text>
      <Text dimColor>
        {round.scope === 'full' ? 'whole branch' : `commits since ${short(round.from)}`} · {round.depth}: {plural(plan.focuses.length, 'reviewer')},{' '}
        {plural(plan.checkers, 'checker')}
        {spent(round) === '' ? '' : ` · ${spent(round)}`} · risk {risk.tier}
        {risk.why.length > 0 ? `: ${risk.why.join('; ')}` : ''}
      </Text>
      {rows.map(finding => {
        const { glyph, color } = mark(finding)
        return (
          <Box key={finding.id} flexDirection="column" marginTop={1}>
            <Text>
              <Text color={color}>{glyph}</Text> <Text weight="bold">{finding.id}</Text>{' '}
              <Text color={finding.status === 'open' ? color : 'inactive'}>{finding.severity}</Text>
              {finding.kind === 'bug' ? '' : ` ${finding.kind}`}
              <Text dimColor>
                {' '}
                · {finding.file}
                {finding.line > 0 ? `:${finding.line}` : ''} · {finding.votes.real} of {finding.votes.of} agree
              </Text>
            </Text>
            <Box paddingLeft={2} flexDirection="column">
              <Text dimColor={finding.status !== 'open'}>{finding.title}</Text>
              {finding.status === 'dismissed' && <Text dimColor>dismissed: {finding.answer ?? ''}</Text>}
              {finding.status === 'fixed' && <Text dimColor>{finding.answer ?? 'fixed'}</Text>}
            </Box>
          </Box>
        )
      })}
      <Box marginTop={1} flexDirection="column">
        {rows.length === 0 && <Text color="success">No findings.</Text>}
        {open.length > 0 && (
          <Text>
            <Text color="error">{plural(open.length, 'finding')} open.</Text> Fix and commit, then review again; or dismiss each with a reason.
          </Text>
        )}
        {open.length === 0 && !moved && <Text color="success">Nothing open: ready for a pull request.</Text>}
        {open.length === 0 && !moved && risk.tier === 'high' && ledger.approved?.sha !== round.head && (
          <Text color="warning">High risk: the gate asks you to approve it.</Text>
        )}
        {moved && <Text color="warning">Commits since this round have not been reviewed.</Text>}
        {round.complete === false && (
          <Text color="warning">This round lost {round.unread} of its agents, so it does not count as a review: review again.</Text>
        )}
        {round.agents !== undefined && round.agents.length > 0 && (
          <Text dimColor>
            {round.agents.map(agent => `${agent.label} ${duration(agent.ms)}${agent.state === 'done' ? '' : ` (${agent.state})`}`).join(' · ')}
          </Text>
        )}
        {round.unread > 0 && (
          <Text dimColor>
            {round.unread} {round.unread === 1 ? 'reply' : 'replies'} could not be read and counted for nothing.
          </Text>
        )}
      </Box>
    </Box>
  )
}
