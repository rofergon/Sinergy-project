import type { StrategyToolDefinition } from "./types";
import { strategyToolInputSchemas } from "./schemas";

export const strategyToolDefinitions = [
  {
    name: "list_strategy_capabilities",
    description: "Discovery tool. Use first when building from scratch to learn valid indicators, operators, limits, defaults, and schema-safe choices. Do not use for validation or backtesting. Produces capabilities.",
    inputSchema: strategyToolInputSchemas.list_strategy_capabilities,
    endpoint: "/strategy-tools/list_strategy_capabilities"
  },
  {
    name: "analyze_market_context",
    description: "Discovery tool. Use after capabilities and before creating or optimizing a strategy so choices are grounded in real candles. Produces support/resistance levels, regime detection, EMA guidance, and a recommended timeframe.",
    inputSchema: strategyToolInputSchemas.analyze_market_context,
    endpoint: "/strategy-tools/analyze_market_context"
  },
  {
    name: "compile_strategy_source",
    description: "Compilation tool. Use when the strategy is expressed as AST v2 or Pine-like script and you need parser/compiler feedback before saving or backtesting. Produces a normalized engine payload plus a compilation preview.",
    inputSchema: strategyToolInputSchemas.compile_strategy_source,
    endpoint: "/strategy-tools/compile_strategy_source"
  },
  {
    name: "list_strategy_templates",
    description: "Discovery tool. Use before creating a draft when a built-in template may match the user's goal or market. Do not use once a draft already exists. Produces template candidates.",
    inputSchema: strategyToolInputSchemas.list_strategy_templates,
    endpoint: "/strategy-tools/list_strategy_templates"
  },
  {
    name: "create_strategy_draft",
    description: "Mutation tool. Use to create a brand-new draft after capabilities are known and when no reusable strategy or template fits. Supports either legacy rule payloads or a new engine-backed source via the optional engine field. Do not use if an active strategyId already exists. Produces a strategy draft.",
    inputSchema: strategyToolInputSchemas.create_strategy_draft,
    endpoint: "/strategy-tools/create_strategy_draft"
  },
  {
    name: "update_strategy_draft",
    description: "Mutation tool. Use to replace the full strategy payload after editing rules, sizing, costs, repairs, or engine-backed source code. Do not send partial objects or root-level strategyId. Produces an updated strategy draft.",
    inputSchema: strategyToolInputSchemas.update_strategy_draft,
    endpoint: "/strategy-tools/update_strategy_draft"
  },
  {
    name: "validate_strategy_draft",
    description: "Verification tool. Use after creating or updating a strategy to confirm schema and logic correctness. Do not skip before backtesting or saving. Produces structured validation status and issues.",
    inputSchema: strategyToolInputSchemas.validate_strategy_draft,
    endpoint: "/strategy-tools/validate_strategy_draft"
  },
  {
    name: "run_strategy_backtest",
    description: "Terminal tool. Use only after validation succeeds or when the request explicitly requires testing an existing valid strategy. Do not use with a raw strategy payload. Produces backtest summary, trades, and overlay.",
    inputSchema: strategyToolInputSchemas.run_strategy_backtest,
    endpoint: "/strategy-tools/run_strategy_backtest"
  },
  {
    name: "get_backtest_summary",
    description: "Read-only terminal follow-up. Use after a prior backtest run when only summary metrics are needed. Do not use to start a test. Produces backtest summary.",
    inputSchema: strategyToolInputSchemas.get_backtest_summary,
    endpoint: "/strategy-tools/get_backtest_summary"
  },
  {
    name: "get_backtest_trades",
    description: "Read-only terminal follow-up. Use after a prior backtest run when trade-by-trade detail is needed. Do not use to start a test. Produces backtest trades.",
    inputSchema: strategyToolInputSchemas.get_backtest_trades,
    endpoint: "/strategy-tools/get_backtest_trades"
  },
  {
    name: "get_backtest_chart_overlay",
    description: "Read-only terminal follow-up. Use after a prior backtest run when chart markers or indicator overlays are needed. Do not use to start a test. Produces chart overlay.",
    inputSchema: strategyToolInputSchemas.get_backtest_chart_overlay,
    endpoint: "/strategy-tools/get_backtest_chart_overlay"
  },
  {
    name: "save_strategy",
    description: "Mutation tool. Use after validation passes when the user wants the draft promoted into a saved strategy. Do not use as a substitute for backtesting. Produces a saved strategy and validation result.",
    inputSchema: strategyToolInputSchemas.save_strategy,
    endpoint: "/strategy-tools/save_strategy"
  },
  {
    name: "list_user_strategies",
    description: "Discovery tool. Use when the user asks about existing saved or draft strategies for an owner. Do not use when a specific strategyId is already known. Produces a strategy list.",
    inputSchema: strategyToolInputSchemas.list_user_strategies,
    endpoint: "/strategy-tools/list_user_strategies"
  },
  {
    name: "get_strategy",
    description: "Discovery tool. Use when a specific strategyId already exists and you need the full stored payload before validation, edits, or explanation. Produces one strategy.",
    inputSchema: strategyToolInputSchemas.get_strategy,
    endpoint: "/strategy-tools/get_strategy"
  },
  {
    name: "clone_strategy_template",
    description: "Mutation tool. Use when a template already matches the request better than creating from scratch. Do not use without marketId and templateId. Produces a cloned strategy draft.",
    inputSchema: strategyToolInputSchemas.clone_strategy_template,
    endpoint: "/strategy-tools/clone_strategy_template"
  }
] satisfies StrategyToolDefinition[];
