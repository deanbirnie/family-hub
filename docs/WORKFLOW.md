# Planning and delivery with Issues and Projects

[Issues](https://github.com/deanbirnie/family-hub/issues) are the source of truth for actionable work. Projects is the queue; PRs deliver work; Markdown retains durable architecture, decisions, security/data protection and owner runbooks. Do not maintain a second task checklist in Markdown. This is a public repository: never include real family records, credentials, keys, medical data or locations.

## Project setup

Create or reuse a single Family Hub project, link this repository, and import all open issues. Configure Status: Backlog, Todo, In progress, In review, Done. Enable auto-add for repository deanbirnie/family-hub with filter `is:issue is:open`; set new work to Backlog and closed issues to Done. Create these views:

| View | Filter | Layout |
|---|---|---|
| Ready next | status:Todo -label:needs-decision | Table |
| In flight | status:"In progress","In review" | Board grouped by Status |
| Needs me | label:needs-decision is:open | Table |
| All work | No filter | Table |

Project setup is manual until a Projects-capable connection is available. Initial assignments: #48 In review (PR #47); #49, #56, #59, #61, #63 need decisions. Suggested Todo queue: #60 (medicine reminders), #69 (scheduled backups), #71 (accessibility audit), subject to confirming scope and no overlapping work. All other open items Backlog. Keep at most three independent Todo items; do not promote work with dependencies or unresolved decisions.

## Prepare and start an issue

Search existing issues and PRs first. Write the goal, current behavior/reproduction where relevant, scope and exclusions, acceptance tests, source links, dependencies (Blocked by #N), and data protection implications. Get approval for security/data protection changes per DATA-PROTECTION.md and MAINTENANCE.md. Add needs-decision when a concrete owner choice is necessary; state the options and recommendation. Remove it after the decision is recorded.

Start a new model session with:

> Work on deanbirnie/family-hub issue #N. Read this guide, the issue and its linked decisions, current main and any active PR. Confirm dependencies and acceptance criteria. Work on a dedicated branch, update the issue with progress, run relevant checks and open a PR. Stop for owner decisions; do not merge or release without approval.

Move to In progress only when starting. Check other active branches/PRs to avoid collisions. Keep unrelated fixes in separate issues. Use issue comments, not chat history, for durable context.

## Handoff and review

Before handing off, comment on the issue with branch/PR, base and last commit, completed work, remaining work, files changed, commands/results, risks and next step. The next model reads the issue and PR, inspects current branch and continues without repeating completed work. Move to In review when PR is ready.

Use `Closes #N` in a delivery PR targeting main only when it satisfies all code acceptance criteria. Use `Refs #N` for partial work or live checks. Review diff, CI (including skipped jobs), security and migrations; record actual verification. Merge only after owner approval; verify default branch and close completed issues, set Done. Keep deployment/physical phone checks separate (#74–77) and close only after owner confirms evidence. Follow README release-by-label rules; do not label a docs-only PR for release.

## Existing work

Phase 10c #48; phase 11 plan #49 blocks #50–54; notifications #54 depend on #50–53. Meals #55 depends on #50 for shopping integration. Later phases #56; CardDAV #57; Health #58–60; household #61–63; cross-cutting #64–73; deployment/live checks #74–77. Historical merged delivery PRs #1–46 remain the record for completed work. Owner steps remain a runbook, not a separate development queue.
