// Pull requests go through the gate's own tool, and a shell line that opens or merges one is sent
// there by a plain match on its text.

// gh pr create, new or merge on one line, with flags such as -R between. gh is named, given by its
// path, or held in a variable or a command substitution.
const PR_LINE = /(?:\bgh\b|\$\{?\w+\}?|\$\([^)\n]*\)|`[^`\n]*`)[^\n]*\bpr\b[^\n]*\b(?:create|new|merge)\b/

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
 * call that does the same. It reads the command's text, continued lines joined as the shell joins
 * them, so env, bash -c, eval, xargs, pushd and a variable holding gh leave it caught with nothing
 * parsed. A script file run by name is not read, and a call hidden on purpose gets past it.
 */
export function opensOrMerges(command: string) {
  const text = command.replace(/\\\r?\n/g, ' ')
  if (PR_LINE.test(text)) return true
  if (!API_LINE.test(text)) return false
  return MUTATION.test(text) || MERGE_PATH.test(text) || (PULLS_PATH.test(text) && POSTS.test(text))
}
