import test from "node:test";
import assert from "node:assert/strict";
import { streamPromptViaChatCompletions } from "./modelRuntime.js";

test("streamPromptViaChatCompletions omits temperature and uses max_completion_tokens for GPT-5 class requests", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | null = null;

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n')
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream"
      }
    });
  }) as typeof fetch;

  try {
    const result = await streamPromptViaChatCompletions("hello", {
      modelBaseUrl: "https://api.openai.com/v1",
      modelName: "gpt-5.4-nano",
      modelApiKey: "test-key",
      modelReasoningEffort: "low",
      modelTimeoutMs: 5_000,
      stream: {
        emit() {
          // no-op
        }
      }
    });

    assert.equal(result.content, "ok");
    assert.equal(result.reasoning, "");
    assert.equal(Object.prototype.hasOwnProperty.call(requestBody ?? {}, "temperature"), false);
    const body = (requestBody ?? {}) as Record<string, unknown>;
    assert.equal(body.max_completion_tokens, 2048);
    assert.equal(Object.prototype.hasOwnProperty.call(body, "max_tokens"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
