/**
 * OpenCode Go fetch shim — injects the `x-opencode-session` header.
 *
 * Why this file exists
 * --------------------
 * The OpenCode Go (Zen) gateway REQUIRES `x-opencode-session`. The public docs
 * describe it as a routing/prompt-cache optimisation, but it is actually an
 * admission check: without it every request fails with
 *
 *   HTTP 400
 *   {"type":"error","error":{"type":"MissingSessionID","message":"Request is
 *    missing x-opencode-session and cannot be routed efficiently."}}
 *
 * OpenWiki's `openai-compatible` provider exposes no way to set custom request
 * headers — `MANAGED_ENV_KEYS` only covers `*_API_KEY`, `*_BASE_URL`,
 * `STREAMING`, `STREAM_MESSAGES`, `USE_RESPONSES_API` and
 * `REASONING_EFFORT_SUPPORTED`. So this cannot be solved in configuration.
 *
 * It CAN be solved at the process boundary. OpenWiki builds the
 * openai-compatible client as
 *
 *   configuration: { baseURL, fetch: createOpenAiCompatibleFetch() }
 *
 * and `createOpenAiCompatibleFetch()` returns
 * `(input, init) => globalThis.fetch(input, ...)` — `globalThis.fetch` is
 * resolved at CALL time, not captured at module load. Replacing it before the
 * process starts therefore intercepts those requests.
 *
 * Usage
 * -----
 *   NODE_OPTIONS="--import=<abs path to this file>" openwiki code --update --print
 *
 * In GitHub Actions the path is `${{ github.workspace }}/.github/openwiki/opencode-go-fetch.mjs`.
 * `NODE_OPTIONS` (rather than a CLI flag) so child processes inherit it too.
 *
 * Session id
 * ----------
 * One id per PROCESS, not per request: one OpenWiki process is one wiki run and
 * one conversation. A fresh id per request would scatter routing and defeat the
 * prompt cache the header exists to enable.
 *
 * This file contains no credentials. The API key comes from
 * `OPENAI_COMPATIBLE_API_KEY` (a repo secret in CI, macOS Keychain locally).
 */

const TARGET_HOST = "opencode.ai";

const SESSION_ID =
  globalThis.crypto?.randomUUID?.() ??
  `openwiki-${Date.now()}-${Math.random().toString(36).slice(2)}`;

// The docs ask clients to identify themselves with their own user agent rather
// than a generic SDK name.
const USER_AGENT = "openwiki-coding-agent/1.0";

const originalFetch = globalThis.fetch;

/** Extract the URL string from either shape `fetch` accepts. */
function resolveUrl(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === "object" && typeof input.url === "string") return input.url;
  return "";
}

/**
 * Inject headers only for the target host; everything else passes through
 * untouched.
 *
 * `input` may be a `Request` (in which case `init` is undefined and the headers
 * live on the Request). Rebuilding it with `new Request(input, init)` is unsafe
 * once the body has been consumed, so that shape is handled conservatively by
 * cloning with extra headers. The actual caller (LangChain's ChatOpenAI → the
 * openai SDK) uses the `fetch(url, init)` string form.
 */
globalThis.fetch = function openwikiFetchWithSession(input, init) {
  const url = resolveUrl(input);
  if (!url.includes(TARGET_HOST)) {
    return originalFetch(input, init);
  }

  if (input && typeof input === "object" && typeof input.url === "string" && init === undefined) {
    const headers = new Headers(input.headers);
    if (!headers.has("x-opencode-session")) headers.set("x-opencode-session", SESSION_ID);
    if (!headers.has("user-agent")) headers.set("user-agent", USER_AGENT);
    return originalFetch(new Request(input, { headers }));
  }

  const headers = new Headers(init?.headers);
  if (!headers.has("x-opencode-session")) headers.set("x-opencode-session", SESSION_ID);
  if (!headers.has("user-agent")) headers.set("user-agent", USER_AGENT);
  return originalFetch(input, { ...init, headers });
};
