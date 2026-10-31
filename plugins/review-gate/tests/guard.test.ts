import { expect, test } from 'claude-code/testing'
import { opensOrMerges } from '../hooks/guard'

test('a command that opens or merges a pull request is caught as it is normally written, through wrappers, quotes, comments and continued lines, and other gh commands are not', () => {
  const caught = [
    'gh pr create --fill',
    'git push -u origin feat/x && gh pr create --fill',
    'gh pr new --fill',
    'gh pr -R owner/repo create',
    'gh pr --repo=owner/repo merge 3',
    'gh -R owner/repo pr create',
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
    '`command -v gh` pr merge 3',
    '(gh pr merge 3)',
    'gh pr -Ro/r merge 3',
    'gh pr -R"o/r" create',
    'gh pr -R "$(gh repo view --json nameWithOwner -q .nameWithOwner)" merge 3',
    'gh pr -R $(gh repo view -q .x) merge 3',
    'gh pr "merge" 3',
    "gh 'pr' create",
    '\\gh pr merge 3',
    'g\\h pr merge 3',
    'gh pr mer\\ge 3',
    "gh pr $'merge' 3",
    'gh pr merge>/tmp/out 3',
    'gh pr create>/dev/null --fill',
    'gh>/dev/null pr merge 3',
    'gh 2>/dev/null pr merge 3',
    'gh --repo o/r pr merge 3',
    'echo "say \\"hi\\"" && gh pr --repo "o/r" merge 12',
    "# don't forget\ngh pr --repo 'owner/repo' merge 12",
    'out=$(grep ")" f; gh pr --repo "o/r" merge 1)',
    'echo a\\\\\ngh pr merge 1',
    'gh pr mer\\\nge 3',
    'gh pr merge 12 &>/dev/null',
    'gh pr &>/dev/null merge 12',
    'gh pr >|/tmp/x merge 12',
    'bash <<< "gh pr merge 1"',
    "sh <<<'gh pr create --fill'",
    'echo "step 1 ->"\ngh pr merge 1',
    '# send stderr with 2>\ngh pr merge 1',
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
    'gh pr checkout 12 && git merge main',
    'gh pr view 12 --comments | grep -i new',
    'gh pr diff 5 | grep create',
    'cd $DIR && git merge feature/pr-new-thing',
    "gh pr list --json title | jq '.[] | select(.title | test(\"new\"))'",
    'gh issue list --label pr merge',
    'gh issue create --title "pr merge notes"',
    'gh pr view 12 > pr-create.txt',
    "git commit -F - <<'EOF'\nfeat: route gh through the tool\n\nThe pr merge path is refused.\nEOF",
  ]
  for (const command of passed) expect({ command, caught: opensOrMerges(command) }).toEqual({ command, caught: false })
})

test('a command with many flags after pr is read at once', () => {
  const started = Date.now()
  expect(opensOrMerges(`gh pr ${'--x '.repeat(40)}y`)).toBe(false)
  expect(opensOrMerges(`gh pr ${'--x '.repeat(40)}merge`)).toBe(true)
  expect(Date.now() - started < 50).toBe(true)
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
