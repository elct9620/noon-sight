import { type McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { query } from "./buffer";
import { instants, settled, windows } from "./period";
import { type About, about, budget, onSite } from "./piece";

/**
 * What a post turned out to be, told apart by the link it carried rather than
 * by anything the author declared: a piece of this site, somewhere else worth
 * pointing at, or a thought that stands on its own.
 */
const KINDS = ["article", "link", "note"] as const;

type Kind = (typeof KINDS)[number];

const DEFAULT_DAYS = 28;
const DEFAULT_LIMIT = 15;

/** One page of posts, which is as many as Buffer will answer with at once. */
const PAGE_SIZE = 100;

/** Enough pages to reach the limit at three channels a piece, and no more. */
const PAGES = 3;

/**
 * Copies of one act are written within milliseconds of each other, so what
 * separates two acts is a gap rather than a value. A boundary that fell
 * between two copies would report one thought twice.
 */
const TOGETHER_MS = 5_000;

const DOCUMENT = `query Content($organizationId: OrganizationId!, $first: Int!, $after: String, $start: DateTime!, $end: DateTime!) {
  posts(
    first: $first
    after: $after
    input: {
      organizationId: $organizationId
      filter: { status: [sent], dueAt: { start: $start, end: $end } }
      sort: [{ field: dueAt, direction: desc }]
    }
  ) {
    edges { node { id text dueAt createdAt channelService tags { name } } }
    pageInfo { hasNextPage endCursor }
  }
}`;

type Post = {
  id: string;
  text: string;
  dueAt: string;
  createdAt: string;
  channelService: string;
  tags?: { name: string }[] | null;
};

type Answer = {
  posts: {
    edges: { node: Post }[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

type Input = {
  days?: number;
  until?: string;
  kind?: Kind;
  limit?: number;
};

const inputSchema = fromJsonSchema<Input>({
  type: "object",
  properties: {
    days: {
      type: "integer",
      minimum: 1,
      maximum: 365,
      description: `How many days the window covers, counting back from its last day. Defaults to ${DEFAULT_DAYS}.`,
    },
    until: {
      type: "string",
      pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      description:
        "The last day the window covers, as YYYY-MM-DD. Defaults to the day the traffic reports here end on, so what was published and how it was read cover the same days.",
    },
    kind: {
      type: "string",
      enum: [...KINDS],
      description:
        "Narrow to one kind. `article` carried a link to this site, `link` pointed somewhere else, `note` stood on its own. Omit for all three.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 50,
      description: `How many pieces to answer with, most recent first. Defaults to ${DEFAULT_LIMIT}. Each carries its full text, so a narrower window reads more than a larger limit does.`,
    },
  },
  additionalProperties: false,
});

/** Trailing punctuation belongs to the sentence, not to the address. */
const LINK = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)]/g;

const links = (text: string) => text.match(LINK) ?? [];

const host = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

type Act = {
  posts: Post[];
  /** The first of the copies to go out, which is when the thing was said. */
  at: string;
  page: string | null;
  host: string | null;
};

/**
 * A thought reaches every channel at once, and the copies differ: a thread's
 * opening post is the thought with the rest cut off, and a channel that
 * shortens links leaves the address unreadable. Whichever copy still names the
 * page speaks for all of them, so the act is the unit rather than the post.
 */
const acts = (posts: Post[]): Act[] => {
  const ordered = [...posts].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );

  const together: Post[][] = [];
  let last = -Infinity;

  for (const post of ordered) {
    const at = Date.parse(post.createdAt);

    if (at - last > TOGETHER_MS) together.push([]);
    together[together.length - 1].push(post);
    last = at;
  }

  return together.map((posts) => {
    const found = posts.flatMap(({ text }) => links(text));

    return {
      posts,
      at: posts.reduce(
        (first, { dueAt }) => (dueAt < first ? dueAt : first),
        posts[0].dueAt,
      ),
      page: found.map(onSite).find(Boolean) ?? null,
      host: found.map(host).find(Boolean) ?? null,
    };
  });
};

const kindOf = ({ page, host }: Act): Kind =>
  page ? "article" : host ? "link" : "note";

/**
 * The fullest wording of a thought is the one worth keeping, and how much was
 * said is measured with the addresses taken out: a copy carrying the whole URL
 * would otherwise outweigh the one that actually said more, which is exactly
 * the pair a shortened link produces.
 */
const prose = (text: string) => text.replace(LINK, "").length;

const said = (posts: Post[]) =>
  posts
    .reduce((held, { text }) => (prose(text) > prose(held) ? text : held), "")
    .trim();

const day = (at: string) => at.slice(0, 10);

const item = (act: Act, article: About | null) => {
  const kind = kindOf(act);
  const tags = [
    ...new Set(
      act.posts.flatMap(({ tags }) => tags?.map(({ name }) => name) ?? []),
    ),
  ];

  return {
    publishedAt: day(act.at),
    kind,
    text: said(act.posts),
    channels: [
      ...new Set(act.posts.map(({ channelService }) => channelService)),
    ],
    ...(tags.length ? { tags } : {}),
    ...(act.page ? { page: act.page } : {}),
    ...(kind === "link" && act.host ? { host: act.host } : {}),
    ...(article ? { article } : {}),
  };
};

/**
 * Buffer answers a page at a time and an act spans as many posts as it reached
 * channels, so enough pages are read to fill the limit rather than a fixed
 * number of posts.
 */
const published = async (start: string, end: string, limit: number) => {
  const held: Post[] = [];
  let after: string | null = null;

  for (let page = 0; page < PAGES; page += 1) {
    const { posts }: Answer = await query<Answer>(DOCUMENT, {
      first: PAGE_SIZE,
      after,
      start,
      end,
    });

    held.push(...posts.edges.map(({ node }) => node));

    // A page that says there is more but names no cursor would be asked for
    // again, and the same posts arriving twice is a piece reported twice.
    if (!posts.pageInfo.hasNextPage || !posts.pageInfo.endCursor) break;
    if (acts(held).length >= limit) break;

    after = posts.pageInfo.endCursor;
  }

  return held;
};

export const registerContentReport = (server: McpServer) =>
  server.registerTool(
    "content_report",
    {
      title: "Content report",
      description:
        "Report what was published through Buffer in a window, as the posts themselves rather than as counts. This is the only source here that says what a site is about rather than how it was read: every other tool starts once somebody arrived, and none of them can see a thought that was never written up as an article. Each piece carries its full text, the channels it reached, the tags it was filed under, and — where it linked to this site — what that page declares itself to be about. Whether it drew anyone is a separate question the traffic reports answer, so read them side by side rather than expecting a number here. Only what went through Buffer is visible, so anything posted straight to a network is absent, and a channel that shortens links leaves its copy's destination unreadable — a piece promoted on no other channel is reported as a link to the shortener rather than as an article.",
      inputSchema,
    },
    async ({ days = DEFAULT_DAYS, until, kind, limit = DEFAULT_LIMIT }) => {
      const [period] = windows(until ?? settled(), days);
      const { from, to } = instants(period);

      const posts = await published(
        new Date(from).toISOString(),
        // The window's last day counts whole, and Buffer reads the end as
        // inclusive rather than as the midnight after it.
        new Date(to - 1).toISOString(),
        limit,
      );

      const chosen = acts(posts)
        .filter((act) => !kind || kindOf(act) === kind)
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
        .slice(0, limit);

      const spend = budget();
      const items = [];
      let unresolved = 0;

      for (const act of chosen) {
        const article = act.page ? await about(act.page, spend) : null;

        if (act.page && !article) unresolved += 1;
        items.push(item(act, article));
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              period: { startDate: period.startDate, endDate: period.endDate },
              items,
              // Saying nothing here would read as every piece having been
              // read, which is the one thing an empty answer must not mean.
              ...(unresolved ? { unresolved } : {}),
            }),
          },
        ],
      };
    },
  );
