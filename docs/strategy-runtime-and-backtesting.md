# Strategy Runtime and Backtesting Architecture

This document explains the new strategy and backtesting foundation inside Sinergy. The goal of this design is to make the trading engine the source of truth, so the manual builder, public API, and future agent-facing Pine-like DSL all compile into the same internal runtime.

The current implementation lives primarily in:

- `packages/shared/src/strategy.ts`
- `services/matcher/src/services/strategyCatalog.ts`
- `services/matcher/src/services/strategyValidation.ts`
- `services/matcher/src/services/indicatorEngine.ts`
- `services/matcher/src/services/strategyRuntime.ts`
- `services/matcher/src/services/strategyBacktest.ts`
- `apps/web/src/components/StrategyPanel.tsx`

## Design Goal

The old system already had a usable rule builder and backtester, but the rule format itself was still acting like the execution model. That made it harder to evolve toward:

- richer series expressions
- Pine Script style historical references like `close[1]`
- future `ta.*` or DSL compilation
- agent-authored strategies that are more than simple left/right comparisons

The new design moves the system to an `engine-first` shape:

1. Shared strategy contract and capabilities
2. Normalization and validation
3. Internal runtime/AST compilation
4. Series evaluation and indicator resolution
5. Backtest execution and metrics
6. API, builder UI, and agent tooling as adapters on top

## Layered Architecture

### 1. Shared Contract

`packages/shared/src/strategy.ts` defines the portable strategy contract used across matcher, agent, and web.

It now includes:

- more operators: `==`, `!=`
- more price sources: `hl2`, `hlc3`, `ohlc4`
- historical offsets on operands through `barsAgo`
- more indicators: `atr`, `roc`, `stoch`
- source-aware indicator params via `source`
- richer backtest metrics such as expectancy, average trade, average bars held, and exposure

This shared model is still the external strategy shape for now.

### 2. Capabilities and Defaults

`services/matcher/src/services/strategyCatalog.ts` is the registry of what the matcher supports.

It exposes:

- valid operators
- valid price sources
- indicator catalog
- per-indicator params and defaults
- sizing modes
- risk rules
- built-in templates

This file is the schema-safe discovery layer for the UI and the strategy agent.

### 3. Normalization and Validation

`services/matcher/src/services/strategyValidation.ts` converts loose input into a valid `StrategyDefinition` and checks that it respects matcher constraints.

This layer is responsible for:

- coercing raw inputs into typed operands
- accepting `barsAgo`
- parsing numeric params plus `source`
- enforcing supported indicators, outputs, and params
- rejecting invalid historical offsets
- preventing ambiguous long/short configurations

This means the engine receives a normalized strategy before simulation begins.

### 4. Indicator and Series Engine

`services/matcher/src/services/indicatorEngine.ts` is the raw series computation layer.

It handles:

- candle-derived sources such as `hl2`, `hlc3`, and `ohlc4`
- indicator series generation
- overlay generation for chart rendering
- operand value resolution at a specific index
- historical lookups via `barsAgo`

The indicator engine does not decide whether to enter or exit trades. It only computes reusable numeric series and resolves operand values.

### 5. Internal Runtime / AST

`services/matcher/src/services/strategyRuntime.ts` is the key new layer.

This file introduces an internal compiled runtime with two expression families:

- `RuntimeValueExpression`
- `RuntimeConditionExpression`

The runtime currently supports:

- operand expressions
- math expressions: `+`, `-`, `*`, `/`
- unary helpers: `negate`, `abs`
- comparison conditions
- logical composition with `and`, `or`, and `not`
- boolean constants

The important point is that the matcher no longer has to evaluate the builder rule groups directly during backtesting. Instead, it:

1. compiles a `StrategyDefinition` into `CompiledTradingStrategy`
2. collects indicator references from that runtime
3. builds the required indicator series
4. evaluates runtime expressions bar by bar

This is the bridge toward a future Pine-like compiler. A manual builder, an agent-generated structure, or a script parser can all target this runtime.

### 6. Backtest Runner

`services/matcher/src/services/strategyBacktest.ts` now runs on top of the runtime layer.

The backtester still manages:

- position opening and closing
- entry and exit fills
- fees and slippage
- stop loss / take profit / trailing stop / max bars
- reverse signals
- equity curve
- trades and overlay markers

But entry and exit signals are now resolved through compiled runtime expressions instead of ad hoc group evaluation logic.

That separation is the architectural change that matters most.

## Data Flow

Today the full flow is:

1. A strategy draft is created or updated through the API/UI/agent.
2. The matcher normalizes it into `StrategyDefinition`.
3. Validation checks structural and logical correctness.
4. The strategy compiles into `CompiledTradingStrategy`.
5. The runtime collects required indicator references.
6. The indicator engine computes only the series needed by that runtime.
7. The backtester evaluates entry and exit conditions bar by bar.
8. The system produces:
   - summary
   - trades
   - chart overlay

In short:

`StrategyDefinition -> Validation -> Runtime Compilation -> Series Evaluation -> Backtest Output`

## Current Runtime Shape

The runtime is intentionally small right now. It is not yet a full Pine clone.

What it already gives us:

- a dedicated internal AST
- reusable evaluation primitives
- series-aware expression execution
- independence from the current UI rule grouping format

What it does not yet provide:

- named variables
- function-call AST nodes like `ta.ema(close, 20)`
- explicit boolean filters separate from entries/exits
- multiple statement blocks
- `if` expressions
- persistent state like Pine `var`
- order management features such as pyramiding
- multi-timeframe expressions

That is by design. The runtime is meant to be stable enough to build on, not complete all at once.

## Public Strategy Contract v2

The project now also has a semi-public source contract in `packages/shared/src/strategyEngine.ts`.

The key exported types are:

- `StrategyAstV2`
- `StrategyValueExpressionV2`
- `StrategyConditionExpressionV2`
- `StrategyEngineDefinition`
- `StrategyCompilationPreview`

`StrategyDefinition` can now optionally carry:

- `engine.sourceType = "ast_v2"`
- `engine.sourceType = "pine_like_v0"`

This means a strategy draft can be stored in one of two ways:

1. Legacy builder-compatible `entryRules` and `exitRules`
2. Engine-backed source through `engine.ast` or `engine.script`

When `engine` is present, the matcher treats that source as the primary execution contract.

## Pine-Like Compiler

The first Pine-like compiler lives in `services/matcher/src/services/strategySourceCompiler.ts`.

This compiler currently supports a focused subset:

- line-based assignments
- bindings such as `fast = ta.ema(close, 9)`
- signal assignments
  - `longEntry = ...`
  - `longExit = ...`
  - `shortEntry = ...`
  - `shortExit = ...`
- logical operators
  - `and`
  - `or`
  - `not`
- comparisons
  - `>`
  - `>=`
  - `<`
  - `<=`
  - `==`
  - `!=`
- historical references
  - `close[1]`
  - `fast[2]`
- math expressions
  - `+`
  - `-`
  - `*`
  - `/`
- selected functions
  - `ta.ema`
  - `ta.sma`
  - `ta.rsi`
  - `ta.atr`
  - `ta.roc`
  - `ta.vwap`
  - `ta.highest`
  - `ta.lowest`
  - `ta.stoch`
  - `ta.macd`
  - `ta.bb`
  - `ta.crossover`
  - `ta.crossunder`
  - `math.abs`

This is intentionally a narrow first compiler. The important thing is that it already compiles into the same runtime used by the backtester.

## API and Tooling Migration

The strategy tool API now exposes the new source contract in two ways:

- `create_strategy_draft` now accepts an optional `engine`
- `compile_strategy_source` compiles `AST v2` or Pine-like source and returns:
  - normalized `engine`
  - `preview` metadata

This allows the strategy agent to work in a safer staged flow:

1. Generate script or AST
2. Compile it through `compile_strategy_source`
3. Create or update a draft using the compiled engine
4. Validate
5. Backtest

That reduces the chance of the agent saving malformed source directly into a strategy.

The `strategy-agent` now reflects that flow directly:

- tool context auto-injects `marketId` for `compile_strategy_source`
- prompts instruct the model to prefer engine-backed creation for new custom strategies
- the creation fast path now does:
  - `list_strategy_capabilities`
  - `analyze_market_context`
  - `list_strategy_templates`
  - `compile_strategy_source`
  - `create_strategy_draft(engine=...)`
  - `update_strategy_draft`
  - `validate_strategy_draft`
  - `run_strategy_backtest`

For simple strategy families, the agent now generates Pine-like source deterministically from a compact `engineHint` instead of constructing legacy `entryRules` and `exitRules` first.

## Why This Helps the Agent

The long-term target is for the strategy agent to reason in terms closer to trading logic and less in terms of UI-specific rule rows.

With this runtime in place, the agent can eventually work at three levels:

1. High-level intent
   - "build a momentum strategy with EMA trend filter and stochastic confirmation"
2. Intermediate compiled structure
   - runtime expressions or a future public AST
3. Execution
   - validation, backtesting, overlays, metrics

That keeps the agent aligned with the same execution semantics used by the matcher.

## Why This Helps a Pine-Like DSL

Pine Script style systems usually have:

- a parser
- an AST
- a series runtime
- built-in technical analysis functions
- a strategy execution layer

The new Sinergy runtime gives us the middle of that stack:

- internal expression model
- series evaluation
- comparison semantics
- strategy execution and metrics

What remains for a Pine-like language is mostly the front half:

- script syntax
- parser
- semantic analysis
- compiler from script AST into runtime expressions

Because the backtester now runs on the runtime instead of the builder structure, that future compiler has a much cleaner target.

## Backward Compatibility

The current public strategy shape is still supported. We did not remove the builder contract or the API format.

Instead, the system now treats the current shape as an adapter source:

- UI builder edits `StrategyDefinition`
- validation still accepts `StrategyDefinition`
- matcher compiles `StrategyDefinition` into runtime expressions internally

This keeps the product working while allowing a phased migration.

## New Strategy Features Already Enabled

The engine now supports several trading-system features that were missing or too rigid before:

- historical offsets on operands with `barsAgo`
- derived candle sources
  - `hl2`
  - `hlc3`
  - `ohlc4`
- more operators
  - `==`
  - `!=`
- source-aware indicators
  - for example `ema(source=hl2, period=20)`
- new indicators
  - `atr`
  - `roc`
  - `stoch`
- richer performance metrics
  - `avgTradeNetPnl`
  - `avgWinningTradeNetPnl`
  - `avgLosingTradeNetPnl`
  - `avgBarsHeld`
  - `expectancy`
  - `exposurePct`

## Testing

The matcher test suite now covers the runtime direction explicitly.

See:

- `services/matcher/src/strategyAdvanced.test.ts`
- `services/matcher/src/strategyToolApi.test.ts`

The runtime tests verify:

- advanced capabilities are exposed
- `barsAgo` validation works
- derived price sources resolve correctly
- runtime compilation works from the legacy rule format
- backtest metrics still behave correctly

## Recommended Next Steps

The next logical phase is to define a public or semi-public `Strategy AST v2` that is closer to the runtime than the current builder-only shape.

Suggested order:

1. Introduce `Strategy AST v2` as a first-class internal/public contract
2. Add compiler adapters:
   - current builder format -> runtime
   - future AST v2 -> runtime
   - future Pine-like DSL -> runtime
3. Expand runtime expressions with:
   - named variables
   - function calls
   - explicit filters
   - reusable subexpressions
4. Add more execution features:
   - pyramiding
   - partial exits
   - order types
   - multi-timeframe support
5. Update agent tooling to target the new AST instead of raw builder-shaped rule groups

## Summary

The important change is not just that the system has more indicators or more backtest metrics.

The important change is that Sinergy now has a dedicated internal strategy runtime. That runtime sits between the external strategy shape and the backtester, and it gives the project a real foundation for:

- agent-authored strategies
- future Pine-like scripting
- safer API evolution
- richer backtesting without rewriting the execution engine each time

That is the new base to build the rest of the strategy system on top of.
