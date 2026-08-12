import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { SignJWT, generateKeyPair } from "jose";
import { HttpResponse, http } from "msw";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { server } from "./setup";

const PROTOCOL_VERSION = "2026-07-28";
const ALG = "RS256";
const REPORT_URL =
  "https://analyticsdata.googleapis.com/v1beta/properties/123456:runReport";

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

// What Google was asked for, so a case can state the request rather than only
// the answer it produced.
let requests: Record<string, unknown>[];

beforeEach(async () => {
  requests = [];
  const { keys: cached } = await env.TOKEN_CACHE.list();
  await Promise.all(cached.map(({ name }) => env.TOKEN_CACHE.delete(name)));

  server.use(
    http.post("https://oauth2.googleapis.com/token", () =>
      HttpResponse.json({ access_token: "ya29.traffic", expires_in: 3600 }),
    ),
  );
});

const reports = (rows: [string, string, string][]) =>
  server.use(
    http.post(REPORT_URL, async ({ request }) => {
      requests.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({
        dimensionHeaders: [
          { name: "sessionDefaultChannelGroup" },
          { name: "dateRange" },
        ],
        metricHeaders: [
          { name: "sessions" },
          { name: "totalUsers" },
          { name: "newUsers" },
          { name: "engagementRate" },
          { name: "averageSessionDuration" },
          { name: "keyEvents" },
        ],
        rows: rows.map(([channel, period, sessions]) => ({
          dimensionValues: [{ value: channel }, { value: period }],
          metricValues: [
            { value: sessions },
            { value: sessions },
            { value: "1" },
            { value: "0.5" },
            { value: "60" },
            { value: "0" },
          ],
        })),
      });
    }),
  );

const call = async (
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = { "cf-access-jwt-assertion": assertion },
) => {
  const ctx = createExecutionContext();
  const response = await createApp(keys.publicKey).fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": PROTOCOL_VERSION,
        "Mcp-Method": method,
        // Under 2026-07-28 a request repeats what it is calling in headers so
        // an intermediary can route it without reading the body, and the
        // server rejects the two disagreeing.
        ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : {}),
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: PROTOCOL_VERSION,
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        },
      }),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
};

const readResult = async (response: Response) => {
  const body = await response.text();
  const data = body
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("");

  return JSON.parse(data || body).result;
};

const readReport = async (response: Response) =>
  JSON.parse((await readResult(response)).content[0].text);

describe("traffic_report", () => {
  it("is offered with its breakdowns spelled out", async () => {
    const { tools } = await readResult(await call("tools/list"));
    const [tool] = tools;

    expect(tool.name).toBe("traffic_report");
    expect(tool.inputSchema.properties.breakdown.items.enum).toEqual([
      "channel",
      "source",
      "page",
      "country",
      "device",
      "visitor_type",
    ]);
  });

  it("answers a breakdown with both periods on one row", async () => {
    reports([
      ["Organic Search", "current", "120"],
      ["Organic Search", "previous", "96"],
      ["Referral", "current", "10"],
      ["Referral", "previous", "8"],
    ]);

    const { rows } = await readReport(
      await call("tools/call", {
        name: "traffic_report",
        arguments: { breakdown: ["channel"] },
      }),
    );

    expect(rows).toMatchObject([
      {
        sessionDefaultChannelGroup: "Organic Search",
        current: { sessions: 120 },
        previous: { sessions: 96 },
      },
      {
        sessionDefaultChannelGroup: "Referral",
        current: { sessions: 10 },
        previous: { sessions: 8 },
      },
    ]);
  });

  // The second window is what makes the answer actionable, so the tool asks for
  // it rather than leaving the client to work out an equal span and call again.
  it("asks Google for the period before the one requested", async () => {
    reports([]);

    await call("tools/call", {
      name: "traffic_report",
      arguments: { days: 7 },
    });

    expect(requests[0].dateRanges).toEqual([
      { name: "current", startDate: "7daysAgo", endDate: "yesterday" },
      { name: "previous", startDate: "14daysAgo", endDate: "8daysAgo" },
    ]);
  });

  it("groups by nothing when no breakdown is asked for", async () => {
    reports([]);

    await call("tools/call", {
      name: "traffic_report",
      arguments: {},
    });

    expect(requests[0].dimensions).toEqual([]);
  });

  // Ranking after the fold rather than in the request: a row Google truncated
  // would come back as a period of zero and read as a collapse.
  it("answers the largest rows by current sessions", async () => {
    reports([
      ["Referral", "current", "10"],
      ["Referral", "previous", "8"],
      ["Organic Search", "current", "120"],
      ["Organic Search", "previous", "96"],
    ]);

    const { rows } = await readReport(
      await call("tools/call", {
        name: "traffic_report",
        arguments: { breakdown: ["channel"], limit: 1 },
      }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].sessionDefaultChannelGroup).toBe("Organic Search");
  });

  it("is not reachable without an Access assertion", async () => {
    const response = await call(
      "tools/call",
      { name: "traffic_report", arguments: {} },
      {},
    );

    expect(response.status).toBe(403);
    expect(requests).toHaveLength(0);
  });
});
