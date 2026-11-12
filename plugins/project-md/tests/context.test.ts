import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { LEAD } from '../hooks/register'

const REPO = '/home/u/game'
const PROJECT_MD = `${REPO}/PROJECT.md`
const CLAUDE_MD = { path: `${REPO}/CLAUDE.md`, kind: 'project' as const, content: 'Use uv.' }

type Disk = {
  // The repo the session runs in; null outside one.
  repo?: string | null
  // The session's own folder.
  root?: string
  files?: Record<string, string>
  // PROJECT.md is there but reading it fails, as for want of permission.
  unreadable?: boolean
}

// An engine whose disk holds `files`; `reads` lists each file the hook read.
function engine(on: On, disk: Disk = {}) {
  const files = new Map(Object.entries(disk.files ?? {}))
  const reads: string[] = []
  const repo = disk.repo === undefined ? REPO : disk.repo
  on('session.repo', () => ({ value: repo === null ? null : { root: repo, remote: null, internal: false, name: null } }))
  on('session.root', () => ({ value: disk.root ?? REPO }))
  on('fs.exists', (_, e) => ({ value: files.has(String(e.path)) }))
  on('fs.read', (_, e) => {
    reads.push(String(e.path))
    const text = files.get(String(e.path))
    if (disk.unreadable) throw new Error('EACCES: permission denied')
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('prompt.context', (_, e) => ({ blocks: e.blocks, instructionFiles: e.instructionFiles }))
  return { reads }
}

// The instruction files the first message carries, the repo's CLAUDE.md first.
const context = async ($: any, files: unknown[] | undefined = [CLAUDE_MD]) =>
  (await $.prompt.context({ blocks: [{ name: 'claudeMd', text: 'claude md' }], instructionFiles: files })).instructionFiles

test('the root PROJECT.md joins the instruction files as a project file', async ($, on) => {
  engine(on, { files: { [PROJECT_MD]: '# game\n\nA puzzle game.\n' } })
  expect(await context($)).toEqual([
    CLAUDE_MD,
    { path: PROJECT_MD, kind: 'project', content: `${LEAD}\n\n# game\n\nA puzzle game.` },
  ])
})

test('it says to raise a request that conflicts with the scope, as the import line did', async () => {
  expect(LEAD).toContain('If a request conflicts with its non-goals or constraints, say so before starting.')
})

test('a repo with no PROJECT.md is left as it was, and nothing is read', async ($, on) => {
  const { reads } = engine(on)
  expect(await context($)).toEqual([CLAUDE_MD])
  expect(reads).toEqual([])
})

test('with no CLAUDE.md at all, PROJECT.md is the one instruction file', async ($, on) => {
  engine(on, { files: { [PROJECT_MD]: 'A puzzle game.' } })
  expect(await context($, [])).toEqual([{ path: PROJECT_MD, kind: 'project', content: `${LEAD}\n\nA puzzle game.` }])
})

test('a session in a subfolder loads the PROJECT.md at the repo root', async ($, on) => {
  engine(on, { root: `${REPO}/src/levels`, files: { [PROJECT_MD]: 'A puzzle game.' } })
  expect(((await context($)) ?? []).map((file: { path: string }) => file.path)).toEqual([CLAUDE_MD.path, PROJECT_MD])
})

test('outside a git repo, PROJECT.md is read from the session folder', async ($, on) => {
  engine(on, { repo: null, root: '/home/u/notes/', files: { '/home/u/notes/PROJECT.md': 'Notes.' } })
  expect(((await context($)) ?? []).map((file: { path: string }) => file.path)).toEqual([CLAUDE_MD.path, '/home/u/notes/PROJECT.md'])
})

test('a PROJECT.md a CLAUDE.md already imports is not added twice', async ($, on) => {
  const { reads } = engine(on, { files: { [PROJECT_MD]: 'A puzzle game.' } })
  const imported = { path: PROJECT_MD, kind: 'project' as const, content: 'A puzzle game.', parent: CLAUDE_MD.path }
  expect(await context($, [CLAUDE_MD, imported])).toEqual([CLAUDE_MD, imported])
  expect(reads).toEqual([])
})

test('an empty PROJECT.md adds nothing', async ($, on) => {
  engine(on, { files: { [PROJECT_MD]: ' \n' } })
  expect(await context($)).toEqual([CLAUDE_MD])
})

test('when a hook below rewrote the CLAUDE.md text, its files stay unknown', async ($, on) => {
  engine(on, { files: { [PROJECT_MD]: 'A puzzle game.' } })
  const rewritten = await $.prompt.context({ blocks: [{ name: 'claudeMd', text: 'rewritten' }] })
  expect(rewritten.instructionFiles).toBeUndefined()
})

test('a PROJECT.md that cannot be read leaves the session as it was', async ($, on) => {
  engine(on, { files: { [PROJECT_MD]: 'A puzzle game.' }, unreadable: true })
  expect(await context($)).toEqual([CLAUDE_MD])
})
