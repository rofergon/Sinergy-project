import "dotenv/config";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

function defaultAgentDbFile() {
  const candidates = [
    resolve(process.cwd(), "../matcher/data/strategies.sqlite"),
    resolve(process.cwd(), "services/matcher/data/strategies.sqlite"),
    resolve(process.cwd(), "./data/agent-sessions.sqlite")
  ];

  return (
    candidates.find((candidate) => existsSync(dirname(candidate))) ??
    candidates[candidates.length - 1]
  );
}

const envSchema = z.object({
  AGENT_PORT: z.coerce.number().int().positive().default(8790),
  AGENT_MATCHER_URL: z.string().url().default("http://127.0.0.1:8787"),
  AGENT_DB_FILE: z.string().default(defaultAgentDbFile()),
  AGENT_MODEL_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  AGENT_MODEL_NAME: z.string().default("gpt-5.4-nano"),
  AGENT_MODEL_API_KEY: z.string(),
  AGENT_MODEL_REASONING_EFFORT: z.enum(["none", "low", "medium", "high", "xhigh"]).optional(),
  AGENT_MODEL_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  AGENT_MAX_STEPS: z.coerce.number().int().positive().default(6),
  AGENT_TOOLCALL_RETRIES: z.coerce.number().int().nonnegative().default(2),
  // Keep the native LangChain tool loop opt-in until it has broader production coverage.
  AGENT_FORCE_FALLBACK_JSON: z
    .string()
    .optional()
    .transform((value) => value === "1" || value === "true")
    .default(true)
});

export const env = envSchema.parse(process.env);
