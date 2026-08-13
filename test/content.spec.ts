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
const BUFFER_API = "https://api.buffer.com";
const SITE = "https://blog.test.example";
const PAGE = "/posts/2026/08/06/kobako/";

const TODAY = "2026-08-12T09:00:00Z";

/** Three days back, which is where a window ends unless a caller says otherwise. */
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

type Asked = { query: string; variables: Record<string, unknown> };

let asked: Asked[];

type Post = {
  id: string;
  text: string;
  dueAt: string;
  createdAt: string;
  channelService: string;
  tags: { name: string }[];
};

const post = (
  id: string,
  text: string,
  {
    dueAt = "2026-08-06T05:30:00.000Z",
    createdAt = "2026-08-06T01:11:18.673Z",
    channelService = "twitter",
    tags = ["Ruby"],
  } = {},
): Post => ({
  id,
  text,
  dueAt,
  createdAt,
  channelService,
  tags: tags.map((name) => ({ name })),
});

/**
 * One act reaches three channels, and only the channel with link shortening
 * turned off keeps the address readable. Collapsing them is what makes the
 * page recoverable at all.
 */
const ACT = [
  post("a", `Kobako 的設計考量\n\n${SITE}${PAGE}`, {
    channelService: "twitter",
  }),
  post("b", `Kobako 的設計考量，還有更長的一段補充說明\n\nhttps://bit.ly/x`, {
    createdAt: "2026-08-06T01:11:18.684Z",
    channelService: "facebook",
  }),
  post("c", `Kobako 的設計考量\n\nhttps://lnkd.in/y`, {
    createdAt: "2026-08-06T01:11:18.687Z",
    channelService: "linkedin",
  }),
];

const buffer = (posts: Post[], answer?: Record<string, unknown>) =>
  server.use(
    http.post(BUFFER_API, async ({ request }) => {
      asked.push((await request.json()) as Asked);

      return HttpResponse.json(
        answer ?? {
          data: {
            posts: {
              edges: posts.map((node) => ({ node })),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      );
    }),
  );

const article = (body: string, type = "text/markdown") =>
  server.use(
    http.get(`${SITE}${PAGE}`, () =>
      HttpResponse.text(body, { headers: { "Content-Type": type } }),
    ),
  );

const FRONTMATTER = `---
title: "Kobako：為什麼是 Ruby"
tags: ["LLM","Ruby"]
series: "kobako"
language: "zh-tw"
---
body`;

afterEach(() => vi.useRealTimers());

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(TODAY));
  asked = [];
  await env.CONTENT_CACHE.delete(`piece:1:${PAGE}`);
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

const report = (args: Record<string, unknown> = {}) =>
  call("tools/call", { name: "content_report", arguments: args });

describe("content_report", () => {
  it("is offered with the kinds it tells apart spelled out", async () => {
    const { tools } = await readResult(await call("tools/list"));
    const tool = tools.find(
      ({ name }: { name: string }) => name === "content_report",
    );

    expect(tool.inputSchema.properties.kind.enum).toEqual([
      "article",
      "link",
      "note",
    ]);
  });

  it("answers for a window ending where the other reports end", async () => {
    buffer([]);

    expect(await readReport(await report())).toMatchObject({
      period: { startDate: "2026-07-13", endDate: ANCHOR },
    });
    expect(asked[0].variables).toMatchObject({
      organizationId: "org-test",
      start: "2026-07-13T00:00:00.000Z",
    });
  });

  // Three posts are one thing said. Counting them as three would treat the
  // channels a thought reached as three separate thoughts.
  it("collapses the copies of one act into the thing that was said", async () => {
    buffer(ACT);
    article(FRONTMATTER);

    const { items } = await readReport(await report());

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      publishedAt: "2026-08-06",
      kind: "article",
      channels: ["twitter", "facebook", "linkedin"],
      tags: ["Ruby"],
      page: PAGE,
    });
    // The fullest wording of a thought is the one worth keeping; a thread's
    // opening post is the same thought with the rest cut off.
    expect(items[0].text).toContain("還有更長的一段補充說明");
  });

  // The channel with shortening turned off is the only one that kept the
  // address, and it speaks for the act rather than only for itself.
  it("reads the page from whichever copy still names it", async () => {
    buffer(ACT);
    article(FRONTMATTER);

    const { items } = await readReport(await report());

    expect(items[0].article).toEqual({
      title: "Kobako：為什麼是 Ruby",
      topics: ["LLM", "Ruby"],
      series: "kobako",
      language: "zh-tw",
    });
  });

  it("tells an opinion from a link to somewhere else", async () => {
    buffer([
      post("n", "這算是個人對新工具的預測，大致上是這樣的", {
        createdAt: "2026-08-08T01:00:00.000Z",
        dueAt: "2026-08-08T05:30:00.000Z",
        tags: [],
      }),
      post("l", "AWS 的新 Policy 語言\n\nhttps://github.com/dogwood/x", {
        createdAt: "2026-08-07T01:00:00.000Z",
        dueAt: "2026-08-07T05:30:00.000Z",
        tags: [],
      }),
    ]);

    const { items } = await readReport(await report());

    expect(items).toMatchObject([
      { kind: "note", publishedAt: "2026-08-08" },
      { kind: "link", host: "github.com", publishedAt: "2026-08-07" },
    ]);
    expect(items[0].page).toBeUndefined();
    expect(items[1].article).toBeUndefined();
  });

  it("narrows to one kind when asked", async () => {
    buffer([
      post("n", "純粹的想法", { createdAt: "2026-08-08T01:00:00.000Z" }),
      ...ACT,
    ]);
    article(FRONTMATTER);

    const { items } = await readReport(await report({ kind: "note" }));

    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("note");
  });

  // A page nobody could read is not a page nobody wrote about, and a report
  // that quietly dropped the difference would read as the latter.
  it("says how many pieces it could not read", async () => {
    buffer(ACT);
    server.use(
      http.get(`${SITE}${PAGE}`, () =>
        HttpResponse.text("nope", { status: 404 }),
      ),
    );

    const answer = await readReport(await report());

    expect(answer.unresolved).toBe(1);
    expect(answer.items[0].article).toBeUndefined();
    expect(answer.items[0].page).toBe(PAGE);
  });

  it("repeats what Buffer said when it refuses", async () => {
    buffer([], {
      data: null,
      errors: [
        { message: "Not authorized", extensions: { code: "UNAUTHORIZED" } },
      ],
    });

    const result = await readResult(await report());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Not authorized");
  });

  it("answers nobody who has not passed Access", async () => {
    buffer(ACT);

    const response = await call(
      "tools/call",
      { name: "content_report", arguments: {} },
      {},
    );

    expect(response.status).toBe(403);
  });
});
