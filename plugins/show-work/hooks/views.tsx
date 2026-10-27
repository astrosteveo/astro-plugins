// The Tests, Git and Find views. Each takes the elements of the
// surface it draws on, with a Raster where the surface has one, and the data.

import type { Color, Elements, RenderElement } from 'claude-code'

import type { GitFile, GitState, Preview, Search, TestRun, Touch } from '../types'
import { hitItems, matches, mdBlocks, splitFences, treeRows } from './explorer'

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
  Code: Elements['terminal']['Code']
  Markdown: Elements['terminal']['Markdown']
  Image?: Elements['terminal']['Image']
  // Where the terminal has one: the viewer the pointer can drag over.
  Client?: Elements['terminal']['Client']
}

const MD_IMAGE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g
const LOCAL_LINK = /\]\(\s*<?(?![a-z][a-z0-9+.-]*:|#|\/\/)([^)\s>]+)/gi

// `line 4` or `lines 4 to 9`.
export const rangeLabel = (from: number, to: number) => (from === to ? `line ${from}` : `lines ${from} to ${to}`)

// Code or a diff in the viewer a drag can pick lines in, with the chip that
// offers to ask about them; plain code where the surface has no Client.
export function Viewer({
  kit,
  id,
  source,
  path,
  startLine,
  format = 'source',
  isWrapped,
  sel,
  label,
  onClearChip,
}: {
  kit: Pick<ExplorerKit, 'Box' | 'Text' | 'Button' | 'Code' | 'Client'>
  id: string
  source: string
  path: string
  startLine: number
  format?: 'source' | 'diff'
  isWrapped: boolean
  sel: { from: number; to: number } | null
  label: string
  onClearChip: () => void
}) {
  const { Box, Text, Button, Code, Client } = kit
  if (Client === undefined) {
    return (
      <Code
        source={source === '' ? ' ' : source}
        path={path}
        {...(format === 'diff' ? { format } : { startLine })}
        wrap={isWrapped ? 'wrap' : 'truncate-end'}
      />
    )
  }

  // What the drag put in the prompt rides above the lines, where a long file cannot push it off screen.
  return (
    <Box flexDirection="column">
      {sel !== null && (
        <Box flexDirection="row" columnGap={2}>
          <Text dimColor>In your prompt: {label}</Text>
          <Button key="chip-clear" plain dimColor onPress={onClearChip}>
            ✗ drop it
          </Button>
        </Box>
      )}
      <Client
        key={`viewer-${format}`}
        module="./viewer.tsx"
        props={{ id, source, path, startLine, format, isWrapped, sel }}
      />
    </Box>
  )
}

// An image file as a picture, sized to the pane; elsewhere its name and size.
function imageBody(
  { Box, Text, Image }: ExplorerKit,
  shown: Preview,
  data: { place: (size: { width: number; height: number }) => { columns: number; rows: number } },
) {
  const one = shown.images?.[0]
  if (one === undefined) {
    return <Text dimColor>No picture.</Text>
  }

  return (
    <Box flexDirection="column">
      {Image === undefined ? (
        <Text dimColor>An image, {one.width}x{one.height}; this surface cannot draw it.</Text>
      ) : (
        <Image key="view-pic" source={{ file: one.file, format: 'png' }} {...data.place(one)} alt={one.alt || ' '} />
      )}
      <Text dimColor>
        {one.width}x{one.height}
      </Text>
    </Box>
  )
}

// A markdown file as the screen draws it: its prose as markdown, its local
// pictures as pictures, in the order the file has them.
function markdownBlocks(
  { Box, Text, Button, Image, Client }: ExplorerKit,
  shown: Preview,
  data: {
    onLink: (href: string) => void
    place: (size: { width: number; height: number }) => { columns: number; rows: number }
    rows: number[]
    sel: { from: number; to: number } | null
  },
) {
  const blocks = mdBlocks(shown.source, shown.images?.map(one => one.ref) ?? [])
  const heights = blocks.map((block, index) => {
    if (block.kind !== 'image') {
      return data.rows[index] ?? 1
    }
    const picture = shown.images?.find(one => one.ref === block.ref)

    return (picture === undefined || Image === undefined ? 0 : data.place(picture).rows) + (block.alt === '' ? 0 : 1)
  })

  // A block is drawn in a region of its own, which cannot answer a link; links to
  // files of the project are listed below the file instead.
  const links = [...new Set([...shown.source.matchAll(LOCAL_LINK)].map(one => one[1] ?? ''))].filter(one => one !== '')

  return (
    <Box flexDirection="column" gap={1}>
      {blocks.map((block, index) => {
        if (block.kind === 'image') {
          const picture = shown.images?.find(one => one.ref === block.ref)
          if (picture === undefined || Image === undefined) {
            return null
          }

          return (
            <Box key={`md-img-${index}`} flexDirection="column">
              <Image
                key={`md-pic-${index}`}
                source={{ file: picture.file, format: 'png' }}
                {...data.place(picture)}
                alt={block.alt || ' '}
              />
              {block.alt !== '' && <Text dimColor>{block.alt}</Text>}
            </Box>
          )
        }

        return Client === undefined ? null : (
          <Client
            key={`md-block-${index}`}
            module="./md.tsx"
            props={{
              file: shown.file,
              index,
              kind: block.kind,
              text: block.text,
              lang: block.kind === 'code' ? block.lang : '',
              heights,
              sel: data.sel,
            }}
          />
        )
      })}
      {links.length > 0 && (
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          <Text dimColor>links:</Text>
          {links.slice(0, 12).map(href => (
            <Button key={`md-link-${href}`} plain onPress={() => data.onLink(href)}>
              → {href}
            </Button>
          ))}
        </Box>
      )}
    </Box>
  )
}

function markdownBody(
  { Box, Text, Markdown, Image, Code }: ExplorerKit,
  shown: Preview,
  data: { wraps: boolean; place: (size: { width: number; height: number }) => { columns: number; rows: number }; onLink: (href: string) => void },
) {
  const parts: (
    | { text: string }
    | { image: NonNullable<Preview['images']>[number] }
    | { code: string; lang: string }
  )[] = []
  let at = 0
  let text = ''
  for (const match of shown.source.matchAll(MD_IMAGE)) {
    const image = Image === undefined ? undefined : shown.images?.find(one => one.ref === match[2])
    if (image === undefined) {
      continue
    }
    text += shown.source.slice(at, match.index)
    at = (match.index ?? 0) + match[0].length
    parts.push({ text }, { image })
    text = ''
  }
  parts.push({ text: text + shown.source.slice(at) })
  // Fenced code is drawn as highlighted code; the prose between as markdown.
  const drawn: typeof parts = parts.flatMap((part): typeof parts => ('text' in part ? splitFences(part.text) : [part]))
  const links = [...new Set([...shown.source.matchAll(LOCAL_LINK)].map(one => one[1] ?? ''))].filter(one => one !== '')

  return (
    <Box flexDirection="column">
      {drawn.map((part, n) =>
        'code' in part ? (
          <Box key={`md-code-${n}`} flexDirection="column" marginY={1}>
            <Code
              source={part.code === '' ? ' ' : part.code}
              {...(part.lang === '' ? {} : { language: part.lang })}
              wrap={data.wraps ? 'wrap' : 'truncate-end'}
            />
          </Box>
        ) : 'image' in part ? (
          Image === undefined ? null : (
            <Box key={`md-img-${n}`} flexDirection="column">
              <Image
                key={`md-pic-${n}`}
                source={{ file: part.image.file, format: 'png' }}
                {...data.place(part.image)}
                alt={part.image.alt || ' '}
              />
              {part.image.alt !== '' && <Text dimColor>{part.image.alt}</Text>}
            </Box>
          )
        ) : part.text.trim() === '' ? null : (
          <Markdown
            key={`md-${n}`}
            text={part.text}
            {...(links.length === 0 ? {} : { pressableLinks: links, onLinkPress: link => data.onLink(link.href) })}
          />
        ),
      )}
    </Box>
  )
}

// The project's files: a tree to walk, a filter that finds a file by a few
// of its letters, and a preview with a button that mentions it in the prompt.
export function explorerView(
  kit: ExplorerKit,
  data: {
    files: string[]
    codes: Record<string, string>
    touched: Touch[]
    open: string[]
    filter: string
    preview: Preview | null
    onToggle: (dir: string) => () => void
    onOpen: (file: string) => () => void
    onClose: () => void
    onMention: (file: string) => () => void
    onDiff: (file: string) => () => void
    onRefresh: () => void
    onRaw: () => void
    // Rendered markdown, block by block: the rows each drew at, and the blocks dragged over.
    mdRows: number[]
    mdSel: { from: number; to: number } | null
    wraps: boolean
    onWrap: () => void
    // The lines dragged over, 0-based, and what the chip does with them.
    sel: { from: number; to: number } | null
    onClearChip: () => void
    onLink: (href: string) => void
    place: (size: { width: number; height: number }) => { columns: number; rows: number }
  },
): RenderElement {
  const { Box, Text, Button } = kit
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
              {shown.isImage === true
                ? 'image'
                : shown.hit === undefined
                  ? `${shown.lines} lines`
                  : `line ${shown.hit} of ${shown.lines}`}
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
            {shown.isMarkdown === true && (
              <Button key="ex-raw" variant="secondary" hotkey="v" onPress={data.onRaw}>
                {shown.isRaw === true ? 'rendered' : 'source'}
              </Button>
            )}
            {shown.isImage !== true && shown.isBinary !== true && (shown.isMarkdown !== true || shown.isRaw === true) && (
              <Button key="ex-wrap" plain dimColor hotkey="w" onPress={data.onWrap}>
                wrap: {data.wraps ? 'on' : 'off'}
              </Button>
            )}
            <Button key="ex-close" plain dimColor hotkey="x" onPress={data.onClose}>
              ✗ close
            </Button>
          </Box>
        </Box>
        {shown.isBinary ? (
          <Text dimColor>A binary file: nothing to preview.</Text>
        ) : shown.isImage === true ? (
          imageBody(kit, shown, data)
        ) : shown.isMarkdown === true && shown.isRaw !== true ? (
          kit.Client === undefined ? markdownBody(kit, shown, data) : markdownBlocks(kit, shown, { place: data.place, onLink: data.onLink, rows: data.mdRows, sel: data.mdSel })
        ) : (
          <Viewer
            kit={kit}
            id={shown.file}
            source={shown.source}
            path={shown.file}
            startLine={shown.start ?? 1}
            isWrapped={data.wraps}
            sel={data.sel}
            label={data.sel === null ? '' : rangeLabel((shown.start ?? 1) + data.sel.from, (shown.start ?? 1) + data.sel.to)}
            onClearChip={data.onClearChip}
          />
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
  { Box, Text, Button }: Kit,
  data: {
    search: Search | null
    onSearch: (query: string) => () => void
    onOpen: (file: string, line?: number) => () => void
    // Where the terminal has one: the list the pointer can drag over, and the rows dragged.
    Client?: Elements['terminal']['Client']
    sel: { from: number; to: number } | null
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
      ) : data.Client !== undefined ? (
        <data.Client
          key="search-hits"
          module="./hits.tsx"
          props={{ items: hitItems(found.hits), sel: data.sel }}
        />
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
