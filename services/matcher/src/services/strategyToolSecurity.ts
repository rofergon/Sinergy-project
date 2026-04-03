import { STRATEGY_API_VERSION, STRATEGY_TOOL_LIMITS, type StrategyToolName } from "@sinergy/shared";

export class StrategyToolError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode = 400,
    readonly details?: Record<string, unknown>,
    readonly retryable = false
  ) {
    super(message);
    this.name = "StrategyToolError";
  }
}

type RateLimitEntry = {
  windowStart: number;
  count: number;
};

export class StrategyToolRateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();

  check(tool: StrategyToolName, ownerAddress: string) {
    const now = Date.now();
    const key = `${tool}:${ownerAddress.toLowerCase()}`;
    const current = this.entries.get(key);

    if (!current || now - current.windowStart >= 60_000) {
      this.entries.set(key, { windowStart: now, count: 1 });
      return;
    }

    if (current.count >= STRATEGY_TOOL_LIMITS.requestsPerMinutePerOwnerPerTool) {
      throw new StrategyToolError(
        "Rate limit exceeded for this strategy tool and owner.",
        "rate_limit_exceeded",
        429,
        {
          tool,
          limit: STRATEGY_TOOL_LIMITS.requestsPerMinutePerOwnerPerTool,
          windowMs: 60_000
        },
        true
      );
    }

    current.count += 1;
  }
}

export function makeStrategyToolMeta(tool: string) {
  return {
    apiVersion: STRATEGY_API_VERSION,
    tool,
    requestId: crypto.randomUUID(),
    timestamp: new Date().toISOString()
  };
}

export function toStrategyToolErrorPayload(error: unknown, fallbackTool: string) {
  if (error instanceof StrategyToolError) {
    return {
      statusCode: error.statusCode,
      body: {
        ok: false as const,
        meta: makeStrategyToolMeta(fallbackTool),
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
          retryable: error.retryable
        }
      }
    };
  }

  return {
    statusCode: 500,
    body: {
      ok: false as const,
      meta: makeStrategyToolMeta(fallbackTool),
      error: {
        code: "internal_error",
        message: error instanceof Error ? error.message : "Unexpected strategy tool failure.",
        retryable: false
      }
    }
  };
}
