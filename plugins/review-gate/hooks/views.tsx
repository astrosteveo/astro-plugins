import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'
import type { Activity, Finding, Ledger, Repo, Run } from '../types'
import { short } from './git'
import { ROUND_CAP, aboutOf, capLeft, duration, leftText, openFindings, riskNow, spent, standing, streak } from './ledger'

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

const cut = (text: string, most: number) => (text.length <= most ? text : `${text.slice(0, most - 1)}…`)

/**
 * The band while a round runs: a line for the round and, while the cap binds, how many rounds it
 * leaves after this one; then, once /code-review is at work, a line for its agent (its tool calls,
 * what it is doing now, and a button that opens its transcript).
 */
export function liveBand($: EngineInterface, e: RenderInput, run: Run, doing: Activity | null, now: number): RenderElement {
  const { Box, Button, Text } = $.ui.resolve(e)
  const phase = run.phase === 'judging' ? "judging the change's risk" : `/code-review ${run.level ?? ''}`.trimEnd()
  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor>review · </Text>
        <Text color="suggestion">
          round {run.round} · {phase} · {duration(now - run.startedAt)}
        </Text>
        {run.left !== undefined && <Text dimColor> · {leftText(run.left, true)}</Text>}
      </Text>
      {run.phase === 'reviewing' && (
        <Box flexDirection="row">
          <Text>
            {'  '}
            <Text color="suggestion">●</Text> <Text dimColor>{plural(doing?.calls ?? 0, 'call')} · </Text>
            {cut(doing?.doing ?? 'starting', 70)}{' '}
          </Text>
          {run.agentId !== undefined && <Button key="watch" label="watch" onPress={() => $.ui.view({ agentId: run.agentId ?? '' })} />}
        </Box>
      )}
    </Box>
  )
}

/**
 * The band above the prompt while a branch has something to say: a round running; findings open;
 * commits not reviewed yet; or a commit ready for its pull request. Nothing on the default branch.
 */
export function band(
  $: EngineInterface,
  e: RenderInput,
  repo: Repo | null,
  ledger: Ledger | null,
  run: Run | null,
  doing: Activity | null,
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
  const stand = standing(ledger, repo.head)
  const left = capLeft(ledger) ?? 0
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
      {stand.kind === 'unreviewed' && <Text color="warning">{open.length > 0 ? ' · ' : ''}○ new commits since {short(ledger.reviewed ?? '')}</Text>}
      {(stand.kind === 'ready' || stand.kind === 'approval') && <Text color="success">✓ {short(repo.head)} reviewed, ready for a pull request</Text>}
      {stand.kind === 'approval' && <Text color="warning"> · high risk: you approve it at the gate</Text>}
      {left > 0 && <Text dimColor> · {leftText(left)}</Text>}
    </Box>
  )
}

function mark(finding: Finding) {
  if (finding.status === 'fixed') return { glyph: '✓', color: 'success' as const }
  if (finding.status === 'dismissed') return { glyph: '–', color: 'inactive' as const }
  if (finding.severity === 'nit') return { glyph: '✗', color: 'warning' as const }
  return { glyph: '✗', color: finding.severity === 'pre-existing' ? ('warning' as const) : ('error' as const) }
}

// Findings that need an answer first, then the answered.
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
  const waiting = openFindings(ledger).length
  const risk = riskNow(ledger) ?? round.risk
  const moved = isLast && repo !== null && repo.branch === ledger.branch && repo.head !== round.head
  // What the pull request waits for, as the gate reads it, once the commits since have been reviewed.
  const now = moved ? undefined : standing(ledger, ledger.reviewed ?? round.head)
  const cost = [spent(round), round.calls === undefined ? '' : plural(round.calls, 'call')].filter(part => part !== '').join(' · ')
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
        {round.scope === 'full' ? 'whole branch' : `commits since ${short(round.from)}`} · /code-review {round.level}
        {cost === '' ? '' : ` · ${cost}`} · risk {risk.tier}
        {risk.why.length > 0 ? `: ${risk.why.join('; ')}` : ''}
      </Text>
      {rows.map(finding => {
        const { glyph, color } = mark(finding)
        const about = aboutOf(finding)
        return (
          <Box key={finding.id} flexDirection="column" marginTop={1}>
            <Text>
              <Text color={color}>{glyph}</Text> <Text weight="bold">{finding.id}</Text>{' '}
              <Text color={finding.status === 'open' ? color : 'inactive'}>{finding.severity}</Text>
              {finding.kind === 'bug' ? '' : ` ${finding.kind}`}
              <Text dimColor>
                {' '}
                · {finding.file}
                {finding.line > 0 ? `:${finding.line}` : ''}
                {about === '' ? '' : ` · ${about}`}
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
        {waiting > 0 && (
          <Text>
            <Text color="error">{plural(waiting, 'finding')} open.</Text> Fix and commit, then review again; or dismiss each with a reason.
          </Text>
        )}
        {(now?.kind === 'ready' || now?.kind === 'approval') && <Text color="success">Nothing open: ready for a pull request.</Text>}
        {now?.kind === 'approval' && <Text color="warning">High risk: the gate asks you to approve it.</Text>}
        {moved && <Text color="warning">Commits since this round have not been reviewed.</Text>}
      </Box>
    </Box>
  )
}
