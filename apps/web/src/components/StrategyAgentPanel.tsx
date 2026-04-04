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
  StrategyAgentSessionListItem,
  StrategyAgentSessionSnapshot,
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

type PersistedAgentState = {
  prompt: string;
  activeSessionId?: string;
};

function buildMessageId() {
  return `agent-msg-${crypto.randomUUID()}`;
}

function shortId(value?: string) {
  if (!value) return "--";
  return value.length <= 14 ? value : `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function readPersistedAgentState(storageKey: string): PersistedAgentState | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.sessionStorage.getItem(storageKey);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedAgentState;
  } catch {
    return null;
  }
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

function toMessagesFromSession(session: StrategyAgentSessionSnapshot): AgentMessage[] {
  return session.recentTurns.map((turn) => ({
    id: turn.id,
    role: turn.role,
    text: turn.text,
    mode: turn.mode,
    usedTools: turn.usedTools,
    warnings: turn.warnings,
    strategyId: turn.role === "assistant" ? session.strategyId : undefined
  }));
}

function formatTimestamp(value: string) {
  return new Date(value).toLocaleString();
}

function summarizeSession(item: StrategyAgentSessionListItem) {
  return item.strategy?.name ?? item.lastUserMessage ?? "Untitled session";
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
  const [session, setSession] = useState<StrategyAgentSessionSnapshot | null>(null);
  const [history, setHistory] = useState<StrategyAgentSessionListItem[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyRailOpen, setHistoryRailOpen] = useState(false);
  const [planModeEnabled, setPlanModeEnabled] = useState(false);

  const storageKey = useMemo(() => {
    if (!address || !selectedMarket?.id) return null;
    return `sinergy.strategy-agent.${address}.${selectedMarket.id}`;
  }, [address, selectedMarket?.id]);

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

  async function loadSession(sessionId: string, options?: { updateStatus?: boolean }) {
    if (!address) return;

    const payload = await agentApi<{ ok: true; result: { session: StrategyAgentSessionSnapshot } }>(
      `/sessions/${sessionId}?ownerAddress=${address}`
    );
    setSession(payload.result.session);
    setMessages(toMessagesFromSession(payload.result.session));
    onBacktestResult(null);

    if (payload.result.session.strategy?.timeframe) {
      onTimeframeChange(payload.result.session.strategy.timeframe);
    }

    if (options?.updateStatus !== false) {
      setStatus("Session loaded.");
    }
  }

  async function refreshHistory(preferredSessionId?: string, hydrateSession = false) {
    if (!address || !selectedMarket?.id) {
      setHistory([]);
      return;
    }

    setHistoryBusy(true);
    try {
      const payload = await agentApi<{ ok: true; result: { sessions: StrategyAgentSessionListItem[] } }>(
        `/sessions?ownerAddress=${address}&marketId=${selectedMarket.id}&limit=20`
      );
      setHistory(payload.result.sessions);

      const targetSessionId = preferredSessionId ?? session?.sessionId;
      if (
        hydrateSession &&
        targetSessionId &&
        payload.result.sessions.some((item) => item.sessionId === targetSessionId)
      ) {
        await loadSession(targetSessionId, { updateStatus: false });
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setHistoryBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function loadWorkspace() {
      if (!storageKey || !address || !selectedMarket?.id) {
        setPrompt("");
        setMessages([]);
        setSession(null);
        setHistory([]);
        return;
      }

      const persisted = readPersistedAgentState(storageKey);
      if (!cancelled) {
        setPrompt(persisted?.prompt ?? "");
        setMessages([]);
        setSession(null);
      }

      await refreshHistory(persisted?.activeSessionId, Boolean(persisted?.activeSessionId));
    }

    void loadWorkspace();
    return () => {
      cancelled = true;
    };
  }, [address, selectedMarket?.id, storageKey]);

  useEffect(() => {
    if (!storageKey || typeof window === "undefined") return;

    const payload: PersistedAgentState = {
      prompt,
      activeSessionId: session?.sessionId
    };

    window.sessionStorage.setItem(storageKey, JSON.stringify(payload));
  }, [prompt, session?.sessionId, storageKey]);

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
        const payload = await agentApi<{ ok: true; result: StrategyAgentPlanResponse }>("/strategy/plan", {
          method: "POST",
          body: JSON.stringify({
            ownerAddress: address,
            marketId: selectedMarket.id,
            goal,
            sessionId: session?.sessionId,
            mode
          })
        });

        setSession(payload.result.session);
        setMessages((current) => [
          ...current,
          {
            id: buildMessageId(),
            role: "assistant",
            text: payload.result.finalMessage,
            mode,
            plannedTools: payload.result.plannedTools,
            warnings: payload.result.warnings,
            strategyId: payload.result.session.strategyId
          }
        ]);
        setStatus("Plan ready.");
        void refreshHistory(payload.result.session.sessionId, false);
        return;
      }

      const payload = await agentApi<{ ok: true; result: StrategyAgentRunResponse }>("/strategy/run", {
        method: "POST",
        body: JSON.stringify({
          ownerAddress: address,
          marketId: selectedMarket.id,
          goal,
          sessionId: session?.sessionId,
          mode
        })
      });

      const bundle = toBacktestBundle(payload.result.toolTrace);
      if (bundle) {
        onTimeframeChange(bundle.summary.timeframe);
        setTimeout(() => {
          onBacktestResult(bundle);
        }, 50);
      }

      setSession(payload.result.session);
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
          strategyId: payload.result.artifacts.strategyId ?? payload.result.session.strategyId,
          bundle
        }
      ]);
      setStatus(
        payload.result.session.strategyId
          ? "Agent workflow finished. Session and strategy are ready to reopen."
          : "Agent workflow finished."
      );
      void refreshHistory(payload.result.session.sessionId, false);
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

  function startNewSession() {
    setMessages([]);
    setSession(null);
    setStatus("Started a fresh strategy session.");
    onBacktestResult(null);
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
        <span>Session</span>
        <strong>{session ? shortId(session.sessionId) : "New"}</strong>
        <span>Strategy</span>
        <strong>{session?.strategy?.name ?? shortId(session?.strategyId)}</strong>
      </div>

      <div className={`strategy-agent-workspace ${historyRailOpen ? "sessions-open" : "sessions-closed"}`}>
        <div className="strategy-agent-main">
          <div className="strategy-agent-main-toolbar">
            <div className="strategy-agent-main-copy">
              <strong>Conversation</strong>
              <small>
                {session
                  ? `${session.turnCount} turns in memory • session ${shortId(session.sessionId)}`
                  : "Start a fresh run or reopen one from the sessions rail."}
              </small>
            </div>
            <button
              type="button"
              className="strategy-agent-rail-toggle"
              onClick={() => setHistoryRailOpen((current) => !current)}
              aria-expanded={historyRailOpen}
              aria-label={historyRailOpen ? "Hide sessions panel" : "Show sessions panel"}
            >
              <span className="strategy-agent-rail-icon" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              <span>{historyRailOpen ? "Hide Sessions" : "Show Sessions"}</span>
            </button>
          </div>

          <div className="strategy-agent-thread">
            {messages.length === 0 ? (
              <div className="strategy-empty-state">
                Try something like: "Create an EMA crossover strategy for this market, validate it, and run a
                backtest." Sessions and linked strategies stay available in the right rail.
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
              placeholder="Describe the strategy you want to build, validate, improve, or continue..."
            />
            <div className="strategy-agent-actions">
              <label className="strategy-agent-plan-toggle">
                <input
                  type="checkbox"
                  checked={planModeEnabled}
                  onChange={(event) => setPlanModeEnabled(event.target.checked)}
                  disabled={busy !== null}
                />
                <span>Plan mode</span>
              </label>
              <button
                type="button"
                onClick={startNewSession}
                disabled={busy !== null}
              >
                New Session
              </button>
              <button
                type="button"
                className="strategy-primary-btn strategy-agent-submit-btn"
                onClick={() => void submit(planModeEnabled ? "plan" : "run")}
                disabled={busy !== null || !prompt.trim()}
              >
                {busy === "plan"
                  ? "Planning..."
                  : busy === "run"
                    ? "Running..."
                    : planModeEnabled
                      ? "Plan With AI"
                      : "Run With AI"}
              </button>
            </div>
          </div>

          {status && <div className="strategy-status-msg strategy-agent-status-msg">{status}</div>}
        </div>

        <button
          type="button"
          className={`strategy-agent-rail-backdrop ${historyRailOpen ? "open" : ""}`}
          onClick={() => setHistoryRailOpen(false)}
          aria-hidden={!historyRailOpen}
          tabIndex={historyRailOpen ? 0 : -1}
        />

        <aside className="strategy-agent-sidebar" aria-hidden={!historyRailOpen}>
          <div className="strategy-agent-session-bar">
            <div className="strategy-agent-session-copy">
              <strong>Session Workspace</strong>
              <small>
                {session
                  ? `${session.turnCount} turns in memory • updated ${formatTimestamp(session.updatedAt)}`
                  : "Pick a previous session from the right rail or start a fresh one for this market."}
              </small>
            </div>
            <div className="strategy-agent-session-actions">
              {session?.strategyId && (
                <button
                  type="button"
                  onClick={() => onReviewStrategy(session.strategyId!, null)}
                  disabled={busy !== null}
                >
                  Open Strategy In Builder
                </button>
              )}
              <button type="button" onClick={startNewSession} disabled={busy !== null}>
                New Session
              </button>
            </div>
          </div>

          <div className="strategy-agent-history">
            <div className="strategy-agent-history-head">
              <div>
                <strong>Session History</strong>
                <small>Your recent runs for this market.</small>
              </div>
              <div className="strategy-agent-history-head-actions">
                <button type="button" onClick={() => void refreshHistory()} disabled={historyBusy || busy !== null}>
                  {historyBusy ? "Refreshing..." : "Refresh"}
                </button>
                <button type="button" onClick={() => setHistoryRailOpen(false)} disabled={busy !== null}>
                  Close
                </button>
              </div>
            </div>

            {history.length === 0 ? (
              <div className="strategy-empty-state">No saved sessions yet for this market.</div>
            ) : (
              <div className="strategy-agent-history-list">
                {history.map((item) => (
                  <div
                    key={item.sessionId}
                    className={`strategy-agent-history-card ${item.sessionId === session?.sessionId ? "active" : ""}`}
                  >
                    <div className="strategy-agent-history-copy">
                      <strong>{summarizeSession(item)}</strong>
                      <small>{formatTimestamp(item.updatedAt)}</small>
                      <p>{item.lastAssistantMessage ?? item.lastUserMessage ?? "Session without messages yet."}</p>
                      <div className="strategy-agent-chips">
                        <span>{item.turnCount} turns</span>
                        {item.strategy?.status && <span>{item.strategy.status}</span>}
                        {item.strategy?.timeframe && <span>{item.strategy.timeframe}</span>}
                      </div>
                    </div>
                    <div className="strategy-agent-history-actions">
                      <button type="button" onClick={() => void loadSession(item.sessionId)} disabled={busy !== null}>
                        Open Session
                      </button>
                      {item.strategyId && (
                        <button
                          type="button"
                          onClick={() => onReviewStrategy(item.strategyId!, null)}
                          disabled={busy !== null}
                        >
                          Open Strategy
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
