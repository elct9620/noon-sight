import { env } from "cloudflare:workers";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { query } from "../src/buffer";
import { server } from "./setup";

const GRAPHQL_API = "https://api.buffer.com";

const DOCUMENT = `query Anything($organizationId: OrganizationId!) {
  posts(input: { organizationId: $organizationId }) { edges { node { id } } }
}`;

type Asked = { query: string; variables: Record<string, string> };

// Every request the seam sends lands here, so a test can read what it asked.
let asked: Asked[];

const answers = (
  body: Record<string, unknown>,
  init?: { status?: number; headers?: Record<string, string> },
) =>
  server.use(
    http.post(GRAPHQL_API, async ({ request }) => {
      asked.push((await request.json()) as Asked);
      return HttpResponse.json(body, init);
    }),
  );

beforeEach(() => {
  asked = [];
});

describe("query", () => {
  it("carries the key and names the organization it is asking about", async () => {
    let authorization: string | null = null;
    server.use(
      http.post(GRAPHQL_API, async ({ request }) => {
        authorization = request.headers.get("Authorization");
        asked.push((await request.json()) as Asked);
        return HttpResponse.json({ data: { posts: { edges: [] } } });
      }),
    );

    expect(await query(DOCUMENT)).toEqual({ posts: { edges: [] } });
    expect(authorization).toBe("Bearer buffer-test-key");
    expect(asked[0].query).toBe(DOCUMENT);
    expect(asked[0].variables).toEqual({ organizationId: "org-test" });
  });

  it("passes what the caller asked alongside the organization", async () => {
    answers({ data: { posts: { edges: [] } } });

    await query(DOCUMENT, { first: 20 });

    expect(asked[0].variables).toEqual({
      organizationId: "org-test",
      first: 20,
    });
  });

  // Buffer answers a refused query with 200 and an `errors` array, so a seam
  // reading only the status would hand back an empty answer as if the account
  // had published nothing.
  it("reads a refusal that arrived as 200", async () => {
    answers({
      data: null,
      errors: [
        { message: "Not authorized", extensions: { code: "UNAUTHORIZED" } },
      ],
    });

    await expect(query(DOCUMENT)).rejects.toThrow(
      "Buffer refused the request (200): Not authorized",
    );
  });

  // A rate limit is the one refusal a caller can do something about, so the
  // window that ran out and the seconds it asks for travel with the sentence.
  it("says which window ran out and how long to wait", async () => {
    answers(
      {
        data: null,
        errors: [
          {
            message: "Too many requests from this client.",
            extensions: { code: "RATE_LIMIT_EXCEEDED", window: "15m" },
          },
        ],
      },
      { status: 429, headers: { "Retry-After": "42" } },
    );

    await expect(query(DOCUMENT)).rejects.toThrow(
      "Buffer refused the request (429): Too many requests from this client. (the 15m window is spent; retry in 42s)",
    );
  });

  // A gateway answering HTML carries no `errors` array, and the body is then
  // the most useful thing there is.
  it("repeats a body that is not GraphQL at all", async () => {
    server.use(
      http.post(GRAPHQL_API, () =>
        HttpResponse.text("<html>502</html>", { status: 502 }),
      ),
    );

    await expect(query(DOCUMENT)).rejects.toThrow(
      "Buffer refused the request (502): <html>502</html>",
    );
  });

  // An answer carrying neither data nor an error is still not a report, and
  // has to say so rather than surface as a read of undefined further in.
  it("says so when nothing came back at all", async () => {
    answers({ data: null });

    await expect(query(DOCUMENT)).rejects.toThrow("neither data nor a reason");
  });

  // A source nobody has configured still answers, and says which value is
  // missing — a key and an organization are two separate things to get wrong.
  it("says which value is missing rather than going quiet", async () => {
    const key = env.BUFFER_API_KEY;
    const organization = env.BUFFER_ORGANIZATION_ID;

    try {
      env.BUFFER_API_KEY = undefined;
      await expect(query(DOCUMENT)).rejects.toThrow("key");

      env.BUFFER_API_KEY = key;
      env.BUFFER_ORGANIZATION_ID = undefined;
      await expect(query(DOCUMENT)).rejects.toThrow("organization");

      expect(asked).toHaveLength(0);
    } finally {
      env.BUFFER_API_KEY = key;
      env.BUFFER_ORGANIZATION_ID = organization;
    }
  });
});
