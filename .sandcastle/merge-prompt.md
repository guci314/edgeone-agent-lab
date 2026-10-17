# TASK

Merge the following branches into the current branch:

{{BRANCHES}}

For each branch:

1. Run `git merge <branch> --no-edit`
2. If there are merge conflicts, resolve them intelligently by reading both sides and choosing the correct resolution
3. After resolving conflicts, verify everything works (per AGENTS.md):

   - `npm run typecheck` always
   - `npm test` before the final commit (the full 190-check suite, pure local)
   - No resource/UI gates exist in this repo — skip anything resource-related

4. If checks fail, fix the issues before proceeding to the next branch
5. **Failure triage (important)**: if checks fail, first decide whether the failure pre-exists — run the same command on the branch base (target branch): fails there too = pre-existing, verify the root cause confirms it is unrelated to these changes, record that reasoning and proceed; passes there = regression introduced by this work, must be fixed.

After all branches are merged, make a single commit summarizing the merge (prefix `RALPH: merge`).

# CLOSE ISSUES

For each branch that was merged, close its issue using the following command:

`gh issue close <ID> --comment "Completed by Sandcastle"`

Here are all the issues:

{{ISSUES}}

Once you've merged everything you can, output <promise>COMPLETE</promise>.
