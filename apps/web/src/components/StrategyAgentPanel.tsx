import { useEffect, useMemo, useRef, useState } from "react";
import { useInterwovenKit } from "@initia/interwovenkit-react";
import { useSignTypedData } from "wagmi";
import type {
  HexString,
  StrategyBacktestSummary,
  StrategyBacktestTrade,
  StrategyChartOverlay,
  StrategyTimeframe,
  StrategyToolName
} from "@sinergy/shared";
import {
  agentApi,
  agentApiStream,
  createStrategyExecutionIntent,
  executeApprovedStrategy,
  fetchStrategyExecutionApproval,
  saveStrategyExecutionApproval
} from "../lib/api";
import type {
  ChartViewport,
  MarketSnapshot,
  StrategyApprovalRecord,
  StrategyAgentPlanResponse,
  StrategyAgentRunResponse,
  StrategyAgentSessionListItem,
  StrategyAgentSessionSnapshot,
  StrategyAgentToolTraceEntry,
  StrategyBacktestBundle
} from "../types";
import { fetchBacktestBundle } from "../lib/api";
import { depositToSinergyRollup } from "../lib/bridgeDeposit";
import { DEFAULT_SINERGY_BRIDGE_ASSET, resolveRollupRestUrl } from "../initia";
import type { TxPopupData } from "./TransactionPopup";

type Props = {
  address?: HexString;
  selectedMarket?: MarketSnapshot;
  selectedTimeframe: StrategyTimeframe;
  viewport: ChartViewport | null;
  onBacktestResult: (result: StrategyBacktestBundle | null) => void;
  onTimeframeChange: (timeframe: StrategyTimeframe) => void;
  onReviewStrategy: (strategyId: string, bundle: StrategyBacktestBundle | null, runId?: string) => void;
  onStrategyStarted?: () => void;
  onConnect?: () => void;
  initiaAddress?: string;
  showTx?: (data: TxPopupData) => void;
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
  initiaAddress,
  selectedMarket,
  selectedTimeframe,
  viewport,
  onBacktestResult,
  onTimeframeChange,
  onReviewStrategy,
  onStrategyStarted,
  onConnect,
  showTx
}: Props) {
  const { requestTxBlock } = useInterwovenKit();
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
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [executionBusy, setExecutionBusy] = useState(false);
  const [approval, setApproval] = useState<StrategyApprovalRecord | null>(null);
  const [changeRequestByMessage, setChangeRequestByMessage] = useState<Record<string, string>>({});
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

  function scrollThreadToBottom(behavior: ScrollBehavior = "auto") {
    const thread = threadRef.current;
    if (!thread) return;

    window.requestAnimationFrame(() => {
      thread.scrollTo({
        top: thread.scrollHeight,
        behavior
      });
    });
  }
  const emptyConversationSuggestion = buildEmptyConversationSuggestion();
  const { signTypedDataAsync } = useSignTypedData();

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

      if (persisted?.activeSessionId && !cancelled) {
        try {
          await loadSession(persisted.activeSessionId, { updateStatus: false });
        } catch {
          if (!cancelled) {
            setStatus("Could not restore the previous agent session.");
          }
        }
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
    let cancelled = false;

    async function loadApproval() {
      if (!address || !session?.strategyId) {
        setApproval(null);
        return;
      }

      try {
        const result = await fetchStrategyExecutionApproval(address, session.strategyId);
        if (!cancelled) {
          setApproval(result);
        }
      } catch {
        if (!cancelled) {
          setApproval(null);
        }
      }
    }

    void loadApproval();
    return () => {
      cancelled = true;
    };
  }, [address, session?.strategyId, session?.updatedAt]);

  useEffect(() => {
    const textarea = promptTextareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
  }, [prompt]);

  useEffect(() => {
    scrollThreadToBottom(busy === "run" ? "auto" : "smooth");
  }, [messages, status]);

  useEffect(() => {
    const thread = threadRef.current;
    if (!thread || busy !== "run") return;

    let frameId = 0;
    const scrollToBottom = () => {
      cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => {
        scrollThreadToBottom();
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

    if (clarifierOpen) {
      setClarifierOpen(false);
      setClarifierGoal("");
      setClarifierMode(null);
    }

    const userMessage: AgentMessage = {
      id: buildMessageId(),
      role: "user",
      text: enrichedGoal,
      mode
    };
    setMessages((current) => [...current, userMessage]);
    setPrompt("");
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

  async function authorizeOnchainExecution() {
    if (!address || !session?.strategyId) {
      throw new Error("Connect wallet and create a strategy before authorizing execution.");
    }

    setApprovalBusy(true);
    setStatus("Preparing onchain authorization...");

    try {
      const intent = await createStrategyExecutionIntent({
        ownerAddress: address,
        strategyId: session.strategyId
      });

      const signature = await signTypedDataAsync({
        domain: intent.domain,
        types: intent.types,
        primaryType: intent.primaryType,
        message: {
          owner: intent.message.owner,
          strategyIdHash: intent.message.strategyIdHash,
          strategyHash: intent.message.strategyHash,
          marketId: intent.message.marketId,
          maxSlippageBps: BigInt(intent.message.maxSlippageBps),
          nonce: BigInt(intent.message.nonce),
          deadline: BigInt(intent.message.deadline)
        }
      });

      const record = await saveStrategyExecutionApproval({
        ownerAddress: address,
        strategyId: session.strategyId,
        message: intent.message,
        signature
      });

      setApproval(record);
      setStatus("Strategy authorized for onchain execution.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setApprovalBusy(false);
    }
  }

  async function runAuthorizedExecution() {
    if (!address || !session?.strategyId) {
      return;
    }

    setExecutionBusy(true);
    setStatus("Executing approved strategy...");

    try {
      const result = await executeApprovedStrategy({
        ownerAddress: address,
        strategyId: session.strategyId
      });

      setApproval(null);

      if (result.action === "no_action") {
        setStatus(typeof result.reason === "string" ? result.reason : "No live action was taken.");
      } else if (result.action === "router_swap") {
        setStatus("Approved strategy executed through the router.");
      } else if (result.action === "dark_pool_order") {
        setStatus("Approved strategy placed a dark-pool order.");
      } else {
        setStatus("Approved strategy execution finished.");
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setExecutionBusy(false);
    }
  }

  async function runStrategyAfterBridge(strategyId: string) {
    if (!address || !initiaAddress) {
      onConnect?.();
      return;
    }

    setExecutionBusy(true);
    setStatus("Funding this strategy through the local OPinit deposit flow...");

    try {
      if (!approval || approval.strategyId !== strategyId) {
        setStatus("Preparing execution approval before bridge funding...");
        const intent = await createStrategyExecutionIntent({
          ownerAddress: address,
          strategyId
        });

        const signature = await signTypedDataAsync({
          domain: intent.domain,
          types: intent.types,
          primaryType: intent.primaryType,
          message: {
            owner: intent.message.owner,
            strategyIdHash: intent.message.strategyIdHash,
            strategyHash: intent.message.strategyHash,
            marketId: intent.message.marketId,
            maxSlippageBps: BigInt(intent.message.maxSlippageBps),
            nonce: BigInt(intent.message.nonce),
            deadline: BigInt(intent.message.deadline)
          }
        });

        const record = await saveStrategyExecutionApproval({
          ownerAddress: address,
          strategyId,
          message: intent.message,
          signature
        });
        setApproval(record);
      }

      const bridgeAsset = DEFAULT_SINERGY_BRIDGE_ASSET;
      if (!bridgeAsset) {
        throw new Error("No bridge-backed asset is configured for this deployment.");
      }

      const bridgeAmount = "1";
      setStatus(`Depositing ${bridgeAmount} ${bridgeAsset.sourceSymbol} to Sinergy through OPinit...`);
      const deposit = await depositToSinergyRollup({
        requestTxBlock,
        initiaAddress,
        amount: bridgeAmount,
        bridgeAsset,
        restUrl: resolveRollupRestUrl(),
        onSubmitted: () => {
          setStatus("Deposit submitted. Waiting for Sinergy balance before starting the strategy...");
        }
      });
      const successMsg = deposit.creditedBalance !== null
        ? `${bridgeAmount} ${bridgeAsset.sourceSymbol} arrived on Sinergy${deposit.sequence ? ` (deposit #${deposit.sequence})` : ""}.`
        : `Deposit submitted${deposit.sequence ? ` as #${deposit.sequence}` : ""}; Sinergy balance may need a short moment to refresh.`;
      showTx?.({
        type: "bridge-success",
        title: "Bridge Complete!",
        message: successMsg,
        amount: `${bridgeAmount} ${bridgeAsset.sourceSymbol}`,
        operation: "Strategy Funding",
        txHash: deposit.result.transactionHash,
        duration: 10000
      });
      setStatus("Bridge funding submitted. Starting the strategy with available bridged capital...");

      await executeApprovedStrategy({
        ownerAddress: address,
        strategyId
      });

      setApproval(null);
      setStatus("Strategy run started. Opening live strategy monitoring...");
      onStrategyStarted?.();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setExecutionBusy(false);
    }
  }

  function requestAgentChange(messageId: string, strategyId: string) {
    const changeRequest = changeRequestByMessage[messageId]?.trim();
    if (!changeRequest) {
      setStatus("Tell the agent what you want to change first.");
      return;
    }

    setPrompt(`Modify strategy ${shortId(strategyId)}: ${changeRequest}`);
    setChangeRequestByMessage((current) => ({
      ...current,
      [messageId]: ""
    }));
    setStatus("Change request loaded. Send it when ready.");
    promptTextareaRef.current?.focus();
  }

  function renderStrategyNextActions(message: AgentMessage) {
    if (message.role !== "assistant" || !message.strategyId) {
      return null;
    }

    const changeValue = changeRequestByMessage[message.id] ?? "";

    return (
      <div className="sam-next-actions">
        <div className="sam-next-actions-head">
          <strong>What do you want to do with this strategy?</strong>
          <small>Review it manually, ask the agent for a change, or fund and start the run.</small>
        </div>
        <div className="sam-next-action-grid">
          <button
            type="button"
            className="sam-next-action-btn"
            onClick={() => onReviewStrategy(message.strategyId!, message.bundle ?? null, message.bundle?.summary.runId)}
          >
            <span className="sam-next-action-icon" aria-hidden="true">✎</span>
            <span>
              <strong>Manual Edit</strong>
              <small>Open Strategy Builder</small>
            </span>
          </button>
          <button
            type="button"
            className="sam-next-action-btn sam-next-action-run"
            onClick={() => void runStrategyAfterBridge(message.strategyId!)}
            disabled={executionBusy || approvalBusy || busy !== null}
          >
            <span className="sam-next-action-icon" aria-hidden="true">▶</span>
            <span>
              <strong>{executionBusy ? "Starting..." : "Run Strategy"}</strong>
              <small>Bridge testnet INIT to Sinergy-2</small>
            </span>
          </button>
        </div>
        <div className="sam-change-request">
          <input
            type="text"
            value={changeValue}
            onChange={(event) =>
              setChangeRequestByMessage((current) => ({
                ...current,
                [message.id]: event.target.value
              }))
            }
            placeholder="Tell the agent what to change..."
          />
          <button
            type="button"
            onClick={() => requestAgentChange(message.id, message.strategyId!)}
            disabled={busy !== null || !changeValue.trim()}
          >
            Ask Agent
          </button>
        </div>
      </div>
    );
  }

  if (!address) {
    return (
      <div className="strategy-agent-panel">
        <div className="sap-head-bar">
          <div className="sap-head-left">
            <span className="panel-title sap-title">Agent Workspace</span>
            <p className="sap-subtitle">
              Explore the strategy agent first. Connect your wallet when you are ready to build,
              backtest, and save a real session.
            </p>
          </div>
          <div className="sap-head-chips">
            {selectedMarket && (
              <span className="sap-chip sap-chip-market">
                <span className="sap-chip-dot" />
                {selectedMarket.symbol}
              </span>
            )}
            <span className="sap-chip">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8"/><path d="M12 7v5l3 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
              {selectedTimeframe}
            </span>
            <span className="sap-chip sap-chip-badge offline">
              <span className="sap-badge-led led-off" />
              Wallet required
            </span>
          </div>
        </div>

        <div className="strategy-agent-workspace strategy-agent-preview">
          <div className="strategy-agent-main">
            <div className="sap-toolbar">
              <div className="sap-toolbar-info">
                <strong>Conversation</strong>
                <small>A wallet unlocks live market context, saved sessions, and execution approvals.</small>
              </div>
              <div className="sap-toolbar-actions">
                <button type="button" className="sap-action-btn sap-action-primary" onClick={onConnect}>
                  Connect Wallet
                </button>
              </div>
            </div>

            <div className="strategy-agent-thread strategy-agent-preview-thread">
              <div className="sam-row">
                <div className="sam-avatar sam-avatar-agent" aria-hidden="true">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                    <path d="M12 3l2.1 4.25L18.8 8l-3.4 3.3.8 4.7L12 13.8 7.8 16l.8-4.7L5.2 8l4.7-.75L12 3z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
                  </svg>
                </div>
                <div className="sam-bubble strategy-agent-preview-bubble">
                  <div className="sam-meta-top">
                    <span className="sam-role-label">Agent</span>
                    <span className="sam-mode-tag sam-mode-plan">Preview</span>
                  </div>
                  <p className="sam-text">
                    Hi, I can help you turn a trading idea into a validated strategy. To start a
                    real run, connect your wallet so I can create a private session, read the
                    selected market, and save the backtest to your address.
                  </p>
                  <div className="strategy-agent-preview-prompts" aria-label="Example prompts">
                    <span>Try: build a conservative BTC breakout strategy</span>
                    <span>Try: backtest an ETH mean reversion setup</span>
                    <span>Try: protect downside with a clear stop loss</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="strategy-agent-compose strategy-agent-preview-compose">
              <div className="strategy-agent-locked-input">
                <span>Connect your wallet to message the agent</span>
                <button type="button" className="sap-action-btn sap-action-primary" onClick={onConnect}>
                  Connect
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="strategy-agent-panel">
      {/* ── HEADER: Compact status bar ── */}
      <div className="sap-head-bar">
        <div className="sap-head-left">
          <span className="panel-title sap-title">Agent Workspace</span>
          <p className="sap-subtitle">
            Describe a strategy goal and the agent will build, validate, and backtest it.
          </p>
        </div>
        <div className="sap-head-chips">
          {selectedMarket && (
            <span className="sap-chip sap-chip-market">
              <span className="sap-chip-dot" />
              {selectedMarket.symbol}
            </span>
          )}
          <span className="sap-chip">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8"/><path d="M12 7v5l3 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
            {selectedTimeframe}
          </span>
          <span className="sap-chip">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 7H4a2 2 0 00-2 2v9a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2z" stroke="currentColor" strokeWidth="1.8"/></svg>
            {session ? shortId(session.sessionId) : "New"}
          </span>
          <span className={`sap-chip sap-chip-badge ${runtimeBadge === "Offline" ? "offline" : ""}`}>
            <span className={`sap-badge-led ${runtimeBadge === "Offline" ? "led-off" : "led-on"}`} />
            {runtimeBadge}
          </span>
        </div>
      </div>

      {/* Strategy/Onchain band */}
      {session?.strategyId && (
        <div className="sap-strategy-band">
          <span>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 2h6l2 4H7L9 2z" stroke="currentColor" strokeWidth="1.5"/><rect x="3" y="6" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.5"/></svg>
            {session.strategy?.name ?? shortId(session.strategyId)}
          </span>
          <span className={`sap-onchain-badge ${approval ? "authorized" : ""}`}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="4" y="11" width="16" height="11" rx="2" stroke="currentColor" strokeWidth="1.5"/><path d="M8 11V7a4 4 0 018 0v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
            {approval ? "Authorized" : "Pending signature"}
          </span>
        </div>
      )}


      <div className={`strategy-agent-workspace ${historyRailOpen ? "sessions-open" : "sessions-closed"}`}>
        <div className="strategy-agent-main">
          {/* ── TOOLBAR ── */}
          <div className="sap-toolbar">
            <div className="sap-toolbar-info">
              <strong>Conversation</strong>
              <small>
                {session
                  ? `${session.turnCount} turns · session ${shortId(session.sessionId)}`
                  : "Start a fresh run or reopen one from the sessions rail."}
              </small>
            </div>
            <div className="sap-toolbar-actions">
              {session?.strategyId && (
                <button
                  type="button"
                  className="sap-action-btn"
                  onClick={() => void authorizeOnchainExecution()}
                  disabled={approvalBusy || executionBusy || busy !== null}
                >
                  {approvalBusy ? "Signing…" : approval ? "↻ Refresh Approval" : "✍ Authorize"}
                </button>
              )}
              {session?.strategyId && approval && (
                <button
                  type="button"
                  className="sap-action-btn sap-action-primary"
                  onClick={() => void runAuthorizedExecution()}
                  disabled={executionBusy || approvalBusy || busy !== null}
                >
                  {executionBusy ? "Executing…" : "▶ Execute"}
                </button>
              )}
              <button
                id="sap-sessions-toggle"
                type="button"
                className="sap-sessions-btn"
                onClick={() => setHistoryRailOpen((current) => !current)}
                aria-expanded={historyRailOpen}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                </svg>
                {historyRailOpen ? "Hide" : "Sessions"}
              </button>
            </div>
          </div>

          {/* ── CHAT THREAD ── */}
          <div className="strategy-agent-thread" ref={threadRef}>
            {messages.length === 0 ? (
              <div className="sap-empty-state">
                <div className="sap-empty-icon">
                  <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
                    <rect width="32" height="32" rx="16" fill="rgba(240,185,11,0.1)" />
                    <path d="M10 22l3-3h9a2 2 0 002-2V9a2 2 0 00-2-2H10a2 2 0 00-2 2v11a2 2 0 002 2z" stroke="#f0b90b" strokeWidth="1.5" strokeLinejoin="round" fill="none"/>
                    <circle cx="13" cy="14.5" r="1" fill="#f0b90b"/>
                    <circle cx="16" cy="14.5" r="1" fill="#f0b90b"/>
                    <circle cx="19" cy="14.5" r="1" fill="#f0b90b"/>
                  </svg>
                </div>
                <p className="sap-empty-desc">
                  Describe a strategy and the agent will build, validate, and backtest it for you.
                </p>
                <div className="sap-empty-chips">
                  {[
                    "Create an EMA crossover strategy, validate it, and run a backtest",
                    "RSI oversold bounce with recommended stop loss",
                    "Bollinger Band breakout strategy for this market",
                  ].map((s) => (
                    <button key={s} type="button" className="sap-suggestion-chip" onClick={() => setPrompt(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((message) => {
                const isUser = message.role === "user";
                const displayText =
                  isUser && message.text.includes("\nUser execution preferences:")
                    ? message.text.split("\nUser execution preferences:")[0].trim()
                    : message.text;

                return (
                  <div key={message.id} className={`sam-row ${isUser ? "sam-row-user" : "sam-row-agent"}`}>
                    {!isUser && (
                      <div className="sam-avatar sam-avatar-agent" aria-hidden="true">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                          <rect x="4" y="8" width="16" height="12" rx="3" stroke="currentColor" strokeWidth="1.5" fill="none"/>
                          <circle cx="9" cy="14" r="1.5" fill="currentColor"/>
                          <circle cx="15" cy="14" r="1.5" fill="currentColor"/>
                          <path d="M9 4h6M12 4v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                        </svg>
                      </div>
                    )}

                    <div className="sam-bubble">
                      <div className="sam-meta-top">
                        <span className="sam-role-label">{isUser ? "You" : "Agent"}</span>
                        {message.mode && (
                          <span className={`sam-mode-tag sam-mode-${message.mode}`}>
                            {message.mode === "plan" ? "📋 Plan" : "▶ Run"}
                          </span>
                        )}
                      </div>

                      {/* Thinking */}
                      {message.liveThinking && (
                        <div className="sam-thinking">
                          <button
                            type="button"
                            className="sam-thinking-toggle"
                            onClick={() =>
                              setCollapsedThinkingIds((current) => ({
                                ...current,
                                [message.id]: !current[message.id],
                              }))
                            }
                            aria-expanded={!collapsedThinkingIds[message.id]}
                          >
                            <span className="sam-thinking-icon">💭</span>
                            <span className="sam-thinking-label">Thinking</span>
                            <span className={`sam-thinking-chevron ${collapsedThinkingIds[message.id] ? "" : "open"}`}>▾</span>
                          </button>
                          {!collapsedThinkingIds[message.id] && (
                            <div className="sam-thinking-body">{message.liveThinking}</div>
                          )}
                        </div>
                      )}

                      {/* Live workflow timeline */}
                      {message.liveWorkflowSteps && message.liveWorkflowSteps.length > 0 && (
                        <div className="sam-timeline">
                          {message.liveWorkflowSteps.map((step, idx) => (
                            <div key={step.key} className={`sam-tl-step status-${step.status}`}>
                              <div className="sam-tl-left">
                                <div className="sam-tl-dot">
                                  {step.status === "completed" && <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 5l2.5 2.5L8 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                                  {step.status === "error" && <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M3 3l4 4M7 3l-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>}
                                  {step.status === "running" && <div className="sam-tl-pulse" />}
                                </div>
                                {idx < (message.liveWorkflowSteps?.length ?? 0) - 1 && <div className="sam-tl-line" />}
                              </div>
                              <div className="sam-tl-content">
                                <div className="sam-tl-head">
                                  <strong>{step.title}</strong>
                                  <span className={`sam-tl-badge badge-${step.status}`}>{step.status}</span>
                                </div>
                                <small>{step.summary}</small>
                                {step.reasoningSummary && <p className="sam-tl-reasoning">{summarizeThinking(step.reasoningSummary, 220)}</p>}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Final trace */}
                      {message.trace && message.trace.length > 0 && (
                        <div className="sam-timeline">
                          {message.trace.map((entry, idx) => {
                            const card = toWorkflowStepCard(entry);
                            return (
                              <div key={`${message.id}-${entry.step}`} className={`sam-tl-step status-${card.status}`}>
                                <div className="sam-tl-left">
                                  <div className="sam-tl-dot">
                                    {card.status === "completed" && <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 5l2.5 2.5L8 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                                    {card.status === "error" && <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M3 3l4 4M7 3l-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>}
                                  </div>
                                  {idx < (message.trace?.length ?? 0) - 1 && <div className="sam-tl-line" />}
                                </div>
                                <div className="sam-tl-content">
                                  <div className="sam-tl-head">
                                    <strong>{card.title}</strong>
                                    <span className={`sam-tl-badge badge-${card.status}`}>{card.status}</span>
                                  </div>
                                  <small>{card.summary}</small>
                                  {card.reasoningSummary && <p className="sam-tl-reasoning">{card.reasoningSummary}</p>}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* Planned tools */}
                      {message.plannedTools && message.plannedTools.length > 0 && (
                        <div className="sam-planned-tools">
                          <div className="sam-planned-tools-head">📋 Planned Steps</div>
                          {message.plannedTools.map((item) => (
                            <div key={`${message.id}-${item.tool}`} className="sam-planned-tool-row">
                              <span className="sam-planned-tool-name">{humanizeToolName(item.tool)}</span>
                              <small className="sam-planned-tool-why">{item.why}</small>
                            </div>
                          ))}
                        </div>
                      )}

                      {displayText && <p className="sam-text">{displayText}</p>}

                      {/* Used tools */}
                      {message.usedTools && message.usedTools.length > 0 && (
                        <div className="sam-tools-chips">
                          {message.usedTools.map((tool) => (
                            <span key={`${message.id}-${tool}`} className="sam-tool-chip">{humanizeToolName(tool)}</span>
                          ))}
                        </div>
                      )}

                      {/* Warnings */}
                      {message.warnings && message.warnings.length > 0 && (
                        <div className="sam-warnings">
                          {message.warnings.map((warning) => (
                            <div key={`${message.id}-${warning}`} className="sam-warning-item">
                              <small>⚠ {warning}</small>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Backtest mini-card */}
                      {message.bundle && (() => {
                        const { summary } = message.bundle;
                        const netPnl = typeof summary.netPnl === "number" ? summary.netPnl : null;
                        const positive = netPnl !== null && netPnl >= 0;
                        const winRate = typeof summary.winRate === "number" ? summary.winRate : null;
                        const totalTrades = (summary as { tradeCount?: number }).tradeCount ?? (summary as { totalTrades?: number }).totalTrades;
                        const maxDd = typeof summary.maxDrawdownPct === "number" ? summary.maxDrawdownPct : null;
                        const pf = typeof summary.profitFactor === "number" ? summary.profitFactor : null;
                        return (
                          <div className={`sam-backtest-card ${positive ? "bc-positive" : "bc-negative"}`}>
                            <div className="sam-bc-header">
                              <span className="sam-bc-title">📊 Backtest Results</span>
                              {netPnl !== null && (
                                <span className={`sam-bc-pnl ${positive ? "bc-pnl-pos" : "bc-pnl-neg"}`}>
                                  {positive ? "+" : ""}{netPnl.toFixed(2)} USDC
                                </span>
                              )}
                            </div>
                            <div className="sam-bc-metrics">
                              <div className="sam-bc-metric"><span>Win Rate</span><strong>{winRate !== null ? `${winRate}%` : "--"}</strong></div>
                              <div className="sam-bc-metric"><span>Trades</span><strong>{typeof totalTrades === "number" ? totalTrades : "--"}</strong></div>
                              <div className="sam-bc-metric"><span>Max DD</span><strong className={maxDd !== null && maxDd > 20 ? "bc-warn" : ""}>{maxDd !== null ? `${maxDd.toFixed(1)}%` : "--"}</strong></div>
                              {pf !== null && <div className="sam-bc-metric"><span>PF</span><strong className={pf >= 1.5 ? "bc-good" : ""}>{pf.toFixed(2)}</strong></div>}
                            </div>
                          </div>
                        );
                      })()}

                      {renderStrategyNextActions(message)}
                    </div>

                    {isUser && (
                      <div className="sam-avatar sam-avatar-user" aria-hidden="true">Tú</div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* ── COMPOSE AREA ── */}
          <div className="strategy-agent-compose">

            {/* Clarifier drawer */}
            {clarifierOpen && clarificationRequired && (
              <div className="sap-clarifier">
                <div className="sap-clarifier-head">
                  <strong>⚙ Quick preferences</strong>
                  <small>Choose trading direction and stop-loss style before running.</small>
                </div>
                <div className="sap-clarifier-section">
                  <span className="sap-clarifier-label">Direction</span>
                  <div className="sap-clarifier-pills">
                    {([{key: "both", label: "Long + Short"}, {key: "long_only", label: "Long only"}, {key: "short_only", label: "Short only"}] as const).map(({key, label}) => (
                      <button key={key} type="button" className={`sap-clarifier-pill ${clarification.sidePreference === key ? "selected" : ""}`} onClick={() => setClarification((c) => ({...c, sidePreference: key}))}>
                        {clarification.sidePreference === key && <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 5l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="sap-clarifier-section">
                  <span className="sap-clarifier-label">Stop Loss</span>
                  <div className="sap-clarifier-pills">
                    {([{key: "recommended", label: "Recommended"}, {key: "none", label: "No SL"}, {key: "custom", label: "Custom %"}] as const).map(({key, label}) => (
                      <button key={key} type="button" className={`sap-clarifier-pill ${clarification.stopLossMode === key ? "selected" : ""}`} onClick={() => setClarification((c) => ({...c, stopLossMode: key}))}>
                        {clarification.stopLossMode === key && <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 5l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                        {label}
                      </button>
                    ))}
                  </div>
                  {clarification.stopLossMode === "custom" && (
                    <input type="number" className="sap-clarifier-input" min="0.1" step="0.1" value={clarification.customStopLossPct} onChange={(e) => setClarification((c) => ({...c, customStopLossPct: e.target.value}))} placeholder="Stop loss % e.g. 2.5" />
                  )}
                </div>
              </div>
            )}

            {/* Input row */}
            <div className="sap-input-row">
              <textarea
                ref={promptTextareaRef}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    void submit(planModeEnabled ? "plan" : "run");
                  }
                }}
                rows={1}
                placeholder="Describe the strategy you want to build, validate, improve, or continue..."
              />
              <button
                id="sap-send-btn"
                type="button"
                className={`sap-send-btn ${busy !== null ? "busy" : ""}`}
                onClick={() => void submit(planModeEnabled ? "plan" : "run")}
                disabled={busy !== null || !prompt.trim() || (clarifierOpen && clarificationRequired && clarification.stopLossMode === "custom" && !clarification.customStopLossPct.trim())}
                aria-label="Send message"
              >
                {busy !== null ? <span className="sap-send-spinner" aria-hidden="true" /> : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M12 19V5M5 12l7-7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                )}
              </button>
            </div>

            {/* Bottom bar */}
            <div className="sap-compose-footer">
              <label className="sap-plan-toggle">
                <input type="checkbox" checked={planModeEnabled} onChange={(event) => setPlanModeEnabled(event.target.checked)} disabled={busy !== null} />
                <span className={`sap-plan-pill ${planModeEnabled ? "active" : ""}`}>
                  {planModeEnabled ? "📋 Plan mode" : "▶ Run mode"}
                </span>
              </label>
              <span className="sap-compose-hint">⌘↵ to send</span>
              <button type="button" className="sap-new-session-btn" onClick={startNewSession} disabled={busy !== null}>
                + New Session
              </button>
            </div>
          </div>

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
                  ? `${session.turnCount} turns · updated ${formatTimestamp(session.updatedAt)}`
                  : "Pick a previous session or start a fresh one."}
              </small>
            </div>
            <div className="strategy-agent-session-actions">
              {session?.strategyId && (
                <button type="button" onClick={() => onReviewStrategy(session.strategyId!, null, session.runId)} disabled={busy !== null}>
                  Open Strategy In Builder
                </button>
              )}
              <button type="button" onClick={startNewSession} disabled={busy !== null}>New Session</button>
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
                  {historyBusy ? "Refreshing…" : "Refresh"}
                </button>
                <button type="button" onClick={() => setHistoryRailOpen(false)} disabled={busy !== null}>Close</button>
              </div>
            </div>

            {history.length === 0 ? (
              <div className="strategy-empty-state">No saved sessions yet for this market.</div>
            ) : (
              <div className="strategy-agent-history-list">
                {history.map((item) => (
                  <div key={item.sessionId} className={`strategy-agent-history-card ${item.sessionId === session?.sessionId ? "active" : ""}`}>
                    <div className="sah-card-top">
                      <strong className="sah-card-name">{summarizeSession(item)}</strong>
                      <div className="sah-card-chips">
                        <span className="sah-chip">{item.turnCount} turns</span>
                        {item.strategy?.status && <span className="sah-chip">{item.strategy.status}</span>}
                        {item.strategy?.timeframe && <span className="sah-chip">{item.strategy.timeframe}</span>}
                      </div>
                    </div>
                    <small className="sah-card-time">{formatTimestamp(item.updatedAt)}</small>
                    {(item.lastAssistantMessage ?? item.lastUserMessage) && (
                      <p className="sah-card-preview">{item.lastAssistantMessage ?? item.lastUserMessage}</p>
                    )}
                    <div className="sah-card-actions">
                      <button type="button" className="sah-action-btn" onClick={() => void loadSession(item.sessionId)} disabled={busy !== null}>Open Session</button>
                      {item.strategyId && (
                        <button type="button" className="sah-action-btn sah-action-strategy" onClick={() => onReviewStrategy(item.strategyId!, null, item.runId)} disabled={busy !== null}>View Strategy</button>
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
