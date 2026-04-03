type ModelInfo = {
  reachable: boolean;
  healthOk: boolean;
  models: string[];
  chatOk: boolean;
  toolCallingObserved: boolean;
};

export async function probeModel(baseUrl: string, model: string): Promise<ModelInfo> {
  const normalized = baseUrl.replace(/\/$/, "");
  const result: ModelInfo = {
    reachable: false,
    healthOk: false,
    models: [],
    chatOk: false,
    toolCallingObserved: false
  };

  const healthResponse = await fetch(`${normalized.replace(/\/v1$/, "")}/health`).catch(() => null);
  if (healthResponse?.ok) {
    result.healthOk = true;
  }

  const modelsResponse = await fetch(`${normalized}/models`).catch(() => null);
  if (modelsResponse?.ok) {
    const payload = (await modelsResponse.json()) as {
      data?: Array<{ id?: string }>;
      models?: Array<{ model?: string; name?: string }>;
    };
    result.reachable = true;
    result.models = [
      ...(payload.data?.map((item) => item.id).filter(Boolean) ?? []),
      ...(payload.models?.map((item) => item.model ?? item.name).filter(Boolean) ?? [])
    ] as string[];
  }

  const chatResponse = await fetch(`${normalized}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Respond with exactly ok" }],
      temperature: 0,
      max_tokens: 8
    })
  }).catch(() => null);

  if (chatResponse?.ok) {
    result.chatOk = true;
  }

  const toolsResponse = await fetch(`${normalized}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Call the ping tool." }],
      temperature: 0,
      max_tokens: 64,
      tools: [
        {
          type: "function",
          function: {
            name: "ping",
            description: "Return pong",
            parameters: {
              type: "object",
              properties: {},
              additionalProperties: false
            }
          }
        }
      ],
      tool_choice: "auto"
    })
  }).catch(() => null);

  if (toolsResponse?.ok) {
    const payload = (await toolsResponse.json()) as {
      choices?: Array<{
        message?: {
          tool_calls?: unknown[];
        };
      }>;
    };
    result.toolCallingObserved = Boolean(payload.choices?.[0]?.message?.tool_calls?.length);
  }

  return result;
}
