import { env } from "cloudflare:workers";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { type Report, compare, runReport } from "../src/analytics";
import { server } from "./setup";

const REPORT_URL =
  "https://analyticsdata.googleapis.com/v1beta/properties/123456:runReport";

const grantsToken = () =>
  server.use(
    http.post("https://oauth2.googleapis.com/token", () =>
      HttpResponse.json({ access_token: "ya29.report", expires_in: 3600 }),
    ),
  );

beforeEach(async () => {
  const { keys } = await env.TOKEN_CACHE.list();
  await Promise.all(keys.map(({ name }) => env.TOKEN_CACHE.delete(name)));
  grantsToken();
});

describe("runReport", () => {
  it("addresses the property and carries the access token", async () => {
    let authorization: string | null = null;
    server.use(
      http.post(REPORT_URL, ({ request }) => {
        authorization = request.headers.get("Authorization");
        return HttpResponse.json({ rowCount: 0 });
      }),
    );

    await runReport("123456", { metrics: [{ name: "sessions" }] });

    expect(authorization).toBe("Bearer ya29.report");
  });

  // One status covers unrelated causes: a property the account was never added
  // to, and an API nobody enabled, both answer 403. Only Google's sentence says
  // which, and the caller has already passed Access.
  it("repeats what Google said when it refuses", async () => {
    server.use(
      http.post(REPORT_URL, () =>
        HttpResponse.json(
          {
            error: {
              status: "PERMISSION_DENIED",
              message:
                "Google Analytics Data API has not been used in project 000000000000 before or it is disabled.",
            },
          },
          { status: 403 },
        ),
      ),
    );

    await expect(runReport("123456", {})).rejects.toThrow(
      "Google Analytics refused the report (403): Google Analytics Data API has not been used in project 000000000000 before or it is disabled.",
    );
  });
});

const report = (rows: [string, string, string][]): Report => ({
  dimensionHeaders: [
    { name: "sessionDefaultChannelGroup" },
    { name: "dateRange" },
  ],
  metricHeaders: [{ name: "sessions" }],
  rows: rows.map(([channel, period, sessions]) => ({
    dimensionValues: [{ value: channel }, { value: period }],
    metricValues: [{ value: sessions }],
  })),
});

describe("compare", () => {
  it("folds both periods of a breakdown into one row", () => {
    expect(
      compare(
        report([
          ["Organic Search", "current", "120"],
          ["Organic Search", "previous", "96"],
        ]),
      ),
    ).toEqual([
      {
        sessionDefaultChannelGroup: "Organic Search",
        current: { sessions: 120 },
        previous: { sessions: 96 },
      },
    ]);
  });

  // A channel that appeared or vanished is the finding, not a gap to drop.
  it("reads zero for a period a breakdown is missing from", () => {
    expect(
      compare(
        report([
          ["Organic Search", "current", "120"],
          ["Referral", "previous", "40"],
        ]),
      ),
    ).toEqual([
      {
        sessionDefaultChannelGroup: "Organic Search",
        current: { sessions: 120 },
        previous: { sessions: 0 },
      },
      {
        sessionDefaultChannelGroup: "Referral",
        current: { sessions: 0 },
        previous: { sessions: 40 },
      },
    ]);
  });

  // Asking for no breakdown leaves `dateRange` as the only dimension, which is
  // the same shape with an empty key rather than a case of its own.
  it("answers a single row when nothing is broken down", () => {
    expect(
      compare({
        dimensionHeaders: [{ name: "dateRange" }],
        metricHeaders: [{ name: "sessions" }, { name: "engagementRate" }],
        rows: [
          {
            dimensionValues: [{ value: "current" }],
            metricValues: [{ value: "300" }, { value: "0.61" }],
          },
          {
            dimensionValues: [{ value: "previous" }],
            metricValues: [{ value: "250" }, { value: "0.58" }],
          },
        ],
      }),
    ).toEqual([
      {
        current: { sessions: 300, engagementRate: 0.61 },
        previous: { sessions: 250, engagementRate: 0.58 },
      },
    ]);
  });

  it("answers nothing when the property reported no rows", () => {
    expect(compare({})).toEqual([]);
  });
});
