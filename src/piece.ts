import { env } from "cloudflare:workers";

/**
 * What a page says it is about. Every field is optional because a site owes
 * none of them: a page that declares nothing is still a page, and reporting it
 * with no topics says more than leaving it out would.
 */
export type About = {
  title?: string;
  topics: string[];
  series?: string;
  language?: string;
};

/**
 * The version travels in the key so that changing what is stored expires the
 * old shape at once. Without it a field added here would read as absent for as
 * long as the entry lives, which is a silent under-report rather than a miss.
 */
const key = (page: string) => `piece:1:${page}`;

/** A published piece keeps saying what it is about; a month bounds being wrong. */
const KEPT_SECONDS = 2_592_000;

/** A page that answered nothing is asked again sooner, but not every call. */
const MISSING_SECONDS = 86_400;

/** Staleness is the point here, so reads are allowed to stop at the edge. */
const READ_TTL = 86_400;

/**
 * Workers Free allows fifty external subrequests per invocation. What is
 * counted here is pages asked for; the ten left below fifty are what absorbs
 * the hops a redirect adds and the requests the source itself spends, neither
 * of which this can see. Stopping short leaves a report missing some topics;
 * running past it leaves no report at all.
 */
const EXTERNAL_FETCHES = 40;

export type Budget = { spent: number };

export const budget = (): Budget => ({ spent: 0 });

/**
 * The path this URL names on the site this server answers for, or null for
 * anywhere else. Without a site configured nothing is on it: guessing would
 * make every shared link look like this site's own.
 */
export const onSite = (url: string): string | null => {
  if (!env.CLOUDFLARE_SITE_HOST) return null;

  try {
    const { hostname, pathname } = new URL(url);

    return hostname === env.CLOUDFLARE_SITE_HOST ? pathname : null;
  } catch {
    return null;
  }
};

/** A quoted string and a JSON list are both already JSON; anything else is itself. */
const value = (raw: string) => {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

/** schema.org lets one string stand for a list, and writes it with commas. */
const list = (held: unknown): string[] => {
  if (Array.isArray(held)) return held.map(String);
  if (!held) return [];

  return String(held)
    .split(",")
    .map((one) => one.trim())
    .filter(Boolean);
};

/**
 * Frontmatter is a convention rather than a format, so only the shape every
 * generator agrees on is read: `key: value` between the fences, and the block
 * sequence some sites write a list as instead of an inline one.
 */
const frontmatter = (body: string): Record<string, unknown> | null => {
  const fenced = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body);
  if (!fenced) return null;

  const held: Record<string, unknown> = {};
  let sequence: string | null = null;

  for (const line of fenced[1].split(/\r?\n/)) {
    const item = /^\s*-\s+(.*)$/.exec(line);

    if (item && sequence) {
      (held[sequence] as unknown[]).push(value(item[1].trim()));
      continue;
    }

    const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!pair) continue;

    const [, name, raw] = pair;

    if (raw.trim()) {
      held[name] = value(raw.trim());
      sequence = null;
    } else {
      held[name] = [];
      sequence = name;
    }
  }

  return held;
};

/** What schema.org settled on, for a site that answers HTML to either request. */
const linkedData = (body: string): Record<string, unknown> | null => {
  for (const [, json] of body.matchAll(
    /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g,
  )) {
    try {
      const parsed = JSON.parse(json);
      const found = [parsed]
        .flat()
        .find((entry) => entry?.keywords || entry?.headline);

      if (found) return found;
    } catch {
      // One unreadable block says nothing about the next.
    }
  }

  return null;
};

const read = (body: string, type: string): About | null => {
  const declared = type.includes("markdown")
    ? frontmatter(body)
    : linkedData(body);

  if (!declared) return null;

  const topics = list(
    declared.tags ?? declared.categories ?? declared.keywords,
  );
  const title = declared.title ?? declared.headline;
  const series = declared.series;
  const language = declared.language ?? declared.lang;

  // A page that declared nothing at all is reported as having declared
  // nothing. One that named only itself still named something, and a title is
  // worth more to a reader than the path it would otherwise be known by.
  if (!topics.length && !series && !title) return null;

  return {
    ...(title ? { title: String(title) } : {}),
    topics,
    ...(series ? { series: String(series) } : {}),
    ...(language ? { language: String(language) } : {}),
  };
};

/**
 * A cache is not a source of truth, so a namespace that will not answer costs
 * a fetch rather than the report.
 */
const held = async (page: string): Promise<About | null | undefined> => {
  try {
    const raw = await env.CONTENT_CACHE.get(key(page), { cacheTtl: READ_TTL });

    // A miss and a page known to declare nothing are both null on the way out,
    // so the second is stored as one and told apart on the way in.
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
};

const keep = async (page: string, found: About | null) => {
  try {
    await env.CONTENT_CACHE.put(key(page), JSON.stringify(found), {
      expirationTtl: found ? KEPT_SECONDS : MISSING_SECONDS,
    });
  } catch {
    // Losing the write costs the next reader a fetch, and nothing else.
  }
};

/**
 * What a page on this site says it is about, asked for once and then held.
 *
 * Markdown is asked for first because a site that offers it has already done
 * the parsing: frontmatter is the answer in fields, where HTML is the answer
 * buried in a page four times the size. Neither is this site's own arrangement
 * — a generator that offers only one of them still answers.
 */
export const about = async (
  page: string,
  budget: Budget,
): Promise<About | null> => {
  const cached = await held(page);
  if (cached !== undefined) return cached;

  if (budget.spent >= EXTERNAL_FETCHES) return null;
  budget.spent += 1;

  const response = await fetch(`https://${env.CLOUDFLARE_SITE_HOST}${page}`, {
    headers: { Accept: "text/markdown, text/html;q=0.9" },
  });

  const found = response.ok
    ? read(
        await response.text(),
        response.headers.get("Content-Type") ?? "text/html",
      )
    : null;

  await keep(page, found);

  return found;
};
