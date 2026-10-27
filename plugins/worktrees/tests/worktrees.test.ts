import { expect, test } from 'claude-code/testing'
import {
  type Entry,
  STALE_MS,
  differences,
  isDirty,
  isInside,
  isSweepable,
  judge,
  needsWorktree,
  pickBase,
  slug,
  withExclude,
  worktreeName,
} from '../hooks/worktrees'

test('a task name becomes a short branch-safe name', () => {
  expect(slug('Fix the login bug, please!')).toBe('fix-the-login-bug-please')
  expect(slug('   ')).toBe('task')
  expect(slug('日本語')).toBe('task')
  expect(slug('a'.repeat(100)).length).toBeLessThanOrEqual(28)
  expect(slug('add dark mode to the settings pane and the header')).toBe('add-dark-mode-to-the')
  // One long word has no boundary to cut on.
  expect(slug('x'.repeat(40))).toBe('x'.repeat(28))
  expect(worktreeName('Fix it', '3f9a')).toBe('fix-it-3f9a')
})

test('only a tree with nothing in it counts as clean', () => {
  expect(isDirty('')).toBe(false)
  expect(isDirty('\n')).toBe(false)
  expect(isDirty(' M a.txt\n')).toBe(true)
  expect(isDirty('?? new.txt\n')).toBe(true)
})

test('a worktree is removed only when nothing would be lost', () => {
  expect(judge({ exists: true, dirty: false, unmerged: [] })).toEqual({ remove: true })
  expect(judge({ exists: false, dirty: false, unmerged: [] })).toEqual({ remove: true })
  expect(judge({ exists: true, dirty: true, unmerged: [] })).toEqual({ remove: false, reason: 'uncommitted changes' })
  expect(judge({ exists: true, dirty: false, unmerged: ['HEAD', 'wt/x'] })).toEqual({
    remove: false,
    reason: 'commits not in main (HEAD, wt/x)',
  })
  // Changes win over commits: the person is told about the file first.
  expect(judge({ exists: true, dirty: true, unmerged: ['HEAD'] }).remove).toBe(false)
})

const NOW = 10 * STALE_MS
const entry = (over: Partial<Entry> = {}): Entry => ({
  sessionId: 's1',
  repo: '/r',
  path: '/r/.claude/worktrees/a-1111',
  branch: 'wt/a-1111',
  base: 'main',
  createdAt: NOW - 1000,
  ...over,
})

test('a sweep leaves a running session alone, and takes an ended or long-dead one', () => {
  expect(isSweepable(entry(), NOW, '/elsewhere')).toBe(false)
  expect(isSweepable(entry({ endedAt: NOW - 10 }), NOW, '/elsewhere')).toBe(true)
  expect(isSweepable(entry({ createdAt: NOW - STALE_MS - 1 }), NOW, '/elsewhere')).toBe(true)
  // The session sitting in it is never swept, ended or not.
  expect(isSweepable(entry({ endedAt: NOW - 10 }), NOW, '/r/.claude/worktrees/a-1111/src')).toBe(false)
})

test('a path is inside a directory only on a whole segment', () => {
  expect(isInside('/r/w/a', '/r/w/a')).toBe(true)
  expect(isInside('/r/w/a/src', '/r/w/a')).toBe(true)
  expect(isInside('/r/w/ab', '/r/w/a')).toBe(false)
})

test('the base is main, or origin/main when local main is behind it or absent', () => {
  const both = { defaultBranch: 'main', hasLocal: true, hasRemote: true }
  expect(pickBase({ ...both, localIsBehindRemote: false })).toBe('main')
  expect(pickBase({ ...both, localIsBehindRemote: true })).toBe('origin/main')
  expect(pickBase({ defaultBranch: 'main', hasLocal: false, hasRemote: true, localIsBehindRemote: false })).toBe('origin/main')
  expect(pickBase({ defaultBranch: 'main', hasLocal: true, hasRemote: false, localIsBehindRemote: false })).toBe('main')
  expect(pickBase({ defaultBranch: undefined, hasLocal: false, hasRemote: false, localIsBehindRemote: false })).toBe('HEAD')
})

test('the exclude file gains the worktrees folder once', () => {
  expect(withExclude('')).toBe('/.claude/worktrees/\n')
  expect(withExclude('*.log')).toBe('*.log\n/.claude/worktrees/\n')
  expect(withExclude('*.log\n')).toBe('*.log\n/.claude/worktrees/\n')
  const once = withExclude('*.log\n')
  expect(withExclude(once)).toBe(once)
})

test('a call waits for a worktree when it changes a file, or runs a command the engine does not call read-only', () => {
  const real = { tool_use_id: 't1' }
  expect(needsWorktree({ ...real, tool: 'Write' })).toBe(true)
  expect(needsWorktree({ ...real, tool: 'Edit' })).toBe(true)
  expect(needsWorktree({ ...real, tool: 'NotebookEdit' })).toBe(true)
  expect(needsWorktree({ ...real, tool: 'Bash' })).toBe(true)
  expect(needsWorktree({ ...real, tool: 'Bash', isReadOnly: true })).toBe(false)
  // Reading, searching and asking are no change.
  for (const tool of ['Read', 'Grep', 'Glob', 'Agent', 'WebFetch', 'mcp__worktrees__start']) {
    expect(needsWorktree({ ...real, tool })).toBe(false)
  }
  // A subagent's command is let through; its file change is not.
  expect(needsWorktree({ ...real, tool: 'Bash', agentId: 'a1' })).toBe(false)
  expect(needsWorktree({ ...real, tool: 'Write', agentId: 'a1' })).toBe(true)
  // A query from another plugin is no call.
  expect(needsWorktree({ tool: 'Write' })).toBe(false)
})

test('the main checkout is called different only when it is on another commit or has changes', () => {
  const same = { branch: 'main', sha: 'a1', hasChanges: false, base: 'main', baseSha: 'a1' }
  expect(differences(same)).toEqual([])
  expect(differences({ ...same, sha: 'b2', branch: 'feature-x' })).toEqual([
    'The main checkout is on feature-x, a different commit from main, where the worktree was cut.',
  ])
  expect(differences({ ...same, sha: 'b2', branch: '' })[0]).toContain('a detached HEAD')
  expect(differences({ ...same, hasChanges: true })).toEqual([
    'The main checkout has uncommitted changes, which the worktree does not have.',
  ])
  expect(differences({ ...same, sha: 'b2', hasChanges: true })).toHaveLength(2)
  // A base git could not resolve says nothing about a commit.
  expect(differences({ ...same, baseSha: undefined, sha: 'b2' })).toEqual([])
})
