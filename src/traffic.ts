import { type McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { env } from "cloudflare:workers";
import { compare, runReport } from "./analytics";
import { settled, windows } from "./period";

/**
 * Each breakdown names a question rather than a column: what a report can be
 * grouped by is a closed list, so the tool stays a tool instead of becoming a
 * way to spell arbitrary Data API requests.
 */
const BREAKDOWNS = {
  channel: "sessionDefaultChannelGroup",
  source: "sessionSourceMedium",
  page: "landingPagePlusQueryString",
  // Codes rather than names for both, for reasons that happen to agree. A name
  // is no coordinate two sources can share, and Search Console answers in ISO
  // codes and nothing else; and "Chinese" merges audiences that read nothing
  // alike, when which one a visitor is is the point of asking.
  country: "countryId",
  language: "languageCode",
  device: "deviceCategory",
  visitor_type: "newVsReturning",
} as const;

/**
 * One fixed set, so reach and worth sit on the same row: traffic that arrives
 * and does not engage reads differently from traffic that does, and splitting
 * them across tools would make the reader join them back up.
 */
const METRICS = [
  "sessions",
  "totalUsers",
  "newUsers",
  "engagementRate",
  "averageSessionDuration",
  "keyEvents",
];

const DEFAULT_DAYS = 28;
const DEFAULT_LIMIT = 10;

type Breakdown = keyof typeof BREAKDOWNS;

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
        "How to group the traffic. Omit for the site as a whole. `channel` and `source` say where visitors came from, `page` which content brought them in, `country`, `language`, `device` and `visitor_type` who they are. Two may be combined to cross them.",
    },
    where: {
      type: "object",
      properties: Object.fromEntries(
        Object.keys(BREAKDOWNS).map((key) => [key, { type: "string" }]),
      ),
      additionalProperties: false,
      description:
        'Narrow the report to one segment, keyed the same way as `breakdown` and valued as the report itself reports it — `{"country": "TW"}`, `{"channel": "Organic Search"}`. Several keys must all hold. A segment can be narrowed on without being grouped by.',
    },
    days: {
      type: "integer",
      minimum: 1,
      maximum: 365,
      description: `How many days each of the two periods covers. Defaults to ${DEFAULT_DAYS}.`,
    },
    until: {
      type: "string",
      pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      description:
        "The last day the report covers, as YYYY-MM-DD. Defaults to the most recent day every source here has finished counting, so reports drawn from different sources cover the same days and can be read side by side. Name a later one to trade that alignment for fresher Analytics days. The answer always states the dates it used.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 100,
      description: `How many rows to answer with, largest by current sessions first. Defaults to ${DEFAULT_LIMIT}.`,
    },
  },
  additionalProperties: false,
});

/**
 * Every condition has to hold, which is what `andGroup` says. Google matches a
 * string exactly unless told otherwise, and exact is what a segment means.
 */
const segment = (where: Partial<Record<Breakdown, string>>) => {
  const expressions = Object.entries(where).map(([key, value]) => ({
    filter: {
      fieldName: BREAKDOWNS[key as Breakdown],
      stringFilter: { value },
    },
  }));

  return expressions.length ? { andGroup: { expressions } } : undefined;
};

export const registerTrafficReport = (server: McpServer) =>
  server.registerTool(
    "traffic_report",
    {
      title: "Traffic report",
      description:
        "Report Google Analytics traffic for a period against the equally long period before it, so growth and decline are readable without a second call. Every row carries the same metrics for both periods.",
      inputSchema,
    },
    async ({
      breakdown = [],
      where = {},
      days = DEFAULT_DAYS,
      until = settled(),
      limit = DEFAULT_LIMIT,
    }) => {
      if (!env.GA_PROPERTY_ID) {
        throw new Error("No Google Analytics property is configured");
      }

      const periods = windows(until, days);
      const report = await runReport(env.GA_PROPERTY_ID, {
        dimensions: breakdown.map((key) => ({ name: BREAKDOWNS[key] })),
        metrics: METRICS.map((name) => ({ name })),
        dateRanges: periods,
        dimensionFilter: segment(where),
      });

      // Ranking and cutting happen after both periods are folded together: a
      // row Google truncated would otherwise come back as a period of zero and
      // read as a collapse rather than as an absence.
      //
      // A row is then named the way it was asked for. Answering `page` with
      // `landingPagePlusQueryString` would give the tool two vocabularies and
      // let Google's back out through the one that was meant to be closed.
      const rows = compare(report)
        .sort((a, b) => b.current.sessions - a.current.sessions)
        .slice(0, limit)
        .map(({ current, previous, ...dimensions }) => ({
          ...Object.fromEntries(
            breakdown.map((key) => [key, dimensions[BREAKDOWNS[key]]]),
          ),
          current,
          previous,
        }));

      return {
        content: [{ type: "text", text: JSON.stringify({ periods, rows }) }],
      };
    },
  );
