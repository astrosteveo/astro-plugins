// Shell reading for two jobs: keeping the review's own agents to commands that only look, and
// spotting the pull request commands the gate stands in front of.

// Output thrown away, or one stream joined to another: redirections that write no file. Each ends
// where its word does, so `>&1foo`, which writes a file named 1foo, is not one of them.
const HARMLESS = /(?:&|\d)?>\s*\/dev\/null(?=$|[\s;&|])|\d?>&\d(?=$|[\s;&|])/g

/**
 * A command's simple commands, each a list of its words with the quotes taken off.
 *
 * Strict, it gives undefined for any word the shell would change before the program sees it: an
 * expansion (`$`, backquotes, `$'…'`), a brace list, a glob, a subshell, or an output redirection
 * that writes a file. What it gives is then exactly what each program receives. Loose, it reads
 * all of those as text.
 */
export function simpleCommands(command: string, strict: boolean): string[][] | undefined {
  const source = strict ? command.replace(HARMLESS, ' ') : command
  const commands: string[][] = []
  let words: string[] = []
  let word = ''
  let hasWord = false
  let quote: string | undefined
  const endWord = () => {
    if (hasWord) words.push(word)
    word = ''
    hasWord = false
  }
  const endCommand = () => {
    endWord()
    if (words.length > 0) commands.push(words)
    words = []
  }
  for (let at = 0; at < source.length; at++) {
    const char = source[at] ?? ''
    if (quote === "'") {
      if (char === "'") quote = undefined
      else word += char
      continue
    }
    if (strict && (char === '`' || char === '$')) return undefined
    if (quote === '"') {
      if (char === '"') quote = undefined
      else if (char === '\\' && at + 1 < source.length) word += source[++at]
      else word += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      hasWord = true
    } else if (char === '\\') {
      if (at + 1 < source.length) word += source[++at]
      hasWord = true
    } else if (strict && '>{}*?[()'.includes(char)) {
      return undefined
    } else if ('|;&\n()'.includes(char)) {
      endCommand()
    } else if (char === ' ' || char === '\t' || char === '<' || char === '>') {
      endWord()
    } else {
      word += char
      hasWord = true
    }
  }
  if (quote !== undefined && strict) return undefined
  endCommand()
  return commands
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

// Programs that only read, and what each must not be given: a flag that writes a file, runs
// another program, or never ends.
const LOOKS: Record<string, (args: readonly string[]) => string | undefined> = {
  cat: () => undefined,
  head: () => undefined,
  wc: () => undefined,
  ls: () => undefined,
  grep: () => undefined,
  egrep: () => undefined,
  fgrep: () => undefined,
  cut: () => undefined,
  tr: () => undefined,
  nl: () => undefined,
  stat: () => undefined,
  pwd: () => undefined,
  echo: () => undefined,
  printf: () => undefined,
  true: () => undefined,
  basename: () => undefined,
  dirname: () => undefined,
  realpath: () => undefined,
  diff: () => undefined,
  cd: () => undefined,
  jq: () => undefined,
  column: () => undefined,
  test: () => undefined,
  '[': () => undefined,
  git: gitRefusal,
  tail: args => (args.some(arg => /^-[^-]*[fF]/.test(arg) || arg.startsWith('--follow')) ? 'tail -f never ends' : undefined),
  rg: args => (args.some(arg => /^--(pre|pre-glob|hostname-bin)(=|$)/.test(arg)) ? 'rg --pre runs another program' : undefined),
  find: args =>
    args.some(arg => ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'].includes(arg))
      ? 'find may only list: -exec, -ok, -delete and -fprint act on what it finds'
      : undefined,
  sort: args =>
    args.some(arg => arg.startsWith('--compress-program'))
      ? 'sort --compress-program runs another program'
      : args.some(arg => /^-[^-]*o/.test(arg) || arg.startsWith('--output'))
        ? 'sort -o writes a file'
        : undefined,
  uniq: args => (args.filter(arg => !arg.startsWith('-')).length > 1 ? 'uniq writes its second file' : undefined),
  sed: sedRefusal,
}

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

function gitRefusal(args: readonly string[]) {
  let at = 0
  while (at < args.length && (args[at] ?? '').startsWith('-')) {
    const flag = args[at] ?? ''
    if (flag === '-C') at += 2
    else if (['--no-pager', '-P', '--no-optional-locks', '--literal-pathspecs'].includes(flag)) at += 1
    else return `git ${flag} can change what git runs`
  }
  const subcommand = args[at]
  if (subcommand === undefined || !GIT_READS.has(subcommand)) return `git ${subcommand ?? ''} is not one that only reads`.replace(/ +is/, ' is')
  const rest = args.slice(at + 1)
  if (rest.some(arg => arg.startsWith('--output'))) return 'git --output writes a file'
  if (subcommand === 'grep' && rest.some(arg => arg.startsWith('-O') || arg.startsWith('--open-files-in-pager')))
    return 'git grep -O runs another program'
  return undefined
}

// Line addresses, or /patterns/, then p: the scripts that print and do nothing else.
const ADDRESS = String.raw`(?:\d+|\$|/(?:[^/\\]|\\.)*/)`
const PRINTS = new RegExp(String.raw`^(?:\s*${ADDRESS}(?:\s*,\s*(?:${ADDRESS}|\+\d+))?\s*p\s*;?)+\s*$`)

function sedRefusal(args: readonly string[]) {
  const scripts: string[] = []
  let quiet = false
  for (let at = 0; at < args.length; at++) {
    const arg = args[at] ?? ''
    if (arg === '-n' || arg === '--quiet' || arg === '--silent') quiet = true
    else if (arg === '-e' || arg === '--expression') scripts.push(args[++at] ?? '')
    else if (arg.startsWith('-i') || arg.startsWith('--in-place')) return 'sed -i writes the file'
    else if (arg.startsWith('-') && arg !== '-E' && arg !== '-r' && arg !== '-s' && arg !== '-z') return `sed ${arg} is not allowed here`
    else if (scripts.length === 0 && !arg.startsWith('-')) scripts.push(arg)
  }
  if (!quiet || scripts.length === 0 || !scripts.every(script => PRINTS.test(script))) return "sed may only print lines, as sed -n '10,40p' FILE"
  return undefined
}

/**
 * Why a review agent may not run a command, or undefined when it only looks. The agents read the
 * repository under review, whose text may try to steer them; a command that could change it, or
 * run something that could, is refused.
 */
export function reviewerRefusal(command: string, inBackground: boolean) {
  const lead = 'review-gate: reviewers only read, so this command was refused'
  if (inBackground) return `${lead}: run it in the foreground.`
  const commands = simpleCommands(command, true)
  if (commands === undefined)
    return `${lead}: the shell would change some of its words first ($, backquotes, braces, globs or subshells), or it writes a file. Quote every pattern ('*.ts'), name files plainly, and read files with Read.`
  for (const words of commands) {
    const program = words[0] ?? ''
    if (ASSIGNMENT.test(program)) return `${lead}: it sets a variable first. Run the command without it.`
    if (program.includes('/')) return `${lead}: run programs by name, not by path.`
    const check = Object.hasOwn(LOOKS, program) ? LOOKS[program] : undefined
    if (check === undefined)
      return `${lead}: ${program} is not one of the programs a reviewer runs (git log, show, diff, blame and grep, rg, grep, find, ls, cat, head, tail, wc, sed -n).`
    const why = check(words.slice(1))
    if (why !== undefined) return `${lead}: ${why}.`
  }
  return undefined
}

/**
 * A pull request command the gate checks: which kind, what it names, and the folders every `cd`
 * before it moved to, in order (`~` for a bare cd). `isOpaque` marks one whose arguments come from
 * elsewhere, as through xargs, so the gate cannot tell what it acts on.
 */
export type PrCommand = { kind: 'create' | 'merge'; target?: string; head?: string; repo?: string; cd: string[]; isOpaque?: true }

// gh flags that take a value: the word after one is neither the verb nor the pull request.
const VALUES = new Set([
  '-R',
  '--repo',
  '-b',
  '--body',
  '-F',
  '--body-file',
  '-t',
  '--title',
  '--subject',
  '-A',
  '--author-email',
  '--match-head-commit',
  '-B',
  '--base',
  '-H',
  '--head',
  '-a',
  '--assignee',
  '-l',
  '--label',
  '-m',
  '--milestone',
  '-p',
  '--project',
  '-r',
  '--reviewer',
  '-T',
  '--template',
])

const VERBS: Record<string, PrCommand['kind']> = { create: 'create', new: 'create', merge: 'merge' }

// The value a flag gives in `--flag value`, `--flag=value` or `-Fvalue` form.
function flagValue(words: readonly string[], names: readonly string[]) {
  for (let at = 0; at < words.length; at++) {
    const word = words[at] ?? ''
    for (const name of names) {
      if (word === name) return words[at + 1]
      if (name.startsWith('--') && word.startsWith(`${name}=`)) return word.slice(name.length + 1)
      if (!name.startsWith('--') && word.startsWith(name) && word.length > name.length) return word.slice(name.length)
    }
  }
  return undefined
}

// One `gh … pr … create|new|merge` in a list of words, wherever gh stands in it (after command,
// env, xargs, sudo and the like), with gh's flags allowed before the verb.
function prIn(words: readonly string[], cd: readonly string[]): PrCommand | undefined {
  for (let at = 0; at < words.length; at++) {
    if ((words[at] ?? '').split('/').pop() !== 'gh') continue
    let next = at + 1
    while ((words[next] ?? '').startsWith('-')) next += VALUES.has(words[next] ?? '') ? 2 : 1
    if (words[next] !== 'pr') continue
    next += 1
    while ((words[next] ?? '').startsWith('-')) next += VALUES.has(words[next] ?? '') ? 2 : 1
    const kind = VERBS[words[next] ?? '']
    if (kind === undefined) continue
    const rest = words.slice(next + 1)
    const repo = flagValue(words.slice(at + 1), ['-R', '--repo'])
    const isOpaque = words.slice(0, at).some(word => word.split('/').pop() === 'xargs')
    const found: PrCommand = { kind, cd: [...cd], ...(repo === undefined ? {} : { repo }), ...(isOpaque ? { isOpaque } : {}) }
    if (kind === 'create') {
      const head = flagValue(rest, ['-H', '--head'])
      return head === undefined ? found : { ...found, head }
    }
    for (let index = 0; index < rest.length; index++) {
      const word = rest[index] ?? ''
      if (VALUES.has(word)) index += 1
      else if (!word.startsWith('-')) return { ...found, target: word }
    }
    return found
  }
  return undefined
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])

// The script a shell is handed with -c (or a cluster that ends in c, as -lc), or what eval runs.
function scriptOf(words: readonly string[], at: number) {
  const program = (words[at] ?? '').split('/').pop() ?? ''
  if (program === 'eval') return words.slice(at + 1).join(' ')
  if (!SHELLS.has(program)) return undefined
  const flag = words.findIndex((word, index) => index > at && /^-[a-z]*c$/.test(word))
  return flag < 0 ? undefined : words[flag + 1]
}

/**
 * Every `gh pr create`, `gh pr new` and `gh pr merge` a command runs, in order, with the folders a
 * `cd` before each moved to. The script a shell runs with -c, and what eval runs, are read too; a
 * quoted body or title that only mentions such a command is not.
 */
export function prCommands(command: string, cd: readonly string[] = []): PrCommand[] {
  const found: PrCommand[] = []
  const moved = [...cd]
  for (const words of simpleCommands(command, false) ?? []) {
    const at = words.findIndex(word => !ASSIGNMENT.test(word))
    if (at < 0) continue
    if (words[at] === 'cd') {
      moved.push(words[at + 1] ?? '~')
      continue
    }
    const script = scriptOf(words, at)
    if (script !== undefined) {
      found.push(...prCommands(script, moved))
      continue
    }
    const pr = prIn(words, moved)
    if (pr !== undefined) found.push(pr)
  }
  return found
}
