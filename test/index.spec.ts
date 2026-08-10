import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

describe("worker", () => {
  it("responds on the root path", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("http://localhost/"),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Hello Hono!");
  });
});
