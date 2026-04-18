import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StrategyAgentService } from "./strategyAgent.js";

test("getCapabilities falls back to local catalog when matcher catalog is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  const tempDir = mkdtempSync(join(tmpdir(), "strategy-agent-capabilities-"));

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);

    if (url === "http://model.test/health") {
      return new Response("missing", { status: 404 });
    }

    if (url === "http://model.test/v1/models") {
      return new Response(JSON.stringify({
        data: [{ id: "gpt-test" }]
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }

    if (url === "http://matcher.test/strategy-tools/catalog") {
      throw new Error("matcher down");
    }

    throw new Error(`Unexpected fetch: ${url} ${init?.method ?? "GET"}`);
  }) as typeof fetch;

  try {
    const service = new StrategyAgentService({
      matcherUrl: "http://matcher.test",
      sessionDbFile: join(tempDir, "sessions.sqlite"),
      modelBaseUrl: "http://model.test/v1",
      modelName: "gpt-test",
      modelApiKey: "test-key",
      modelTimeoutMs: 2_000,
      maxSteps: 4,
      toolcallRetries: 0,
      forceFallbackJson: true
    });

    const result = await service.getCapabilities();

    assert.equal(result.model.reachable, true);
    assert.equal(result.tools.length > 0, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
