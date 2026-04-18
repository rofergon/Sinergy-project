import { ChatOpenAI } from "@langchain/openai";

export type StrategyAgentModelOptions = {
  modelBaseUrl: string;
  modelName: string;
  modelApiKey: string;
  modelReasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
  modelTimeoutMs: number;
};

export type PromptStreamResult = {
  content: string;
  reasoning: string;
};

export type PromptStreamCallbacks = {
  emit: (event:
    | { type: "status"; message: string }
    | { type: "thinking_delta"; text: string }
    | { type: "content_delta"; text: string }) => void;
};

function buildChatModel(
  options: StrategyAgentModelOptions,
  overrides?: {
    timeout?: number;
  }
) {
  return new ChatOpenAI({
    model: options.modelName,
    apiKey: options.modelApiKey,
    configuration: {
      baseURL: options.modelBaseUrl
    },
    timeout: overrides?.timeout ?? options.modelTimeoutMs,
    temperature: 0,
    maxRetries: 0,
    ...(options.modelReasoningEffort ? { reasoning: { effort: options.modelReasoningEffort } } : {})
  });
}

export function createStrategyAgentModels(options: StrategyAgentModelOptions) {
  return {
    model: buildChatModel(options),
    planningModel: buildChatModel(options, {
      timeout: Math.min(options.modelTimeoutMs, 12_000)
    })
  };
}

function consumeTaggedContentChunk(
  state: { mode: "content" | "thinking"; buffer: string },
  chunk: string,
  callbacks?: PromptStreamCallbacks
) {
  state.buffer += chunk;
  let contentDelta = "";
  let thinkingDelta = "";

  while (state.buffer.length > 0) {
    if (state.mode === "content") {
      const thinkIndex = state.buffer.indexOf("<think>");
      if (thinkIndex >= 0) {
        const before = state.buffer.slice(0, thinkIndex);
        if (before) {
          callbacks?.emit({ type: "content_delta", text: before });
          contentDelta += before;
        }
        state.buffer = state.buffer.slice(thinkIndex + "<think>".length);
        state.mode = "thinking";
        continue;
      }

      if (state.buffer.length > 16) {
        const safe = state.buffer.slice(0, -16);
        if (safe) {
          callbacks?.emit({ type: "content_delta", text: safe });
          contentDelta += safe;
        }
        state.buffer = state.buffer.slice(-16);
      }
      break;
    }

    const endThinkIndex = state.buffer.indexOf("</think>");
    if (endThinkIndex >= 0) {
      const thought = state.buffer.slice(0, endThinkIndex);
      if (thought) {
        callbacks?.emit({ type: "thinking_delta", text: thought });
        thinkingDelta += thought;
      }
      state.buffer = state.buffer.slice(endThinkIndex + "</think>".length);
      state.mode = "content";
      continue;
    }

    if (state.buffer.length > 16) {
      const safe = state.buffer.slice(0, -16);
      if (safe) {
        callbacks?.emit({ type: "thinking_delta", text: safe });
        thinkingDelta += safe;
      }
      state.buffer = state.buffer.slice(-16);
    }
    break;
  }

  return { contentDelta, thinkingDelta };
}

export async function streamPromptViaChatCompletions(
  prompt: string,
  options: StrategyAgentModelOptions & {
    stream: PromptStreamCallbacks;
    statusLabel?: string;
    maxTokens?: number;
  }
): Promise<PromptStreamResult> {
  const normalizedBase = options.modelBaseUrl.replace(/\/+$/, "");
  const url = `${normalizedBase}/chat/completions`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.modelApiKey}`
    },
    body: JSON.stringify({
      model: options.modelName,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: options.maxTokens ?? 2048,
      stream: true
    })
  });

  if (!response.ok || !response.body) {
    throw new Error(`Model streaming request failed with HTTP ${response.status}`);
  }

  options.stream.emit({
    type: "status",
    message: options.statusLabel ?? "Waiting for model..."
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";
  let finalContent = "";
  let finalReasoning = "";
  const tagState: { mode: "content" | "thinking"; buffer: string } = {
    mode: "content",
    buffer: ""
  };

  const flushTaggedBuffer = () => {
    if (!tagState.buffer) return;
    if (tagState.mode === "thinking") {
      options.stream.emit({ type: "thinking_delta", text: tagState.buffer });
      finalReasoning += tagState.buffer;
    } else {
      options.stream.emit({ type: "content_delta", text: tagState.buffer });
      finalContent += tagState.buffer;
    }
    tagState.buffer = "";
  };

  while (true) {
    const { done, value } = await reader.read();
    sseBuffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

    let boundaryIndex = sseBuffer.indexOf("\n\n");
    while (boundaryIndex >= 0) {
      const rawEvent = sseBuffer.slice(0, boundaryIndex);
      sseBuffer = sseBuffer.slice(boundaryIndex + 2);

      const data = rawEvent
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");

      if (!data || data === "[DONE]") {
        boundaryIndex = sseBuffer.indexOf("\n\n");
        continue;
      }

      try {
        const payload = JSON.parse(data) as {
          choices?: Array<{
            delta?: {
              content?: string | null;
              reasoning_content?: string | null;
            };
            message?: {
              content?: string | null;
              reasoning_content?: string | null;
            };
          }>;
        };
        const choice = payload.choices?.[0];
        const delta = choice?.delta ?? choice?.message;
        const reasoningChunk = typeof delta?.reasoning_content === "string" ? delta.reasoning_content : "";
        const contentChunk = typeof delta?.content === "string" ? delta.content : "";

        if (reasoningChunk) {
          finalReasoning += reasoningChunk;
          options.stream.emit({ type: "thinking_delta", text: reasoningChunk });
        }

        if (contentChunk) {
          if (reasoningChunk) {
            finalContent += contentChunk;
            options.stream.emit({ type: "content_delta", text: contentChunk });
          } else {
            const tagged = consumeTaggedContentChunk(tagState, contentChunk, options.stream);
            finalContent += tagged.contentDelta;
            finalReasoning += tagged.thinkingDelta;
          }
        }
      } catch {
        // Ignore malformed non-JSON keepalive chunks.
      }

      boundaryIndex = sseBuffer.indexOf("\n\n");
    }

    if (done) {
      break;
    }
  }

  flushTaggedBuffer();

  return {
    content: finalContent,
    reasoning: finalReasoning
  };
}
