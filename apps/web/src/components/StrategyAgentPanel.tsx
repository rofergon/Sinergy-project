import { useEffect, useMemo, useState } from "react";
import type {
  HexString,
  StrategyBacktestSummary,
  StrategyBacktestTrade,
  StrategyChartOverlay,
  StrategyTimeframe,
  StrategyToolName
} from "@sinergy/shared";
import { agentApi } from "../lib/api";
import type {
  MarketSnapshot,
  StrategyAgentPlanResponse,
  StrategyAgentRunResponse,
  StrategyAgentToolTraceEntry,
  StrategyBacktestBundle
} from "../types";

type Props = {
  address?: HexString;
  selectedMarket?: MarketSnapshot;
  onBacktestResult: (result: StrategyBacktestBundle | null) => void;
  onTimeframeChange: (timeframe: StrategyTimeframe) => void;
  onReviewStrategy: (strategyId: string, bundle: StrategyBacktestBundle | null) => void;
};

type AgentMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  mode?: "plan" | "run";
  plannedTools?: Array<{ tool: StrategyToolName; why: string }>;
  usedTools?: StrategyToolName[];
  trace?: StrategyAgentToolTraceEntry[];
  warnings?: string[];
  strategyId?: string;
  bundle?: StrategyBacktestBundle | null;
};

type AgentCapabilitiesResponse = {
  model: {
    baseUrl: string;
    modelName: string;
    reachable: boolean;
    healthOk: boolean;
    toolCallingObserved: boolean;
  };
  runtime: {
    maxSteps: number;
    toolcallRetries: number;
    forceFallbackJson: boolean;
  };
  tools: Array<{
    name: StrategyToolName;
    description: string;
    endpoint?: string;
  }>;
};

function buildMessageId() {
  return `agent-msg-${crypto.randomUUID()}`;
}

function toBacktestBundle(trace: StrategyAgentToolTraceEntry[]): StrategyBacktestBundle | null {
  const runEntry = [...trace]
    .reverse()
    .find((entry) => entry.tool === "run_strategy_backtest" && entry.output);

  if (!runEntry?.output) {
    return null;
  }

  const output = runEntry.output as {
    summary?: StrategyBacktestSummary;
    trades?: StrategyBacktestTrade[];
    overlay?: StrategyChartOverlay;
  };

  if (!output.summary || !output.trades || !output.overlay) {
    return null;
  }

  return {
    summary: output.summary,
    trades: output.trades,
    overlay: output.overlay
  };
}

export function StrategyAgentPanel({
  address,
  selectedMarket,
  onBacktestResult,
  onTimeframeChange,
  onReviewStrategy
}: Props) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState<"plan" | "run" | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [status, setStatus] = useState("");
  const [runtime, setRuntime] = useState<AgentCapabilitiesResponse | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadRuntime() {
      try {
        const result = await agentApi<AgentCapabilitiesResponse>("/capabilities");
        if (!cancelled) {
          setRuntime(result);
        }
      } catch (error) {
        if (!cancelled) {
          setStatus(error instanceof Error ? error.message : String(error));
        }
      }
    }

    void loadRuntime();
    return () => {
      cancelled = true;
    };
  }, []);

  const runtimeBadge = useMemo(() => {
    if (!runtime) return "Connecting";
    if (!runtime.model.reachable || !runtime.model.healthOk) return "Offline";
    return runtime.model.toolCallingObserved ? "Native tools" : "Fallback JSON";
  }, [runtime]);

  async function submit(mode: "plan" | "run") {
    const goal = prompt.trim();
    if (!address || !goal || !selectedMarket) return;

    const userMessage: AgentMessage = {
      id: buildMessageId(),
      role: "user",
      text: goal,
      mode
    };
    setMessages((current) => [...current, userMessage]);
    setBusy(mode);
    setStatus(mode === "plan" ? "Planning with agent..." : "Running agent workflow...");

    try {
      if (mode === "plan") {
        const payload = await agentApi<{ ok: true; result: StrategyAgentPlanResponse }>(
          "/strategy/plan",
          {
            method: "POST",
            body: JSON.stringify({
              ownerAddress: address,
              marketId: selectedMarket.id,
              goal,
              mode
            })
          }
        );

        setMessages((current) => [
          ...current,
          {
            id: buildMessageId(),
            role: "assistant",
            text: payload.result.finalMessage,
            mode,
            plannedTools: payload.result.plannedTools,
            warnings: payload.result.warnings
          }
        ]);
        setStatus("Plan ready.");
        return;
      }

      const payload = await agentApi<{ ok: true; result: StrategyAgentRunResponse }>(
        "/strategy/run",
        {
          method: "POST",
          body: JSON.stringify({
            ownerAddress: address,
            marketId: selectedMarket.id,
            goal,
            mode
          })
        }
      );

      const bundle = toBacktestBundle(payload.result.toolTrace);
      if (bundle) {
        onTimeframeChange(bundle.summary.timeframe);
        onBacktestResult(bundle);
      }

      setMessages((current) => [
        ...current,
        {
          id: buildMessageId(),
          role: "assistant",
          text: payload.result.finalMessage,
          mode,
          usedTools: payload.result.usedTools,
          trace: payload.result.toolTrace,
          warnings: payload.result.warnings,
          strategyId: payload.result.artifacts.strategyId,
          bundle
        }
      ]);
      setStatus(
        payload.result.artifacts.strategyId
          ? "Agent workflow finished. Review the generated strategy in the builder."
          : "Agent workflow finished."
      );
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          id: buildMessageId(),
          role: "assistant",
          text: error instanceof Error ? error.message : String(error),
          mode
        }
      ]);
      setStatus("Agent request failed.");
    } finally {
      setBusy(null);
    }
  }

  if (!address) {
    return (
      <div className="strategy-agent-panel">
        <div className="strategy-empty-state">
          Connect wallet to start a strategy conversation with the agent.
        </div>
      </div>
    );
  }

  return (
    <div className="strategy-agent-panel">
      <div className="strategy-agent-head">
        <div>
          <span className="panel-title">Agent Workspace</span>
          <p>
            Describe the strategy goal in natural language. The agent will plan or execute against the
            same backend tools used by the manual builder.
          </p>
        </div>
        <div className="strategy-agent-runtime">
          <span className={`strategy-agent-badge ${runtimeBadge === "Offline" ? "offline" : ""}`}>
            {runtimeBadge}
          </span>
          <small>{runtime?.model.modelName ?? "Loading model..."}</small>
        </div>
      </div>

      <div className="strategy-agent-context">
        <span>Market</span>
        <strong>{selectedMarket?.symbol ?? "Select a market"}</strong>
        <span>Tools</span>
        <strong>{runtime?.tools.length ?? "--"}</strong>
      </div>

      <div className="strategy-agent-thread">
        {messages.length === 0 ? (
          <div className="strategy-empty-state">
            Try something like: "Create an EMA crossover strategy for this market, validate it, and run a backtest."
          </div>
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              className={`strategy-agent-message ${message.role === "assistant" ? "assistant" : "user"}`}
            >
              <div className="strategy-agent-message-head">
                <strong>{message.role === "assistant" ? "Agent" : "You"}</strong>
                {message.mode && <span>{message.mode === "plan" ? "Plan" : "Run"}</span>}
              </div>
              <p>{message.text}</p>

              {message.plannedTools && message.plannedTools.length > 0 && (
                <div className="strategy-agent-list">
                  {message.plannedTools.map((item) => (
                    <div key={`${message.id}-${item.tool}`}>
                      <strong>{item.tool}</strong>
                      <small>{item.why}</small>
                    </div>
                  ))}
                </div>
              )}

              {message.usedTools && message.usedTools.length > 0 && (
                <div className="strategy-agent-chips">
                  {message.usedTools.map((tool) => (
                    <span key={`${message.id}-${tool}`}>{tool}</span>
                  ))}
                </div>
              )}

              {message.trace && message.trace.length > 0 && (
                <div className="strategy-agent-trace">
                  {message.trace.map((entry) => (
                    <div key={`${message.id}-${entry.step}`}>
                      <strong>
                        {entry.step}. {entry.tool}
                      </strong>
                      <small>{entry.error?.message ?? "completed"}</small>
                    </div>
                  ))}
                </div>
              )}

              {message.warnings && message.warnings.length > 0 && (
                <div className="strategy-agent-warnings">
                  {message.warnings.map((warning) => (
                    <small key={`${message.id}-${warning}`}>{warning}</small>
                  ))}
                </div>
              )}

              {message.strategyId && (
                <button
                  type="button"
                  className="strategy-agent-review-btn"
                  onClick={() => onReviewStrategy(message.strategyId!, message.bundle ?? null)}
                >
                  Review In Builder
                </button>
              )}
            </div>
          ))
        )}
      </div>

      <div className="strategy-agent-compose">
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Describe the strategy you want to build, validate, or improve..."
        />
        <div className="strategy-agent-actions">
          <button type="button" onClick={() => void submit("plan")} disabled={busy !== null || !prompt.trim()}>
            {busy === "plan" ? "Planning..." : "Plan With AI"}
          </button>
          <button
            type="button"
            className="strategy-primary-btn"
            onClick={() => void submit("run")}
            disabled={busy !== null || !prompt.trim()}
          >
            {busy === "run" ? "Running..." : "Run With AI"}
          </button>
        </div>
      </div>

      {status && <div className="strategy-status-msg">{status}</div>}
    </div>
  );
}
