import { useEffect, useMemo, useRef, useState } from "react";
import type {
  HexString,
  StrategyBacktestSummary,
  StrategyBacktestTrade,
  StrategyChartOverlay,
  StrategyTimeframe,
  StrategyToolName
} from "@sinergy/shared";
import { agentApi, agentApiStream } from "../lib/api";
import type {
  ChartViewport,
  MarketSnapshot,
  StrategyAgentPlanResponse,
  StrategyAgentRunResponse,
  StrategyAgentSessionListItem,
  StrategyAgentSessionSnapshot,
  StrategyAgentToolTraceEntry,
  StrategyBacktestBundle
} from "../types";
import { fetchBacktestBundle } from "../lib/api";

type Props = {
  address?: HexString;
  selectedMarket?: MarketSnapshot;
  selectedTimeframe: StrategyTimeframe;
  viewport: ChartViewport | null;
  onBacktestResult: (result: StrategyBacktestBundle | null) => void;
  onTimeframeChange: (timeframe: StrategyTimeframe) => void;
  onReviewStrategy: (strategyId: string, bundle: StrategyBacktestBundle | null, runId?: string) => void;
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
  liveThinking?: string;
  liveWorkflowSteps?: WorkflowStepCard[];
};

type WorkflowStepStatus = "pending" | "running" | "completed" | "error";

type WorkflowStepCard = {
  key: string;
  step?: number;
  tool: string;
  title: string;
  status: WorkflowStepStatus;
  summary: string;
  reasoningSummary?: string;
  detail?: string;
};

type AgentStreamEvent =
  | { type: "status"; message: string }
  | { type: "thinking_delta"; text: string }
  | { type: "content_delta"; text: string }
  | { type: "tool"; phase: "start" | "done" | "error"; tool: string; step?: number; message?: string }
  | { type: "tool_progress"; tool: string; step?: number; message: string }
  | { type: "done"; result: StrategyAgentRunResponse }
  | { type: "error"; message: string };

type StrategyClarification = {
  sidePreference: "both" | "long_only" | "short_only";
  stopLossMode: "recommended" | "none" | "custom";
  customStopLossPct: string;
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

function summarizeThinking(text: string, maxLength = 140) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength).trimEnd()}...`;
}

function humanizeToolName(tool: string) {
  return tool
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function summarizeToolOutput(tool: string, output?: Record<string, unknown>) {
  if (!output) return undefined;

  if (tool === "list_strategy_capabilities" && typeof output.capabilities === "object" && output.capabilities) {
    return "Read available indicators, operators, limits, and supported timeframes.";
  }

  if (tool === "analyze_market_context" && typeof output.analysis === "object" && output.analysis) {
    const analysis = output.analysis as {
      recommendedTimeframe?: string;
      overallRegime?: string;
    };
    const parts = [
      analysis.recommendedTimeframe ? `Recommended TF ${analysis.recommendedTimeframe}` : undefined,
      analysis.overallRegime ? `Regime ${String(analysis.overallRegime).replace(/_/g, " ")}` : undefined
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(" • ") : "Reviewed market regime and timing context.";
  }

  if ((tool === "create_strategy_draft" || tool === "clone_strategy_template" || tool === "update_strategy_draft" || tool === "get_strategy")
    && typeof output.strategy === "object"
    && output.strategy) {
    const strategy = output.strategy as { name?: string; timeframe?: string };
    const parts = [strategy.name, strategy.timeframe].filter(Boolean);
    return parts.length > 0 ? `Prepared strategy ${parts.join(" • ")}.` : "Prepared the strategy payload.";
  }

  if (tool === "validate_strategy_draft" && typeof output.validation === "object" && output.validation) {
    const validation = output.validation as { ok?: boolean; issues?: unknown[] };
    if (validation.ok) {
      return "Validation passed with no blocking issues.";
    }
    return `Validation found ${validation.issues?.length ?? 0} issue(s).`;
  }

  if (tool === "run_strategy_backtest" && typeof output.summary === "object" && output.summary) {
    const summary = output.summary as {
      netPnl?: number;
      winRate?: number;
      totalTrades?: number;
      tradeCount?: number;
      maxDrawdownPct?: number;
      profitFactor?: number;
    };
    const trades = summary.tradeCount ?? summary.totalTrades;
    const parts = [
      typeof summary.netPnl === "number" ? `PnL ${summary.netPnl.toFixed(2)}` : undefined,
      typeof summary.winRate === "number" ? `Win rate ${summary.winRate}` : undefined,
      typeof trades === "number" ? `Trades ${trades}` : undefined,
      typeof summary.profitFactor === "number" ? `PF ${summary.profitFactor}` : undefined,
      typeof summary.maxDrawdownPct === "number" ? `DD ${summary.maxDrawdownPct}` : undefined
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(" • ") : "Backtest finished.";
  }

  return undefined;
}

function summarizeToolReasoning(step: Pick<StrategyAgentToolTraceEntry, "tool" | "reason" | "expectedArtifact" | "resultSummary" | "output" | "error">) {
  if (step.error?.message) {
    return step.error.message;
  }
  if (step.reason) {
    return step.reason;
  }
  if (step.resultSummary) {
    return step.resultSummary.replace(/_/g, " ");
  }
  if (step.expectedArtifact) {
    return `Expected artifact: ${step.expectedArtifact}.`;
  }
  return summarizeToolOutput(step.tool, step.output) ?? "Step completed.";
}

function toWorkflowStepCard(step: StrategyAgentToolTraceEntry): WorkflowStepCard {
  return {
    key: `${step.step}-${step.tool}`,
    step: step.step,
    tool: step.tool,
    title: `${step.step}. ${humanizeToolName(step.tool)}`,
    status: step.error ? "error" : "completed",
    summary: summarizeToolOutput(step.tool, step.output) ?? (step.error?.message ?? "Completed."),
    reasoningSummary: summarizeToolReasoning(step),
    detail: step.error?.message ?? step.expectedArtifact
  };
}

function summarizeLiveToolEvent(tool: string, message?: string, fallback?: string) {
  const trimmed = message?.replace(/\s+/g, " ").trim();
  if (trimmed) {
    return trimmed;
  }
  if (fallback) {
    return fallback;
  }
  return `Working on ${humanizeToolName(tool).toLowerCase()}.`;
}

function upsertWorkflowStep(
  current: WorkflowStepCard[],
  event: {
    tool: string;
    step?: number;
    status?: WorkflowStepStatus;
    summary?: string;
    reasoningSummary?: string;
    detail?: string;
  }
) {
  const key = event.step ? `${event.step}-${event.tool}` : `${current.length + 1}-${event.tool}`;
  const existingIndex = current.findIndex((step) =>
    event.step ? step.key === key : step.status === "running" && step.tool === event.tool
  );

  if (existingIndex === -1) {
    return [
      ...current,
      {
        key,
        step: event.step,
        tool: event.tool,
        title: event.step ? `${event.step}. ${humanizeToolName(event.tool)}` : humanizeToolName(event.tool),
        status: event.status ?? "running",
        summary: event.summary ?? `Starting ${humanizeToolName(event.tool).toLowerCase()}.`,
        reasoningSummary: event.reasoningSummary,
        detail: event.detail
      }
    ];
  }

  return current.map((step, index) =>
    index === existingIndex
      ? {
          ...step,
          status: event.status ?? step.status,
          summary: event.summary ?? step.summary,
          reasoningSummary: event.reasoningSummary ?? step.reasoningSummary,
          detail: event.detail ?? step.detail
        }
      : step
  );
}

function buildEmptyConversationSuggestion() {
  return 'Try something like: "Create an EMA crossover strategy for this market, validate it, and run a backtest." Sessions and linked strategies stay available in the right rail.';
}

function shouldAskStrategyClarification(goal: string) {
  const normalized = goal.trim().toLowerCase();
  if (!normalized) return false;

  const creationPatterns = [
    /\b(create|build|generate|make|design|draft|start)\b[\s\S]{0,80}\b(strategy|bot|system)\b/u,
    /\b(strategy|bot|system)\b[\s\S]{0,80}\b(from scratch|new)\b/u,
    /\b(crea|crear|genera|generar|disena|diseña|arma|construye|haz|desarrolla)\b[\s\S]{0,80}\b(estrategia|bot|sistema)\b/u,
    /\b(estrategia|bot|sistema)\b[\s\S]{0,80}\b(desde cero|nueva)\b/u
  ];

  return creationPatterns.some((pattern) => pattern.test(normalized));
}

export function StrategyAgentPanel({
  address,
  selectedMarket,
  selectedTimeframe,
  viewport,
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
  const [clarifierOpen, setClarifierOpen] = useState(false);
  const [clarifierMode, setClarifierMode] = useState<"plan" | "run" | null>(null);
  const [clarifierGoal, setClarifierGoal] = useState("");
  const [clarification, setClarification] = useState<StrategyClarification>({
    sidePreference: "both",
    stopLossMode: "recommended",
    customStopLossPct: ""
  });
  const [liveThinking, setLiveThinking] = useState("");
  const [liveFinalText, setLiveFinalText] = useState("");
  const [liveWorkflowSteps, setLiveWorkflowSteps] = useState<WorkflowStepCard[]>([]);
  const [collapsedThinkingIds, setCollapsedThinkingIds] = useState<Record<string, boolean>>({});
  const [liveThinkingCollapsed, setLiveThinkingCollapsed] = useState(false);
  const promptTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const activeRunMessageIdRef = useRef<string | null>(null);
  const emptyConversationSuggestion = buildEmptyConversationSuggestion();

  const storageKey = useMemo(() => {
    if (!address || !selectedMarket?.id) return null;
    return `sinergy.strategy-agent.${address}.${selectedMarket.id}`;
  }, [address, selectedMarket?.id]);

  async function loadRuntime(options?: { silent?: boolean }) {
    try {
      const result = await agentApi<AgentCapabilitiesResponse>("/capabilities");
      setRuntime(result);
    } catch (error) {
      if (!options?.silent) {
        setStatus(error instanceof Error ? error.message : String(error));
      }
    }
  }

  const runtimeBadge = useMemo(() => {
    if (!runtime) return "Ready";
    if (!runtime.model.reachable) return "Offline";
    return runtime.model.toolCallingObserved ? "Native tools" : "Ready";
  }, [runtime]);
  const clarificationRequired = useMemo(() => shouldAskStrategyClarification(prompt), [prompt]);

  async function loadSession(sessionId: string, options?: { updateStatus?: boolean }) {
    if (!address) return;

    const payload = await agentApi<{ ok: true; result: { session: StrategyAgentSessionSnapshot } }>(
      `/sessions/${sessionId}?ownerAddress=${address}`
    );
    setSession(payload.result.session);
    setMessages(toMessagesFromSession(payload.result.session));
    setLiveThinking("");
    setLiveFinalText("");
    setLiveWorkflowSteps([]);
    setLiveThinkingCollapsed(false);

    if (payload.result.session.runId) {
      try {
        const restoredBundle = await fetchBacktestBundle(address, payload.result.session.runId);
        onTimeframeChange(restoredBundle.summary.timeframe);
        onBacktestResult(restoredBundle);
      } catch {
        onBacktestResult(null);
      }
    } else {
      onBacktestResult(null);
    }

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
        setHistory([]);
      }
    }

    void loadWorkspace();
    return () => {
      cancelled = true;
    };
  }, [address, selectedMarket?.id, storageKey]);

  useEffect(() => {
    if (!historyRailOpen || !address || !selectedMarket?.id) {
      return;
    }

    void refreshHistory();
  }, [address, historyRailOpen, selectedMarket?.id]);

  useEffect(() => {
    if (!storageKey || typeof window === "undefined") return;

    const payload: PersistedAgentState = {
      prompt,
      activeSessionId: session?.sessionId
    };

    window.sessionStorage.setItem(storageKey, JSON.stringify(payload));
  }, [prompt, session?.sessionId, storageKey]);

  useEffect(() => {
    const textarea = promptTextareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
  }, [prompt]);

  useEffect(() => {
    const thread = threadRef.current;
    if (!thread) return;
    thread.scrollTo({
      top: thread.scrollHeight,
      behavior: "smooth"
    });
  }, [messages, status]);

  useEffect(() => {
    const thread = threadRef.current;
    if (!thread || busy !== "run") return;

    let frameId = 0;
    const scrollToBottom = () => {
      cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => {
        thread.scrollTop = thread.scrollHeight;
      });
    };

    const observer = new MutationObserver(() => {
      scrollToBottom();
    });

    observer.observe(thread, {
      childList: true,
      subtree: true,
      characterData: true
    });

    scrollToBottom();

    return () => {
      cancelAnimationFrame(frameId);
      observer.disconnect();
    };
  }, [busy]);

  function updateMessage(messageId: string, updater: (message: AgentMessage) => AgentMessage) {
    setMessages((current) =>
      current.map((message) => (message.id === messageId ? updater(message) : message))
    );
  }

  useEffect(() => {
    if (!clarificationRequired && clarifierOpen) {
      setClarifierOpen(false);
      setClarifierGoal("");
      setClarifierMode(null);
    }
  }, [clarificationRequired, clarifierOpen]);

  async function submit(mode: "plan" | "run") {
    const goal = prompt.trim();
    if (!address || !goal || !selectedMarket) return;
    void loadRuntime({ silent: true });

    if (clarificationRequired && (!clarifierOpen || clarifierGoal !== goal || clarifierMode !== mode)) {
      setClarifierOpen(true);
      setClarifierGoal(goal);
      setClarifierMode(mode);
      setStatus("Confirm side and stop-loss preferences before running the agent.");
      return;
    }

    const stopLossLine =
      clarification.stopLossMode === "custom" && clarification.customStopLossPct.trim()
        ? `custom ${clarification.customStopLossPct.trim()}%`
        : clarification.stopLossMode === "none"
          ? "none"
          : "recommended";

    const enrichedGoal = [
      goal,
      "",
      "User execution preferences:",
      `- selected chart timeframe: ${selectedTimeframe}`,
      `- allowed sides: ${clarification.sidePreference === "both" ? "long and short" : clarification.sidePreference === "long_only" ? "long only" : "short only"}`,
      `- stop loss preference: ${stopLossLine}`
    ].join("\n");

    const userMessage: AgentMessage = {
      id: buildMessageId(),
      role: "user",
      text: enrichedGoal,
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
                strategyId: session?.strategyId,
                preferredTimeframe: selectedTimeframe,
                chartBars: viewport?.bars,
                chartFromTs: viewport?.fromTs,
                chartToTs: viewport?.toTs,
                goal: enrichedGoal,
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

      const liveAssistantMessageId = buildMessageId();
      activeRunMessageIdRef.current = liveAssistantMessageId;
      setMessages((current) => [
        ...current,
        {
          id: liveAssistantMessageId,
          role: "assistant",
          text: "",
          mode,
          liveWorkflowSteps: []
        }
      ]);
      let streamedThinking = "";
      let streamedFinalText = "";

      await agentApiStream(
        "/strategy/run/stream",
        {
          method: "POST",
          body: JSON.stringify({
            ownerAddress: address,
            marketId: selectedMarket.id,
            strategyId: session?.strategyId,
            preferredTimeframe: selectedTimeframe,
            chartBars: viewport?.bars,
            chartFromTs: viewport?.fromTs,
            chartToTs: viewport?.toTs,
            goal: enrichedGoal,
            sessionId: session?.sessionId,
            mode
          })
        },
        {
          onEvent: (event, raw) => {
            const payload = raw as AgentStreamEvent;
            if (event === "status" && payload.type === "status") {
              setStatus(payload.message);
              return;
            }
            if (event === "thinking_delta" && payload.type === "thinking_delta") {
              streamedThinking += payload.text;
              if (activeRunMessageIdRef.current) {
                updateMessage(activeRunMessageIdRef.current, (message) => ({
                  ...message,
                  liveThinking: (message.liveThinking ?? "") + payload.text
                }));
              }
              return;
            }
            if (event === "content_delta" && payload.type === "content_delta") {
              streamedFinalText += payload.text;
              if (activeRunMessageIdRef.current) {
                updateMessage(activeRunMessageIdRef.current, (message) => ({
                  ...message,
                  text: message.text + payload.text
                }));
              }
              return;
            }
            if (event === "tool" && payload.type === "tool") {
              if (activeRunMessageIdRef.current) {
                updateMessage(activeRunMessageIdRef.current, (message) => ({
                  ...message,
                  liveWorkflowSteps: upsertWorkflowStep(message.liveWorkflowSteps ?? [], {
                    tool: payload.tool,
                    step: payload.step,
                    status:
                      payload.phase === "start"
                        ? "running"
                        : payload.phase === "done"
                          ? "completed"
                          : "error",
                    summary: summarizeLiveToolEvent(
                      payload.tool,
                      payload.message,
                      payload.phase === "start"
                        ? `Starting ${humanizeToolName(payload.tool).toLowerCase()}.`
                        : payload.phase === "done"
                          ? `${humanizeToolName(payload.tool)} completed.`
                          : `${humanizeToolName(payload.tool)} failed.`
                    ),
                    reasoningSummary: payload.message,
                    detail:
                      payload.phase === "start"
                        ? "Step started."
                        : payload.phase === "done"
                          ? "Step finished."
                          : payload.message
                  })
                }));
              }
              return;
            }
            if (event === "tool_progress" && payload.type === "tool_progress") {
              if (activeRunMessageIdRef.current) {
                updateMessage(activeRunMessageIdRef.current, (message) => ({
                  ...message,
                  liveWorkflowSteps: upsertWorkflowStep(message.liveWorkflowSteps ?? [], {
                    tool: payload.tool,
                    step: payload.step,
                    status: "running",
                    summary: summarizeLiveToolEvent(payload.tool, payload.message),
                    reasoningSummary: payload.message,
                    detail: "Streaming tool update."
                  })
                }));
              }
              return;
            }
            if (event === "done" && payload.type === "done") {
              const bundle = toBacktestBundle(payload.result.toolTrace);
              if (bundle) {
                onTimeframeChange(bundle.summary.timeframe);
                setTimeout(() => {
                  onBacktestResult(bundle);
                }, 50);
              }

              setSession(payload.result.session);
              if (activeRunMessageIdRef.current) {
                updateMessage(activeRunMessageIdRef.current, (message) => ({
                  ...message,
                  text: payload.result.finalMessage || message.text || streamedFinalText,
                  usedTools: payload.result.usedTools,
                  trace: payload.result.toolTrace,
                  warnings: payload.result.warnings,
                  strategyId: payload.result.artifacts.strategyId ?? payload.result.session.strategyId,
                  bundle,
                  liveThinking: streamedThinking || undefined,
                  liveWorkflowSteps: undefined
                }));
                activeRunMessageIdRef.current = null;
              }
              setStatus(
                payload.result.session.strategyId
                  ? "Agent workflow finished. Session and strategy are ready to reopen."
                  : "Agent workflow finished."
              );
              setLiveThinkingCollapsed(false);
              void refreshHistory(payload.result.session.sessionId, false);
              return;
            }
            if (event === "error" && payload.type === "error") {
              throw new Error(payload.message);
            }
          }
        }
      );
    } catch (error) {
      if (activeRunMessageIdRef.current) {
        updateMessage(activeRunMessageIdRef.current, (message) => ({
          ...message,
          text: error instanceof Error ? error.message : String(error),
          liveWorkflowSteps: undefined
        }));
        activeRunMessageIdRef.current = null;
      } else {
        setMessages((current) => [
          ...current,
          {
            id: buildMessageId(),
            role: "assistant",
            text: error instanceof Error ? error.message : String(error),
            mode
          }
        ]);
      }
      setStatus("Agent request failed.");
    } finally {
      setBusy(null);
    }
  }

  function startNewSession() {
    setMessages([]);
    setSession(null);
    setClarifierOpen(false);
    setClarifierGoal("");
    setClarifierMode(null);
    setLiveThinking("");
    setLiveFinalText("");
    setLiveWorkflowSteps([]);
    setLiveThinkingCollapsed(false);
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
          <small>{runtime?.model.modelName ?? "Loads on first message"}</small>
        </div>
      </div>

      <div className="strategy-agent-context">
        <span>Market</span>
        <strong>{selectedMarket?.symbol ?? "Select a market"}</strong>
        <span>Tools</span>
        <strong>{runtime?.tools.length ?? "--"}</strong>
        <span>Session</span>
        <strong>{session ? shortId(session.sessionId) : "New"}</strong>
        <span>Chart TF</span>
        <strong>{selectedTimeframe}</strong>
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

          <div className="strategy-agent-thread" ref={threadRef}>
            {messages.length === 0 ? (
              null
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
                  {message.liveThinking && (
                    <div className="strategy-agent-trace">
                      <button
                        type="button"
                        className={`strategy-agent-thinking-card ${collapsedThinkingIds[message.id] ? "collapsed" : ""}`}
                        onClick={() =>
                          setCollapsedThinkingIds((current) => ({
                            ...current,
                            [message.id]: !current[message.id]
                          }))
                        }
                        aria-expanded={!collapsedThinkingIds[message.id]}
                      >
                        <span className="strategy-agent-thinking-title">Thinking</span>
                        <small className="strategy-agent-thinking-body">
                          {collapsedThinkingIds[message.id]
                            ? summarizeThinking(message.liveThinking)
                            : message.liveThinking}
                        </small>
                      </button>
                    </div>
                  )}
                  <p>{message.text}</p>

                  {message.liveWorkflowSteps && message.liveWorkflowSteps.length > 0 && (
                    <div className="strategy-agent-trace">
                      {message.liveWorkflowSteps.map((step) => (
                        <div key={step.key} className={`strategy-agent-step-card status-${step.status}`}>
                          <div className="strategy-agent-step-head">
                            <strong>{step.title}</strong>
                            <span>{step.status}</span>
                          </div>
                          <small>{step.summary}</small>
                          {step.reasoningSummary && (
                            <p className="strategy-agent-step-reasoning">{summarizeThinking(step.reasoningSummary, 220)}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

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
                      {message.trace.map((entry) => {
                        const card = toWorkflowStepCard(entry);
                        return (
                          <div
                            key={`${message.id}-${entry.step}`}
                            className={`strategy-agent-step-card status-${card.status}`}
                          >
                            <div className="strategy-agent-step-head">
                              <strong>{card.title}</strong>
                              <span>{card.status}</span>
                            </div>
                            <small>{card.summary}</small>
                            {card.reasoningSummary && (
                              <p className="strategy-agent-step-reasoning">{card.reasoningSummary}</p>
                            )}
                          </div>
                        );
                      })}
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
                      onClick={() =>
                        onReviewStrategy(
                          message.strategyId!,
                          message.bundle ?? null,
                          message.bundle?.summary.runId
                        )
                      }
                    >
                      Review In Builder
                    </button>
                  )}
                </div>
              ))
            )}

          </div>

          <div className="strategy-agent-compose">
            {messages.length === 0 && (
              <div className="strategy-agent-suggestion" aria-live="polite">
                {emptyConversationSuggestion}
              </div>
            )}
            <textarea
              ref={promptTextareaRef}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={1}
              placeholder="Describe the strategy you want to build, validate, improve, or continue..."
            />
            {clarifierOpen && clarificationRequired && (
              <div className="strategy-agent-trace">
                <div>
                  <strong>Agent needs two quick preferences before running</strong>
                  <small>Choose allowed sides and how stop loss should be handled.</small>
                </div>
                <div className="strategy-agent-chips">
                  <button
                    type="button"
                    className={clarification.sidePreference === "both" ? "strategy-agent-review-btn" : ""}
                    onClick={() => setClarification((current) => ({ ...current, sidePreference: "both" }))}
                  >
                    Long + Short
                  </button>
                  <button
                    type="button"
                    className={clarification.sidePreference === "long_only" ? "strategy-agent-review-btn" : ""}
                    onClick={() => setClarification((current) => ({ ...current, sidePreference: "long_only" }))}
                  >
                    Long only
                  </button>
                  <button
                    type="button"
                    className={clarification.sidePreference === "short_only" ? "strategy-agent-review-btn" : ""}
                    onClick={() => setClarification((current) => ({ ...current, sidePreference: "short_only" }))}
                  >
                    Short only
                  </button>
                </div>
                <div className="strategy-agent-chips">
                  <button
                    type="button"
                    className={clarification.stopLossMode === "recommended" ? "strategy-agent-review-btn" : ""}
                    onClick={() => setClarification((current) => ({ ...current, stopLossMode: "recommended" }))}
                  >
                    Recommended SL
                  </button>
                  <button
                    type="button"
                    className={clarification.stopLossMode === "none" ? "strategy-agent-review-btn" : ""}
                    onClick={() => setClarification((current) => ({ ...current, stopLossMode: "none" }))}
                  >
                    No SL
                  </button>
                  <button
                    type="button"
                    className={clarification.stopLossMode === "custom" ? "strategy-agent-review-btn" : ""}
                    onClick={() => setClarification((current) => ({ ...current, stopLossMode: "custom" }))}
                  >
                    Custom SL
                  </button>
                </div>
                {clarification.stopLossMode === "custom" && (
                  <input
                    type="number"
                    min="0.1"
                    step="0.1"
                    value={clarification.customStopLossPct}
                    onChange={(event) =>
                      setClarification((current) => ({
                        ...current,
                        customStopLossPct: event.target.value
                      }))
                    }
                    placeholder="Stop loss %"
                  />
                )}
              </div>
            )}
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
                disabled={
                  busy !== null ||
                  !prompt.trim() ||
                  (clarifierOpen &&
                    clarificationRequired &&
                    clarification.stopLossMode === "custom" &&
                    !clarification.customStopLossPct.trim())
                }
              >
                {busy === "plan"
                  ? "Planning..."
                  : busy === "run"
                    ? "Running..."
                    : planModeEnabled
                      ? "Plan"
                      : "Send"}
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
                  onClick={() => onReviewStrategy(session.strategyId!, null, session.runId)}
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
                          onClick={() => onReviewStrategy(item.strategyId!, null, item.runId)}
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
