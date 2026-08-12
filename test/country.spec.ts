import { describe, expect, it } from "vitest";
import { alpha2, alpha3 } from "../src/country";

describe("alpha2", () => {
  it("reads the lowercase three-letter codes Search Console answers in", () => {
    expect(alpha2("twn")).toBe("TW");
    expect(alpha2("usa")).toBe("US");
    expect(alpha2("hkg")).toBe("HK");
  });

  // Both turn up in real search data and both are territories Analytics also
  // names, so the codes ISO set aside for private use are carried rather than
  // treated as noise: `zzz` is the region Google could not determine, and `xkk`
  // is Kosovo, which has no assigned code at all.
  it("carries the privately assigned codes that real data contains", () => {
    expect(alpha2("zzz")).toBe("ZZ");
    expect(alpha2("xkk")).toBe("XK");
  });

  // A country the table has never heard of still had visitors. Dropping the row
  // would lose them and inventing a code would file them under someone else, so
  // the code is repeated as it arrived.
  it("repeats a code it does not know", () => {
    expect(alpha2("abc")).toBe("ABC");
  });
});

describe("alpha3", () => {
  it("writes the spelling Search Console filters on", () => {
    expect(alpha3("TW")).toBe("TWN");
    expect(alpha3("de")).toBe("DEU");
  });

  // Search Console answers an alpha-2 filter with an empty result and no error,
  // so a code that cannot be translated has to be refused here — otherwise it
  // reads as a country that had no traffic at all.
  it("refuses a code it cannot translate rather than filtering on nothing", () => {
    expect(() => alpha3("AB")).toThrow("AB");
  });
});
