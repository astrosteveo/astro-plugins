import { expect, test } from 'claude-code/testing'
import { gitArgsRefusal, gitArgv, gitGrepArgv, opensOrMerges, rgArgv } from '../hooks/guard'

test("the review's git tool runs git's reading commands", () => {
  const reads = [
    ['log', '--oneline', '-20'],
    ['show', 'HEAD:src/app.ts'],
    ['diff', 'abc1234', 'def5678', '--', 'src/app.ts'],
    ['blame', '-L', '10,40', 'src/app.ts'],
    ['grep', '-n', 'token ==', '--', 'src'],
    ['--no-pager', 'log', '-p', '-3', '--', 'src/auth.ts'],
    ['log', '--output-indicator-new=+'],
    ['ls-files', '*.ts'],
    ['grep', '-o', 'token'],
  ]
  for (const args of reads) expect({ args, refusal: gitArgsRefusal(args) }).toEqual({ args, refusal: undefined })
})

test("the review's git tool refuses what writes, runs another program or is not a read, abbreviations included", () => {
  const refused: [string[], string][] = [
    [['commit', '-m', 'fix'], 'git commit is not one that only reads'],
    [['checkout', 'main'], 'git checkout is not one that only reads'],
    [['-c', 'core.pager=evil', 'log'], 'git -c can change what git runs'],
    [['-C', '/elsewhere', 'log'], 'git -C can change what git runs'],
    [['diff', '--output=out.patch'], 'git --output writes a file'],
    [['log', '--outp=out.patch'], 'git --output writes a file'],
    [['diff', '--ext-diff'], 'git --ext-diff runs another program'],
    [['grep', '-Ovim', 'token'], 'git grep -O runs another program'],
    [['grep', '--open-files', 'token'], 'git grep -O runs another program'],
    [['grep', '-iOvim', 'token'], 'git grep -O runs another program'],
    [[], 'name a git subcommand, such as log or show'],
  ]
  for (const [args, reason] of refused) expect({ args, refusal: gitArgsRefusal(args) }).toEqual({ args, refusal: reason })
})

test("the git tool's argv keeps out external diff tools, and passes the arguments as given", () => {
  expect(gitArgv(['diff', 'a', 'b'])).toEqual(['git', '-c', 'core.quotePath=false', '--no-pager', 'diff', '--no-ext-diff', 'a', 'b'])
  expect(gitArgv(['--no-pager', 'show', 'HEAD'])).toEqual(['git', '-c', 'core.quotePath=false', '--no-pager', '--no-pager', 'show', '--no-ext-diff', 'HEAD'])
  expect(gitArgv(['blame', 'src/a b.ts'])).toEqual(['git', '-c', 'core.quotePath=false', '--no-pager', 'blame', 'src/a b.ts'])
})

test('a search becomes ripgrep or git grep argv, every flag its own, the pattern never read as one', () => {
  expect(rgArgv({ pattern: '-rf', path: 'src', glob: '*.ts', ignoreCase: true, context: 2 })).toEqual([
    'rg',
    '--line-number',
    '--no-heading',
    '--color',
    'never',
    '--max-columns',
    '400',
    '--hidden',
    '--glob',
    '!.git',
    '--ignore-case',
    '--context',
    '2',
    '--glob',
    '*.ts',
    '--regexp',
    '-rf',
    '--',
    'src',
  ])
  expect(rgArgv({ pattern: 'a.b', fixed: true, context: 99 }).slice(10)).toEqual(['--fixed-strings', '--context', '20', '--regexp', 'a.b', '--', '.'])
  expect(gitGrepArgv({ pattern: 'token', path: 'src/', glob: '*.ts' })).toEqual([
    'git',
    '-c',
    'core.quotePath=false',
    '--no-pager',
    'grep',
    '--line-number',
    '-I',
    '--extended-regexp',
    '-e',
    'token',
    '--',
    ':(glob)src/**/*.ts',
  ])
  expect(gitGrepArgv({ pattern: 'x', fixed: true }).slice(-5)).toEqual(['--fixed-strings', '-e', 'x', '--', '.'])
  // One file is searched as a file.
  expect(gitGrepArgv({ pattern: 'x', path: 'src/app.ts' }).slice(-2)).toEqual(['--', 'src/app.ts'])
  expect(gitGrepArgv({ pattern: 'x', path: 'src/' }).slice(-2)).toEqual(['--', 'src/'])
})

test('a command that opens or merges a pull request is caught through wrappers, continued lines and variables, and other gh commands are not', () => {
  const caught = [
    'gh pr create --fill',
    'git push -u origin feat/x && gh pr create --fill',
    'gh pr new --fill',
    'gh pr -R owner/repo create',
    'gh pr merge 12 --squash',
    'command gh pr merge 3',
    'env GH_REPO=o/r gh pr merge 3',
    "bash -c 'gh pr create --fill'",
    "eval 'gh pr merge 5'",
    'echo 5 | xargs gh pr merge',
    'pushd ../repo && gh pr create',
    '/usr/bin/gh pr merge 4',
    'gh pr \\\nmerge 7',
    'gh \\\n  pr create --fill',
    'GH=gh\n$GH pr create --fill',
    '"${GH}" pr merge 3',
    '$(command -v gh) pr merge 3',
  ]
  for (const command of caught) expect({ command, caught: opensOrMerges(command) }).toEqual({ command, caught: true })
  const passed = [
    'gh pr view 12',
    'gh pr list',
    'gh pr checks',
    'gh pr view "$N" --json mergeStateStatus',
    'gh issue create',
    'git merge main',
    'echo github pr create',
    'gh repo view',
    "git commit -F - <<'EOF'\nfeat: route gh through the tool\n\nThe pr merge path is refused.\nEOF",
  ]
  for (const command of passed) expect({ command, caught: opensOrMerges(command) }).toEqual({ command, caught: false })
})

test('a gh api call that opens or merges a pull request is caught, and one that reads or comments is not', () => {
  const caught = [
    'gh api repos/o/r/pulls -f title=Add -f head=feat/x -f base=main',
    'gh api -X POST repos/{owner}/{repo}/pulls --input pr.json',
    'gh api --method PUT repos/o/r/pulls/7/merge',
    'gh api repos/o/r/pulls/7/merge \\\n  -X PUT -f merge_method=squash',
    "gh api graphql -f query='\n  mutation {\n    mergePullRequest(input: {pullRequestId: \"P\"}) { clientMutationId }\n  }'",
    'gh api graphql -f query=\'mutation { enablePullRequestAutoMerge(input: {pullRequestId: "P"}) { clientMutationId } }\'',
  ]
  for (const command of caught) expect({ command, caught: opensOrMerges(command) }).toEqual({ command, caught: true })
  const passed = [
    'gh api repos/o/r/pulls',
    'gh api repos/o/r/pulls?state=open --paginate',
    'gh api repos/o/r/pulls/7',
    "gh api repos/o/r/pulls/7/comments -f body='Looks right'",
    'gh api graphql -f query=\'query { repository(owner: "o", name: "r") { pullRequest(number: 7) { title } } }\'',
  ]
  for (const command of passed) expect({ command, caught: opensOrMerges(command) }).toEqual({ command, caught: false })
})
