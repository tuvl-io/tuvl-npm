# Contributing

Thank you for your interest in `@tuvl/client`, the TypeScript client for the [tuvl](https://tuvl.io) workflow engine.

## Setup

Developing needs Node.js 20 or newer (the test runner requires it) and [pnpm](https://pnpm.io) 10. The published
package itself supports Node.js 18 and newer.

```bash
git clone https://github.com/tuvl-io/tuvl-npm.git
cd tuvl-npm
pnpm install --frozen-lockfile
```

## Checks

```bash
pnpm typecheck    # tsc --noEmit
pnpm lint         # biome (lint only; there is no formatter)
pnpm test         # vitest, one shot
pnpm test:coverage  # the same, with a v8 coverage report
pnpm build        # tsup: ESM + CJS + types, and the tuvl-client CLI
make check        # typecheck + lint + test, the CI gate
```

The client has no runtime dependencies and uses only web-standard APIs (`fetch`, `ReadableStream`, Web Crypto), so it runs
on Node, browsers, Deno, Bun and edge runtimes. Keep it that way: a new runtime dependency is a design discussion first.

### Live tests

`src/live.test.ts` runs against a real tuvl server and is skipped unless `TUVL_LIVE_URL` is set. Start a server on the
workflow in `live/workflows/approve_amount.yaml`, then:

```bash
TUVL_LIVE_URL=http://localhost:8885 TUVL_LIVE_TOKEN=<token> pnpm test src/live.test.ts
```

## Code

- The server contract is `AGENTIC_MANUAL.md`. A change to what the client sends, returns or throws updates it in the same pull request.
- A request the server refuses rejects with `TuvlApiError`; do not throw a bare `Error` for an HTTP failure.
- Add a test beside the module you change (`src/<module>.test.ts`). Stub `fetch`; do not reach for the network.
- Comments are short and say the non-obvious *why*, not what the code does.

## Pull requests

1. Fork the repository and branch from `develop`: `git checkout -b fix/my-change`.
2. Run `make check && pnpm build`.
3. Use a conventional commit message (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`).
4. Open the pull request against `develop` and say what changed and why.

### Sign-off

tuvl uses the [Developer Certificate of Origin](DCO). It says you wrote the change, or have the right to submit it,
under this project's license. Add a `Signed-off-by` line to each commit with `git commit -s`:

```
Signed-off-by: Your Name <you@example.com>
```

Use your real name and an address you can be reached at. A pull request whose commits are not signed off
will be asked to add it (`git rebase --signoff develop`).

## Security

Report a vulnerability privately; see [SECURITY.md](SECURITY.md). Never open a public issue for one.

## License

By contributing, you agree that your contribution is licensed under the Apache License, Version 2.0 (Apache-2.0 §5: a
contribution you submit is under these terms unless you state otherwise), and your sign-off certifies the [DCO](DCO).
You keep the copyright in your contribution.
