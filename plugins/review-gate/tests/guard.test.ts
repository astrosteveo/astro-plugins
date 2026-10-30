import { expect, test } from 'claude-code/testing'
import { opensOrMerges } from '../hooks/guard'

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
