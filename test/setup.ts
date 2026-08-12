import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll } from "vitest";

/**
 * Outbound requests are answered here rather than on the network. Every test
 * shares one server and declares its own handlers, so a handler one test
 * installs cannot leak into the next.
 */
export const server = setupServer();

// An unmocked request is a test that would silently reach Google with whatever
// credentials the runtime happens to hold, so it fails instead.
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
