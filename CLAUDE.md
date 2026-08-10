# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

noon-sight is an MCP server on Cloudflare Workers exposing Google Analytics and Google Search Console data as MCP tools. Access is gated by Cloudflare Zero Trust.

**Minimal by design.** Implement only the tool being asked for. Feature completeness is not the goal; staying small is. Before adding an abstraction layer, a config knob, or code for a case that might come later, confirm it is needed now.

**No SPEC.md.** Correctness is expressed by vitest tests, not by specification documents.

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

| Area               | Choice                                                                | Intent                                                                             |
| ------------------ | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| HTTP / MCP         | Hono with `StreamableHTTPTransport` from `@hono/mcp`                  | Stateless Streamable HTTP is the current standard: one endpoint, no Durable Object |
| Access control     | Cloudflare Zero Trust, verifying `Cf-Access-Jwt-Assertion`            | The Worker trusts only JWTs issued by Access; it implements no login of its own    |
| Google credentials | jose signs a Service Account JWT, exchanged for an OAuth access token | Workers lack Node crypto, so the official googleapis SDK cannot run                |
| Token cache        | Cloudflare KV with TTL matching token lifetime                        | Access tokens expire in an hour; KV TTL expires them, so no cleanup logic exists   |
| Testing            | vitest with `@cloudflare/vitest-pool-workers`                         | Runs on real workerd, so binding behaviour matches production                      |

## Conventions

Secrets (Google Service Account JSON, Access AUD) live in `wrangler secret` and `.dev.vars`, never in `wrangler.jsonc`.

Every MCP tool carries at least one vitest case covering the success path and a denied-access path.

`compatibility_date` must stay within what the bundled workerd supports, or `pnpm test` fails to boot the runtime. Raise it only together with a wrangler upgrade.

`.claude/hooks/stop.sh` gates the end of a turn on `typecheck` and `test`, so broken types or failing tests are never handed back. `.claude/hooks/edit.sh` formats each written file, keeping formatting out of review diffs.
