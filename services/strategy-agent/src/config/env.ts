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
  AGENT_MODEL_BASE_URL: z.string().url().default("http://127.0.0.1:18002/v1"),
  AGENT_MODEL_NAME: z.string().default("Qwen3.5-35B-A3B-UD-Q4_K_XL.gguf"),
  AGENT_MODEL_API_KEY: z.string().default("dummy"),
  AGENT_MODEL_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),
  AGENT_MAX_STEPS: z.coerce.number().int().positive().default(12),
  AGENT_TOOLCALL_RETRIES: z.coerce.number().int().nonnegative().default(2),
  AGENT_FORCE_FALLBACK_JSON: z
    .string()
    .optional()
    .transform((value) => value === "1" || value === "true")
    .default(false)
});

export const env = envSchema.parse(process.env);
