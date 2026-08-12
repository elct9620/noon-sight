import { type McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { env } from "cloudflare:workers";
import { DATASET, limits, query } from "./cloudflare";
import { instants, windows, yesterday } from "./period";

/**
 * Each breakdown names a question rather than a column. `bot` is the one no
 * other source here can answer: Analytics only ever meets a visitor that ran
 * its JavaScript, so a crawler is invisible there rather than merely unnamed.
 */
const BREAKDOWNS = {
  bot: "verifiedBotCategory",
  page: "clientRequestPath",
  country: "clientCountryName",
  device: "clientDeviceType",
  status: "edgeResponseStatus",
  host: "clientRequestHTTPHost",
} as const;

type Breakdown = keyof typeof BREAKDOWNS;

/** What the category is when Cloudflare has verified nobody. */
const UNVERIFIED = "unverified";

/** Requests the edge answered, rather than what it fetched to answer them. */
const EYEBALL = "eyeball";

const DEFAULT_DAYS = 7;
const DEFAULT_LIMIT = 10;
const SECONDS = 1000;
const DAY_SECONDS = 86_400;

/**
 * Ranking happens after every window is folded, so each is asked for far more
 * rows than can be answered with — a row inside the limit on one day but cut
 * from another would come back short and read as a decline.
 */
const ROWS = 1000;

type Input = {
  breakdown?: Breakdown[];
  where?: Partial<Record<Breakdown, string>>;
  days?: number;
  until?: string;
  limit?: number;
};

const inputSchema = fromJsonSchema<Input>({
  type: "object",
  properties: {
    breakdown: {
      type: "array",
      items: { type: "string", enum: Object.keys(BREAKDOWNS) },
      maxItems: 2,
      description:
        "How to group the requests. Omit for the site as a whole. `bot` says who was asking, `page` what they asked for, `status` what they got, `country` and `device` where from. `host` splits a zone that carries several sites. Two may be combined to cross them.",
    },
    where: {
      type: "object",
      properties: Object.fromEntries(
        Object.keys(BREAKDOWNS).map((key) => [key, { type: "string" }]),
      ),
      additionalProperties: false,
      description:
        'Narrow the report to one segment, keyed the same way as `breakdown` and valued as the report itself reports it — `{"bot": "AI Crawler"}`, `{"status": "404"}`. Several keys must all hold. Broken links are `{"status": "404"}` grouped by `page`, and are worth narrowing to a bot category as well: unverified traffic answers 4xx constantly, and none of it is a link anyone followed.',
    },
    days: {
      type: "integer",
      minimum: 1,
      maximum: 365,
      description: `How many days each of the two periods covers. Defaults to ${DEFAULT_DAYS}. Cloudflare keeps about a week, so a longer window is refused and the previous period is usually out of reach.`,
    },
    until: {
      type: "string",
      pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      description:
        "The last day the report covers, as YYYY-MM-DD. Defaults to yesterday, the freshest whole day the edge can answer for — the other tools here wait three days for Google to finish counting, so pass their `endDate` to lay the answers side by side, at the cost of days this source cannot spare.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 100,
      description: `How many rows to answer with, largest by current requests first. Defaults to ${DEFAULT_LIMIT}.`,
    },
  },
  additionalProperties: false,
});

/** Cloudflare reads an instant, and not a fraction of a second. */
const instant = (at: number) => `${new Date(at).toISOString().slice(0, 19)}Z`;

/**
 * One query may only span so much, so a window wider than that is asked for in
 * pieces. They ride in one request, since a period is the sum of them.
 */
const spans = (
  period: { startDate: string; endDate: string },
  maxDuration: number,
) => {
  const { from, to } = instants(period);
  const step = maxDuration * SECONDS;
  const cut = [];

  for (let at = from; at < to; at += step) {
    cut.push({
      datetime_geq: instant(at),
      datetime_lt: instant(Math.min(at + step, to)),
    });
  }

  return cut;
};

/**
 * A zone carries every hostname under it, so the site this server answers for
 * is a setting rather than a question. Asking for another one is refused: an
 * answer narrowed to a host outside it would be empty for a reason nobody
 * could see.
 */
const scope = (asked?: string) => {
  const configured = env.CLOUDFLARE_SITE_HOST;

  if (asked && configured && asked !== configured) {
    throw new Error(`This server answers for ${configured}, not for ${asked}`);
  }

  return asked ?? configured ?? null;
};

/**
 * The host carries a port whenever someone knocks on one of the alternates
 * Cloudflare answers, and matching the name alone would drop exactly those
 * requests. The colon anchors the second arm, so nothing below the name is
 * caught with it.
 */
const under = (host: string) => ({
  OR: [
    { clientRequestHTTPHost: host },
    { clientRequestHTTPHost_like: `${host}:%` },
  ],
});

/** A value as this report prints it, written back the way Cloudflare filters. */
const WRITE: Record<Exclude<Breakdown, "host">, (value: string) => unknown> = {
  bot: (value) => (value === UNVERIFIED ? "" : value),
  page: (value) => value,
  country: (value) => value,
  device: (value) => value,
  // A status is a number there and a string here. Anything that is not one
  // would travel as null and answer with an empty report and no reason, which
  // is worse than saying so.
  status: (value) => {
    const code = Number(value);

    if (!Number.isInteger(code)) {
      throw new Error(`${value} is not a status code to narrow a report to`);
    }

    return code;
  },
};

/** And the way back: only the empty category is not already shared vocabulary. */
const read = (key: Breakdown, value: unknown) =>
  key === "bot" && value === "" ? UNVERIFIED : value;

type Node = {
  count: number;
  sum: { edgeResponseBytes: number };
  dimensions?: Record<string, unknown>;
};

type Totals = { keys: unknown[]; requests: number; bytes: number };

const document = (nodes: number, breakdown: Breakdown[]) => {
  const dimensions = breakdown.length
    ? `dimensions { ${breakdown.map((key) => BREAKDOWNS[key]).join(" ")} }`
    : "";

  const asked = Array.from(
    { length: nodes },
    (_, at) => `
      n${at}: ${DATASET}(limit: ${ROWS}, filter: $f${at}, orderBy: [count_DESC]) {
        count
        sum { edgeResponseBytes }
        ${dimensions}
      }`,
  );

  const declared = Array.from(
    { length: nodes },
    (_, at) => `$f${at}: ZoneHttpRequestsAdaptiveGroupsFilter_InputObject`,
  );

  return `query Requests($zoneTag: string, ${declared.join(", ")}) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {${asked.join("")}
    }
  }
}`;
};

/**
 * Cloudflare extrapolates a sampled count before answering, so the count is the
 * number of requests rather than a sample of them — restoring it again would
 * inflate every figure by the sampling factor.
 */
const fold = (breakdown: Breakdown[], nodes: Node[][]) => {
  const folded = new Map<string, Totals>();

  for (const rows of nodes) {
    for (const row of rows) {
      const keys = breakdown.map((key) =>
        read(key, row.dimensions?.[BREAKDOWNS[key]]),
      );
      const at = JSON.stringify(keys);
      const held = folded.get(at) ?? { keys, requests: 0, bytes: 0 };

      folded.set(at, {
        keys,
        requests: held.requests + row.count,
        bytes: held.bytes + row.sum.edgeResponseBytes,
      });
    }
  }

  return folded;
};

/** A period a breakdown was never seen in counted none of it, which is zero. */
const totals = (held?: Totals) => ({
  requests: held?.requests ?? 0,
  bytes: held?.bytes ?? 0,
});

/**
 * A breakdown seen in only one period still gets both, because something that
 * appeared or vanished is what the comparison exists to show. Merging the two
 * is what says which those are — either side may hold a key the other lacks.
 */
const compare = (current: Map<string, Totals>, previous: Map<string, Totals>) =>
  [...new Map([...previous, ...current])].map(([at, seen]) => ({
    keys: seen.keys,
    current: totals(current.get(at)),
    previous: totals(previous.get(at)),
  }));

export const registerRequestReport = (server: McpServer) =>
  server.registerTool(
    "request_report",
    {
      title: "Request report",
      description:
        "Report what reached the edge for a period against the equally long period before it. This is the only source here that sees a request no browser made: a crawler that runs no JavaScript never appears in Analytics at all, and Search Console counts only what Google Search served. Cloudflare names the automation it has verified — search crawlers, AI crawlers, AI assistants, feed fetchers — and leaves the category empty for everything else, so `unverified` holds readers and disguised automation together and is never a count of people. Every request is counted whatever it answered, which is where a broken link shows itself. The window is short: this source keeps about a week, so the previous period is often out of reach and is then reported as unavailable rather than as zero.",
      inputSchema,
    },
    async ({
      breakdown = [],
      where = {},
      days = DEFAULT_DAYS,
      until,
      limit = DEFAULT_LIMIT,
    }) => {
      const { notOlderThan, maxDuration } = await limits();
      const [current, previous] = windows(until ?? yesterday(), days);

      const { host, ...narrowed } = where;
      const site = scope(host);
      const conditions = {
        requestSource: EYEBALL,
        ...(site ? under(site) : {}),
        ...Object.fromEntries(
          Object.entries(narrowed).map(([key, value]) => [
            BREAKDOWNS[key as Breakdown],
            WRITE[key as Exclude<Breakdown, "host">](value),
          ]),
        ),
      };

      // A period the zone has already discarded is not a period of no traffic.
      // Answering the older one as zero would read as everything having arrived
      // this week, so it is left out and said to be out of reach instead.
      const kept = Math.floor(notOlderThan / DAY_SECONDS);
      const earliest = Date.now() - notOlderThan * SECONDS;
      const reaches = (period: typeof current) =>
        instants(period).from >= earliest;

      if (!reaches(current)) {
        throw new Error(
          `This zone keeps ${kept} days, and a ${days}-day window ending ${current.endDate} reaches further back`,
        );
      }

      const paired = reaches(previous);
      const counted = spans(current, maxDuration);
      const earlier = paired ? spans(previous, maxDuration) : [];
      const asked = [...counted, ...earlier];

      const zone = await query<Record<string, Node[]>>(
        document(asked.length, breakdown),
        Object.fromEntries(
          asked.map((span, at) => [`f${at}`, { ...span, ...conditions }]),
        ),
      );

      // The windows came back under the names they went out with, so a period
      // is its own stretch of them.
      const answered = asked.map((_, at) => zone[`n${at}`] ?? []);

      const rows = compare(
        fold(breakdown, answered.slice(0, counted.length)),
        fold(breakdown, answered.slice(counted.length)),
      )
        .sort((a, b) => b.current.requests - a.current.requests)
        .slice(0, limit)
        .map((row) => ({
          ...Object.fromEntries(
            breakdown.map((key, at) => [key, row.keys[at]]),
          ),
          current: row.current,
          previous: paired ? row.previous : null,
        }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              site,
              periods: [
                current,
                paired
                  ? previous
                  : {
                      name: previous.name,
                      unavailable: `outside the ${kept} days this zone retains`,
                    },
              ],
              rows,
            }),
          },
        ],
      };
    },
  );
