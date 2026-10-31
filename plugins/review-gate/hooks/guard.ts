// Pull requests go through the gate's own tool, and a shell command that opens or merges one is sent
// there. The guard stops a habit: it catches gh pr create, new or merge as a command is normally
// written, and makes no attempt to follow a call hidden on purpose.

const VERBS = new Set(['create', 'new', 'merge'])

// gh pr's flags that take the next word as their value.
const VALUED = new Set(['-R', '--repo'])

// gh named, given by its path, or held in a variable.
const isGh = (word: string) => word === 'gh' || word.endsWith('/gh') || word.startsWith('$')

/**
 * A command's words with every quote, backslash and redirection dropped, split at spaces, ; & | ( )
 * and a line's end. Text inside quotes, $( ) and backticks so reads as words of the command, as
 * bash -c, eval and a substitution run it. Each separator stays as the word `;`, so a verb after a
 * pipe or && is not gh pr's.
 */
const wordsOf = (text: string) =>
  text
    // A redirection and its target, as in 2>/dev/null, &>log and >|out, are not words of the command.
    // The target is an unquoted word on the same line, so a here-string's quoted command stays.
    .replace(/&?\d*[<>]+[&|]?[ \t]*[^\s;&|()<>"'`]*/g, ' ')
    .replace(/\$?["'`\\]/g, '')
    .replace(/[;&|()<>\n]+/g, ' ; ')
    .split(/\s+/)
    .filter(word => word !== '')

// Where the first word from `at` on that is not a flag sits, -R taking the word after it as its value.
function pastFlags(words: readonly string[], at: number) {
  while ((words[at] ?? '').startsWith('-')) at += VALUED.has(words[at] ?? '') ? 2 : 1
  return at
}

/**
 * Whether a command runs gh pr create, new or merge: gh, pr as its subcommand, and the verb as pr's,
 * with only flags between. So gh pr view 12 | grep new and gh issue list --label pr are not one.
 */
function runsVerb(text: string) {
  // Each $( ) and backtick substitution becomes the word $sub, which may be gh as a variable may,
  // and its text is read after the command as a command of its own.
  const inner: string[] = []
  for (let last = ''; last !== text; ) {
    last = text
    text = text.replace(/\$\(([^()]*)\)|`([^`]*)`/g, (_, paren?: string, tick?: string) => {
      inner.push(paren ?? tick ?? '')
      return '$sub'
    })
  }
  const words = wordsOf([text, ...inner].join('\n'))
  return words.some((word, at) => {
    if (!isGh(word)) return false
    const pr = pastFlags(words, at + 1)
    return words[pr] === 'pr' && VERBS.has(words[pastFlags(words, pr + 1)] ?? '')
  })
}

// A line that runs gh api, gh named in the same ways.
const API_LINE = /(?:\bgh\b|\$\{?\w+\}?|\$\([^)\n]*\)|`[^`\n]*`)[^\n]*\bapi\b/

// What opens or merges a pull request through gh api: a GraphQL mutation, a call to a pull
// request's merge endpoint, or a POST to the pulls collection, which a field, a body or -X POST makes.
const MUTATION = /\b(?:createPullRequest|mergePullRequest|enablePullRequestAutoMerge|enqueuePullRequest)\b/
const MERGE_PATH = /\/pulls\/[^\s/"']+\/merge(?![\w/-])/
const PULLS_PATH = /\/pulls\/?(?![\w/-])/
const POSTS = /(?:^|\s)(?:-[fF]|--field|--raw-field|--input|(?:-X\s*|--method[=\s]+)["']?post\b)/i

/**
 * Whether a shell command opens or merges a pull request: gh pr create, new or merge, or a gh api
 * call that does the same. A continued line is joined as the shell joins it, with the backslash and
 * newline removed; an escaped backslash before a newline is not a continuation.
 */
export function opensOrMerges(command: string) {
  const text = command.replace(/(?<!\\)((?:\\\\)*)\\\r?\n/g, '$1')
  if (runsVerb(text)) return true
  if (!API_LINE.test(text)) return false
  return MUTATION.test(text) || MERGE_PATH.test(text) || (PULLS_PATH.test(text) && POSTS.test(text))
}
