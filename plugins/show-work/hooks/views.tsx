// The Tests, Git and Find views. Each takes the elements of the
// surface it draws on, with a Raster where the surface has one, and the data.

import type { Color, Elements, RenderElement } from 'claude-code'

import type { GitFile, GitState, Preview, Search, TestRun, Touch } from '../types'
import { matches, treeRows } from './explorer'

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

export function testsView(
  { Box, Text, Button }: Kit,
  { runs, now, onFix }: { runs: TestRun[]; now: number; onFix?: (run: TestRun) => () => void },
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
  const failing = last.names.filter(one => !one.ok)

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
      {!isGreen && onFix !== undefined && (
        <Button key="tests-fix" hotkey="x" variant="primary" onPress={onFix(last)}>
          Fix these (x)
        </Button>
      )}
      {failing.length > 0 && (
        <Box flexDirection="column">
          {failing.slice(0, 15).map(one => (
            <Text key={`fail-${one.name}`} color="error" wrap="truncate-end">
              ✗ {one.name}
            </Text>
          ))}
          {failing.length > 15 && <Text dimColor>… {failing.length - 15} more</Text>}
        </Box>
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
