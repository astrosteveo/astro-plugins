// The Context, Tests, Files and Commits tabs. Each takes the elements of the
// surface it draws on, with a Raster where the surface has one, and the data.

import type { Color, Elements, RenderElement } from 'claude-code'

import type { CommitRow, Meter, Preview, TestRun, Touch, Turn } from '../types'
import { matches, treeRows } from './explorer'
import {
  PALETTE,
  area,
  gauge,
  legend,
  scoreboard,
  stacked,
  tokens,
  touchColor,
  treemap,
} from './charts'

export type Kit = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'> & {
  Raster?: Elements['terminal']['Raster']
}

export function ago(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) {
    return `${s}s ago`
  }

  return s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`
}

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1)

export function contextView(
  { Box, Text, Raster }: Kit,
  { shown, turns, columns }: { shown: Meter | null; turns: Turn[]; columns: number },
): RenderElement {
  if (shown === null) {
    return <Text dimColor>No reading yet. The meter fills after Claude's next answer.</Text>
  }
  const used = shown.tokens ?? 0
  const fraction = used / Math.max(1, shown.window)
  const mark = shown.buffer === undefined ? undefined : (shown.window - shown.buffer) / shown.window
  const charted = turns.filter(turn => turn.context !== undefined)
  const last = turns.findLast(turn => turn.usage !== undefined)
  const color: Color = fraction < 0.5 ? 'success' : fraction < 0.8 ? 'warning' : 'error'

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text>
          <Text weight="bold">Context</Text>{' '}
          <Text color={color} weight="bold">
            {shown.percent ?? Math.round(fraction * 100)}%
          </Text>{' '}
          {tokens(used)} / {tokens(shown.window)}
          {mark === undefined ? '' : <Text dimColor> · compacts at {tokens(shown.window - (shown.buffer ?? 0))}</Text>}
          {shown.usd === undefined ? '' : <Text dimColor> · ${shown.usd.toFixed(2)} so far</Text>}
        </Text>
        {Raster !== undefined && (
          <Raster key="ctx-gauge" {...gauge(fraction, columns, mark)} />
        )}
      </Box>
      {shown.categories.length > 0 && (
        <Box flexDirection="column">
          <Text weight="bold">What fills it</Text>
          {Raster !== undefined && (
            <Raster
              key="ctx-stack"
              {...stacked(
                shown.categories.map((one, i) => ({ tokens: one.tokens, color: PALETTE[i % PALETTE.length]! })),
                shown.window,
                shown.buffer ?? 0,
                columns,
              )}
            />
          )}
          {shown.categories.map((one, i) =>
            Raster !== undefined ? (
              <Raster
                key={`ctx-cat-${i}`}
                {...legend([[PALETTE[i % PALETTE.length]!, `${one.name}  ${tokens(one.tokens)}`]])}
              />
            ) : (
              <Text key={`ctx-cat-${i}`} dimColor>
                {one.name} {tokens(one.tokens)}
              </Text>
            ),
          )}
        </Box>
      )}
      {charted.length > 0 && (
        <Box flexDirection="column">
          <Text weight="bold">
            After each turn <Text dimColor>{charted.length} turns</Text>
          </Text>
          {Raster !== undefined ? (
            <Raster
              key="ctx-area"
              {...area(
                charted.map(turn => (turn.context ?? 0) / Math.max(1, shown.window)),
                columns,
                8,
                mark,
              )}
            />
          ) : (
            <Text dimColor>{charted.map(turn => tokens(turn.context ?? 0)).join(' → ')}</Text>
          )}
        </Box>
      )}
      {last?.usage !== undefined && (
        <Text dimColor>
          turn {last.n}: {tokens(last.usage.input)} in · {tokens(last.usage.output)} out ·{' '}
          {tokens(last.usage.cacheRead)} cache read · {tokens(last.usage.cacheWrite)} cache write
        </Text>
      )}
      {shown.limits.length > 0 && (
        <Text dimColor>
          limits: {shown.limits.map(one => `${one.kind.replace('_', ' ')} ${Math.round(one.percentUsed)}%`).join(' · ')}
        </Text>
      )}
    </Box>
  )
}

export function testsView(
  { Box, Text, Raster }: Kit,
  { runs, columns, now }: { runs: TestRun[]; columns: number; now: number },
): RenderElement {
  const last = runs.at(-1)
  if (last === undefined) {
    return (
      <Text dimColor>
        No test runs yet. The test commands Claude runs (bun test, pytest, cargo test, claude plugin test and
        the like) land here.
      </Text>
    )
  }
  const isGreen = last.failed === 0 && !last.isError
  const board = scoreboard(runs, columns, 20)

  return (
    <Box flexDirection="column" gap={1}>
      <Text wrap="truncate-end">
        <Text color={isGreen ? 'success' : 'error'} weight="bold">
          {isGreen ? '✓' : '✗'} {last.passed} pass · {last.failed} fail
        </Text>{' '}
        <Text dimColor>
          {last.command} · {ago(now - last.at)}
        </Text>
      </Text>
      {Raster !== undefined && <Raster key="tests-board" {...board} />}
      {board.shaky.size > 0 && (
        <Text color="warning" wrap="truncate-end">
          flaky: {[...board.shaky].join(', ')}
        </Text>
      )}
      <Box flexDirection="column">
        {runs
          .slice(-6)
          .reverse()
          .map(run => (
            <Text key={`run-${run.id}`} wrap="truncate-end" dimColor={run !== last}>
              <Text color={run.failed === 0 && !run.isError ? 'success' : 'error'}>
                {run.failed === 0 && !run.isError ? '✓' : '✗'}
              </Text>{' '}
              {String(run.passed).padStart(4)} pass {String(run.failed).padStart(3)} fail · {run.command}
            </Text>
          ))}
      </Box>
    </Box>
  )
}

export function filesView(
  { Box, Text, Button, Raster }: Kit,
  { list, columns, onOpen }: { list: Touch[]; columns: number; onOpen: (file: string) => () => void },
): RenderElement {
  if (list.length === 0) {
    return <Text dimColor>No files touched yet. Each file Claude reads or edits gets a tile here.</Text>
  }
  const ranked = [...list].sort((a, b) => b.reads + b.edits * 2 - (a.reads + a.edits * 2))

  return (
    <Box flexDirection="column" gap={1}>
      {Raster !== undefined && (
        <Box flexDirection="column">
          <Raster
            key="files-map"
            {...treemap(
              ranked.slice(0, 40).map(touch => ({
                label: basename(touch.file),
                weight: touch.reads + touch.edits * 2,
                color: touchColor(touch.reads, touch.edits),
              })),
              columns,
              12,
            )}
          />
          <Raster
            key="files-key"
            {...legend([
              [touchColor(1, 0), 'read'],
              [touchColor(1, 1), 'both'],
              [touchColor(0, 1), 'edited · size is how often'],
            ])}
          />
        </Box>
      )}
      <Box flexDirection="column">
        {ranked.slice(0, 10).map(touch => (
          <Button key={`touch-${touch.file}`} plain dimColor={touch.edits === 0} onPress={onOpen(touch.file)}>
            <Text color={touch.edits > 0 ? 'warning' : 'suggestion'}>{touch.edits > 0 ? '±' : '·'}</Text>{' '}
            {touch.file}{' '}
            <Text dimColor>
              {touch.reads} read{touch.reads === 1 ? '' : 's'} · {touch.edits} edit{touch.edits === 1 ? '' : 's'}
            </Text>
          </Button>
        ))}
      </Box>
    </Box>
  )
}

// Each column of the graph keeps one color, as git colors its lanes.
const LANES: Color[] = ['claude', 'suggestion', 'success', 'warning', 'error']
const GRAPH: Record<string, string> = { '*': '●', '|': '│', '/': '╱', '\\': '╲' }

export function commitsView(
  { Box, Text, Button }: Kit,
  { rows, onRefresh }: { rows: CommitRow[]; onRefresh: () => void },
): RenderElement {
  const count = rows.filter(row => row.sha !== undefined).length

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" gap={2}>
        <Text weight="bold">
          This session's commits <Text dimColor>{count}</Text>
        </Text>
        <Button key="commits-refresh" plain dimColor hotkey="r" onPress={onRefresh}>
          ↻ refresh
        </Button>
      </Box>
      {count === 0 ? (
        <Text dimColor>No commits since the session began.</Text>
      ) : (
        <Box flexDirection="column">
          {rows.map((row, i) => (
            <Text key={`commit-${row.sha ?? `g${i}`}`} wrap="truncate-end">
              {[...row.graph].map((ch, col) =>
                ch === ' ' ? (
                  ' '
                ) : (
                  <Text color={LANES[Math.floor(col / 2) % LANES.length]}>{GRAPH[ch] ?? ch}</Text>
                ),
              )}
              {row.sha !== undefined && (
                <Text>
                  {' '}
                  <Text color="warning">{row.sha}</Text> {row.subject}
                  {row.refs !== undefined && <Text color="success"> ({row.refs})</Text>}
                  {row.added !== undefined && (
                    <Text>
                      {' '}
                      <Text color="success">+{row.added}</Text> <Text color="error">−{row.removed ?? 0}</Text>
                    </Text>
                  )}
                  <Text dimColor> {row.when}</Text>
                </Text>
              )}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  )
}

// A git status code's color: changed, added or new, deleted.
const STATUS_COLOR: Record<string, Color> = { M: 'warning', A: 'success', '??': 'success', D: 'error', R: 'suggestion' }
const statusColor = (code: string) => STATUS_COLOR[code] ?? STATUS_COLOR[code[0] ?? ''] ?? 'warning'

export type ExplorerKit = Kit & {
  Input?: Elements['terminal']['Input']
  Code: Elements['terminal']['Code']
}

// The project's files: a tree to walk, a filter that finds a file by a few
// of its letters, and a preview with a button that mentions it in the prompt.
export function explorerView(
  { Box, Text, Button, Input, Code }: ExplorerKit,
  data: {
    files: string[]
    codes: Record<string, string>
    touched: Touch[]
    open: string[]
    filter: string
    preview: Preview | null
    onFilter: (text: string) => void
    onToggle: (dir: string) => () => void
    onOpen: (file: string) => () => void
    onClose: () => void
    onMention: (file: string) => () => void
    onDiff: (file: string) => () => void
    onRefresh: () => void
  },
): RenderElement {
  const changed = Object.keys(data.codes).length
  const touch = new Map(data.touched.map(one => [one.file, one]))
  const marks = (path: string) => {
    const code = data.codes[path]
    const mine = touch.get(path)

    return (
      <Text>
        {code !== undefined && <Text color={statusColor(code)}> {code}</Text>}
        {mine !== undefined && (
          <Text color={mine.edits > 0 ? 'claude' : 'suggestion'}> {mine.edits > 0 ? '± edited' : '· read'}</Text>
        )}
      </Text>
    )
  }

  if (data.preview !== null) {
    const shown = data.preview
    const code = data.codes[shown.file]

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text wrap="truncate-end">
            <Text weight="bold">{shown.file}</Text>
            <Text dimColor> {shown.lines} lines</Text>
            {marks(shown.file)}
          </Text>
          <Box flexDirection="row" gap={2}>
            <Button key="ex-mention" variant="primary" hotkey="m" onPress={data.onMention(shown.file)}>
              @ mention
            </Button>
            {code !== undefined && code !== '??' && (
              <Button key="ex-diff" variant="secondary" hotkey="d" onPress={data.onDiff(shown.file)}>
                diff
              </Button>
            )}
            <Button key="ex-close" plain dimColor hotkey="x" onPress={data.onClose}>
              ✗ close
            </Button>
          </Box>
        </Box>
        {shown.isBinary ? (
          <Text dimColor>A binary file: nothing to preview.</Text>
        ) : (
          <Code source={shown.source === '' ? ' ' : shown.source} path={shown.file} startLine={1} />
        )}
        {shown.isCut && <Text dimColor>… the first {shown.source.split('\n').length} lines</Text>}
      </Box>
    )
  }

  const found = data.filter.trim() === '' ? undefined : matches(data.files, data.filter, 40)
  const rows = found === undefined ? treeRows(data.files, new Set(data.open)).slice(0, 120) : []

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        {Input !== undefined && (
          <Input
            key="ex-filter"
            autoFocus
            placeholder="find a file by a few letters…"
            value={data.filter}
            onInput={value => data.onFilter(value)}
            onSubmit={value => {
              const first = matches(data.files, value, 1)[0]
              if (first !== undefined) {
                data.onOpen(first)()
              }
            }}
          />
        )}
        <Box flexDirection="row" gap={2}>
          <Text dimColor>
            {data.files.length} files{changed > 0 ? ` · ${changed} changed` : ''}
          </Text>
          <Button key="ex-refresh" plain dimColor hotkey="r" onPress={data.onRefresh}>
            ↻ refresh
          </Button>
        </Box>
      </Box>
      {data.files.length === 0 ? (
        <Text dimColor>No files found here.</Text>
      ) : found !== undefined ? (
        <Box flexDirection="column">
          {found.length === 0 && <Text dimColor>No file matches.</Text>}
          {found.map(path => (
            <Button key={`ex-${path}`} plain onPress={data.onOpen(path)}>
              <Text dimColor>{path.slice(0, path.lastIndexOf('/') + 1)}</Text>
              <Text weight="bold">{basename(path)}</Text>
              {marks(path)}
            </Button>
          ))}
        </Box>
      ) : (
        <Box flexDirection="column">
          {rows.map(row => (
            <Button
              key={`ex-${row.path}`}
              plain
              dimColor={!row.isDir && data.codes[row.path] === undefined && !touch.has(row.path)}
              onPress={row.isDir ? data.onToggle(row.path) : data.onOpen(row.path)}
            >
              {'  '.repeat(row.depth)}
              {row.isDir ? <Text color="suggestion">{row.isOpen ? '▾ ' : '▸ '}</Text> : '  '}
              {row.isDir ? <Text weight="bold">{row.name}/</Text> : row.name}
              {!row.isDir && marks(row.path)}
            </Button>
          ))}
        </Box>
      )}
    </Box>
  )
}
