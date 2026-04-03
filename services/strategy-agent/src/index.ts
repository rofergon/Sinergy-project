import Fastify from "fastify";
import cors from "@fastify/cors";
import { env } from "./config/env.js";
import { StrategyAgentService } from "./services/strategyAgent.js";
import { agentStrategyRequestSchema } from "./types.js";

const agentService = new StrategyAgentService({
  matcherUrl: env.AGENT_MATCHER_URL,
  modelBaseUrl: env.AGENT_MODEL_BASE_URL,
  modelName: env.AGENT_MODEL_NAME,
  modelApiKey: env.AGENT_MODEL_API_KEY,
  modelTimeoutMs: env.AGENT_MODEL_TIMEOUT_MS,
  maxSteps: env.AGENT_MAX_STEPS,
  toolcallRetries: env.AGENT_TOOLCALL_RETRIES,
  forceFallbackJson: env.AGENT_FORCE_FALLBACK_JSON
});

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

app.get("/agent/health", async () => await agentService.getHealth());
app.get("/agent/capabilities", async () => await agentService.getCapabilities());

app.post("/agent/strategy/plan", async (request, reply) => {
  const parsed = agentStrategyRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    reply.code(422);
    return {
      ok: false,
      error: {
        message: "Invalid agent plan request.",
        issues: parsed.error.issues
      }
    };
  }
  return {
    ok: true,
    result: await agentService.plan({
      ...parsed.data,
      mode: "plan"
    })
  };
});

app.post("/agent/strategy/run", async (request, reply) => {
  const parsed = agentStrategyRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    reply.code(422);
    return {
      ok: false,
      error: {
        message: "Invalid agent run request.",
        issues: parsed.error.issues
      }
    };
  }
  return {
    ok: true,
    result: await agentService.run({
      ...parsed.data,
      mode: "run"
    })
  };
});

app.listen({ host: "0.0.0.0", port: env.AGENT_PORT });
