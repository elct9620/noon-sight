import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { type JWTVerifyGetKey, type KeyInput, createRemoteJWKSet } from "jose";
import { accessGuard } from "./access";
import { registerSearchReport } from "./search";
import { registerTrafficReport } from "./traffic";

/**
 * Reaches the client with the handshake rather than on request, which is the
 * point: a reader who has already been handed numbers does not think to ask how
 * to read them.
 *
 * It speaks for every tool this server carries, so it says what holds of site
 * measurement rather than what holds of one provider — a finding about one
 * property would decay here with no test watching it.
 */
const INSTRUCTIONS = `Every report answers for a period and for the equally long period before it. A row is a pair: read the change, not the number.

An ungrouped total merges populations that behave nothing alike, and is usually the least informative row in an answer. Group it, or narrow to one segment, before concluding anything from it.

Automation inflates counts but not attention, so judge a population by how long it stayed rather than by how much it registered. Signals a client emits by rendering a page — a scroll, an element coming into view — fire more reliably for automation than for a reader, and are not evidence of interest.

Every figure is what one measurement system saw, not what happened. Each misses a different part, so two sources disagreeing does not make either wrong.`;

// The factory runs per request: under 2026-07-28 a request carries its own
// protocol version, identity and capabilities, so nothing outlives one exchange.
const handler = createMcpHandler(() => {
  const server = new McpServer(
    { name: "noon-sight", version: "0.1.0" },
    { instructions: INSTRUCTIONS },
  );
  registerTrafficReport(server);
  registerSearchReport(server);

  return server;
});

// The verifying key is the composition root's only argument, which is what lets
// a test drive the endpoint with a key it holds the private half of.
export const createApp = (keys?: KeyInput | JWTVerifyGetKey) => {
  const app = new Hono();

  app.use("/mcp", accessGuard(keys));
  app.all("/mcp", (c) => handler.fetch(c.req.raw));

  return app;
};

// Built once per isolate so the fetched key set is reused across requests; jose
// refetches by itself when Access rotates to a `kid` it has not seen.
export default createApp(
  env.TEAM_DOMAIN
    ? createRemoteJWKSet(new URL(`${env.TEAM_DOMAIN}/cdn-cgi/access/certs`))
    : undefined,
);
