import { env } from "cloudflare:workers";

/** One endpoint answers every dataset; the document says which. */
const GRAPHQL_API = "https://api.cloudflare.com/client/v4/graphql";

/**
 * The dataset every figure here comes from. Named once because the probe and
 * the report have to ask about the same one, or the limits the probe reports
 * would size windows for a dataset nobody reads.
 */
export const DATASET = "httpRequestsAdaptiveGroups";

const LIMITS = `query Limits($zoneTag: string) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      settings {
        ${DATASET} { enabled notOlderThan maxDuration }
      }
    }
  }
}`;

/**
 * How far back this zone will answer, and how wide one query may be. Both move
 * with the plan the zone is on, which is why they are asked for rather than
 * written down: a constant would keep a zone that grew reading as if it had not.
 */
export type Limits = {
  enabled: boolean;
  notOlderThan: number;
  maxDuration: number;
};

type Answer<T> = {
  data?: { viewer?: { zones?: T[] } } | null;
  errors?: { message?: string }[] | null;
};

/**
 * Every question here is asked of one zone, so the zone is named for the caller
 * and unwrapped again on the way back.
 *
 * A refusal arrives as `200` with an `errors` array — the status alone says
 * nothing — so both are read. Cloudflare says why in the same shape either way,
 * and the caller has already passed Access, so the sentence travels rather than
 * being swallowed: one refusal covers a token without the permission, a field
 * the plan does not carry, and a window wider than it allows.
 */
export const query = async <T>(
  document: string,
  variables: Record<string, unknown> = {},
): Promise<T> => {
  if (!env.CLOUDFLARE_API_TOKEN) {
    throw new Error("No Cloudflare API token is configured");
  }

  if (!env.CLOUDFLARE_ZONE_ID) {
    throw new Error("No Cloudflare zone is configured");
  }

  const response = await fetch(GRAPHQL_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: document,
      // The zone is named last so no caller can spell it differently.
      variables: { ...variables, zoneTag: env.CLOUDFLARE_ZONE_ID },
    }),
  });

  const body = await response.text();
  let answer: Answer<T> | undefined;

  try {
    answer = JSON.parse(body);
  } catch {
    // An edge answering HTML carries no `errors` array, and then the body is
    // already the most useful thing there is.
  }

  const said = answer?.errors
    ?.map(({ message }) => message)
    .filter(Boolean)
    .join("; ");

  if (said || !response.ok) {
    throw new Error(
      `Cloudflare refused the request (${response.status}): ${said || body}`,
    );
  }

  const zone = answer?.data?.viewer?.zones?.[0];

  if (!zone) {
    throw new Error("Cloudflare answered for no zone; check the zone id");
  }

  return zone;
};

export const limits = async (): Promise<Limits> => {
  const { settings } = await query<{ settings: Record<string, Limits> }>(
    LIMITS,
  );
  const found = settings?.[DATASET];

  // Without the dataset there is no report to size, and the arithmetic would
  // otherwise run on nulls and answer with dates nobody asked for.
  if (!found?.enabled) {
    throw new Error(`This zone cannot read ${DATASET}`);
  }

  return found;
};
