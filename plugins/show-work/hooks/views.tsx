// The Context, Tests, Files and Commits tabs. Each takes the elements of the
// surface it draws on, with a Raster where the surface has one, and the data.

import type { Color, Elements, RenderElement } from 'claude-code'

import type { CommitRow, GitFile, GitState, Job, Meter, Preview, Search, TestRun, Touch, Turn } from '../types'
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
            <Text dimColor>
              {' '}
              {shown.hit === undefined ? `${shown.lines} lines` : `line ${shown.hit} of ${shown.lines}`}
            </Text>
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
          <Code source={shown.source === '' ? ' ' : shown.source} path={shown.file} startLine={shown.start ?? 1} />
        )}
        {shown.isCut && (
          <Text dimColor>
            … lines {shown.start ?? 1} to {(shown.start ?? 1) + shown.source.split('\n').length - 1}
          </Text>
        )}
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

const since = (ms: number) => {
  const sec = Math.max(0, Math.round(ms / 1000))

  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s`
}

const JOB_MARK: Record<Job['status'], { mark: string; color: Color }> = {
  running: { mark: '…', color: 'warning' },
  ok: { mark: '✓', color: 'success' },
  failed: { mark: '✗', color: 'error' },
  stopped: { mark: '■', color: 'inactive' },
}

// A line of output's color: errors red, warnings yellow, the rest as is.
const lineColor = (line: string): Color | undefined =>
  /\b(error|fail(ed|ure)?|panic|exception)\b/i.test(line)
    ? 'error'
    : /\bwarn(ing)?\b/i.test(line)
      ? 'warning'
      : undefined

// Commands you start from the pane: a field to type one, the recent ones to
// run again, and the chosen one's output as it streams, to stop or hand to
// Claude.
export function runView(
  { Box, Text, Button, Input }: Kit & { Input?: Elements['terminal']['Input'] },
  data: {
    jobs: Job[]
    picked: string | null
    now: number
    onRun: (command: string) => () => void
    onPick: (id: string) => () => void
    onStop: (id: string) => () => void
    onAsk: (job: Job) => () => void
  },
): RenderElement {
  const job = data.jobs.find(one => one.id === data.picked) ?? data.jobs.at(-1)
  const recent = [...new Set(data.jobs.map(one => one.command).reverse())].slice(0, 5)

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        {Input !== undefined && (
          <Input
            key="run-cmd"
            placeholder="run a command: bun test, godot --headless --export-release …"
            submitLabel="run"
            onSubmit={value => {
              if (value.trim() !== '') {
                data.onRun(value.trim())()
              }
            }}
          />
        )}
        {recent.length > 0 && (
          <Box flexDirection="row" columnGap={2} flexWrap="wrap">
            <Text dimColor>again:</Text>
            {recent.map((command, i) => (
              <Button key={`run-again-${i}`} plain dimColor onPress={data.onRun(command)}>
                {command.length > 40 ? command.slice(0, 39) + '…' : command}
              </Button>
            ))}
          </Box>
        )}
      </Box>
      {job === undefined ? (
        <Text dimColor>Nothing run yet. Type a command above and press Enter; its output streams here.</Text>
      ) : (
        <Box flexDirection="column">
          <Box flexDirection="column">
            {data.jobs
              .slice(-5)
              .reverse()
              .map(one => (
                <Button key={`job-${one.id}`} plain dimColor={one.id !== job.id} onPress={data.onPick(one.id)}>
                  <Text color={JOB_MARK[one.status].color}>{JOB_MARK[one.status].mark}</Text> {one.command}
                  <Text dimColor>
                    {' '}
                    {since((one.end ?? data.now) - one.start)}
                    {one.code === undefined || one.code === null || one.code === 0 ? '' : ` · exit ${one.code}`}
                  </Text>
                </Button>
              ))}
          </Box>
          <Box flexDirection="row" gap={2}>
            {job.status === 'running' && (
              <Button key="run-stop" variant="secondary" hotkey="k" onPress={data.onStop(job.id)}>
                ■ stop
              </Button>
            )}
            <Button key="run-rerun" plain dimColor hotkey="e" onPress={data.onRun(job.command)}>
              ↻ again
            </Button>
            <Button key="run-ask" plain dimColor hotkey="a" onPress={data.onAsk(job)}>
              → ask Claude
            </Button>
            <Text dimColor>
              {job.total} lines{job.total > job.output.length ? `, last ${job.output.length} kept` : ''}
            </Text>
          </Box>
          <Box flexDirection="column">
            {job.output.slice(-40).map((line, i) => (
              <Text key={`out-${i}`} wrap="truncate-end" color={lineColor(line)}>
                {line === '' ? ' ' : line}
              </Text>
            ))}
          </Box>
        </Box>
      )}
    </Box>
  )
}

// What git says of a file in a word, by its columns.
const gitWord = (file: GitFile) => {
  const code = file.index === '?' ? '?' : file.index !== ' ' ? file.index : file.worktree

  return { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', U: 'conflict', '?': 'new' }[code] ?? code
}

// The working tree as git sees it: staged above, unstaged and new below;
// press a file to stage or unstage it, ± for its diff, then commit and push.
export function gitView(
  { Box, Text, Button, Input }: Kit & { Input?: Elements['terminal']['Input'] },
  data: {
    state: GitState | null
    onToggle: (file: GitFile) => () => void
    onDiff: (path: string) => () => void
    onStageAll: () => void
    onUnstageAll: () => void
    onCommit: (message: string) => () => void
    onPush: () => void
    onRefresh: () => void
  },
): RenderElement {
  const state = data.state
  if (state === null) {
    return <Text dimColor>Not a git repository.</Text>
  }
  const staged = state.files.filter(file => file.index !== ' ' && file.index !== '?')
  const unstaged = state.files.filter(file => file.worktree !== ' ' && file.index !== '?')
  const fresh = state.files.filter(file => file.index === '?')
  const row = (file: GitFile, isStaged: boolean) => (
    <Box key={`git-${isStaged ? 's' : 'w'}-${file.path}`} flexDirection="row" gap={1}>
      <Button key={`git-${isStaged ? 's' : 'w'}-${file.path}`} plain onPress={data.onToggle(file)}>
        <Text color={isStaged ? 'success' : file.index === '?' ? 'suggestion' : 'warning'}>
          {isStaged ? '●' : '○'}
        </Text>{' '}
        {file.path} <Text dimColor>{gitWord(file)}</Text>
      </Button>
      {file.index !== '?' && (
        <Button key={`git-diff-${isStaged ? 's' : 'w'}-${file.path}`} plain dimColor onPress={data.onDiff(file.path)}>
          ±
        </Button>
      )}
    </Box>
  )
  const section = (title: string, files: GitFile[], isStaged: boolean) =>
    files.length > 0 && (
      <Box flexDirection="column">
        <Text weight="bold">
          {title} <Text dimColor>{files.length}</Text>
        </Text>
        {files.slice(0, 40).map(file => row(file, isStaged))}
      </Box>
    )

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" columnGap={2} flexWrap="wrap">
        <Text>
          <Text color="claude" weight="bold">
            ⎇ {state.branch || 'detached'}
          </Text>
          {state.ahead > 0 && <Text color="success"> ↑{state.ahead}</Text>}
          {state.behind > 0 && <Text color="warning"> ↓{state.behind}</Text>}
        </Text>
        <Button key="git-all" plain dimColor hotkey="a" onPress={data.onStageAll}>
          stage all
        </Button>
        <Button key="git-none" plain dimColor hotkey="z" onPress={data.onUnstageAll}>
          unstage all
        </Button>
        {state.ahead > 0 && (
          <Button key="git-push" plain dimColor hotkey="p" onPress={data.onPush}>
            push
          </Button>
        )}
        <Button key="git-refresh" plain dimColor hotkey="r" onPress={data.onRefresh}>
          ↻
        </Button>
      </Box>
      {state.note !== undefined && (
        <Text color={state.isNoteError === true ? 'error' : 'success'} wrap="truncate-end">
          {state.note}
        </Text>
      )}
      {state.files.length === 0 ? (
        <Text dimColor>Nothing to commit: the working tree is clean.</Text>
      ) : (
        <Box flexDirection="column" gap={1}>
          {section('Staged', staged, true)}
          {section('Changed', unstaged, false)}
          {section('New', fresh, false)}
        </Box>
      )}
      {staged.length > 0 && Input !== undefined && (
        <Input
          key="git-msg"
          placeholder={`commit ${staged.length} staged file${staged.length === 1 ? '' : 's'}: message…`}
          submitLabel="commit"
          onSubmit={value => {
            if (value.trim() !== '') {
              data.onCommit(value.trim())()
            }
          }}
        />
      )}
    </Box>
  )
}

// A search of the project's text: the hits by file, each opening the file
// at that line in the Explorer's preview.
export function searchView(
  { Box, Text, Button, Input }: Kit & { Input?: Elements['terminal']['Input'] },
  data: {
    search: Search | null
    onSearch: (query: string) => () => void
    onOpen: (file: string, line?: number) => () => void
  },
): RenderElement {
  const found = data.search
  const byFile = new Map<string, { line: number; text: string }[]>()
  for (const hit of found?.hits ?? []) {
    byFile.set(hit.file, [...(byFile.get(hit.file) ?? []), hit])
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        {Input !== undefined && (
          <Input
            key="search-q"
            placeholder="search the project's text (regex, smart case)…"
            value={found?.query ?? ''}
            submitLabel="search"
            onSubmit={value => data.onSearch(value)()}
          />
        )}
        {found !== null && found.query !== '' && (
          <Text dimColor>
            {found.error !== undefined
              ? found.error
              : `${found.hits.length}${found.isCut ? '+' : ''} hits in ${byFile.size} file${byFile.size === 1 ? '' : 's'}`}
          </Text>
        )}
      </Box>
      {found === null || found.query === '' ? (
        <Text dimColor>Type a word or a pattern and press Enter. A hit opens its file at that line.</Text>
      ) : (
        <Box flexDirection="column">
          {[...byFile].slice(0, 40).map(([file, hits]) => (
            <Box key={`hits-${file}`} flexDirection="column">
              <Button key={`hit-file-${file}`} plain onPress={data.onOpen(file)}>
                <Text color="suggestion" weight="bold">
                  {file}
                </Text>{' '}
                <Text dimColor>{hits.length}</Text>
              </Button>
              {hits.slice(0, 8).map(hit => (
                <Button key={`hit-${file}:${hit.line}`} plain dimColor onPress={data.onOpen(file, hit.line)}>
                  <Text color="warning">{String(hit.line).padStart(5)}</Text> {hit.text}
                </Button>
              ))}
            </Box>
          ))}
        </Box>
      )}
    </Box>
  )
}
