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

| Area               | Choice                                                                                                        | Intent                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP / MCP         | Hono routes `/mcp` into `createMcpHandler` from `@modelcontextprotocol/server`                                | The official v2 entry serves the 2026-07-28 revision and falls back to stateless 2025-era serving from the same factory, so one endpoint covers both client generations and they cannot drift apart                                                                                                                                                                         |
| MCP session        | Stateless: the handler builds a server per request, and none is shared                                        | Under 2026-07-28 a request carries its own protocol version, capabilities and identity, so there is no session to keep; a response without `mcp-session-id` is the observable form of that                                                                                                                                                                                  |
| Runtime fit        | No runtime configuration; the package resolves its own `workerd` shims                                        | Its export conditions pick an edge-safe JSON Schema validator and preload schemas, so nothing in the bundle reaches for `new Function`                                                                                                                                                                                                                                      |
| Access control     | Cloudflare Zero Trust; jose verifies `Cf-Access-Jwt-Assertion` against the team JWKS, and its `iss` and `aud` | The Worker answers on a public hostname, so a header an attacker can write proves nothing — only the signature does. `aud` separates this application from another, `iss` separates this team from another, and a missing value for either would make jose skip that comparison                                                                                             |
| Client sign-in     | Access Managed OAuth on the application; the Worker implements no OAuth of its own                            | An MCP client is not a browser and cannot follow Access's `302`, so Managed OAuth answers it with a `401` challenge instead. Access resolves the resulting token itself and still forwards `Cf-Access-Jwt-Assertion`, so an OAuth request is indistinguishable from a browser one and the Worker needs no second identity path                                              |
| Debug bypass       | `DEBUG=true` skips verification, and lives only in `.dev.vars`                                                | Local development has no Access in front of it. Production reads `undefined`, so denial is what the absence of configuration already produces; vitest pins the flag off so the suite cannot be disarmed by a developer's local file                                                                                                                                         |
| Google credentials | jose signs a Service Account JWT, exchanged for an OAuth access token                                         | Workers lack Node crypto, so the official googleapis SDK cannot run. Workload Identity Federation is what Google recommends instead of a key, but it exchanges a credential the workload already holds from a trusted issuer and Workers are issued none — so the Worker would have to sign its own, and the key it signs with is the secret federation was meant to remove |
| Token cache        | Cloudflare KV with TTL matching token lifetime                                                                | Access tokens expire in an hour; KV TTL expires them, so no cleanup logic exists                                                                                                                                                                                                                                                                                            |
| Report shape       | Every report spans the requested window and the equally long one before it, folded into one row per breakdown | The Data API answers a table addressed by column position, one row per period. Whether traffic rose is the question worth answering and a single number cannot say, so asking the client to call twice and subtract would hand back both the reading and the shape of Google's API                                                                                          |
| Reading guidance   | `ServerOptions.instructions`, not a documentation tool                                                        | It arrives with the handshake, while a tool has to be called — and whoever already holds the numbers does not think to ask how to read them. One text speaks for every tool, so it states what holds of site measurement rather than of one provider, and carries no finding about a particular property: that would decay with no test watching it                         |
| Testing            | vitest with `@cloudflare/vitest-pool-workers`; outbound requests answered by MSW                              | Runs on real workerd, so binding behaviour matches production. `fetchMock` is gone from `cloudflare:test`, and MSW patches the runtime's own `fetch` — which reaches the Worker because tests drive `createApp` inside the runner rather than through a separate Worker                                                                                                     |

## Dependencies

A package earns its place by evidence, never by reputation or popularity. Before `pnpm add`, establish all of:

- **The maintainer is answerable.** A named team or person, a repository whose activity outlives its last release. An unmaintained package is a liability no matter how clean its code, because the next protocol change lands on you.
- **The transitive tree is clean.** `npm audit` reports nothing, and no package in the tree carries an install script — code that runs on `pnpm add` executes before any review can happen.
- **What reaches the Worker is what you meant to ship.** `wrangler deploy --dry-run` succeeds, and the bundle contains no Node-only path that only fails in production.
- **It adapts rather than re-implements.** A package that rewrites a protocol its own upstream already implements carries that protocol's correctness alone, and its blessing by one project says nothing about its fidelity to the other. Check which side of the seam the logic lives on before trusting an integration package.
- **The name is still the project's current line.** A `latest` tag tracks the package you asked about, not the project behind it: a split or renamed SDK leaves the old name shipping releases while the current line lives under new names. Read the repository's releases before believing npm.

Prefer the package the ecosystem maintains together over the lighter one maintained alone. A heavy dependency tree is a cost; an abandoned one is a dead end.

That bar governs what reaches the Worker. A devDependency never enters the bundle, so it answers to maintenance and to what runs at install time alone. pnpm declines a dependency's install scripts by default; `allowBuilds` in `pnpm-workspace.yaml` records each decision, so an install script is a line of configuration rather than a veto.

## Conventions

Secrets (`GOOGLE_SERVICE_ACCOUNT`, `GA_PROPERTY_ID`, `TEAM_DOMAIN`, `POLICY_AUD`) live in `wrangler secret` and `.dev.vars`, never in `wrangler.jsonc`. `GOOGLE_SERVICE_ACCOUNT` holds the whole Service Account JSON rather than a field per value, because the private key is a PEM whose newlines survive JSON but not a shell. `TEAM_DOMAIN` carries its scheme, since it is both the JWKS host and the expected `iss`. Cloudflare classes these two as vars rather than secrets; keeping them out of the repository costs nothing and publishes neither the team nor the application being guarded.

`POLICY_AUD` cannot be set before the Access application it identifies exists, so a first deployment answers `403 Access is not configured` until Access is enabled on `noon-sight.aotoki.dev` and the secret follows. That denial is the intended state, not a fault. A further hostname joins that same Access application as an additional public hostname; a second application would mint a second AUD, and one `POLICY_AUD` cannot match both.

Managed OAuth registers each client dynamically, and Access refuses a registration whose callback is not on the application's allowed redirect URIs — `https://claude.ai/api/mcp/auth_callback` for the hosted client, a loopback URI for a local one. A client that failed to register keeps that failure until it is removed and added again, so allowlisting the callback afterwards is not enough on its own.

Bindings that must hold for a test to mean anything are pinned in `vitest.config.ts`. The test runtime reads `.dev.vars` as `wrangler dev` does, and an override only replaces the keys it names, so anything left unnamed silently inherits whatever a developer set locally.

Every MCP tool carries at least one vitest case covering the success path and a denied-access path.

A tool that throws has its message turned into an `isError` result, so what it says reaches the model rather than only the client. Upstream refusals therefore travel with whatever the upstream said: one status covers unrelated causes — a Google `403` means both a property the account was never added to and an API nobody enabled — and the caller has already passed Access, so withholding the sentence buys no secrecy and costs the only thing that tells the two apart. Test fixtures quoting such a message use a placeholder identifier; a real one publishes the project for no benefit, the same reason `POLICY_AUD` stays out.

One tool per question, not per breakdown. Tools that differ only in which dimension they group by are one tool with a parameter. What keeps that from being an API in disguise is what the parameter enumerates: a closed list of questions worth asking is a design, a passthrough of arbitrary API fields is a copy.

Under 2026-07-28 a request repeats in headers what it is calling — `Mcp-Method`, and `Mcp-Name` for anything the body names — so an intermediary can route without reading the body. The server rejects the two disagreeing, which is what a request modelled on a 1.x example runs into first.

`compatibility_date` must stay within what the bundled workerd supports, or `pnpm test` fails to boot the runtime. Raise it only together with a wrangler upgrade.

Local workerd — vitest and `wrangler dev` alike — permits `new Function` through an unsafe-eval binding that production does not. A green suite says nothing about dynamic code generation, so keep it off the runtime path by construction rather than trusting a test to catch it.

The test pool pushes `nodejs_compat_v2` onto its runner whatever `wrangler.jsonc` says. A test-only Node dependency therefore needs no production flag, and — as with unsafe-eval — a green suite says nothing about whether the deployed bundle is free of Node.

`.claude/hooks/stop.sh` gates the end of a turn on `typecheck` and `test`, so broken types or failing tests are never handed back. `.claude/hooks/edit.sh` formats each written file, keeping formatting out of review diffs.
