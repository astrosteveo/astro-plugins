import type { EngineInterface, Register } from 'claude-code'

// What the CLAUDE.md import line used to say beside the file, so Claude still raises a conflict.
export const LEAD = "PROJECT.md says what this project is for. If a request conflicts with its non-goals or constraints, say so before starting."

// The PROJECT.md at the root of the repo the session runs in, or of the session's own folder
// outside a repo, when there is one.
async function projectFile($: EngineInterface) {
  const root = (await $.session.repo())?.root ?? (await $.session.root())
  const path = `${root.replace(/[\\/]+$/, '')}/PROJECT.md`
  return (await $.fs.exists(path)) ? path : undefined
}

export const register: Register = on => {
  // PROJECT.md reaches the model as a CLAUDE.md that imports it would bring it: a project
  // instruction file in the first message's context, which the engine reads again after a
  // compaction or /clear. This runs once per conversation, not per turn.
  on('prompt.context', async ($, e, next) => {
    const path = await projectFile($)
    if (path === undefined) return next(e)
    const below = await next(e)
    const files = below.instructionFiles ?? e.instructionFiles
    // Unknown files mean a hook below rewrote the CLAUDE.md text, and one that imports it is
    // already sending it.
    if (files === undefined || files.some(file => file.path === path)) return below
    const text = await $.fs.read(path).catch(() => undefined)
    if (typeof text !== 'string' || text.trim() === '') return below
    return { ...below, instructionFiles: [...files, { path, kind: 'project' as const, content: `${LEAD}\n\n${text.trim()}` }] }
  })
}
