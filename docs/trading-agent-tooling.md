# Trading Agent and strategy tooling

This document explains how Sinergy's trading/strategy agent works, which tools it can use, how it communicates with the `matcher`, and which areas matter most when operating or extending it.

## Summary

The agent lives in `services/strategy-agent` and exposes a Fastify HTTP API under `/agent/*`. Its job is not to place live orders: it interprets a user goal, creates or modifies strategies, validates the payload, and runs backtests through a closed set of tools served by the `matcher`.

The main flow is:

1. The frontend `apps/web` sends a request to the agent with `ownerAddress`, `marketId`, timeframe/chart context, `goal`, and optionally `sessionId`/`strategyId`.
2. The agent decides the next steps with an OpenAI-compatible model, or uses deterministic/model-guided fast paths for creation, modification, or optimization.
3. Every tool call is transported over HTTP to the `matcher` at `POST /strategy-tools/:tool`.
4. The `matcher` validates input with Zod, applies rate limiting per owner/tool, calls `StrategyService`, and returns an envelope `{ ok, meta, result }`.
5. The agent keeps traces, artifacts (`strategyId`, `runId`, backtest summary, validation), and session turns in SQLite.

## Components

| Component | Path | Responsibility |
| --- | --- | --- |
| Agent API | `services/strategy-agent/src/index.ts` | Fastify, CORS, `/agent/*` endpoints, SSE for streaming runs. |
| Agent service | `services/strategy-agent/src/services/strategyAgent.ts` | Orchestration, fast paths, fallback JSON loop, native LangChain tool agent, guardrails, and session persistence. |
| Tool runtime | `services/strategy-agent/src/services/strategyToolRuntime.ts` | Converts shared tools into LangChain tools, injects context, records traces, and updates runtime state. |
| Tool policy | `services/strategy-agent/src/services/agentToolPolicy.ts` | Filters which tools are allowed for the agent. It currently blocks `delete_strategy`. |
| Fallback runtime | `services/strategy-agent/src/services/fallbackRuntime.ts` | Step-by-step JSON loop when native tool calling is not used or fails. |
| Session store | `services/strategy-agent/src/services/sessionStore.ts` | Stores sessions, turns, tool traces, metrics, and artifacts in SQLite. |
| Shared tool contract | `packages/shared/src/strategy-tools/*` | Definitions, strict schemas, HTTP transport, and limits. |
| Matcher tool API | `services/matcher/src/services/strategyToolApi.ts` | Dispatches each tool to `StrategyService`. |
| Strategy service | `services/matcher/src/services/strategyService.ts` | Capabilities, templates, drafts, validation, compilation, and backtesting. |
| Web UI | `apps/web/src/components/StrategyAgentPanel.tsx` | Chat/plan/run UI, SSE handling, session history, and result rendering. |

## Agent API

The entrypoint `services/strategy-agent/src/index.ts` creates `StrategyAgentService` with `AGENT_*` variables and listens on `AGENT_PORT` (`8790` by default).

Endpoints:

| Method | Route | Use |
| --- | --- | --- |
| `GET` | `/agent/health` | Checks the model and the matcher's `/health`. |
| `GET` | `/agent/capabilities` | Returns the model, runtime config, and the allowed tool catalog. |
| `GET` | `/agent/sessions?ownerAddress=&marketId=&limit=` | Lists recent sessions for an owner. |
| `GET` | `/agent/sessions/:sessionId?ownerAddress=` | Fetches a session and refreshes the strategy snapshot when applicable. |
| `GET` | `/agent/sessions/:sessionId/diagnostics?ownerAddress=` | Returns the mode used and the latest run metrics. |
| `POST` | `/agent/strategy/plan` | Plan mode: does not execute tools, only returns suggested steps. |
| `POST` | `/agent/strategy/run` | Executes the full workflow without streaming. |
| `POST` | `/agent/strategy/run/stream` | Executes the workflow with SSE: `status`, `thinking_delta`, `content_delta`, `tool`, `tool_progress`, `done`, `error`. |

Main input (`agentStrategyRequestSchema`):

```json
{
  "ownerAddress": "0x...",
  "goal": "create an EMA strategy and run a backtest",
  "marketId": "0x...",
  "preferredTimeframe": "15m",
  "chartBars": 8640,
  "chartFromTs": 1710000000,
  "chartToTs": 1719999999,
  "strategyId": "optional-uuid",
  "sessionId": "optional-uuid",
  "mode": "run"
}
```

`ownerAddress` must be a 20-byte hex address, `marketId` must be a 32-byte hex identifier, and `chartFromTs/chartToTs` must be provided together.

## Configuration

Example file: `services/strategy-agent/.env.example`.

Main variables:

| Variable | Default | Description |
| --- | --- | --- |
| `AGENT_PORT` | `8790` | Agent service port. |
| `AGENT_MATCHER_URL` | `http://127.0.0.1:8787` | Base URL for the matcher. |
| `AGENT_DB_FILE` | `../matcher/data/strategies.sqlite` | Shared SQLite database used for sessions. |
| `AGENT_MODEL_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible API base URL. |
| `AGENT_MODEL_NAME` | `gpt-5.4-nano` | Model used for planning/orchestration. |
| `AGENT_MODEL_API_KEY` | required | API key for the model. |
| `AGENT_MODEL_REASONING_EFFORT` | optional | `none`, `low`, `medium`, `high`, `xhigh`. |
| `AGENT_MODEL_TIMEOUT_MS` | `60000` | Timeout for model calls. |
| `AGENT_MAX_STEPS` | `6` | Maximum number of steps for the fallback JSON loop. |
| `AGENT_TOOLCALL_RETRIES` | `2` | Runtime config exposed in capabilities. |
| `AGENT_FORCE_FALLBACK_JSON` | `true` in code | If true, forces the JSON loop; `.env.example` shows `false` to enable native tools. |

Useful scripts from the repo root:

```bash
npm run dev:matcher
npm run dev:strategy-agent
npm run dev:web
npm run typecheck -w @sinergy/strategy-agent
```

The frontend resolves `VITE_AGENT_URL` if present; otherwise, in dev it uses `window.location.origin/agent`, and in direct local mode it uses `http://127.0.0.1:8790`.

## Tool catalog

The tools are defined in `packages/shared/src/strategy-tools/definitions.ts`, and their strict schemas live in `schemas.ts`. The agent gets the real catalog from `GET /strategy-tools/catalog`, but filters tools through `agentToolPolicy`.

| Tool | Type | Purpose |
| --- | --- | --- |
| `list_strategy_capabilities` | Discovery | Lists indicators, operators, limits, timeframes, and defaults. |
| `analyze_market_context` | Discovery | Analyzes candles by timeframe, regime, support/resistance, and recommends a timeframe. |
| `compile_strategy_source` | Compilation | Normalizes engine-backed strategies (`pine_like_v0` or `ast_v2`) and returns a preview. |
| `list_strategy_templates` | Discovery | Lists built-in templates adapted to the owner/market. |
| `create_strategy_draft` | Mutation | Creates a new draft, optionally with an `engine`. |
| `update_strategy_draft` | Mutation | Replaces the full strategy payload. It does not accept a partial patch. |
| `validate_strategy_draft` | Verification | Validates schema, market, rules, sizing, risk, and cost model. |
| `run_strategy_backtest` | Terminal | Runs a backtest for a valid strategy and returns summary, trades, and overlay. |
| `get_backtest_summary` | Read-only | Fetches the summary for a `runId`. |
| `get_backtest_trades` | Read-only | Fetches the trades for a `runId`. |
| `get_backtest_chart_overlay` | Read-only | Fetches the chart overlay for a `runId`. |
| `save_strategy` | Mutation | Promotes a valid draft to saved. |
| `list_user_strategies` | Discovery | Lists strategies for the owner. |
| `get_strategy` | Discovery | Loads one strategy by `strategyId`. |
| `delete_strategy` | Mutation blocked from the agent | Exists in the matcher, but the agent cannot call it. |
| `clone_strategy_template` | Mutation | Clones a template into a new draft. |

Important shared limits (`STRATEGY_TOOL_LIMITS`):

| Limit | Value |
| --- | --- |
| `maxBarsPerBacktest` | `200000` |
| `defaultBacktestBars` | `8640` |
| `requestsPerMinutePerOwnerPerTool` | `60` |
| `maxSerializedStrategyBytes` | `100000` |
| Strategy name length | 3 to 80 characters |

## Tool transport and security

The agent uses `createHttpStrategyToolTransport` to call:

```text
POST {AGENT_MATCHER_URL}/strategy-tools/{tool}
Content-Type: application/json
```

Before sending the request, the client validates input against the shared schema. In the matcher, `StrategyToolApi.execute` validates again with the same schema and applies:

- Unknown tool: `unknown_strategy_tool`, HTTP 404.
- Invalid input: `invalid_tool_input`, HTTP 422.
- Rate limit: `rate_limit_exceeded`, HTTP 429, per `tool + ownerAddress`.
- Business logic errors from `StrategyService`, with error code and details.

All matcher outputs use this envelope:

```json
{
  "ok": true,
  "meta": {
    "apiVersion": "...",
    "tool": "run_strategy_backtest",
    "requestId": "uuid",
    "timestamp": "iso"
  },
  "result": {}
}
```

The agent transport turns `ok:false` into an `Error` with `code`, `details`, and `retryable`.

## Context injection

The agent avoids making the model remember every ID. `mergeToolContext` automatically adds:

- `ownerAddress` to every input.
- `marketId` for market-root tools: `analyze_market_context`, `compile_strategy_source`, `list_strategy_templates`, `create_strategy_draft`, `clone_strategy_template`.
- `strategyId` for `run_strategy_backtest`, `save_strategy`, `get_strategy`, and also `validate_strategy_draft` when `strategy` is not passed.
- `runId` for `get_backtest_summary`, `get_backtest_trades`, and `get_backtest_chart_overlay`.

In native LangChain mode, `strategyToolRuntime` also updates state with `strategyId` if a tool returns `strategy.id`, and `runId` if a tool returns `summary.runId`.

## Execution modes

### 1. Plan

`POST /agent/strategy/plan`:

- Creates or resumes a session.
- Syncs the strategy snapshot if the session already has a `strategyId`.
- Calls `list_strategy_capabilities`.
- Asks the model for JSON containing `finalMessage` and `plannedTools`.
- Falls back to a static plan if JSON parsing fails.
- Does not execute mutations or backtests.

### 2. Run with fast paths

Before using the general loop, `StrategyAgentService.run` tries fast paths:

- Creation: when the goal looks like a new strategy request. It calls capabilities, market analysis, templates, asks the model for a creation plan, compiles the engine, creates a draft, updates it, validates it, and usually runs a backtest.
- Modification: there is currently a fast path for RSI filter requests on an existing strategy. It loads the strategy, analyzes the market, compiles an EMA+RSI engine, updates the strategy in place, validates it, and backtests it.
- Optimization: for goals that look like optimize/tune requests. It loads the strategy, analyzes candidate variants, tests parameters, and compares backtests.

These fast paths reduce reliance on native tool calling and force observable artifacts.

### 3. Native tools

If `AGENT_FORCE_FALLBACK_JSON` is false, the agent tries LangChain `createAgent`:

- Real tools plus `agent_runtime_ping`.
- System prompt `STRATEGY_AGENT_SYSTEM_PROMPT`.
- Context schema with `ownerAddress`/`marketId`.
- State schema with `strategyId`/`runId`.
- Dynamic prompt built from runtime state so the model can reuse active IDs.

If no tool calls happen, or the native path fails, it falls back to the JSON loop.

### 4. Fallback JSON loop

`runFallbackJsonLoop` asks the model for strict JSON:

```json
{
  "type": "tool",
  "goal_state": "advance workflow safely",
  "tool": "validate_strategy_draft",
  "input": {},
  "reason": "...",
  "expected_artifact": "validation result",
  "stop_condition": "validation returns ok"
}
```

or:

```json
{
  "type": "final",
  "message": "Completed strategy task.",
  "artifacts": {
    "strategyId": "...",
    "runId": "..."
  }
}
```

The loop:

- Summarizes the last 8 trace entries into the prompt.
- Blocks disallowed tools.
- Avoids repeated tool calls and semantic stalls.
- Injects context with `mergeToolContext`.
- Stores output, errors, and progress summaries into `toolTrace`.
- Detects `strategy.id` and `summary.runId` to continue the workflow.
- If validation fails, attempts automatic repair with `attemptValidationRepair` up to 3 times.

## Recommended strategy workflow

The system prompt enforces this order when the user asks to create and backtest a strategy:

1. `list_strategy_capabilities`
2. `analyze_market_context` if `marketId` is available
3. `compile_strategy_source` for custom engine-backed strategies
4. `create_strategy_draft` or `clone_strategy_template`
5. `update_strategy_draft` to align metadata, timeframe, sides, risk, and costs
6. `validate_strategy_draft`
7. `run_strategy_backtest` if the user asked for testing/backtesting/evaluation

The strategy must preserve this structure:

```text
id, ownerAddress, marketId, name, timeframe, enabledSides,
entryRules, exitRules, sizing, riskRules, costModel, optional engine
```

For `update_strategy_draft`, the agent must send the full object, not a partial patch.

## Validation, backtesting, and persistence

`StrategyService` is the source of truth for business logic:

- `listCapabilities` uses `buildStrategyCapabilities`.
- `analyzeMarketContext` loads candles by timeframe from `priceService` and calculates regime/recommendations.
- `compileStrategySource` normalizes `engine` and generates a preview.
- `createDraft` and `cloneTemplate` write strategies into SQLite.
- `updateDraft` enforces matching `ownerAddress`, preserves `createdAt`, and keeps status as `draft` unless archived.
- `validateDraft` checks known markets and capabilities.
- `saveStrategy` only saves when validation passes.
- `runBacktest` validates before execution, loads candles for the market/timeframe, runs `runStrategyBacktest`, and stores summary/overlay/trades in SQLite.

The key artifacts returned by the agent to the frontend are:

- `strategyId`
- summarized `strategy`
- `runId`
- `summary`
- `validation`
- `toolTrace`
- `metrics`

## Sessions and diagnostics

`StrategyAgentSessionStore` uses SQLite with WAL. It stores:

- Sessions by `sessionId`, `ownerAddress`, `marketId`, `strategyId`, `runId`.
- Recent turns (`MAX_RECENT_TURNS = 12`).
- Full tool traces.
- Last runtime mode: `native-tools` or `fallback-json`.
- Execution metrics.

It also prunes sessions using:

- `MAX_SESSIONS = 200`
- `SESSION_TTL_MS = 12h`

Metrics include successful/failed tool calls, first-pass validation success, repairs, aborted loops, tool misuse, stalls, and finalization guardrails.

## Frontend

`StrategyAgentPanel.tsx` is the main client:

- Builds an `enrichedGoal` with the user goal, selected timeframe, allowed sides, and stop-loss preference.
- In plan mode, calls `/agent/strategy/plan`.
- In run mode, calls `/agent/strategy/run/stream` and renders SSE events.
- Converts the `toolTrace` from `run_strategy_backtest` into a `StrategyBacktestBundle` containing `summary`, `trades`, and `overlay`.
- Keeps per-owner session history and allows reviewing the strategy/backtest.

## Key behaviors and guardrails

- The agent does not promise live trading or paper trading; the current system supports strategy creation, validation, and backtesting.
- `delete_strategy` exists in the matcher but is blocked for the agent.
- Schemas are strict: extra root-level keys fail validation.
- `update_strategy_draft` only accepts `{ ownerAddress, strategy }`.
- `validate_strategy_draft` accepts either `strategyId` or `strategy`.
- If the user requests a backtest, the agent must not finalize without `run_strategy_backtest`.
- If there is an active `strategyId` and the user asks to modify the strategy, it should load it with `get_strategy` and update that same strategy.
- In engine-backed strategies, the effective trading logic may live under `strategy.engine`; top-level fields still need to stay aligned.
- EMA rules must compare different indicators or different parameters, such as EMA 9 crossing EMA 21, never `close` against `close`.

## Extension points

- New tool: add the definition in `packages/shared/src/strategy-tools/definitions.ts`, the schema in `schemas.ts`, the type/result in `types.ts`, and the handler in `StrategyToolApi.execute`; the endpoint will then be available automatically at `/strategy-tools/:tool`.
- New agent policy: update `agentToolPolicy.ts`.
- New fast path: add a goal detector and a method in `StrategyAgentService.run` before the native/fallback path.
- New engine type: extend normalization/compilation in strategy services and capabilities.
- New frontend-visible data: return it in tool output or artifacts and update `StrategyAgentPanel.tsx`.

## Quick troubleshooting

| Symptom | What to check |
| --- | --- |
| `/agent/health` fails on the model | `AGENT_MODEL_BASE_URL`, `AGENT_MODEL_NAME`, `AGENT_MODEL_API_KEY`. |
| `/agent/health` fails on the matcher | Make sure `npm run dev:matcher` is running and `AGENT_MATCHER_URL` points to the right port. |
| A tool fails with 422 | Compare the input against `strategyToolInputSchemas`; the usual cause is an extra key or a missing `strategyId/marketId`. |
| Backtest does not run | Check whether validation passed, whether enough candles exist, and whether `bars` is `<= 200000`. |
| The agent keeps repeating steps | Inspect `toolTrace`, warnings such as `stalledTurns` or `loopsAborted`, and only increase `AGENT_MAX_STEPS` if the workflow really needs more steps. |
| The frontend cannot reach the agent | Set `VITE_AGENT_URL` or check the `/agent` proxy in dev/deploy. |

