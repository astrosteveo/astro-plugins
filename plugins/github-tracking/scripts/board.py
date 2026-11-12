#!/usr/bin/env python3
"""Make the GitHub Projects calls that keep a repo's board true, through the gh CLI.

It finds the board linked to the repo and the board's Status field itself, so no repo needs
to keep a project's ids in its CLAUDE.md. Commands: show where the board stands, move an
issue or PR to a status (adding it to the board first), make issues sub-issues of another,
post a status update, and give the board its views. Stdlib only, so any python3 runs it.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from collections import defaultdict

UPDATE_STATUSES = ("on-track", "at-risk", "off-track", "complete", "inactive")
URL = re.compile(r"https://github\.com/([^/]+)/([^/]+)/(?:issues|pull)/(\d+)")
# The REST version that can create a project's views.
API_VERSION = "2026-03-10"
# The views `views` gives a board. Each shows issues only, as an issue's PR shows in its Linked
# pull requests. The API can neither show nor sort by Created, Updated or Closed, so the done
# view keeps to the last two weeks instead of sorting by when each issue closed.
VIEWS = (
    {"name": "Open work", "layout": "board", "filter": "is:issue is:open", "vertical_group_by": "Status",
     "fields": ("Title", "Labels", "Milestone", "Linked pull requests", "Sub-issues progress")},
    {"name": "Milestones", "layout": "table", "filter": "is:issue is:open", "group_by": "Milestone",
     "fields": ("Title", "Status", "Labels", "Linked pull requests", "Sub-issues progress")},
    {"name": "Recently done", "layout": "table", "filter": "is:issue is:closed closed:>@today-14d",
     "fields": ("Title", "Labels", "Milestone", "Linked pull requests")},
)


class Fail(Exception):
    """A problem the caller can fix; main prints it without a traceback."""


def gh(*args: str, input: str | None = None) -> str:
    try:
        done = subprocess.run(["gh", *args], input=input, capture_output=True, text=True)
    except FileNotFoundError:
        raise Fail("the gh CLI isn't on the PATH")
    if done.returncode != 0:
        raise Fail(done.stderr.strip() or f"gh {args[0]} failed")
    return done.stdout


def graphql(query: str, **variables: str | int) -> dict:
    args = ["api", "graphql", "-f", f"query={query}"]
    for key, value in variables.items():
        # -F would read a string like "123" or "true" as a number or a boolean.
        args += ["-F" if isinstance(value, int) else "-f", f"{key}={value}"]
    return json.loads(gh(*args))["data"]


def this_repo() -> str:
    return gh("repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner").strip()


def board(repo: str, number: int | None) -> dict:
    """The open board linked to repo, with its Status field: the one with that number, or its only one."""
    owner, name = repo.split("/")
    found = graphql(
        """query($owner:String!,$name:String!){repository(owner:$owner,name:$name){projectsV2(first:20){nodes{
        id number title url closed field(name:"Status"){... on ProjectV2SingleSelectField{id options{id name}}}}}}}""",
        owner=owner, name=name)
    boards = [b for b in found["repository"]["projectsV2"]["nodes"] if not b["closed"]]
    if number is not None:
        boards = [b for b in boards if b["number"] == number]
        if not boards:
            raise Fail(f"no open board numbered {number} is linked to {repo}")
    if not boards:
        raise Fail(f"no board is linked to {repo}: set one up with /github-tracking:init, "
                   f"or link it with gh project link NUMBER --owner {owner} --repo {repo}")
    if len(boards) > 1:
        listed = ", ".join(f"{b['number']} ({b['title']})" for b in boards)
        raise Fail(f"{repo} has several boards: {listed}. Say which with --project NUMBER")
    if not boards[0]["field"]:
        raise Fail(f"the board {boards[0]['title']} has no Status field")
    return boards[0]


def content(repo: str, ref: str) -> tuple[str, str, int]:
    """The node id, kind and number of an issue or PR given by its number or URL."""
    match = URL.fullmatch(ref.strip())
    if match:
        owner, name, number = match[1], match[2], int(match[3])
    elif ref.lstrip("#").isdigit():
        (owner, name), number = repo.split("/"), int(ref.lstrip("#"))
    else:
        raise Fail(f"{ref} is neither an issue or PR number nor its URL")
    found = graphql(
        """query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){
        issueOrPullRequest(number:$number){__typename ... on Issue{id} ... on PullRequest{id}}}}""",
        owner=owner, name=name, number=number)["repository"]["issueOrPullRequest"]
    if not found:
        raise Fail(f"{owner}/{name} has no issue or PR #{number}")
    return found["id"], found["__typename"], number


def move(repo: str, project: int | None, ref: str, status: str) -> str:
    b = board(repo, project)
    options = b["field"]["options"]
    option = next((o for o in options if o["name"].casefold() == status.casefold()), None)
    if not option:
        raise Fail(f"the board {b['title']} has no status {status!r}; it has "
                   + ", ".join(o["name"] for o in options))
    node, _, number = content(repo, ref)
    # Adding an item the board already holds returns the item it has.
    item = graphql(
        "mutation($p:ID!,$c:ID!){addProjectV2ItemById(input:{projectId:$p,contentId:$c}){item{id}}}",
        p=b["id"], c=node)["addProjectV2ItemById"]["item"]["id"]
    graphql(
        """mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,
        fieldId:$f,value:{singleSelectOptionId:$o}}){projectV2Item{id}}}""",
        p=b["id"], i=item, f=b["field"]["id"], o=option["id"])
    return f"#{number} is {option['name']} on {b['title']}"


def sub(repo: str, parent: str, children: list[str]) -> list[str]:
    parent_id, kind, parent_number = content(repo, parent)
    if kind != "Issue":
        raise Fail(f"#{parent_number} is a pull request; only an issue has sub-issues")
    # Check every child before linking any, so a bad one leaves nothing linked.
    found = [content(repo, child) for child in children]
    for _, kind, number in found:
        if kind != "Issue":
            raise Fail(f"#{number} is a pull request; only an issue can be a sub-issue")
    said = []
    for child_id, _, number in found:
        graphql("mutation($p:ID!,$c:ID!){addSubIssue(input:{issueId:$p,subIssueId:$c}){issue{id}}}",
                p=parent_id, c=child_id)
        said.append(f"#{number} is a sub-issue of #{parent_number}")
    return said


def update(repo: str, project: int | None, status: str, body: str) -> str:
    if status not in UPDATE_STATUSES:
        raise Fail(f"a status update is one of {', '.join(UPDATE_STATUSES)}, not {status!r}")
    if not body.strip():
        raise Fail("the status update's body is empty")
    b = board(repo, project)
    posted = graphql(
        """mutation($p:ID!,$s:ProjectV2StatusUpdateStatus!,$b:String!){createProjectV2StatusUpdate(input:{
        projectId:$p,status:$s,body:$b}){statusUpdate{createdAt}}}""",
        p=b["id"], s=status.upper().replace("-", "_"), b=body.strip())
    return f"Posted a status update ({status}) on {b['title']} at {posted['createProjectV2StatusUpdate']['statusUpdate']['createdAt']}"


VIEWS_QUERY = """query($id:ID!){node(id:$id){... on ProjectV2{
  owner{__typename ... on User{login} ... on Organization{login}}
  fields(first:50){nodes{... on ProjectV2FieldCommon{name databaseId}}}
  views(first:50){nodes{id name layout filter groupByFields(first:1){totalCount}
    verticalGroupByFields(first:1){totalCount} sortByFields(first:1){totalCount}}}}}}"""


def untouched(view: dict) -> bool:
    """Whether a view is still the one GitHub starts a board with: a table of every item, as it came."""
    return (view["name"] == "View 1" and view["layout"] == "TABLE_LAYOUT" and not view["filter"]
            and not any(view[k]["totalCount"] for k in ("groupByFields", "verticalGroupByFields", "sortByFields")))


def views(repo: str, project: int | None) -> list[str]:
    """Add the VIEWS the board lacks, then drop an untouched View 1 so the board opens on Open work."""
    b = board(repo, project)
    found = graphql(VIEWS_QUERY, id=b["id"])["node"]
    ids = {f["name"]: f["databaseId"] for f in found["fields"]["nodes"] if "name" in f}
    have = {v["name"] for v in found["views"]["nodes"]}
    owner = found["owner"]
    path = f"{'users' if owner['__typename'] == 'User' else 'orgs'}/{owner['login']}/projectsV2/{b['number']}/views"
    said = []
    for view in VIEWS:
        if view["name"] in have:
            continue
        body = {"name": view["name"], "layout": view["layout"], "filter": view["filter"],
                "visible_fields": [ids[f] for f in view["fields"] if f in ids]}
        for key in ("group_by", "vertical_group_by"):
            if view.get(key) in ids:
                body[key] = [ids[view[key]]]
        made = json.loads(gh("api", "-X", "POST", "-H", f"X-GitHub-Api-Version: {API_VERSION}", path,
                             "--input", "-", input=json.dumps(body)))
        said.append(f"Added {view['name']}: {made['html_url']}")
    for view in found["views"]["nodes"]:
        if untouched(view):
            graphql("mutation($v:ID!){deleteProjectV2View(input:{viewId:$v}){projectV2View{id}}}", v=view["id"])
            said.append("Removed View 1, the table of every item a new board starts with")
    return said or [f"{b['title']} already has " + ", ".join(v["name"] for v in VIEWS)]


ITEMS = """query($id:ID!,$after:String){node(id:$id){... on ProjectV2{
  workflows(first:20){nodes{name enabled}}
  views(first:50){nodes{name}}
  statusUpdates(first:1,orderBy:{field:CREATED_AT,direction:DESC}){nodes{createdAt status body}}
  items(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{
    status:fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}}
    content{__typename ... on Issue{number title state} ... on PullRequest{number title state} ... on DraftIssue{title}}}}}}}"""


def show(repo: str, project: int | None) -> str:
    b = board(repo, project)
    items, after, page = [], None, None
    while True:
        page = graphql(ITEMS, id=b["id"], **({"after": after} if after else {}))["node"]
        items += page["items"]["nodes"]
        if not page["items"]["pageInfo"]["hasNextPage"]:
            break
        after = page["items"]["pageInfo"]["endCursor"]
    milestones = json.loads(gh("api", f"repos/{repo}/milestones?state=open&per_page=100"))

    lines = [f"{b['title']} (board {b['number']}, linked to {repo}): {b['url']}"]
    off = [w["name"] for w in page["workflows"]["nodes"] if not w["enabled"]]
    if off:
        lines.append("Workflows off: " + ", ".join(off))
    have = {v["name"] for v in page["views"]["nodes"]}
    missing = [v["name"] for v in VIEWS if v["name"] not in have]
    if missing:
        lines.append("Views missing: " + ", ".join(missing))
    lines.append("Open milestones: " + (", ".join(
        f"{m['title']} ({m['closed_issues']} of {m['open_issues'] + m['closed_issues']} closed)" for m in milestones)
        or "none"))

    by_status = defaultdict(list)
    for item in items:
        status = (item["status"] or {}).get("name") or "No status"
        c = item["content"] or {}
        closed = c.get("state") in ("CLOSED", "MERGED")
        # A draft can't be closed, so at Done it's done.
        if status == "Done" and (closed or c.get("__typename") == "DraftIssue"):
            continue
        label = f"#{c['number']} {c['title']}" if "number" in c else f"(draft) {c.get('title', '?')}"
        # A closed item that isn't Done, or an open one that is, is the board out of step.
        if closed:
            label += f" ({c['state'].lower()})"
        elif status == "Done":
            label += " (open)"
        by_status[status].append(label)
    order = [o["name"] for o in b["field"]["options"]] + ["No status"]
    for status in sorted(by_status, key=lambda s: order.index(s) if s in order else len(order)):
        lines.append(f"{status}:")
        lines += [f"  {label}" for label in by_status[status]]

    latest = page["statusUpdates"]["nodes"]
    if latest:
        u = latest[0]
        lines.append(f"Latest status update ({u['createdAt'][:10]}, {u['status'].lower().replace('_', '-')}):")
        lines += [f"  {line}" for line in u["body"].splitlines()]
    else:
        lines.append("No status update yet")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    # --repo and --project go before or after the command. After it, SUPPRESS keeps the
    # command from setting one given before it back to None.
    options = argparse.ArgumentParser(add_help=False)
    for p, default in ((parser, None), (options, argparse.SUPPRESS)):
        p.add_argument("--repo", default=default, help="OWNER/NAME; the current folder's repo by default")
        p.add_argument("--project", type=int, default=default, help="the board's number, when the repo has several")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("show", parents=[options],
                        help="the board's open milestones, items not done and latest status update")
    m = commands.add_parser("move", parents=[options], help="put an issue or PR on the board, at a status")
    m.add_argument("item", help="its number or URL")
    m.add_argument("status", help="one of the board's statuses, such as Todo, 'In Progress' or Done")
    s = commands.add_parser("sub", parents=[options], help="make issues sub-issues of a parent issue")
    s.add_argument("parent", help="the parent's number or URL")
    s.add_argument("children", nargs="+", help="each sub-issue's number or URL")
    u = commands.add_parser("update", parents=[options], help="post a status update on the board")
    u.add_argument("status", choices=UPDATE_STATUSES)
    u.add_argument("file", help="a Markdown file with its body, or - for stdin")
    commands.add_parser("views", parents=[options],
                        help="give the board views of its open work, milestones and recently done issues")
    args = parser.parse_args(argv)

    try:
        if args.repo and not re.fullmatch(r"[^/\s]+/[^/\s]+", args.repo):
            raise Fail(f"--repo is OWNER/NAME, not {args.repo}")
        repo = args.repo or this_repo()
        if args.command == "show":
            print(show(repo, args.project))
        elif args.command == "move":
            print(move(repo, args.project, args.item, args.status))
        elif args.command == "sub":
            print("\n".join(sub(repo, args.parent, args.children)))
        elif args.command == "views":
            print("\n".join(views(repo, args.project)))
        else:
            body = sys.stdin.read() if args.file == "-" else open(args.file).read()
            print(update(repo, args.project, args.status, body))
    except (Fail, OSError) as problem:
        print(f"board.py: {problem}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
