import {
  CLIENT_CAPABILITIES_META_KEY,
  LATEST_PROTOCOL_VERSION,
  PROTOCOL_VERSION_META_KEY,
  SERVER_INFO_META_KEY,
} from "@modelcontextprotocol/server";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

const MODERN_PROTOCOL_VERSION = "2026-07-28";

const post = async (body: unknown, headers: Record<string, string> = {}) => {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
};

// Under 2026-07-28 every request declares its own version and capabilities, and
// repeats its method in a header so intermediaries can route without a body.
const call = (method: string) =>
  post(
    {
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
          [CLIENT_CAPABILITIES_META_KEY]: {},
        },
      },
    },
    {
      "MCP-Protocol-Version": MODERN_PROTOCOL_VERSION,
      "Mcp-Method": method,
    },
  );

describe("mcp endpoint", () => {
  it("discovers itself over the current protocol revision", async () => {
    const response = await call("server/discover");

    expect(response.status).toBe(200);
    expect(await readResult(response)).toMatchObject({
      supportedVersions: [MODERN_PROTOCOL_VERSION],
      _meta: { [SERVER_INFO_META_KEY]: { name: "noon-sight" } },
    });
  });

  it("still serves handshake-era clients", async () => {
    const response = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "test", version: "0.0.0" },
      },
    });

    expect(response.status).toBe(200);
    expect(await readResult(response)).toMatchObject({
      protocolVersion: LATEST_PROTOCOL_VERSION,
      serverInfo: { name: "noon-sight" },
    });
  });

  it("hands out no session", async () => {
    const response = await call("server/discover");

    expect(response.headers.get("mcp-session-id")).toBeNull();
  });
});

// Answers arrive as plain JSON, or as an SSE data frame when a handler streams.
const readResult = async (response: Response) => {
  const body = await response.text();
  const data = body
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("");

  return JSON.parse(data || body).result;
};
