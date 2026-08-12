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
import { SignJWT, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/index";

const MODERN_PROTOCOL_VERSION = "2026-07-28";
const ALG = "RS256";

// Every request past the guard needs an assertion, so the protocol cases stand
// in for a client Access has already admitted. `test/access.spec.ts` owns what
// happens when it has not.
let keys: CryptoKeyPair;
let assertion: string;

beforeAll(async () => {
  keys = await generateKeyPair(ALG);
  assertion = await new SignJWT({ email: "user@example.com" })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setIssuer(String(env.TEAM_DOMAIN))
    .setAudience(String(env.POLICY_AUD))
    .setExpirationTime("1h")
    .sign(keys.privateKey);
});

const post = async (body: unknown, headers: Record<string, string> = {}) => {
  const ctx = createExecutionContext();
  const response = await createApp(keys.publicKey).fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "cf-access-jwt-assertion": assertion,
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

  // Guidance a client has to ask for arrives too late: whoever already holds
  // the numbers does not think to ask how to read them. Both client
  // generations get it with the handshake, so neither is left without.
  it("hands both client generations its reading instructions", async () => {
    const modern = await readResult(await call("server/discover"));
    const legacy = await readResult(
      await post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "test", version: "0.0.0" },
        },
      }),
    );

    for (const result of [modern, legacy]) {
      expect(result.instructions).toContain("read the change, not the number");
      expect(result.instructions).toContain("ungrouped total");
    }
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
