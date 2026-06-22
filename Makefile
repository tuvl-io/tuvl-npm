.PHONY: help setup install dev build clean \
        test test-watch test-verbose typecheck check \
        smoke verify publish-dry publish whoami

# ── Package manager + tools ──────────────────────────────────────────────────
# pnpm is canonical (lockfile is pnpm-lock.yaml).  Override via `make PKG=npm`
# if you need to run with npm / yarn on a one-off basis.
PKG  ?= pnpm
NPX  := $(PKG) exec
NODE := node
DIST := dist

# ── Help ─────────────────────────────────────────────────────────────────────
help:
	@echo "@tuvl/client — TypeScript SDK for the tuvl workflow engine"
	@echo ""
	@echo "Usage: make <target>"
	@echo ""
	@echo "  setup         Install dependencies from pnpm-lock.yaml"
	@echo "  dev           Run tsup in watch mode (rebuilds on save)"
	@echo "  build         Build dist/ with tsup"
	@echo ""
	@echo "  test          Run the vitest suite (one-shot)"
	@echo "  test-watch    Run vitest in watch mode"
	@echo "  test-verbose  Run vitest with the verbose reporter"
	@echo "  typecheck     Run tsc --noEmit"
	@echo "  check         typecheck + test (CI quality gate)"
	@echo ""
	@echo "  smoke         pack → install into /tmp → require() the artefact"
	@echo "  verify        check + build + smoke (pre-publish gate)"
	@echo "  publish-dry   pnpm publish --dry-run (see what would ship)"
	@echo "  publish       verify, then pnpm publish --access public"
	@echo ""
	@echo "  whoami        Show the npm identity that would publish"
	@echo "  clean         Remove dist/, node_modules caches, leftover *.tgz"

# ── Install ──────────────────────────────────────────────────────────────────
setup:
	$(PKG) install --frozen-lockfile

install: setup

# ── Dev / build ──────────────────────────────────────────────────────────────
dev:
	$(PKG) run dev

build:
	$(PKG) run build

# ── Test ─────────────────────────────────────────────────────────────────────
test:
	$(PKG) run test

test-watch:
	$(PKG) run test:watch

test-verbose:
	$(NPX) vitest run --reporter verbose

# ── Quality gates ────────────────────────────────────────────────────────────
typecheck:
	$(PKG) run typecheck

check: typecheck test

# ── Pre-publish smoke test ───────────────────────────────────────────────────
# Pack the package into a tarball exactly as it would ship to npm, install it
# into a throwaway directory, and `require()` it to confirm:
#   1. dist/ files declared in the `files` array actually got bundled,
#   2. the `exports` map resolves cleanly for CommonJS consumers,
#   3. TuvlClient + TuvlAuth are present at the top level (catches a stale
#      tree-shaken bundle or a broken main entry).
#
# This mirrors the engine's wheel-install smoke step in publish.yml and
# catches "looks fine, breaks on npm install" packaging regressions before
# they reach the registry.
smoke: build
	@echo "→ Packing tarball…"
	@rm -f tuvl-client-*.tgz
	@$(PKG) pack >/dev/null
	@TARBALL=$$(ls tuvl-client-*.tgz | head -1); \
	  if [ -z "$$TARBALL" ]; then echo "::error::pnpm pack produced no tarball"; exit 1; fi; \
	  echo "  ✓ produced $$TARBALL"; \
	  REPO_DIR=$$(pwd); \
	  rm -rf /tmp/tuvl-smoke && mkdir /tmp/tuvl-smoke; \
	  cd /tmp/tuvl-smoke && \
	    echo '{"name":"smoke","version":"0.0.0","private":true,"type":"commonjs"}' > package.json && \
	    $(PKG) add "$$REPO_DIR/$$TARBALL" >/dev/null 2>&1 && \
	    $(NODE) -e 'const t = require("@tuvl/client"); for (const k of ["TuvlClient","TuvlAuth","CrudClient","Transport","parseSseStream"]) { if (!t[k]) { console.error("missing export: " + k); process.exit(1); } } console.log("  ✓ require(\"@tuvl/client\") OK — " + Object.keys(t).length + " exports");' && \
	    cd "$$REPO_DIR" && rm -rf /tmp/tuvl-smoke && rm -f "$$TARBALL"
	@echo "✓ Smoke test passed"

# ── Full pre-publish gate ────────────────────────────────────────────────────
verify: check build smoke
	@echo ""
	@echo "✓ @tuvl/client is ready to publish."
	@echo "  Confirm npm identity with: make whoami"
	@echo "  Dry-run the upload with:    make publish-dry"

# ── Publish ──────────────────────────────────────────────────────────────────
# publish requires `verify` to pass first so we don't ship a broken artefact
# by accident.  Uses --access public because @tuvl is a scoped package
# (npm defaults scoped packages to private otherwise).
#
# Auto-detects the npm dist-tag from the package.json version:
#   *-alpha.N → alpha
#   *-beta.N  → beta
#   *-rc.N    → rc
#   anything else → latest
# This stops a prerelease from accidentally moving the `latest` tag,
# which would surprise anyone running `npm install @tuvl/client` (no
# version pin) with a beta.
#
# The case statement is inlined into each recipe rather than factored
# into a Makefile variable: nesting bash `$(...)` substitutions around
# a `case` block makes bash's parser treat the case-pattern close-paren
# `*-beta.*)` as the close of the outer `$(`, producing a syntax error.
#
# Two-factor auth: if your npm account has 2FA enabled with "auth-and-writes"
# mode, pnpm will prompt interactively for an OTP code.  Switch to "auth-only"
# in your npm profile, or use a granular access token that bypasses 2FA, if
# the OTP prompt doesn't appear in your terminal.
publish-dry:
	@PKG_VERSION=$$($(NODE) -p "require('./package.json').version"); \
	  case "$$PKG_VERSION" in \
	    *-alpha.*) TAG=alpha;; \
	    *-beta.*)  TAG=beta;;  \
	    *-rc.*)    TAG=rc;;    \
	    *)         TAG=latest;; \
	  esac; \
	  BRANCH=$$(git rev-parse --abbrev-ref HEAD); \
	  echo "→ Dry-run: would publish $$PKG_VERSION with dist-tag '$$TAG' from branch '$$BRANCH'"; \
	  $(PKG) publish --access public --tag "$$TAG" --publish-branch "$$BRANCH" --dry-run

publish: verify
	@PKG_VERSION=$$($(NODE) -p "require('./package.json').version"); \
	  case "$$PKG_VERSION" in \
	    *-alpha.*) TAG=alpha;; \
	    *-beta.*)  TAG=beta;;  \
	    *-rc.*)    TAG=rc;;    \
	    *)         TAG=latest;; \
	  esac; \
	  BRANCH=$$(git rev-parse --abbrev-ref HEAD); \
	  echo "→ Publishing $$PKG_VERSION with dist-tag '$$TAG' from branch '$$BRANCH'"; \
	  $(PKG) publish --access public --tag "$$TAG" --publish-branch "$$BRANCH"

# ── Identity ─────────────────────────────────────────────────────────────────
whoami:
	@echo "npm registry identity:"
	@$(PKG) whoami || (echo "  (not logged in — run: $(PKG) login)" && exit 1)

# ── Clean ────────────────────────────────────────────────────────────────────
clean:
	rm -rf $(DIST)
	rm -rf node_modules/.cache node_modules/.vite
	rm -f tuvl-client-*.tgz
	rm -rf /tmp/tuvl-smoke
