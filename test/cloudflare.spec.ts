import { env } from "cloudflare:workers";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { limits, query } from "../src/cloudflare";
import { server } from "./setup";

const GRAPHQL_API = "https://api.cloudflare.com/client/v4/graphql";

const DOCUMENT = `query Anything($zoneTag: string) {
  viewer { zones(filter: { zoneTag: $zoneTag }) { name } }
}`;

type Asked = { query: string; variables: Record<string, string> };

// Every request the seam sends lands here, so a test can read what it asked.
let asked: Asked[];

const answers = (body: Record<string, unknown>, status = 200) =>
  server.use(
    http.post(GRAPHQL_API, async ({ request }) => {
      asked.push((await request.json()) as Asked);
      return HttpResponse.json(body, { status });
    }),
  );

const zone = (fields: Record<string, unknown>) => ({
  data: { viewer: { zones: [fields] } },
  errors: null,
});

const settings = (dataset: unknown) =>
  zone({ settings: { httpRequestsAdaptiveGroups: dataset } });

beforeEach(() => {
  asked = [];
});

describe("query", () => {
  it("carries the token and names the zone it is asking about", async () => {
    let authorization: string | null = null;
    server.use(
      http.post(GRAPHQL_API, async ({ request }) => {
        authorization = request.headers.get("Authorization");
        asked.push((await request.json()) as Asked);
        return HttpResponse.json(zone({ name: "test.example" }));
      }),
    );

    expect(await query(DOCUMENT)).toEqual({ name: "test.example" });
    expect(authorization).toBe("Bearer cf-test-token");
    expect(asked[0].query).toBe(DOCUMENT);
    expect(asked[0].variables).toEqual({ zoneTag: "zone-test" });
  });

  it("passes what the caller asked alongside the zone", async () => {
    answers(zone({ name: "test.example" }));

    await query(DOCUMENT, { since: "2026-08-05T00:00:00Z" });

    expect(asked[0].variables).toEqual({
      zoneTag: "zone-test",
      since: "2026-08-05T00:00:00Z",
    });
  });

  // GraphQL answers a refusal with 200 and an `errors` array, so a seam that
  // reads only the status would hand back an empty report as if the zone had
  // nothing to say. This is the first thing a query written for a REST API
  // gets wrong here.
  it("reads a refusal that arrived as 200", async () => {
    answers({
      data: null,
      errors: [
        { message: "zone does not have access to the field 'botScore'" },
      ],
    });

    await expect(query(DOCUMENT)).rejects.toThrow(
      "Cloudflare refused the request (200): zone does not have access to the field 'botScore'",
    );
  });

  it("repeats what Cloudflare said when it refuses outright", async () => {
    answers(
      { success: false, errors: [{ message: "Authentication error" }] },
      403,
    );

    await expect(query(DOCUMENT)).rejects.toThrow(
      "Cloudflare refused the request (403): Authentication error",
    );
  });

  // An edge that answers HTML says nothing an `errors` array would, and the
  // body is then the most useful thing there is.
  it("repeats a body that is not GraphQL at all", async () => {
    server.use(
      http.post(GRAPHQL_API, () =>
        HttpResponse.text("<html>error 1015</html>", { status: 429 }),
      ),
    );

    await expect(query(DOCUMENT)).rejects.toThrow(
      "Cloudflare refused the request (429): <html>error 1015</html>",
    );
  });

  // A zone tag naming nothing answers with an empty list rather than an error,
  // which would otherwise read as a site with no traffic.
  it("says so when the zone tag names nothing", async () => {
    answers({ data: { viewer: { zones: [] } }, errors: null });

    await expect(query(DOCUMENT)).rejects.toThrow("no zone");
  });

  // A source nobody has configured still answers, and says which value is
  // missing — a token and a zone are two separate things to get wrong.
  it("says which value is missing rather than going quiet", async () => {
    const token = env.CLOUDFLARE_API_TOKEN;
    const zoneId = env.CLOUDFLARE_ZONE_ID;

    try {
      env.CLOUDFLARE_API_TOKEN = undefined;
      await expect(query(DOCUMENT)).rejects.toThrow("token");

      env.CLOUDFLARE_API_TOKEN = token;
      env.CLOUDFLARE_ZONE_ID = undefined;
      await expect(query(DOCUMENT)).rejects.toThrow("zone");

      expect(asked).toHaveLength(0);
    } finally {
      env.CLOUDFLARE_API_TOKEN = token;
      env.CLOUDFLARE_ZONE_ID = zoneId;
    }
  });
});

describe("limits", () => {
  // How far back this zone answers and how wide one query may be are what size
  // every window here, and both move with the plan — so they are asked rather
  // than written down.
  it("answers how far back and how wide this zone will go", async () => {
    answers(
      settings({ enabled: true, notOlderThan: 691200, maxDuration: 86400 }),
    );

    expect(await limits()).toEqual({
      enabled: true,
      notOlderThan: 691200,
      maxDuration: 86400,
    });
  });

  // Without the dataset there is no report at all, and the window arithmetic
  // would otherwise run on nulls and answer with dates nobody asked for.
  it("says so when the zone cannot read the dataset", async () => {
    answers(
      settings({ enabled: false, notOlderThan: null, maxDuration: null }),
    );

    await expect(limits()).rejects.toThrow("httpRequestsAdaptiveGroups");
  });

  // A zone answering in a shape nobody expected is still a refusal to size a
  // window with, and it has to arrive as that sentence rather than as a read
  // of undefined.
  it("says the same when the answer carries no settings at all", async () => {
    answers(zone({ name: "test.example" }));

    await expect(limits()).rejects.toThrow("httpRequestsAdaptiveGroups");
  });
});
