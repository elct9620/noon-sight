import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { type JWTVerifyGetKey, type KeyInput, createRemoteJWKSet } from "jose";
import { accessGuard } from "./access";
import { registerTrafficReport } from "./traffic";

// The factory runs per request: under 2026-07-28 a request carries its own
// protocol version, identity and capabilities, so nothing outlives one exchange.
const handler = createMcpHandler(() => {
  const server = new McpServer({ name: "noon-sight", version: "0.1.0" });
  registerTrafficReport(server);

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
