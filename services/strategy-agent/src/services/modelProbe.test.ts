import test from "node:test";
import assert from "node:assert/strict";
import { probeModel } from "./modelProbe.js";

test("passive probe avoids chat completions and uses auth for models", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });

    if (url.endsWith("/health")) {
      return new Response("missing", { status: 404 });
    }

    if (url.endsWith("/models")) {
      return new Response(JSON.stringify({
        data: [{ id: "gpt-test" }]
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }

    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  try {
    const result = await probeModel("https://example.test/v1", "gpt-test", {
      apiKey: "test-key"
    });

    assert.equal(result.reachable, true);
    assert.equal(result.healthOk, true);
    assert.deepEqual(result.models, ["gpt-test"]);
    assert.equal(result.chatOk, false);
    assert.equal(result.toolCallingObserved, false);
    assert.equal(calls.some((call) => call.url.endsWith("/chat/completions")), false);
    assert.equal(
      (calls.find((call) => call.url.endsWith("/models"))?.init?.headers as Record<string, string> | undefined)
        ?.Authorization,
      "Bearer test-key"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
