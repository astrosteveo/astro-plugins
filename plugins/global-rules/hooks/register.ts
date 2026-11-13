import type { EngineInterface, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'
import type { LoadedIn } from '../types'

// The session /global-rules:claude-md was last loaded in. A /clear goes on under a new session id,
// in a conversation that no longer holds the guidance, so the skill is loaded again there.
const loadedIn = atom({ plugin: 'global-rules', key: 'loadedIn' } as const, null as LoadedIn)

// Claude Code's instruction files: CLAUDE.md, CLAUDE.local.md and AGENTS.md wherever they are (the
// global one, a project's, a subfolder's), and the Markdown files in a .claude/rules folder.
const INSTRUCTION_FILE = /(^|[\\/])(CLAUDE\.md|CLAUDE\.local\.md|AGENTS\.md)$|(^|[\\/])\.claude[\\/]rules[\\/](.+[\\/])?[^\\/]+\.md$/

export const isInstructionFile = (path: string) => INSTRUCTION_FILE.test(path)

// Added to /init's prompt, so it reads the guidance before its first write rather than being
// refused at it.
export const INIT_LINE =
  'Before you write any CLAUDE.md, CLAUDE.local.md, AGENTS.md or rules file, load /global-rules:claude-md with the Skill tool and follow it to place and word each line.'

const isClaudeMd = ($: EngineInterface, skill: string, pluginName?: string) =>
  skill === `${$.plugin.name}:claude-md` || (skill === 'claude-md' && pluginName === $.plugin.name)

// Claude Code's own /init, not a plugin's init skill such as /project-md:init.
const isInit = (skill: string, pluginName?: string) => skill === 'init' && pluginName === undefined

// Why an edit is refused, or undefined when it may go ahead.
async function refusal($: EngineInterface, path: string): Promise<string | undefined> {
  if (!isInstructionFile(path)) return undefined
  const [loaded, session] = await Promise.all([read($, loadedIn), $.session.id()])
  if (loaded === session) return undefined
  return `${$.plugin.name}: ${path} is a Claude Code instruction file. Load /global-rules:claude-md first, with the Skill tool and global-rules:claude-md: it reads Claude Code's current guidance on writing these files. Then make this change as it says.`
}

export const register: Register = on => {
  on('skill.prompt', async ($, e, next) => {
    const expanded = await next(e)
    if (isClaudeMd($, e.skill, e.pluginName)) {
      const session = await $.session.id()
      await update($, loadedIn, () => session)
    }
    return isInit(e.skill, e.pluginName) ? { ...expanded, text: `${expanded.text}\n\n${INIT_LINE}` } : expanded
  })

  // A guide, not a safety rule: if the check itself fails, the edit goes ahead.
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const deny = await refusal($, e.file_path)
    return deny ? { deny } : next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const deny = await refusal($, e.file_path)
    return deny ? { deny } : next(e)
  }).catch(($, e, next) => next(e))
}
