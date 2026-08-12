/**
 * Every report answers for a period and the equally long one before it, so a
 * row reads as a change rather than as a number.
 *
 * Google Analytics takes these two as the names of its date ranges and echoes
 * them back on every row. Search Console has no such echo — it answers one
 * window per request — so there they are only what this server calls the two
 * it asked for. Naming them once keeps a client from meeting two vocabularies
 * for the same pair.
 */
export const CURRENT = "current";
export const PREVIOUS = "previous";

/**
 * Search Console finalises a day roughly three days after it, and Analytics
 * has no such lag. The anchor is still shared: two reports whose windows differ
 * cannot be read side by side, and reading them together is the whole reason
 * for carrying both sources. A caller who wants the fresher Analytics days back
 * says so with `until`.
 */
const LAG_DAYS = 3;

const DAY_MS = 86_400_000;

const iso = (at: number) => new Date(at).toISOString().slice(0, 10);

/** Days counted rather than calendar arithmetic, so a month boundary is uneventful. */
const before = (date: string, days: number) =>
  iso(Date.parse(`${date}T00:00:00Z`) - days * DAY_MS);

export const today = () => iso(Date.now());

/** The most recent day a source is expected to have finished counting. */
export const settled = () => iso(Date.now() - LAG_DAYS * DAY_MS);

/**
 * A source counting at the edge has no such lag, and waiting for one would
 * spend days of a window it can only reach back a week into. The last whole
 * day is the freshest one it can answer for completely.
 */
export const yesterday = () => iso(Date.now() - DAY_MS);

/**
 * Both ends are inclusive, which is how each API reads a date range: a 28-day
 * window ends on the anchor and starts 27 days earlier, and the window before
 * it ends the day before that — abutting, never overlapping.
 */
/**
 * Read as instants for a source that filters on them rather than on dates. The
 * upper bound is exclusive there, so the day a window ends on is only counted
 * when the range runs to the midnight after it.
 */
export const instants = ({
  startDate,
  endDate,
}: {
  startDate: string;
  endDate: string;
}) => ({
  from: Date.parse(`${startDate}T00:00:00Z`),
  to: Date.parse(`${endDate}T00:00:00Z`) + DAY_MS,
});

export const windows = (until: string, days: number) => [
  { name: CURRENT, startDate: before(until, days - 1), endDate: until },
  {
    name: PREVIOUS,
    startDate: before(until, days * 2 - 1),
    endDate: before(until, days),
  },
];
