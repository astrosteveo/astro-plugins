// Pull requests go through the gate's own tool, and a shell command that opens or merges one is sent
// there: gh pr's verb is read from the command's words, and a gh api call from its text.

const VERBS = new Set(['create', 'new', 'merge'])

// gh pr's flags that take the next word as their value.
const VALUED = new Set(['-R', '--repo'])

// gh named, given by its path, or held in a variable or a command substitution.
const isGh = (word: string) => word === 'gh' || word.endsWith('/gh') || word.startsWith('$')

/**
 * A command's words, quotes removed, with each of ; & | ( ) and a line's end as the word `;`. A
 * quoted string, a $( ) or backticks stay one word, and the text inside each comes back too, to be
 * read as a command of its own, as bash -c, eval and a substitution run it.
 */
function wordsOf(text: string) {
  const words: string[] = []
  const inner: string[] = []
  let word: string | undefined
  const add = (part: string) => (word = (word ?? '') + part)
  const end = () => {
    if (word !== undefined) words.push(word)
    word = undefined
  }
  for (let at = 0; at < text.length; at++) {
    const char = text[at] ?? ''
    if (char === "'" || char === '"' || char === '`') {
      const close = text.indexOf(char, at + 1)
      const inside = text.slice(at + 1, close < 0 ? text.length : close)
      inner.push(inside)
      // Backticks are a substitution, so the word may name gh, as a $( ) may.
      add(char === '`' ? `$(${inside})` : inside)
      at = close < 0 ? text.length : close
    } else if (char === '$' && text[at + 1] === '(') {
      let close = at + 1
      for (let depth = 0; close < text.length; close++) {
        if (text[close] === '(') depth += 1
        else if (text[close] === ')' && --depth === 0) break
      }
      const inside = text.slice(at + 2, close)
      inner.push(inside)
      add(`$(${inside})`)
      at = close
    } else if (';&|()\n'.includes(char)) {
      end()
      words.push(';')
    } else if (/\s/.test(char)) end()
    else add(char)
  }
  end()
  return { words, inner }
}

/**
 * Whether a command runs gh pr create, new or merge: gh, then pr in the same command, then the verb
 * with only flags between, -R taking the word after it. So gh pr view 12 | grep new is not one.
 */
function runsVerb(text: string): boolean {
  const { words, inner } = wordsOf(text)
  for (let at = 0; at < words.length; at++) {
    if (!isGh(words[at] ?? '')) continue
    let pr = at + 1
    while (pr < words.length && words[pr] !== ';' && words[pr] !== 'pr') pr += 1
    if (words[pr] !== 'pr') continue
    let verb = pr + 1
    while ((words[verb] ?? '').startsWith('-')) verb += VALUED.has(words[verb] ?? '') ? 2 : 1
    if (VERBS.has(words[verb] ?? '')) return true
  }
  return inner.some(runsVerb)
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
 * call that does the same. Continued lines are joined as the shell joins them, and quoted text is
 * read as a command too, so env, bash -c, eval, xargs, pushd and a variable holding gh leave it
 * caught. A script file run by name is not read, and a call hidden on purpose gets past it.
 */
export function opensOrMerges(command: string) {
  const text = command.replace(/\\\r?\n/g, ' ')
  if (runsVerb(text)) return true
  if (!API_LINE.test(text)) return false
  return MUTATION.test(text) || MERGE_PATH.test(text) || (PULLS_PATH.test(text) && POSTS.test(text))
}
