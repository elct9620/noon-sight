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
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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

// The window is now computed from today, so today is pinned rather than the
// arithmetic being recomputed by the cases that exist to check it. Only `Date`
// is faked: the timers MSW and fetch run on have to keep moving.
const TODAY = "2026-08-12T09:00:00Z";

afterEach(() => vi.useRealTimers());

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(TODAY));
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
    const tool = tools.find(
      ({ name }: { name: string }) => name === "traffic_report",
    );

    expect(tool.inputSchema.properties.breakdown.items.enum).toEqual([
      "channel",
      "source",
      "page",
      "country",
      "language",
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
        channel: "Organic Search",
        current: { sessions: 120 },
        previous: { sessions: 96 },
      },
      {
        channel: "Referral",
        current: { sessions: 10 },
        previous: { sessions: 8 },
      },
    ]);
  });

  // The breakdown a client asked for is the vocabulary it gets back; answering
  // `page` with `landingPagePlusQueryString` would let Google's names out
  // through the parameter that was meant to close them off.
  it("names a row the way the breakdown was asked for", async () => {
    server.use(
      http.post(REPORT_URL, () =>
        HttpResponse.json({
          dimensionHeaders: [
            { name: "landingPagePlusQueryString" },
            { name: "dateRange" },
          ],
          metricHeaders: [{ name: "sessions" }],
          rows: [
            {
              dimensionValues: [
                { value: "/posts/hello" },
                { value: "current" },
              ],
              metricValues: [{ value: "40" }],
            },
          ],
        }),
      ),
    );

    const { rows } = await readReport(
      await call("tools/call", {
        name: "traffic_report",
        arguments: { breakdown: ["page"] },
      }),
    );

    expect(rows[0]).toMatchObject({ page: "/posts/hello" });
  });

  // The second window is what makes the answer actionable, so the tool asks for
  // it rather than leaving the client to work out an equal span and call again.
  //
  // It stops short of today by the margin Search Console needs to finish
  // counting, so a traffic report and a search report cover the same days
  // without the caller lining them up.
  it("asks Google for the period before the one requested", async () => {
    reports([]);

    await call("tools/call", {
      name: "traffic_report",
      arguments: { days: 7 },
    });

    expect(requests[0].dateRanges).toEqual([
      { name: "current", startDate: "2026-08-03", endDate: "2026-08-09" },
      { name: "previous", startDate: "2026-07-27", endDate: "2026-08-02" },
    ]);
  });

  // Dates rather than Google's `NdaysAgo`: a client that cannot see which days
  // it was answered for cannot tell a quiet week from a window that stopped
  // early, and the answer is the only place that can say.
  it("states the days it covered", async () => {
    reports([]);

    const { periods } = await readReport(
      await call("tools/call", {
        name: "traffic_report",
        arguments: { days: 28 },
      }),
    );

    expect(periods).toEqual([
      { name: "current", startDate: "2026-07-13", endDate: "2026-08-09" },
      { name: "previous", startDate: "2026-06-15", endDate: "2026-07-12" },
    ]);
  });

  // Alignment is the default, not the only option: fresher Analytics days are
  // there for the asking, at the cost of lining up with search.
  it("ends where it is told to", async () => {
    reports([]);

    await call("tools/call", {
      name: "traffic_report",
      arguments: { days: 7, until: "2026-08-11" },
    });

    expect(requests[0].dateRanges).toEqual([
      { name: "current", startDate: "2026-08-05", endDate: "2026-08-11" },
      { name: "previous", startDate: "2026-07-29", endDate: "2026-08-04" },
    ]);
  });

  // An ungrouped total merges populations that behave differently, so reading
  // one of them apart is the only way that total means anything.
  it("narrows to a segment without grouping by it", async () => {
    reports([]);

    await call("tools/call", {
      name: "traffic_report",
      arguments: { breakdown: ["page"], where: { country: "TW" } },
    });

    expect(requests[0].dimensionFilter).toEqual({
      andGroup: {
        expressions: [
          {
            filter: {
              fieldName: "countryId",
              stringFilter: { value: "TW" },
            },
          },
        ],
      },
    });
    expect(requests[0].dimensions).toEqual([
      { name: "landingPagePlusQueryString" },
    ]);
  });

  it("requires every condition of a segment to hold", async () => {
    reports([]);

    await call("tools/call", {
      name: "traffic_report",
      arguments: {
        where: { country: "TW", channel: "Organic Search" },
      },
    });

    expect(requests[0].dimensionFilter).toEqual({
      andGroup: {
        expressions: [
          {
            filter: { fieldName: "countryId", stringFilter: { value: "TW" } },
          },
          {
            filter: {
              fieldName: "sessionDefaultChannelGroup",
              stringFilter: { value: "Organic Search" },
            },
          },
        ],
      },
    });
  });

  // The name would merge zh-tw with zh-cn, and which one a visitor reads in is
  // the whole reason for asking.
  it("groups language by code rather than by name", async () => {
    reports([]);

    await call("tools/call", {
      name: "traffic_report",
      arguments: { breakdown: ["language"] },
    });

    expect(requests[0].dimensions).toEqual([{ name: "languageCode" }]);
  });

  it("asks for no filter when no segment is named", async () => {
    reports([]);

    await call("tools/call", {
      name: "traffic_report",
      arguments: {},
    });

    expect(requests[0]).not.toHaveProperty("dimensionFilter");
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
    expect(rows[0].channel).toBe("Organic Search");
  });

  // Google's own relative syntax is the tempting thing to write here, and a
  // date that never parses would otherwise reach the arithmetic and come back
  // as a time-value error naming nothing the caller wrote.
  it("refuses a date it cannot read", async () => {
    reports([]);

    const response = await call("tools/call", {
      name: "traffic_report",
      arguments: { until: "yesterday" },
    });

    const result = await readResult(response);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("until");
    expect(requests).toHaveLength(0);
  });

  // Same as every other source here: not configured is an answer the caller can
  // read, not a tool that quietly stops existing.
  it("says so when no property is configured rather than going quiet", async () => {
    reports([]);
    const configured = env.GA_PROPERTY_ID;
    env.GA_PROPERTY_ID = undefined;

    try {
      const result = await readResult(
        await call("tools/call", {
          name: "traffic_report",
          arguments: {},
        }),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Google Analytics");
      expect(requests).toHaveLength(0);
    } finally {
      env.GA_PROPERTY_ID = configured;
    }
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
