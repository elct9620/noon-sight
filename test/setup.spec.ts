import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { server } from "./setup";

// MSW intercepts by patching the runtime's own `fetch`, which workerd provides
// rather than Node. Nothing else in the suite states that this holds, so a
// runtime that stops supporting it would otherwise surface as every Google
// test failing at once for an unrelated-looking reason.
describe("outbound request mocking", () => {
  it("answers a request from a handler instead of the network", async () => {
    server.use(
      http.get("https://example.test/ping", () =>
        HttpResponse.json({ pong: true }),
      ),
    );

    const response = await fetch("https://example.test/ping");

    expect(await response.json()).toEqual({ pong: true });
  });
});
