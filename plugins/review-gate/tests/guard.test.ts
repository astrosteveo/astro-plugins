import { expect, test } from 'claude-code/testing'
import { prCommand, reviewerRefusal } from '../hooks/guard'

// Commands a reviewer may run: they only look.
const READS = [
  'git log --oneline -20',
  'git -C /repo show HEAD:src/app.ts',
  'git diff abc1234 def5678 -- src/app.ts',
  'git blame -L 10,40 src/app.ts',
  'git grep -n "token ==" -- src',
  'git --no-pager log -p -3 -- src/auth.ts',
  'rg -n "parseConfig" src',
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
]

// Commands a reviewer may not run, and the start of why.
const REFUSED: [string, string][] = [
  ['rm -rf src', 'review-gate: reviewers only read, so this command was refused: rm is not one'],
  ['git commit -m "fix"', 'review-gate: reviewers only read, so this command was refused: git commit is not one that only reads'],
  ['git checkout main', 'review-gate: reviewers only read, so this command was refused: git checkout is not'],
  ['git -c core.pager=evil log', 'review-gate: reviewers only read, so this command was refused: git -c can change what git runs'],
  ['git diff --output=out.patch', 'review-gate: reviewers only read, so this command was refused: git --output writes a file'],
  ['git grep -O vim token', 'review-gate: reviewers only read, so this command was refused: git grep -O runs another program'],
  ['cat src/app.ts > copy.ts', 'review-gate: reviewers only read, so this command was refused: it substitutes a command or writes a file'],
  ['echo $(whoami)', 'review-gate: reviewers only read, so this command was refused: it substitutes a command'],
  ['echo `whoami`', 'review-gate: reviewers only read, so this command was refused: it substitutes a command'],
  ["sed -i 's/a/b/' src/app.ts", 'review-gate: reviewers only read, so this command was refused: sed -i writes the file'],
  ["sed -n 's/a/b/w out' src/app.ts", 'review-gate: reviewers only read, so this command was refused: sed may only print lines'],
  ['find . -name "*.tmp" -delete', 'review-gate: reviewers only read, so this command was refused: find may only list'],
  ['find . -exec rm {} \\;', 'review-gate: reviewers only read, so this command was refused: find may only list'],
  ['sort -o names.txt names.txt', 'review-gate: reviewers only read, so this command was refused: sort -o writes a file'],
  ['uniq in.txt out.txt', 'review-gate: reviewers only read, so this command was refused: uniq writes its second file'],
  ['rg --pre ./run.sh token', 'review-gate: reviewers only read, so this command was refused: rg --pre runs another program'],
  ['tail -f log.txt', 'review-gate: reviewers only read, so this command was refused: tail -f never ends'],
  ['GIT_EXTERNAL_DIFF=./x git diff', 'review-gate: reviewers only read, so this command was refused: it sets a variable first'],
  ['bun test', 'review-gate: reviewers only read, so this command was refused: bun is not one'],
  ['ls && npm install', 'review-gate: reviewers only read, so this command was refused: npm is not one'],
  ['cat <<EOF\nrm -rf /\nEOF', 'review-gate: reviewers only read, so this command was refused: rm is not one'],
]

test('a reviewer runs the commands that only look', () => {
  for (const command of READS) expect({ command, refusal: reviewerRefusal(command, false) }).toEqual({ command, refusal: undefined })
})

test('a reviewer is refused a command that could change something, with the reason', () => {
  for (const [command, reason] of REFUSED) {
    const refusal = reviewerRefusal(command, false) ?? ''
    expect({ command, starts: refusal.startsWith(reason) ? reason : refusal }).toEqual({ command, starts: reason })
  }
})

test('a reviewer runs nothing in the background', () => {
  expect(reviewerRefusal('git log', true)).toBe('review-gate: reviewers only read, so this command was refused: run it in the foreground.')
})

test('the gate finds gh pr create and gh pr merge, with what they name', () => {
  expect(prCommand('gh pr create --title "Add the gate" --body "Testing: bun test"')).toEqual({ kind: 'create' })
  expect(prCommand('git push -u origin feat/x && gh pr create --fill')).toEqual({ kind: 'create' })
  expect(prCommand('gh pr create --head feat/other --fill')).toEqual({ kind: 'create', head: 'feat/other' })
  expect(prCommand('gh pr create -H me:feat/other')).toEqual({ kind: 'create', head: 'me:feat/other' })
  expect(prCommand('cd ../repo && gh pr create --fill')).toEqual({ kind: 'create', cd: '../repo' })
  expect(prCommand('gh pr merge --squash --delete-branch')).toEqual({ kind: 'merge' })
  expect(prCommand('gh pr merge 12 --squash')).toEqual({ kind: 'merge', target: '12' })
  expect(prCommand('gh pr merge --subject "Ship it" 14')).toEqual({ kind: 'merge', target: '14' })
  expect(prCommand('GH_TOKEN=x gh pr merge feat/x')).toEqual({ kind: 'merge', target: 'feat/x' })
  // A body that spans lines and names the commands stays one word of the create.
  expect(prCommand(`gh pr create --title t --body "$(cat <<'EOF'\nRun gh pr merge 3 after.\nEOF\n)"`)).toEqual({ kind: 'create' })
})

test('the gate leaves other gh and git commands alone', () => {
  for (const command of ['gh pr view 12', 'gh pr list', 'gh pr checks', 'git push', 'git merge main', 'echo gh pr', 'gh issue create']) {
    expect({ command, pr: prCommand(command) }).toEqual({ command, pr: undefined })
  }
})
