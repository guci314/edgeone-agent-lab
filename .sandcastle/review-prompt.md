# TASK

Review the code changes on branch `{{BRANCH}}` and improve code clarity, consistency, and maintainability while preserving exact functionality — then verify against AGENTS.md's testing rules.

# CONTEXT

You are an autonomous engineer in a Docker sandbox (Linux, Node 22 with TypeScript type-stripping, npm; dependencies pre-copied from the host). No platform logins, no real network calls — verify with `npm test` / `npm run typecheck`.

## Branch diff

!`git diff {{TARGET_BRANCH}}...{{BRANCH}}`

## Commits on this branch

!`git log {{TARGET_BRANCH}}..{{BRANCH}} --oneline`

# REVIEW PROCESS

1. **Understand the change**: Read the diff and commits above to understand the intent.

2. **Analyze for improvements**: Look for opportunities to:
   - Reduce unnecessary complexity and nesting
   - Eliminate redundant code and abstractions
   - Improve readability through clear variable and function names
   - Consolidate related logic
   - Remove unnecessary comments that describe obvious code
   - Avoid nested ternary operators - prefer switch statements or if/else chains
   - Choose clarity over brevity - explicit code is often better than overly compact code

3. **Check correctness & architecture (AGENTS.md gates)**:
   - Does the implementation match the intent? Are edge cases handled?
   - Layout & dependency boundaries: `src/feishu` / `src/ghworkspace` → `src/shared` only, **feishu and ghworkspace never import each other**; `bridge/` and `cloud-functions/` are independent sub-packages
   - Keep the zero-platform-dependency property: core logic must stay testable without EdgeOne/Feishu network (fetch stubs stay in tests, not product code)
   - New dependencies go into the root `package.json` only — no ad-hoc imports outside dependencies
   - Smallest change that satisfies the request; no unrelated rewrites
   - Are new/changed behaviors covered by assertions in `test/smoke.ts`?
   - Forbidden files untouched: `.github/workflows/`, `deploy.sh`, `edgeone.json`, `wrangler.jsonc`, the OPENWIKI block in AGENTS.md

4. **Maintain balance**: Avoid over-simplification that could reduce clarity, create overly clever solutions, or merge concerns.

5. **Apply project standards**: Follow the coding standards defined in @.sandcastle/CODING_STANDARDS.md

6. **Preserve functionality**: Never change what the code does - only how it does it.

# VERIFICATION (npm, per AGENTS.md)

Run both gates — they are the entire test surface of this repo:

- `npm test` (single entry, 190 checks)
- `npm run typecheck` (`tsc --noEmit`)
- Both must be green. First run after dependency changes may take a minute — wait, do not abort.

# EXECUTION

If you find improvements or failing checks:

1. Make the changes directly on this branch
2. Re-run the same checks until they pass
3. Commit describing the refinements (prefix `RALPH:` review refinement)

If the code is already clean and all checks pass, do nothing.

Once complete, output <promise>COMPLETE</promise>.
