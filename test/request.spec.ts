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
const GRAPHQL_API = "https://api.cloudflare.com/client/v4/graphql";

const TODAY = "2026-08-12T09:00:00Z";

/** The last whole day, which is where every window here ends by default. */
const ANCHOR = "2026-08-11";

/** What this zone actually answers: eight days back, one day at a time. */
const LIMITS = { enabled: true, notOlderThan: 691200, maxDuration: 86400 };

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

type Filter = { datetime_geq: string; datetime_lt: string } & Record<
  string,
  unknown
>;

type Asked = { query: string; variables: Record<string, Filter | string> };

type Row = {
  count: number;
  sum: { edgeResponseBytes: number };
  dimensions?: Record<string, unknown>;
};

let asked: Asked[];

const row = (requests: number, dimensions?: Record<string, unknown>): Row => ({
  count: requests,
  sum: { edgeResponseBytes: requests * 100 },
  ...(dimensions ? { dimensions } : {}),
});

/**
 * One endpoint answers both questions the tool asks — what this zone will
 * answer at all, and the windows themselves — so the mock tells them apart the
 * way the code does, by what was asked for.
 *
 * Every window is its own variable, and the node reading it carries the same
 * number, so a filter can be answered without knowing which day it is.
 */
const cloudflare = ({
  limits = LIMITS,
  rows = () => [] as Row[],
}: {
  limits?: Record<string, unknown>;
  rows?: (filter: Filter) => Row[];
} = {}) =>
  server.use(
    http.post(GRAPHQL_API, async ({ request }) => {
      const body = (await request.json()) as Asked;
      asked.push(body);

      if (body.query.includes("settings")) {
        return HttpResponse.json({
          data: {
            viewer: {
              zones: [{ settings: { httpRequestsAdaptiveGroups: limits } }],
            },
          },
        });
      }

      const zone: Record<string, unknown> = {};
      for (const [name, filter] of Object.entries(body.variables)) {
        if (name === "zoneTag") continue;
        zone[`n${name.slice(1)}`] = rows(filter as Filter);
      }

      return HttpResponse.json({ data: { viewer: { zones: [zone] } } });
    }),
  );

afterEach(() => vi.useRealTimers());

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(TODAY));
  asked = [];
});

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
  call("tools/call", { name: "request_report", arguments: args });

/** The windows themselves, without the question about what this zone allows. */
const windows = () =>
  asked
    .filter(({ query }) => !query.includes("settings"))
    .flatMap(({ variables }) =>
      Object.entries(variables)
        .filter(([name]) => name !== "zoneTag")
        .map(([, filter]) => filter as Filter),
    );

/** A window belongs to the current period when it starts on or after this day. */
const from = (filter: Filter, day: string) => filter.datetime_geq >= day;

describe("request_report", () => {
  it("is offered with its breakdowns spelled out", async () => {
    cloudflare();

    const { tools } = await readResult(await call("tools/list"));
    const tool = tools.find(
      ({ name }: { name: string }) => name === "request_report",
    );

    expect(tool.inputSchema.properties.breakdown.items.enum).toEqual([
      "bot",
      "page",
      "country",
      "device",
      "status",
      "host",
    ]);
  });

  // Each day is its own window, so a period is the sum of its days — and both
  // periods land on one row, which is what makes a crawler that arrived this
  // week tell itself apart from one that was always there.
  it("adds the days of a period up and pairs it with the one before", async () => {
    cloudflare({
      rows: (filter) => [
        row(from(filter, "2026-08-09") ? 10 : 5, {
          verifiedBotCategory: "AI Crawler",
        }),
      ],
    });

    const { rows } = await readReport(
      await report({ breakdown: ["bot"], days: 3 }),
    );

    expect(rows).toEqual([
      {
        bot: "AI Crawler",
        current: { requests: 30, bytes: 3000 },
        previous: { requests: 15, bytes: 1500 },
      },
    ]);
  });

  // Cloudflare extrapolates a sampled count before answering, so multiplying it
  // by the sample interval again — which is what most tooling around this API
  // does — would inflate every figure by the sampling factor.
  it("reads the count as the number of requests, not as a sample of them", async () => {
    cloudflare({
      rows: (filter) => (from(filter, "2026-08-11") ? [row(1000)] : []),
    });

    const { rows } = await readReport(await report({ days: 1 }));

    expect(rows[0].current.requests).toBe(1000);
  });

  // A period the zone has already discarded is not a period of no traffic, and
  // reporting it as zero would read as everything having arrived this week.
  it("says the previous period is out of reach rather than reporting zero", async () => {
    cloudflare({ rows: () => [row(42)] });

    const { periods, rows } = await readReport(await report({ days: 7 }));

    expect(periods[0]).toEqual({
      name: "current",
      startDate: "2026-08-05",
      endDate: ANCHOR,
    });
    expect(periods[1]).toMatchObject({ name: "previous" });
    expect(periods[1].unavailable).toContain("8 days");
    expect(rows[0].previous).toBeNull();
  });

  // One query may only span so much, so a window wider than that is asked for
  // in pieces — in one request, since they are read together.
  it("asks in windows no wider than the zone allows", async () => {
    cloudflare({ limits: { ...LIMITS, maxDuration: 43_200 } });

    await report({ days: 1 });

    // One day either side of the anchor, each in two halves, and every one of
    // them narrowed the same way — including to the ports the site also
    // answers on, which an exact match on the name alone would drop.
    expect(windows()).toHaveLength(4);
    expect(windows().slice(0, 2)).toEqual([
      {
        datetime_geq: "2026-08-11T00:00:00Z",
        datetime_lt: "2026-08-11T12:00:00Z",
        requestSource: "eyeball",
        OR: [
          { clientRequestHTTPHost: "blog.test.example" },
          { clientRequestHTTPHost_like: "blog.test.example:%" },
        ],
      },
      {
        datetime_geq: "2026-08-11T12:00:00Z",
        datetime_lt: "2026-08-12T00:00:00Z",
        requestSource: "eyeball",
        OR: [
          { clientRequestHTTPHost: "blog.test.example" },
          { clientRequestHTTPHost_like: "blog.test.example:%" },
        ],
      },
    ]);
  });

  // A zone carries every hostname under it, and the site this server answers
  // for is one of them — so the answer says which, and a caller cannot be left
  // reading another site's numbers as this one's.
  it("says which site it answered for", async () => {
    cloudflare({ rows: () => [row(1)] });

    const { site } = await readReport(await report({ days: 1 }));

    expect(site).toBe("blog.test.example");
  });

  it("refuses a site this server does not answer for", async () => {
    cloudflare();

    const result = await readResult(
      await report({ where: { host: "elsewhere.example" } }),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("blog.test.example");
  });

  // With no site named, the zone is the site: every hostname under it answers,
  // and the report says as much rather than implying one.
  it("answers for the whole zone when no site is configured", async () => {
    cloudflare({ rows: () => [row(7)] });
    const configured = env.CLOUDFLARE_SITE_HOST;
    env.CLOUDFLARE_SITE_HOST = undefined;

    try {
      const { site } = await readReport(await report({ days: 1 }));

      expect(site).toBeNull();
      expect(windows()[0].OR).toBeUndefined();
    } finally {
      env.CLOUDFLARE_SITE_HOST = configured;
    }
  });

  // Cloudflare leaves the category empty for anything it has not verified,
  // which is every reader and every crawler wearing a browser's user agent at
  // once. Calling that "human" would invent the one thing it cannot say.
  it("reads an unnamed category as unverified rather than as human", async () => {
    cloudflare({
      rows: () => [row(9, { verifiedBotCategory: "" })],
    });

    const { rows } = await readReport(
      await report({ breakdown: ["bot"], days: 1 }),
    );

    expect(rows[0].bot).toBe("unverified");
  });

  // The status is a number there and a string here, and a filter that kept the
  // string would be refused by the API rather than answered.
  it("asks about a status as the number it is", async () => {
    cloudflare();

    await report({ where: { status: "404" }, days: 1 });

    expect(windows()[0].edgeResponseStatus).toBe(404);
  });

  // Anything that is not a status code would travel as null and answer with an
  // empty report, which reads as a site nothing like that ever happened to.
  it("refuses a status that is not one", async () => {
    cloudflare();

    const result = await readResult(
      await report({ where: { status: "missing" } }),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("missing");
  });

  it("says so when no zone is configured rather than going quiet", async () => {
    cloudflare();
    const zone = env.CLOUDFLARE_ZONE_ID;
    env.CLOUDFLARE_ZONE_ID = undefined;

    try {
      const result = await readResult(await report({}));

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("zone");
      expect(asked).toHaveLength(0);
    } finally {
      env.CLOUDFLARE_ZONE_ID = zone;
    }
  });

  it("is not reachable without an Access assertion", async () => {
    cloudflare();

    const response = await call(
      "tools/call",
      { name: "request_report", arguments: {} },
      {},
    );

    expect(response.status).toBe(403);
    expect(asked).toHaveLength(0);
  });
});
