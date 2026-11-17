# Changelog

All notable changes to **@tuvl/client** are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project follows [Semantic Versioning](https://semver.org). Releases are cut by hand: see
[Releasing](CONTRIBUTING.md#releasing). The first entry is the first 2.1 release.

---

## [2.1.0-beta.6] — 2026-11-17

**The 2.1 client: a beta that pairs with `tuvl 2.1.0b6`.** The version number follows the engine's beta (2.1.0-beta.1 and 2.1.0-beta.2 were
never published). Install it from the `beta` tag, so that `latest` stays on 2.0.0:

```bash
npm install @tuvl/client@beta
```

It needs Node.js 22 or newer and talks to a tuvl 2.x server; it was checked against 2.1 (a browser can read a throttled sign-in's `Retry-After` from
`tuvl 2.1.0b6`). Nothing a 2.0 program calls was removed; read **Changed** for what behaves differently.

### Added

- **A followed stream reconnects.** `events()`, `stream()` and `tokens()` reopen the stream from the next position after the last one read when the connection drops
  or a proxy closes it, skip what they already delivered, and stop at the run's last event or a final status. After five failed attempts in a row they throw
  `TuvlStreamError { runId, lastSeq, cause }`; resume with `events({ fromSeq: error.lastSeq + 1 })`. `follow: false` is one pass and never reconnects.
- **`TuvlTimeoutError`** (`runId`, `status`, `timeoutMs`) is what `wait({ timeoutMs })` rejects with; it is an `Error` and its message is the one `wait` always had.
  `wait()` also takes `maxIntervalMs`.
- **`TuvlApiError.retryAfter`**: the seconds a `429` or `503` asked the caller to wait (`Retry-After`, a number or an HTTP date).
- **`TuvlAuth.setPassword(token, password)`** for the set-password links of `tuvl iam users invite`; **`readOAuthToken({ url?, clear? })`** reads the token an OAuth sign-in leaves in
  the landing page's URL fragment; **`client.ready()`** asks `GET /ready`; **`TuvlAuth.jwksUrl()`** names where the signing keys are published.
- **`verifyWebhook` and `webhookHandler` take `maxBodyBytes`** (default 64 KiB); a larger body is `WebhookError("too_large")`, and the handler answers `413`.
- Types follow the engine: `RunStatus` has `compensating`, `RunEventType` lists the ten events the journal writes since 2.0 (`memory_*`, `map_*`, `parallel_*`, `supervisor`),
  `Approval` has `assignee`.
- `tuvl-client generate --help`; `--option=value`.

### Changed

- **Node.js 22 is the minimum** (`engines` said `>=18`; it, the build target and the CI matrix now agree: 22, 24 and 26, the lines Node itself supports). The package still runs
  anywhere that has Web Crypto and `fetch`, but not on Node 18, where `verifyWebhook` never worked (no global `crypto`).
- **A stream that ends is no longer taken for a run that ended**: where `events()` used to stop silently when the connection dropped, it now reconnects or throws `TuvlStreamError`.
- **`wait()` backs off** from `intervalMs` (500 ms) to `maxIntervalMs` (5 s) instead of polling at a fixed interval, rides out five transient failures in a row
  (network error, 408, 425, 429, 5xx) and rejects at once on any other refusal. A run that waits on a person is still polled for as long as they take unless you pass
  `untilWaiting`, `timeoutMs` or a `signal`.
- **`TuvlRunError.message` no longer carries the run's body** (`tuvl run r1 ended with HTTP 422`); it is on `.body`. Messages reach logs and error trackers.
- **`readToken` and `isTokenExpired` refuse malformed claims** they used to pass: a payload that is not an object, `groups` or `scopes` that are not lists of strings, a non-numeric `exp`.
- **`crud(model)` encodes the model name** and throws a `TypeError` for `""`, `.` and `..`.
- **A success answer that is not JSON** (a proxy's page, a wrong `baseUrl`) is a `TuvlApiError` naming the path and the content type, not a `SyntaxError`.
- **`Run.status_url` and `events_url` are optional**: a run started by an anonymous caller of a public trigger has neither, and a handle on it says why a read is refused.
- `tuvl-client generate` refuses an unknown option, a flag without a value, a stray word and `--file` with `--url` (exit 2) instead of using the defaults.

### Fixed

- `onToken(...)` no longer produces an unhandled rejection when the stream fails and nobody awaits `done`.
- The OAuth example read the token from the query string; the engine puts it in the URL fragment.
- Revocation is documented as it works: with or without Redis.

### Security

- **A webhook body or signature header cannot be made to cost unbounded CPU.** The body is read with a limit and refused before anything is hashed; a signature header over 2 KB or with
  more than 10 candidates is `malformed`; a valid candidate stops the check. The review's 10 MB input with 200 candidates went from 1.8 s of CPU to none.
- **Publishing uses npm trusted publishing** (OIDC, no stored token) from a protected environment, with provenance; every GitHub Action is pinned to a commit.
