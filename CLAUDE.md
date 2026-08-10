# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

noon-sight is an MCP server on Cloudflare Workers exposing Google Analytics and Google Search Console data as MCP tools. Access is gated by Cloudflare Zero Trust.

**Minimal by design.** Implement only the tool being asked for. Feature completeness is not the goal; staying small is. Before adding an abstraction layer, a config knob, or code for a case that might come later, confirm it is needed now.

**No SPEC.md.** Correctness is expressed by vitest tests, not by specification documents.

## Working together

Work runs in two movements, and the boundary between them carries more weight than the commands do.

**Aligning.** Aotokitsuruya opens with `/inspect`, which reads and asks but changes nothing. An item joins the work list only once both its intent and its scope are settled; whatever stays ambiguous stays out, rather than being resolved by guessing.

**Executing.** Once the work list is agreed and `/goal` fixes the finishing condition, run the loop unattended: `/write` or `/refactor`, then `/inspect` again as code review, `/refactor` on what it surfaces, and `/git:commit`. If part of the list turns out to be blocked, finish the rest and say what was left out — narrowing the list is not a decision to make alone.

That loop invites more design than this project wants: its skills offer layered structures, patterns and abstractions by default. Minimal by design still governs. Reach for the smallest implementation the tests accept, and treat the review pass as an opportunity to delete what the previous step made unnecessary rather than to enrich it.

## Commands

| Command           | Purpose                                                                              |
| ----------------- | ------------------------------------------------------------------------------------ |
| `pnpm dev`        | Run locally (wrangler dev)                                                           |
| `pnpm test`       | Run tests on workerd; `pnpm test <pattern>` narrows to matching files                |
| `pnpm typecheck`  | Typecheck `src` and `test` as separate projects                                      |
| `pnpm format`     | Prettier with defaults; `format:check` verifies without writing                      |
| `pnpm deploy`     | Deploy to Cloudflare                                                                 |
| `pnpm cf-typegen` | Generate `CloudflareBindings` types from wrangler.jsonc; run after changing bindings |

## Technical decisions

| Area               | Choice                                                                         | Intent                                                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP / MCP         | Hono routes `/mcp` into `createMcpHandler` from `@modelcontextprotocol/server` | The official v2 entry serves the 2026-07-28 revision and falls back to stateless 2025-era serving from the same factory, so one endpoint covers both client generations and they cannot drift apart |
| MCP session        | Stateless: the handler builds a server per request, and none is shared         | Under 2026-07-28 a request carries its own protocol version, capabilities and identity, so there is no session to keep; a response without `mcp-session-id` is the observable form of that          |
| Runtime fit        | No runtime configuration; the package resolves its own `workerd` shims         | Its export conditions pick an edge-safe JSON Schema validator and preload schemas, so nothing in the bundle reaches for `new Function`                                                              |
| Access control     | Cloudflare Zero Trust, verifying `Cf-Access-Jwt-Assertion`                     | The Worker trusts only JWTs issued by Access; it implements no login of its own                                                                                                                     |
| Google credentials | jose signs a Service Account JWT, exchanged for an OAuth access token          | Workers lack Node crypto, so the official googleapis SDK cannot run                                                                                                                                 |
| Token cache        | Cloudflare KV with TTL matching token lifetime                                 | Access tokens expire in an hour; KV TTL expires them, so no cleanup logic exists                                                                                                                    |
| Testing            | vitest with `@cloudflare/vitest-pool-workers`                                  | Runs on real workerd, so binding behaviour matches production                                                                                                                                       |

## Dependencies

A package earns its place by evidence, never by reputation or popularity. Before `pnpm add`, establish all of:

- **The maintainer is answerable.** A named team or person, a repository whose activity outlives its last release. An unmaintained package is a liability no matter how clean its code, because the next protocol change lands on you.
- **The transitive tree is clean.** `npm audit` reports nothing, and no package in the tree carries an install script — code that runs on `pnpm add` executes before any review can happen.
- **What reaches the Worker is what you meant to ship.** `wrangler deploy --dry-run` succeeds, and the bundle contains no Node-only path that only fails in production.
- **It adapts rather than re-implements.** A package that rewrites a protocol its own upstream already implements carries that protocol's correctness alone, and its blessing by one project says nothing about its fidelity to the other. Check which side of the seam the logic lives on before trusting an integration package.
- **The name is still the project's current line.** A `latest` tag tracks the package you asked about, not the project behind it: a split or renamed SDK leaves the old name shipping releases while the current line lives under new names. Read the repository's releases before believing npm.

Prefer the package the ecosystem maintains together over the lighter one maintained alone. A heavy dependency tree is a cost; an abandoned one is a dead end.

## Conventions

Secrets (Google Service Account JSON, Access AUD) live in `wrangler secret` and `.dev.vars`, never in `wrangler.jsonc`.

Every MCP tool carries at least one vitest case covering the success path and a denied-access path.

`compatibility_date` must stay within what the bundled workerd supports, or `pnpm test` fails to boot the runtime. Raise it only together with a wrangler upgrade.

Local workerd — vitest and `wrangler dev` alike — permits `new Function` through an unsafe-eval binding that production does not. A green suite says nothing about dynamic code generation, so keep it off the runtime path by construction rather than trusting a test to catch it.

`.claude/hooks/stop.sh` gates the end of a turn on `typecheck` and `test`, so broken types or failing tests are never handed back. `.claude/hooks/edit.sh` formats each written file, keeping formatting out of review diffs.
