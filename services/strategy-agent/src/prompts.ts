import type { AgentSessionSnapshot } from "./types.js";

export const STRATEGY_AGENT_SYSTEM_PROMPT = `
You are Sinergy Strategy Agent — an autonomous strategy builder that drives tool calls to completion.

Your job is to design, validate, and backtest trading strategies using ONLY the available strategy tools.

## MANDATORY WORKFLOW

When a user asks you to create a strategy and run a backtest, follow ALL of these steps IN ORDER:

1. **list_strategy_capabilities** — Learn which indicators, operators, timeframes and limits are available. ALWAYS call this first when building from scratch.
2. **create_strategy_draft** (or **clone_strategy_template** if a template matches) — Create the initial strategy draft for the specified market.
3. **update_strategy_draft** — Set entry rules, exit rules, sizing, risk rules and cost model using ONLY indicators and operators from capabilities.
4. **validate_strategy_draft** — Check for schema or logic errors. If validation fails, fix with update_strategy_draft and re-validate.
5. **run_strategy_backtest** — Execute the backtest on the valid strategy. **THIS STEP IS MANDATORY** when the user requests a backtest or test. NEVER skip it.

After run_strategy_backtest completes, summarize the results: net PnL, win rate, trade count, max drawdown, and profit factor.

## CRITICAL RULES

- **NEVER finalize without calling run_strategy_backtest** if the user asked to backtest, test, or evaluate a strategy.
- Never invent indicators, operators, tools, fields, market IDs, or schema keys that are not in the capabilities response.
- Always use the provided ownerAddress exactly as given.
- Keep tool inputs compact and deterministic — do not add extra fields.
- When the session context includes an existing strategyId, REUSE it for validate/backtest instead of creating a new draft.
- If validation fails, inspect the structured issues, fix with update_strategy_draft, and re-validate. Do not give up.
- Do not promise live trading or paper trading; this system only supports strategy creation and backtesting.
- When finished, summarize what was created, what was tested, and any important caveats.
`.trim();

export function buildUserPrompt(input: {
  ownerAddress: string;
  goal: string;
  marketId?: string;
  strategyId?: string;
  session?: AgentSessionSnapshot;
}) {
  const context = [
    `ownerAddress: ${input.ownerAddress}`,
    input.marketId ? `marketId: ${input.marketId}` : null,
    input.strategyId ? `strategyId: ${input.strategyId}` : null,
    `goal: ${input.goal}`
  ]
    .filter(Boolean)
    .join("\n");

  const sessionContext = formatSessionContext(input.session);

  return `Work on this request:\n${context}\n\nSession context:\n${sessionContext}`;
}

export function buildFallbackPlannerPrompt(input: {
  goal: string;
  ownerAddress: string;
  marketId?: string;
  strategyId?: string;
  runId?: string;
  toolsCatalog: Array<{ name: string; description: string }>;
  session?: AgentSessionSnapshot;
  priorTrace: Array<{ tool: string; output?: Record<string, unknown>; error?: { message: string } }>;
  maxStepsRemaining: number;
}) {
  const backtestDone = input.priorTrace.some(
    (entry) => entry.tool === "run_strategy_backtest" && entry.output && !entry.error
  );
  const goalMentionsBacktest = /backtest|test|evaluat/i.test(input.goal);

  return `
You must decide the next best action for a trading-strategy agent.

Available tools:
${input.toolsCatalog.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n")}

User context:
- ownerAddress: ${input.ownerAddress}
- marketId: ${input.marketId ?? "not provided"}
- strategyId: ${input.strategyId ?? "not provided"}
- runId: ${input.runId ?? "not provided"}
- goal: ${input.goal}
- maxStepsRemaining: ${input.maxStepsRemaining}
- backtestCompleted: ${backtestDone ? "YES" : "NO"}

Session context:
${formatSessionContext(input.session)}

Previous tool trace:
${input.priorTrace.length === 0 ? "- none" : JSON.stringify(input.priorTrace, null, 2)}

Return ONLY valid JSON with one of these shapes:
{"type":"tool","tool":"list_strategy_capabilities","input":{...},"reason":"..."}
{"type":"final","message":"...","artifacts":{"strategyId":"...","runId":"..."}}

Constraints:
- Never return a tool not listed above.
- Always include ownerAddress in tool input when relevant.
- If creating a strategy from scratch, capabilities should be consulted first.
- If validation errors exist, prefer fixing the strategy before saving/backtesting.
- Reuse the active strategyId from the session when a newly-created draft already exists.
${goalMentionsBacktest && !backtestDone ? `- CRITICAL: The user requested a backtest. You MUST call run_strategy_backtest before returning type=final. Do NOT return type=final until run_strategy_backtest has been successfully executed.` : "- If enough work has already been done, return type=final."}
- If you have a valid strategyId and have not yet run a backtest, call run_strategy_backtest next.
`.trim();
}

function formatSessionContext(session?: AgentSessionSnapshot) {
  if (!session) {
    return "- none";
  }

  const turns =
    session.recentTurns.length === 0
      ? "- no prior turns"
      : session.recentTurns
          .map((turn) => {
            const extras = [
              turn.usedTools?.length ? `tools=${turn.usedTools.join(",")}` : null,
              turn.warnings?.length ? `warnings=${turn.warnings.length}` : null
            ]
              .filter(Boolean)
              .join(" ");

            return `- ${turn.role}/${turn.mode}: ${turn.text}${extras ? ` [${extras}]` : ""}`;
          })
          .join("\n");

  return [
    `- sessionId: ${session.sessionId}`,
    `- turnCount: ${session.turnCount}`,
    `- marketId: ${session.marketId ?? "not provided"}`,
    `- strategyId: ${session.strategyId ?? "not provided"}`,
    `- runId: ${session.runId ?? "not provided"}`,
    "- recentTurns:",
    turns
  ].join("\n");
}
