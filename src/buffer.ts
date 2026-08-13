import { env } from "cloudflare:workers";

/** One endpoint answers every query; the document says what is being asked. */
const GRAPHQL_API = "https://api.buffer.com";

/** The one refusal a caller can act on rather than only report. */
const RATE_LIMITED = "RATE_LIMIT_EXCEEDED";

type Failure = {
  message?: string;
  extensions?: { code?: string; window?: string };
};

type Answer<T> = {
  data?: T | null;
  errors?: Failure[] | null;
};

/**
 * A rate limit names the window it spent — fifteen minutes, a day, a month —
 * and how long to wait, and the two arrive in different places. Neither is
 * worth much alone: the seconds say when to come back, the window says whether
 * coming back at all is the answer.
 */
const limited = (response: Response, errors: Failure[]) => {
  const spent = errors.find(
    ({ extensions }) => extensions?.code === RATE_LIMITED,
  )?.extensions?.window;

  if (!spent) return "";

  const after = response.headers.get("Retry-After");

  return ` (the ${spent} window is spent${after ? `; retry in ${after}s` : ""})`;
};

/**
 * Every question here is asked of one organization, so it is named for the
 * caller rather than repeated at each call site.
 *
 * A refusal arrives as `200` with an `errors` array as readily as with a
 * status, so both are read. Buffer says why in the same shape either way, and
 * the caller has already passed Access, so the sentence travels rather than
 * being swallowed: one refusal covers a key without the scope, a field the
 * plan does not carry, and a window whose requests are already spent.
 */
export const query = async <T>(
  document: string,
  variables: Record<string, unknown> = {},
): Promise<T> => {
  if (!env.BUFFER_API_KEY) {
    throw new Error("No Buffer API key is configured");
  }

  if (!env.BUFFER_ORGANIZATION_ID) {
    throw new Error("No Buffer organization is configured");
  }

  const response = await fetch(GRAPHQL_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.BUFFER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: document,
      // The organization is named last so no caller can spell it differently.
      variables: { ...variables, organizationId: env.BUFFER_ORGANIZATION_ID },
    }),
  });

  const body = await response.text();
  let answer: Answer<T> | undefined;

  try {
    answer = JSON.parse(body);
  } catch {
    // A gateway answering HTML carries no `errors` array, and then the body is
    // already the most useful thing there is.
  }

  const failures = answer?.errors ?? [];
  const said = failures
    .map(({ message }) => message)
    .filter(Boolean)
    .join("; ");

  if (said || !response.ok) {
    throw new Error(
      `Buffer refused the request (${response.status}): ${said || body}${limited(response, failures)}`,
    );
  }

  // Every refusal Buffer has a name for arrives above, so reaching here means
  // an answer shaped like neither. Naming a likely cause would be inventing
  // one; saying what arrived is all this can honestly do.
  if (!answer?.data) {
    throw new Error("Buffer answered with neither data nor a reason");
  }

  return answer.data;
};
