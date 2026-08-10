import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { SignJWT, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { isBypassed } from "../src/access";
import { createApp } from "../src/index";

const ALG = "RS256";
const ISSUER = "https://test.cloudflareaccess.com";
const AUDIENCE = "test-policy-aud";

let keys: CryptoKeyPair;

beforeAll(async () => {
  keys = await generateKeyPair(ALG);
});

const sign = (claims: { issuer?: string; audience?: string } = {}) =>
  new SignJWT({ email: "user@example.com" })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setIssuer(claims.issuer ?? ISSUER)
    .setAudience(claims.audience ?? AUDIENCE)
    .setExpirationTime("1h")
    .sign(keys.privateKey);

// The guard is exercised through the real endpoint rather than in isolation, so
// a route mounted without it would fail these too.
const get = async (token?: string) => {
  const ctx = createExecutionContext();
  const response = await createApp(keys.publicKey).fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(token ? { "Cf-Access-Jwt-Assertion": token } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
      }),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
};

describe("Access guard", () => {
  it("denies a request carrying no assertion", async () => {
    expect((await get()).status).toBe(403);
  });

  it("denies a token this team did not sign", async () => {
    const foreign = await generateKeyPair(ALG);
    const forged = await new SignJWT({ email: "attacker@example.com" })
      .setProtectedHeader({ alg: ALG })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime("1h")
      .sign(foreign.privateKey);

    expect((await get(forged)).status).toBe(403);
  });

  // A valid Access token minted for a different application must not open this
  // one; the audience claim is the only thing separating them.
  it("denies a token issued for another application", async () => {
    expect((await get(await sign({ audience: "other-app" }))).status).toBe(403);
  });

  it("denies a token from another team", async () => {
    const elsewhere = "https://other.cloudflareaccess.com";
    expect((await get(await sign({ issuer: elsewhere }))).status).toBe(403);
  });

  it("lets a token signed for this application through to MCP", async () => {
    const response = await get(await sign());

    expect(response.status).toBe(200);
  });

  // A deployment reaches this state before its Access application exists, so
  // the answer has to be denial rather than an open door.
  it("denies everything while no verifying key is configured", async () => {
    const ctx = createExecutionContext();
    const response = await createApp(undefined).fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "Cf-Access-Jwt-Assertion": await sign() },
        body: "{}",
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(403);
  });
});

// The bypass decision is a pure function precisely because `import { env }`
// is fixed for the whole run, so no endpoint test can reach this branch.
describe("isBypassed", () => {
  it("opens only for the exact string true", () => {
    expect(isBypassed("true")).toBe(true);
  });

  it("stays closed for anything else, absence included", () => {
    expect(isBypassed("false")).toBe(false);
    expect(isBypassed("1")).toBe(false);
    expect(isBypassed("TRUE")).toBe(false);
    expect(isBypassed(undefined)).toBe(false);
  });
});
