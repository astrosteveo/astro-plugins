import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { MenuView } from '../types'
import { deleteMemory, readIndex } from './files'
import { entries, indexUsage, isName, memoryParts } from './memory'

export const MENU = 'global-memory'

const LIST: MenuView = { kind: 'list' }

// Change the tag when MenuView changes: a value an earlier version stored outlives a reload.
const view = atom({ plugin: 'global-memory', key: 'view' } as const, LIST, { shape: 'view-1' })

// The memories the index lists, then the files it doesn't list, which no session loads.
async function memories($: EngineInterface, dir: string) {
  const index = await readIndex($, dir).catch(() => '')
  const listed = entries(index)
  const onDisk = (await $.fs.list(dir).catch(() => []))
    .filter(f => f.kind === 'file' && f.name.endsWith('.md'))
    .map(f => f.name.slice(0, -3))
    .filter(isName)
  const unlisted = onDisk.filter(name => !listed.some(m => m.name === name))
  return {
    index,
    listed: listed.map(m => ({ ...m, isMissing: !onDisk.includes(m.name) })),
    unlisted,
  }
}

// Registered at session start, by the plugin's one session.start hook.
export const MENU_COMMAND = { name: MENU, description: 'Browse, read and delete your global memories' }

// `dir` is where the global memory is, as session.start found it.
export function menu(on: On, dir: () => string) {
  on('command.run', { command: MENU }, async $ => {
    await update($, view, () => LIST)
    const opened = await $.ui.open({ id: MENU, title: 'Global memory', focus: true, closeOnEscape: true })
    return { text: opened.isPlaced ? 'Opened the global memory menu.' : `The global memory menu is waiting to open: ${opened.reason}` }
  })

  on('ui.render', { component: 'Pane', requestId: MENU }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const folder = dir()
    if (folder === '') return <Text>Neither CLAUDE_CONFIG_DIR nor HOME is set, so there is no global memory.</Text>
    const shown = await read($, view)
    const go = (to: MenuView) => () => void update($, view, () => to)
    const { index, listed, unlisted } = await memories($, folder)

    if (shown.kind === 'list') {
      const count = listed.length + unlisted.length
      const row = (name: string, title: string, detail: string, first: boolean) => (
        <Button key={`memory:${name}`} plain {...(first ? { autoFocus: true as const } : {})} onPress={go({ kind: 'memory', name })}>
          {title} <Text dimColor>{detail}</Text>
        </Button>
      )
      return (
        <Box flexDirection="column">
          <Text dimColor>
            {count === 1 ? '1 memory' : `${count} memories`} · index {indexUsage(index)}
          </Text>
          {shown.notice !== undefined && <Text color={shown.isError ? 'error' : 'success'}>{shown.notice}</Text>}
          {count === 0 && <Text dimColor>No global memories yet. Claude saves one when you correct it or state a preference that holds in every project.</Text>}
          {listed.map((m, i) => row(m.name, m.title, `— ${m.description}${m.isMissing ? ' (its file is gone)' : ''}`, i === 0))}
          {unlisted.length > 0 && <Text dimColor>Not in the index, so no session loads them:</Text>}
          {unlisted.map((name, i) => row(name, name, '', listed.length === 0 && i === 0))}
        </Box>
      )
    }

    const entry = listed.find(m => m.name === shown.name)
    const title = entry?.title ?? shown.name

    if (shown.kind === 'confirm') {
      const remove = async () => {
        const done = await deleteMemory($, folder, shown.name)
        const after: MenuView = 'result' in done ? { kind: 'list', notice: `Deleted "${title}".` } : { kind: 'list', notice: done.deny, isError: true }
        await update($, view, () => after)
      }
      return (
        <Box flexDirection="column" gap={1}>
          <Text>
            Delete global memory "{title}"? Its file and its index line go, and no later session loads it.
          </Text>
          <Box flexDirection="row" gap={1}>
            <Button key="cancel" hotkey="n" autoFocus onPress={go({ kind: 'memory', name: shown.name })}>
              Cancel
            </Button>
            <Button key="confirm" hotkey="y" onPress={() => void remove()}>
              Delete
            </Button>
          </Box>
        </Box>
      )
    }

    const file = `${folder}/${shown.name}.md`
    const text = await $.fs.read(file).catch(() => undefined)
    const parts = typeof text === 'string' ? memoryParts(text) : undefined
    const facts = [parts?.type, parts?.modified && `saved ${parts.modified.slice(0, 10)} ${parts.modified.slice(11, 16)} UTC`, file].filter(Boolean).join(' · ')
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text weight="semibold">{title}</Text>
          <Text dimColor>{facts}</Text>
          {entry !== undefined && <Text dimColor>{entry.description}</Text>}
        </Box>
        <Box flexDirection="row" gap={1}>
          <Button key="back" hotkey="b" autoFocus onPress={go(LIST)}>
            Back
          </Button>
          <Button key="delete" hotkey="d" onPress={go({ kind: 'confirm', name: shown.name })}>
            Delete
          </Button>
        </Box>
        {parts === undefined ? (
          <Text dimColor>Its file is gone; only its index line is left.</Text>
        ) : (
          <Markdown text={parts.body} />
        )}
      </Box>
    )
  })
}
