// Shell reading for two jobs: keeping the review's own agents to commands that only look, and
// spotting the pull request commands the gate stands in front of.

// Output thrown away, or one stream joined to another: redirections that write no file.
const HARMLESS = /&?\d?>\s*\/dev\/null|\d?>&\d/g

/**
 * A command's simple commands, each a list of its words with the quotes taken off. Strict, it gives
 * undefined for what it cannot follow safely: command or process substitution, and an output
 * redirection that writes a file. Loose, it reads those as text.
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
    const after = source[at + 1] ?? ''
    if (quote === "'") {
      if (char === "'") quote = undefined
      else word += char
      continue
    }
    if (strict && (char === '`' || (char === '$' && after === '('))) return undefined
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
    } else if (strict && (char === '>' || (char === '<' && after === '('))) {
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
  sort: args => (args.some(arg => arg === '-o' || /^-[^-]*o/.test(arg) || arg.startsWith('--output')) ? 'sort -o writes a file' : undefined),
  uniq: args => (args.filter(arg => !arg.startsWith('-')).length > 1 ? 'uniq writes its second file' : undefined),
  tree: args => (args.includes('-o') ? 'tree -o writes a file' : undefined),
  file: args => (args.some(arg => /^-[^-]*C/.test(arg) || arg === '--compile') ? 'file -C writes a file' : undefined),
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
 * repository under review; a command that could change it, or run something that could, is refused.
 */
export function reviewerRefusal(command: string, inBackground: boolean) {
  const lead = 'review-gate: reviewers only read, so this command was refused'
  if (inBackground) return `${lead}: run it in the foreground.`
  const commands = simpleCommands(command, true)
  if (commands === undefined)
    return `${lead}: it substitutes a command or writes a file. Run the command on its own, and read files with Read.`
  for (const words of commands) {
    const program = words[0] ?? ''
    if (ASSIGNMENT.test(program)) return `${lead}: it sets a variable first. Run the command without it.`
    const name = program.split('/').pop() ?? ''
    const check = Object.hasOwn(LOOKS, name) ? LOOKS[name] : undefined
    if (check === undefined)
      return `${lead}: ${name} is not one of the programs a reviewer runs (git log, show, diff, blame and grep, rg, grep, find, ls, cat, head, tail, wc, sed -n).`
    const why = check(words.slice(1))
    if (why !== undefined) return `${lead}: ${why}.`
  }
  return undefined
}

/** A pull request command the gate checks: which kind, and the branch or pull request it names. */
export type PrCommand = { kind: 'create' | 'merge'; target?: string; head?: string; cd?: string }

// gh pr merge's flags that take a value: the word after one is not the pull request.
const MERGE_VALUES = new Set(['-b', '--body', '-F', '--body-file', '-t', '--subject', '-A', '--author-email', '--match-head-commit', '-R', '--repo'])

/** The first `gh pr create` or `gh pr merge` in a command, with the folder a `cd` before it moved to. */
export function prCommand(command: string): PrCommand | undefined {
  let cd: string | undefined
  for (const words of simpleCommands(command, false) ?? []) {
    const at = words.findIndex(word => !ASSIGNMENT.test(word))
    if (at < 0) continue
    const program = (words[at] ?? '').split('/').pop()
    if (program === 'cd') {
      cd = words[at + 1]
      continue
    }
    const [noun, verb, ...rest] = words.slice(at + 1)
    if (program !== 'gh' || noun !== 'pr' || (verb !== 'create' && verb !== 'merge')) continue
    if (verb === 'create') {
      const flag = rest.findIndex(word => word === '-H' || word === '--head' || word.startsWith('--head='))
      const head = flag < 0 ? undefined : (rest[flag] ?? '').startsWith('--head=') ? (rest[flag] ?? '').slice('--head='.length) : rest[flag + 1]
      return { kind: 'create', ...(head === undefined ? {} : { head }), ...(cd === undefined ? {} : { cd }) }
    }
    let target: string | undefined
    for (let index = 0; index < rest.length && target === undefined; index++) {
      const word = rest[index] ?? ''
      if (MERGE_VALUES.has(word)) index += 1
      else if (!word.startsWith('-')) target = word
    }
    return { kind: 'merge', ...(target === undefined ? {} : { target }), ...(cd === undefined ? {} : { cd }) }
  }
  return undefined
}
