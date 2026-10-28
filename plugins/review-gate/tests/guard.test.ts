import { expect, test } from 'claude-code/testing'
import { prCommands, reviewerRefusal } from '../hooks/guard'

// Commands a reviewer may run: they only look, and the shell changes none of their words.
const READS = [
  'git log --oneline -20',
  'git -C /repo show HEAD:src/app.ts',
  'git diff abc1234 def5678 -- src/app.ts',
  'git blame -L 10,40 src/app.ts',
  'git grep -n "token ==" -- src',
  'git --no-pager log -p -3 -- src/auth.ts',
  "git log --format='%h {x}'",
  "rg -n 'parse{2}Config' src",
  "grep -rn 'a|b' src | head -20",
  'find src -name "*.ts" -newer README.md',
  'cat src/app.ts | wc -l',
  "sed -n '10,40p' src/app.ts",
  "sed -n '/^export/,/^}/p' src/app.ts",
  'ls -la src 2>/dev/null',
  'cd src && ls',
  'git log --format=%h 2>&1 | head',
  'sort -u names.txt | uniq -c',
  'tail -n 50 log.txt',
  "echo 'costs $5'",
]

const LEAD = 'review-gate: reviewers only read, so this command was refused: '
const SHELL = `${LEAD}the shell would change some of its words first`

// Commands a reviewer may not run, and the start of why.
const REFUSED: [string, string][] = [
  ['rm -rf src', `${LEAD}rm is not one`],
  ['git commit -m "fix"', `${LEAD}git commit is not one that only reads`],
  ['git checkout main', `${LEAD}git checkout is not`],
  ['git -c core.pager=evil log', `${LEAD}git -c can change what git runs`],
  ['git diff --output=out.patch', `${LEAD}git --output writes a file`],
  ['git grep -O vim token', `${LEAD}git grep -O runs another program`],
  ['./git log', `${LEAD}run programs by name, not by path`],
  ['/usr/bin/cat src/app.ts', `${LEAD}run programs by name, not by path`],
  ['scripts/ls', `${LEAD}run programs by name, not by path`],
  ['cat src/app.ts > copy.ts', SHELL],
  ['echo data >&1foo', SHELL],
  ['echo $(whoami)', SHELL],
  ['echo `whoami`', SHELL],
  ["echo $'\\x2dexec'", SHELL],
  ['cat "$HOME/notes"', SHELL],
  ['find . -name x ${X:--exec} touch pwned {} +', SHELL],
  ['find . {-delete,-true}', SHELL],
  ['ls src/*.ts', SHELL],
  ['(cd src && ls)', SHELL],
  ["sed -i 's/a/b/' src/app.ts", `${LEAD}sed -i writes the file`],
  ["sed -n 's/a/b/w out' src/app.ts", `${LEAD}sed may only print lines`],
  ['find . -name "*.tmp" -delete', `${LEAD}find may only list`],
  ['find . -exec rm {} \;', SHELL],
  ['sort -o names.txt names.txt', `${LEAD}sort -o writes a file`],
  ['sort -uo names.txt names.txt', `${LEAD}sort -o writes a file`],
  ['sort -S 1 --compress-program=sh names.txt', `${LEAD}sort --compress-program runs another program`],
  ['tree -ao README.md', `${LEAD}tree is not one`],
  ['uniq in.txt out.txt', `${LEAD}uniq writes its second file`],
  ['rg --pre ./run.sh token', `${LEAD}rg --pre runs another program`],
  ['tail -f log.txt', `${LEAD}tail -f never ends`],
  ['GIT_EXTERNAL_DIFF=x git diff', `${LEAD}it sets a variable first`],
  ['bun test', `${LEAD}bun is not one`],
  ['ls && npm install', `${LEAD}npm is not one`],
  ['cat <<EOF\nrm -rf /\nEOF', `${LEAD}rm is not one`],
]

test('a reviewer runs the commands that only look', () => {
  for (const command of READS) expect({ command, refusal: reviewerRefusal(command, false) }).toEqual({ command, refusal: undefined })
})

test('a reviewer is refused a command that could change something, or that the shell would change, with the reason', () => {
  for (const [command, reason] of REFUSED) {
    const refusal = reviewerRefusal(command, false) ?? ''
    expect({ command, starts: refusal.startsWith(reason) ? reason : refusal }).toEqual({ command, starts: reason })
  }
})

test('a reviewer runs nothing in the background', () => {
  expect(reviewerRefusal('git log', true)).toBe(`${LEAD}run it in the foreground.`)
})

test('the gate finds every gh pr create, new and merge, with what each names and the cds before it', () => {
  const cases: [string, unknown[]][] = [
    ['gh pr create --title "Add the gate" --body "Testing: bun test"', [{ kind: 'create', cd: [] }]],
    ['git push -u origin feat/x && gh pr create --fill', [{ kind: 'create', cd: [] }]],
    ['gh pr new --fill', [{ kind: 'create', cd: [] }]],
    ['gh pr create --head feat/other --fill', [{ kind: 'create', head: 'feat/other', cd: [] }]],
    ['gh pr create -H me:feat/other', [{ kind: 'create', head: 'me:feat/other', cd: [] }]],
    ['gh pr -R owner/repo create --fill', [{ kind: 'create', repo: 'owner/repo', cd: [] }]],
    ['cd ../repo && gh pr create --fill', [{ kind: 'create', cd: ['../repo'] }]],
    ['cd a && cd b && gh pr create', [{ kind: 'create', cd: ['a', 'b'] }]],
    ['cd && gh pr create', [{ kind: 'create', cd: ['~'] }]],
    ['gh pr merge --squash --delete-branch', [{ kind: 'merge', cd: [] }]],
    ['gh pr merge 12 --squash', [{ kind: 'merge', target: '12', cd: [] }]],
    ['gh pr merge --subject "Ship it" 14', [{ kind: 'merge', target: '14', cd: [] }]],
    ['gh pr merge 7 -R owner/other', [{ kind: 'merge', target: '7', repo: 'owner/other', cd: [] }]],
    ['GH_TOKEN=x gh pr merge feat/x', [{ kind: 'merge', target: 'feat/x', cd: [] }]],
    ['command gh pr create --fill', [{ kind: 'create', cd: [] }]],
    ['env GH_TOKEN=x gh pr merge 3', [{ kind: 'merge', target: '3', cd: [] }]],
    ["bash -c 'gh pr create --fill'", [{ kind: 'create', cd: [] }]],
    ['sh -lc "cd app && gh pr merge 2"', [{ kind: 'merge', target: '2', cd: ['app'] }]],
    ["eval 'gh pr merge 5'", [{ kind: 'merge', target: '5', cd: [] }]],
    ['echo 5 | xargs gh pr merge', [{ kind: 'merge', cd: [], isOpaque: true }]],
    ['gh pr merge 1; gh pr merge 2', [{ kind: 'merge', target: '1', cd: [] }, { kind: 'merge', target: '2', cd: [] }]],
    // A body that spans lines and names the commands is text, not a command.
    [`gh pr create --title t --body "$(cat <<'EOF'\nRun gh pr merge 3 after.\nEOF\n)"`, [{ kind: 'create', cd: [] }]],
  ]
  for (const [command, found] of cases) expect({ command, found: prCommands(command) }).toEqual({ command, found })
})

test('the gate leaves other gh and git commands alone', () => {
  for (const command of ['gh pr view 12', 'gh pr list', 'gh pr checks', 'git push', 'git merge main', 'echo gh pr', 'gh issue create', 'echo "gh pr merge 3"']) {
    expect({ command, found: prCommands(command) }).toEqual({ command, found: [] })
  }
})
