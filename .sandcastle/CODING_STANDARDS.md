# Coding Standards (distilled from AGENTS.md — reviewer loads this file)

## Architecture

- Layout: `src/feishu/` (飞书侧：验签/事件/命令/会话/OAuth/云文档工具), `src/ghworkspace/` (GitHub 工作区与 `gh_` issue 工具族), `src/shared/` (共享 util)
- Dependency direction: `feishu` / `ghworkspace` → `shared` only; **feishu and ghworkspace must never import each other**
- `bridge/` and `cloud-functions/` are independent sub-packages (own package.json) — do not couple root `src/` to them
- Keep the zero-platform-dependency property: core logic testable with no EdgeOne/Feishu/network (test stubs global fetch; product code must not gain network calls that tests can't fake)
- New dependencies go into the root `package.json` and must survive `npm ci`

## Style

- TypeScript `strict: true`, ESM (`type: module`), import sources keep the `.ts` extension (Node type-stripping)
- Make the smallest change that satisfies the request; prefer existing patterns (store/kv helpers, section-stub tests) over new abstractions
- Comments only for non-obvious reasons; follow the repo's existing comment density
- Commit messages: Chinese conventional style (`feat(scope): ...`), agent commits prefixed `RALPH:`

## Testing (AGENTS.md)

- Single test entry: `npm test` (`test/smoke.ts`, 190 checks, pure local) — add assertions in the relevant lettered section, keeping the per-section stub style (each section installs its own fetch stubs, no cross-section dependencies)
- Type-level changes also need `npm run typecheck` (`tsc --noEmit`)
- Both gates green before commit; if a gate cannot be run, state the concrete reason and the command that should be run
- Do not weaken existing assertions to make them pass

## Done Criteria (AGENTS.md)

- `npm test` and `npm run typecheck` both pass, or the reason they were not run is explicit
- The diff is scoped to the requested behavior; no unrelated rewrites
- New behavior is covered by assertions in `test/smoke.ts`
- Forbidden files untouched: `.github/workflows/`, `deploy.sh`, `edgeone.json`, `wrangler.jsonc`, OPENWIKI block in AGENTS.md
