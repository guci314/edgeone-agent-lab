# TASK

Fix issue {{TASK_ID}}: {{ISSUE_TITLE}}

Pull in the issue using `gh issue view {{TASK_ID}}`. If it references a parent PRD or doc, pull that in too.

Only work on the issue specified.

Work on branch {{BRANCH}}. Make commits and run checks.

# CONTEXT

You are an autonomous engineer in a Docker sandbox (Linux, Node 22 with TypeScript type-stripping, npm; dependencies are pre-copied from the host into the worktree, `npm install` is only a safety net). Host-side tooling and platform logins are unavailable.

The repository contract `AGENTS.md` is authoritative — read it and honor it (module layout, dependency boundaries, test gates, forbidden files: `.github/workflows/`, `deploy.sh`, `edgeone.json`, `wrangler.jsonc`, the OPENWIKI block).

Here are the last 10 commits:

<recent-commits>

!`git log -n 10 --format="%H%n%ad%n%B---" --date=short`

</recent-commits>

# EXPLORATION

Explore the repo and fill your context window with relevant information that will allow you to complete the task.

Pay extra attention to the relevant sections of `test/smoke.ts` — it is the single test entry (190 assertions, fully local, stubs global fetch).

# EXECUTION

If applicable, use RGR to complete the task.

1. RED: write one test
2. GREEN: write the implementation to pass that test
3. REPEAT until done
4. REFACTOR the code

# FEEDBACK LOOPS (npm, per AGENTS.md)

Before committing, run the narrowest meaningful checks (everything happens in this sandbox):

- Behavior change → `npm test` (single entry, 190 checks, pure local, no platform)
- Type-level change → `npm run typecheck` (`tsc --noEmit`, strict: true)
- Run **both** before every commit; both must be green
- First `npm install` / dependency work may take a minute or two — wait, do not abort
- Unavailable here (do not attempt): EdgeOne platform login (`edgeone makers dev/deploy` needs a token), real Feishu/network calls (tests stub them). No browser needed.

Docs-only changes: skip the build; verify md paths/links by reading them back.

# COMMIT

Make a git commit. The commit message must:

1. Start with `RALPH:` prefix
2. Include task completed + doc/PRD reference
3. Key decisions made
4. Files changed
5. Blockers or notes for next iteration

Keep it concise. Use Chinese conventional style (`feat(scope): ...` etc.) after the prefix, matching repo history.

# THE ISSUE

If the task is not complete, leave a comment on the issue with what was done.

Do not close the issue - this will be done later.

Once complete, output <promise>COMPLETE</promise>.

# FINAL RULES

ONLY WORK ON A SINGLE TASK.
