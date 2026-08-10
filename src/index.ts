import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { Hono } from "hono";

const app = new Hono();

// The factory runs per request: under 2026-07-28 a request carries its own
// protocol version, identity and capabilities, so nothing outlives one exchange.
const handler = createMcpHandler(
  () => new McpServer({ name: "noon-sight", version: "0.1.0" }),
);

app.all("/mcp", (c) => handler.fetch(c.req.raw));

export default app;
