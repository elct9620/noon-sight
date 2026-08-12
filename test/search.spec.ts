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
const QUERY_URL =
  "https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Atest.example/searchAnalytics/query";

// Search Console has counted up to this day, three days behind the pinned
// today, which is the lag it actually runs at.
const TODAY = "2026-08-12T09:00:00Z";
const ANCHOR = "2026-08-09";

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

let requests: Record<string, never>[];

afterEach(() => vi.useRealTimers());

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(TODAY));
  requests = [];

  const { keys: cached } = await env.TOKEN_CACHE.list();
  await Promise.all(cached.map(({ name }) => env.TOKEN_CACHE.delete(name)));

  server.use(
    http.post("https://oauth2.googleapis.com/token", () =>
      HttpResponse.json({ access_token: "ya29.search", expires_in: 3600 }),
    ),
  );
});

type Row = {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

const row = (keys: string[], clicks: number, position: number): Row => ({
  keys,
  clicks,
  impressions: clicks * 10,
  ctr: 0.1,
  position,
});

/**
 * One endpoint answers three different questions here — which days are
 * counted, and one window each — so the mock tells them apart the way the code
 * does: by what was asked for rather than by the order it arrived in.
 */
const searches = ({
  counted = [ANCHOR],
  current = [] as Row[],
  previous = [] as Row[],
} = {}) =>
  server.use(
    http.post(QUERY_URL, async ({ request }) => {
      const body = (await request.json()) as Record<string, never>;
      requests.push(body);

      if ((body.dimensions as string[] | undefined)?.[0] === "DATE") {
        return HttpResponse.json({
          rows: counted.map((date) => row([date], 1, 1)),
        });
      }

      return HttpResponse.json({
        rows: body.endDate === ANCHOR ? current : previous,
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

const report = (args: Record<string, unknown>) =>
  call("tools/call", { name: "search_report", arguments: args });

/** The two window requests, in the order the report reads them. */
const windows = () =>
  requests.filter((body) => (body.dimensions as string[])?.[0] !== "DATE");

describe("search_report", () => {
  it("is offered with its breakdowns spelled out", async () => {
    const { tools } = await readResult(await call("tools/list"));
    const tool = tools.find(
      ({ name }: { name: string }) => name === "search_report",
    );

    expect(tool.inputSchema.properties.breakdown.items.enum).toEqual([
      "query",
      "page",
      "country",
      "device",
    ]);
  });

  // Impressions say how many people had the need, clicks how many acted on it,
  // and position why. One row carrying all four for both periods is what makes
  // "ranking but not compelling" tell itself apart from "not ranking".
  it("answers a breakdown with both periods on one row", async () => {
    searches({
      current: [row(["mcp on workers"], 42, 8.3)],
      previous: [row(["mcp on workers"], 31, 11.7)],
    });

    const { rows } = await readReport(await report({ breakdown: ["query"] }));

    expect(rows).toEqual([
      {
        query: "mcp on workers",
        current: { clicks: 42, impressions: 420, ctr: 0.1, position: 8.3 },
        previous: { clicks: 31, impressions: 310, ctr: 0.1, position: 11.7 },
      },
    ]);
  });

  // A page that was never seen in a period had no clicks and no impressions,
  // which is zero. It had no position at all, and zero would read as ranking
  // first — better than any real ranking rather than worse than all of them.
  it("reads a missing period as no counts and no ranking", async () => {
    searches({ current: [row(["ruby ddd"], 5, 14.2)], previous: [] });

    const { rows } = await readReport(await report({ breakdown: ["query"] }));

    expect(rows[0].previous).toEqual({
      clicks: 0,
      impressions: 0,
      ctr: null,
      position: null,
    });
  });

  // The same country, page and device have to be spelled the same way here as
  // in a traffic report, or the two answers cannot be laid side by side — which
  // is the only reason for holding both sources.
  it("answers in the vocabulary the traffic report uses", async () => {
    searches({
      current: [
        row(["https://blog.test.example/posts/hello/", "twn", "DESKTOP"], 9, 3),
      ],
    });

    const { rows } = await readReport(
      await report({ breakdown: ["page", "country"] }),
    );

    expect(rows[0]).toMatchObject({
      page: "/posts/hello/",
      country: "TW",
    });
  });

  // Asking for nothing in particular is the first call anyone makes, and Search
  // Console answers it with a row carrying no keys at all rather than an empty
  // key — which the fold has to read as one row rather than as none.
  it("answers the site as a whole when nothing is grouped by", async () => {
    searches({
      current: [row([], 222, 12.4)],
      previous: [row([], 180, 15.1)],
    });

    const { rows } = await readReport(await report({}));

    expect(windows()[0].dimensions).toEqual([]);
    expect(rows).toEqual([
      {
        current: { clicks: 222, impressions: 2220, ctr: 0.1, position: 12.4 },
        previous: { clicks: 180, impressions: 1800, ctr: 0.1, position: 15.1 },
      },
    ]);
  });

  // Asking for everything Google has would fold days still being counted into
  // the current period and report the shortfall as a decline.
  it("asks only for days Search Console has finished with", async () => {
    searches();

    await report({});

    expect(windows()[0].dataState).toBe("FINAL");
  });

  it("lowercases the device the way Analytics reports it", async () => {
    searches({ current: [row(["MOBILE"], 9, 3)] });

    const { rows } = await readReport(await report({ breakdown: ["device"] }));

    expect(rows[0].device).toBe("mobile");
  });

  // Search Console answers an alpha-2 filter with an empty result and no error,
  // so a country asked for in the shared vocabulary has to be translated back
  // or the report would quietly claim the country had no traffic.
  it("asks about a country in the spelling Search Console filters on", async () => {
    searches();

    await report({ where: { country: "TW" } });

    expect(windows()[0].dimensionFilterGroups).toEqual([
      {
        groupType: "and",
        filters: [
          { dimension: "COUNTRY", operator: "EQUALS", expression: "TWN" },
        ],
      },
    ]);
  });

  // A page is named by its path but stored as a full URL, and a domain property
  // has no single origin to put back. Matching the path as a substring would
  // catch everything below it too, so the pattern is anchored at both ends.
  it("matches a page by its whole path rather than by a prefix of it", async () => {
    searches();

    await report({ where: { page: "/posts/hello/" } });

    expect(windows()[0].dimensionFilterGroups).toEqual([
      {
        groupType: "and",
        filters: [
          {
            dimension: "PAGE",
            operator: "INCLUDING_REGEX",
            expression: "^https?://[^/]+/posts/hello/$",
          },
        ],
      },
    ]);
  });

  // Both spellings name the same page — one is how this report prints it, the
  // other how Search Console stores it — and a mismatch would answer with an
  // empty report rather than an error.
  it("takes a page named by its full URL as the same page", async () => {
    searches();

    await report({ where: { page: "https://blog.test.example/posts/hello/" } });

    expect(windows()[0].dimensionFilterGroups).toEqual([
      {
        groupType: "and",
        filters: [
          {
            dimension: "PAGE",
            operator: "INCLUDING_REGEX",
            expression: "^https?://[^/]+/posts/hello/$",
          },
        ],
      },
    ]);
  });

  // Search Console says which days it has finished counting only by leaving the
  // rest out, so the window is ended where the data ends rather than where a
  // constant guesses it does.
  it("ends the window where Search Console has finished counting", async () => {
    searches({ counted: ["2026-08-05", "2026-08-06", "2026-08-07"] });

    const { periods } = await readReport(await report({ days: 7 }));

    expect(periods).toEqual([
      { name: "current", startDate: "2026-08-01", endDate: "2026-08-07" },
      { name: "previous", startDate: "2026-07-25", endDate: "2026-07-31" },
    ]);
  });

  it("falls back to the usual lag when it is told of no counted day", async () => {
    searches({ counted: [] });

    const { periods } = await readReport(await report({ days: 7 }));

    expect(periods[0]).toEqual({
      name: "current",
      startDate: "2026-08-03",
      endDate: ANCHOR,
    });
  });

  it("ends where it is told to", async () => {
    searches();

    const { periods } = await readReport(
      await report({ days: 7, until: "2026-07-31" }),
    );

    expect(periods[0]).toEqual({
      name: "current",
      startDate: "2026-07-25",
      endDate: "2026-07-31",
    });
  });

  // Ranking after both periods are folded together, so a row the API cut from
  // one window does not come back as a period of zero and read as a collapse.
  it("answers the largest rows by current clicks", async () => {
    searches({
      current: [row(["small"], 2, 20), row(["large"], 90, 4)],
      previous: [row(["small"], 1, 22), row(["large"], 80, 5)],
    });

    const { rows } = await readReport(
      await report({ breakdown: ["query"], limit: 1 }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].query).toBe("large");
  });

  // A source nobody has configured yet still answers, and says why. Hiding the
  // tool instead would leave a caller unable to tell an unconfigured server
  // from one whose search data is genuinely empty.
  it("says so when no property is configured rather than going quiet", async () => {
    searches();
    const configured = env.GSC_SITE_URL;
    env.GSC_SITE_URL = undefined;

    try {
      const result = await readResult(await report({}));

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Search Console");
      expect(requests).toHaveLength(0);
    } finally {
      env.GSC_SITE_URL = configured;
    }
  });

  it("is not reachable without an Access assertion", async () => {
    searches();

    const response = await call(
      "tools/call",
      { name: "search_report", arguments: {} },
      {},
    );

    expect(response.status).toBe(403);
    expect(requests).toHaveLength(0);
  });
});
