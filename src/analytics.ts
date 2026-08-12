import { accessToken, refusal } from "./google";
import { CURRENT, PREVIOUS } from "./period";

const DATA_API = "https://analyticsdata.googleapis.com/v1beta";

/**
 * Google adds this dimension to every row, carrying the name the request gave
 * the date range, so it is how a row says which period it belongs to.
 */
const PERIOD_DIMENSION = "dateRange";

type Header = { name: string };

type ReportRow = {
  dimensionValues: { value: string }[];
  metricValues: { value: string }[];
};

export type Report = {
  dimensionHeaders?: Header[];
  metricHeaders?: Header[];
  rows?: ReportRow[];
};

type Periods = {
  current: Record<string, number>;
  previous: Record<string, number>;
};

/** A dimension value per breakdown, and the same metrics for both periods. */
export type ComparedRow = Periods & Record<string, unknown>;

export const runReport = async (
  propertyId: string,
  request: unknown,
): Promise<Report> => {
  const response = await fetch(
    `${DATA_API}/properties/${propertyId}:runReport`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    },
  );

  if (!response.ok) {
    throw new Error(
      await refusal(response, "Google Analytics refused the report"),
    );
  }

  return response.json<Report>();
};

/**
 * The API answers a table addressed by column position — headers on one side,
 * bare values on the other, and one row per period. Reading that is the
 * caller's work only if we hand it over, so it is folded here into one row per
 * breakdown carrying both periods.
 *
 * A breakdown present in only one period still gets both, the absent side
 * reading zero, because a channel that appeared or vanished is exactly what
 * the comparison exists to show.
 */
export const compare = (report: Report): ComparedRow[] => {
  const dimensions = (report.dimensionHeaders ?? []).map(({ name }) => name);
  const metrics = (report.metricHeaders ?? []).map(({ name }) => name);
  const periodAt = dimensions.indexOf(PERIOD_DIMENSION);

  const zeroed = () => Object.fromEntries(metrics.map((name) => [name, 0]));
  const folded = new Map<
    string,
    { breakdown: Record<string, string> } & Periods
  >();

  for (const row of report.rows ?? []) {
    const values = row.dimensionValues.map(({ value }) => value);
    const breakdown = Object.fromEntries(
      dimensions.flatMap((name, at) =>
        at === periodAt ? [] : [[name, values[at]]],
      ),
    );

    const key = JSON.stringify(breakdown);
    const compared = folded.get(key) ?? {
      breakdown,
      current: zeroed(),
      previous: zeroed(),
    };
    folded.set(key, compared);

    const period = values[periodAt] === PREVIOUS ? PREVIOUS : CURRENT;
    metrics.forEach((name, at) => {
      compared[period][name] = Number(row.metricValues[at]?.value ?? 0);
    });
  }

  // The breakdown is grouped on while folding and spread on the way out, so a
  // caller reads `{ channel, current, previous }` rather than a nested key.
  return [...folded.values()].map(({ breakdown, ...periods }) => ({
    ...breakdown,
    ...periods,
  }));
};
