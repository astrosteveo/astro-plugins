import { expect, test } from 'claude-code/testing'
import { RAW_PR, gitArgsRefusal, gitArgv, gitGrepArgv, rgArgv } from '../hooks/guard'

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
  expect(rgArgv({ pattern: 'a.b', fixed: true, context: 99 }).slice(7)).toEqual(['--fixed-strings', '--context', '20', '--regexp', 'a.b', '--', '.'])
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
})

test('a line that opens or merges a pull request is caught however it is wrapped, and other gh commands are not', () => {
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
  ]
  for (const command of caught) expect({ command, caught: RAW_PR.test(command) }).toEqual({ command, caught: true })
  const passed = ['gh pr view 12', 'gh pr list', 'gh pr checks', 'gh issue create', 'git merge main', 'echo github pr create', 'gh repo view']
  for (const command of passed) expect({ command, caught: RAW_PR.test(command) }).toEqual({ command, caught: false })
})
