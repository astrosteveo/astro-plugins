// What the review lets programs do. Its agents read the repository through two tools that run
// git and ripgrep by argv, with no shell between, so the arguments checked are the arguments run.
// Pull requests go through the gate's own tool, and a shell line that opens or merges one is sent
// there by a plain match on its text.

// git subcommands that only read the repository.
const GIT_READS = new Set([
  'log',
  'show',
  'diff',
  'blame',
  'annotate',
  'grep',
  'ls-files',
  'ls-tree',
  'rev-parse',
  'rev-list',
  'status',
  'cat-file',
  'merge-base',
  'shortlog',
  'describe',
  'name-rev',
  'for-each-ref',
  'show-ref',
  'whatchanged',
])

// git's own flags a review may give before the subcommand.
const GIT_GLOBALS = new Set(['--no-pager', '-P', '--no-optional-locks', '--literal-pathspecs'])

// Subcommands that run a diff, which may follow a configured external diff tool.
const DIFFS = new Set(['diff', 'show', 'log', 'whatchanged'])

// A long option, or an abbreviation of one, as git and GNU tools take them: `--outp=x` is `--output=x`.
function abbreviates(arg: string, name: string) {
  if (!arg.startsWith('--')) return false
  const given = arg.slice(2).split('=')[0] ?? ''
  return given.length >= 2 && name.startsWith(given)
}

/**
 * Why the review's git tool may not run these arguments, or undefined when they only read: a
 * subcommand that reads, with no flag that writes a file or runs another program.
 */
export function gitArgsRefusal(args: readonly string[]): string | undefined {
  let at = 0
  while (at < args.length && (args[at] ?? '').startsWith('-')) {
    const flag = args[at] ?? ''
    if (!GIT_GLOBALS.has(flag)) return `git ${flag} can change what git runs`
    at += 1
  }
  const subcommand = args[at]
  if (subcommand === undefined) return 'name a git subcommand, such as log or show'
  if (!GIT_READS.has(subcommand)) return `git ${subcommand} is not one that only reads`
  const rest = args.slice(at + 1)
  if (rest.some(arg => abbreviates(arg, 'output'))) return 'git --output writes a file'
  if (rest.some(arg => abbreviates(arg, 'ext-diff'))) return 'git --ext-diff runs another program'
  // -O runs a pager program, alone or in a cluster of short flags such as -iO.
  if (subcommand === 'grep' && rest.some(arg => /^-[A-Za-z]*O/.test(arg) || abbreviates(arg, 'open-files-in-pager')))
    return 'git grep -O runs another program'
  return undefined
}

/** The argv the review's git tool runs: git's reading command, with no external diff tool. */
export function gitArgv(args: readonly string[]) {
  const at = args.findIndex(arg => !arg.startsWith('-'))
  const subcommand = args[at] ?? ''
  const own = DIFFS.has(subcommand) ? [...args.slice(0, at + 1), '--no-ext-diff', ...args.slice(at + 1)] : [...args]
  return ['git', '-c', 'core.quotePath=false', '--no-pager', ...own]
}

/** A search the review's search tool runs: every flag is the tool's own. */
export type Search = { pattern: string; path?: string; glob?: string; ignoreCase?: boolean; fixed?: boolean; context?: number }

const lines = (search: Search) => Math.max(0, Math.min(20, Math.trunc(search.context ?? 0)))

/** ripgrep's argv for a search. */
export function rgArgv(search: Search) {
  return [
    'rg',
    '--line-number',
    '--no-heading',
    '--color',
    'never',
    '--max-columns',
    '400',
    // Hidden files too, as git grep searches them; never the .git folder.
    '--hidden',
    '--glob',
    '!.git',
    ...(search.ignoreCase === true ? ['--ignore-case'] : []),
    ...(search.fixed === true ? ['--fixed-strings'] : []),
    ...(lines(search) > 0 ? ['--context', String(lines(search))] : []),
    ...(search.glob === undefined || search.glob === '' ? [] : ['--glob', search.glob]),
    '--regexp',
    search.pattern,
    '--',
    search.path === undefined || search.path === '' ? '.' : search.path,
  ]
}

/**
 * git grep's argv for the same search, where ripgrep is not installed. A path is passed as given, so
 * one file is searched as a file; a glob narrows a folder to the names it matches.
 */
export function gitGrepArgv(search: Search) {
  const path = search.path === undefined || search.path === '' ? '.' : search.path
  const folder = path === '.' ? '' : `${path.replace(/\/+$/, '')}/`
  const where = search.glob === undefined || search.glob === '' ? path : `:(glob)${folder}**/${search.glob}`
  return [
    'git',
    '-c',
    'core.quotePath=false',
    '--no-pager',
    'grep',
    '--line-number',
    '-I',
    ...(search.ignoreCase === true ? ['--ignore-case'] : []),
    search.fixed === true ? '--fixed-strings' : '--extended-regexp',
    ...(lines(search) > 0 ? ['--context', String(lines(search))] : []),
    '-e',
    search.pattern,
    '--',
    where,
  ]
}

/**
 * A shell line that opens or merges a pull request, however it is wrapped: `env`, `bash -c`, eval,
 * xargs and pushd all leave this text in the line, so nothing needs parsing.
 */
export const RAW_PR = /\bgh\b[^\n]*\bpr\b[^\n]*\b(create|new|merge)\b/
