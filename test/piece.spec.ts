import { env } from "cloudflare:workers";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { about, budget, onSite } from "../src/piece";
import { server } from "./setup";

const SITE = "https://blog.test.example";
const PAGE = "/posts/2026/08/12/kobako/";

const FRONTMATTER = `---
title: "Kobako：為什麼是 Ruby"
date: 2026-08-12T00:00:00+08:00
tags: ["LLM","AI","Ruby"]
series: "kobako"
language: "zh-tw"
---

上週末我在 COSCUP 的演講…
`;

const LD_JSON = `<html><head><script type="application/ld+json">
{"@context":"https://schema.org","@type":"BlogPosting",
 "headline":"Kobako：為什麼是 Ruby","keywords":["LLM","AI","Ruby"]}
</script></head><body>…</body></html>`;

let accepted: (string | null)[];

const page = (body: string, { type = "text/markdown", status = 200 } = {}) =>
  server.use(
    http.get(`${SITE}${PAGE}`, ({ request }) => {
      accepted.push(request.headers.get("Accept"));
      return HttpResponse.text(body, {
        status,
        headers: { "Content-Type": type },
      });
    }),
  );

beforeEach(async () => {
  accepted = [];
  await env.CONTENT_CACHE.delete(`piece:1:${PAGE}`);
});

describe("onSite", () => {
  it("reads a link to this site down to the path every source names it by", () => {
    expect(onSite(`${SITE}${PAGE}`)).toBe(PAGE);
  });

  it("refuses a link to anywhere else, whatever it points at", () => {
    expect(onSite("https://github.com/elct9620/kobako")).toBeNull();
    expect(onSite("https://bit.ly/3TPgYWx")).toBeNull();
  });

  // Without a site to compare against there is no such thing as a link to it,
  // and guessing would make every shared page look like this one's.
  it("refuses everything when no site is configured", () => {
    const host = env.CLOUDFLARE_SITE_HOST;

    try {
      env.CLOUDFLARE_SITE_HOST = undefined;
      expect(onSite(`${SITE}${PAGE}`)).toBeNull();
    } finally {
      env.CLOUDFLARE_SITE_HOST = host;
    }
  });
});

describe("about", () => {
  it("asks for markdown and reads what the frontmatter declares", async () => {
    page(FRONTMATTER);

    expect(await about(PAGE, budget())).toEqual({
      title: "Kobako：為什麼是 Ruby",
      topics: ["LLM", "AI", "Ruby"],
      series: "kobako",
      language: "zh-tw",
    });
    expect(accepted[0]).toContain("text/markdown");
  });

  // Frontmatter is a convention rather than a format, so the list a site
  // writes as a block is the same list as one written inline.
  it("reads a block sequence as the same list", async () => {
    page(`---
title: Kobako
categories:
  - LLM
  - Ruby
---
body`);

    expect(await about(PAGE, budget())).toMatchObject({
      title: "Kobako",
      topics: ["LLM", "Ruby"],
    });
  });

  // A site that answers HTML to a markdown request has still said what the
  // page is about, in the vocabulary schema.org settled.
  it("falls back to what the HTML declares", async () => {
    page(LD_JSON, { type: "text/html" });

    expect(await about(PAGE, budget())).toMatchObject({
      title: "Kobako：為什麼是 Ruby",
      topics: ["LLM", "AI", "Ruby"],
    });
  });

  // schema.org lets one string stand for the list, and writes it with commas.
  it("reads keywords written as one string", async () => {
    page(
      `<script type="application/ld+json">{"@type":"BlogPosting","headline":"Kobako","keywords":"LLM, AI, Ruby"}</script>`,
      { type: "text/html" },
    );

    expect(await about(PAGE, budget())).toMatchObject({
      topics: ["LLM", "AI", "Ruby"],
    });
  });

  // A page that named only itself still named something, and the title is
  // worth more to a reader than the path it would otherwise be known by.
  it("keeps a page that declared only a title", async () => {
    page(`---\ntitle: "Kobako"\ndate: 2026-08-12\n---\nbody`);

    expect(await about(PAGE, budget())).toEqual({
      title: "Kobako",
      topics: [],
    });
  });

  it("answers nothing for a page that declares nothing", async () => {
    page("<html><body>no topics here</body></html>", { type: "text/html" });

    expect(await about(PAGE, budget())).toBeNull();
  });

  it("answers nothing for a page that is not there", async () => {
    page("not found", { status: 404 });

    expect(await about(PAGE, budget())).toBeNull();
  });

  // A published piece keeps saying what it is about, so the second reader pays
  // nothing — including the reader who found nothing, or every unresolvable
  // link in a window would be fetched again on every call.
  it("asks once, whether the page answered or not", async () => {
    page(FRONTMATTER);
    await about(PAGE, budget());
    await about(PAGE, budget());
    expect(accepted).toHaveLength(1);

    await env.CONTENT_CACHE.delete(`piece:1:${PAGE}`);
    accepted = [];
    page("gone", { status: 404 });
    expect(await about(PAGE, budget())).toBeNull();
    expect(await about(PAGE, budget())).toBeNull();
    expect(accepted).toHaveLength(1);
  });

  // The free plan allows fifty external subrequests per invocation, and a
  // redirect spends one of its own. Stopping short leaves a report missing
  // topics; running past it leaves no report at all.
  it("stops asking once the invocation's budget is spent", async () => {
    page(FRONTMATTER);
    const spent = budget();
    spent.spent = 40;

    expect(await about(PAGE, spent)).toBeNull();
    expect(accepted).toHaveLength(0);
  });

  // A cache is not a source of truth, so a namespace that will not answer
  // costs a fetch rather than the report.
  it("still answers when the cache will not", async () => {
    page(FRONTMATTER);
    const cache = env.CONTENT_CACHE;

    try {
      env.CONTENT_CACHE = {
        get: () => Promise.reject(new Error("KV is unavailable")),
        put: () => Promise.reject(new Error("KV is unavailable")),
      } as unknown as KVNamespace;

      expect(await about(PAGE, budget())).toMatchObject({ series: "kobako" });
    } finally {
      env.CONTENT_CACHE = cache;
    }
  });
});
