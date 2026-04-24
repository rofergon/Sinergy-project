import { useEffect, useMemo, useRef, useState } from "react";
import { useSignTypedData } from "wagmi";
import type { HexString, StrategyChartOverlay, StrategyEquityPoint, StrategyIndicatorKind } from "@sinergy/shared";
import {
  activateStrategyAutoExecution,
  fetchBacktestChartOverlay,
  createStrategyExecutionIntent,
  deactivateStrategyAutoExecution,
  fetchStrategyDashboard,
  fetchStrategyExecutionApproval,
  fetchStrategyExecutionHistory,
  fetchStrategyLiveOverlay,
  runStrategyNow,
  saveStrategyExecutionApproval,
  strategyTool
} from "../lib/api";
import type {
  MarketSnapshot,
  StrategyDashboardCard,
  StrategyExecutionRecord,
  StrategyExecutionStrategySummary
} from "../types";
import { TradingViewChart } from "./TradingViewChart";

type Props = {
  address?: HexString;
  markets: MarketSnapshot[];
  highlightedStrategyId?: string | null;
  onOpenStrategy: (strategyId: string, runId?: string) => void;
};

function formatMetric(value?: number, digits = 2) {
  if (value === undefined || value === null || !Number.isFinite(value)) {
    return "--";
  }
  return value.toFixed(digits);
}

function formatCapital(value?: number) {
  if (value === undefined || value === null || !Number.isFinite(value)) {
    return "--";
  }
  return value.toFixed(2);
}

function formatPercent(value?: number, digits = 2) {
  if (value === undefined || value === null || !Number.isFinite(value)) {
    return "--";
  }
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(digits)}%`;
}

function buildSparklineGeometry(points: StrategyEquityPoint[]) {
  if (points.length === 0) {
    return null;
  }

  const min = Math.min(...points.map((point) => point.equity));
  const max = Math.max(...points.map((point) => point.equity));
  const range = max - min || 1;
  const coordinates = points.map((point, index) => {
    const x = (index / Math.max(points.length - 1, 1)) * 100;
    const y = 100 - ((point.equity - min) / range) * 100;
    return { x, y };
  });
  const line = coordinates.map(({ x, y }) => `${x},${y}`).join(" ");
  const area = [
    `M 0 100`,
    ...coordinates.map(({ x, y }) => `L ${x} ${y}`),
    "L 100 100 Z"
  ].join(" ");

  return {
    area,
    line,
    start: coordinates[0],
    end: coordinates[coordinates.length - 1],
    trendUp: points[points.length - 1]!.equity >= points[0]!.equity
  };
}

function liveStrategyStatusLabel(status?: StrategyExecutionStrategySummary["status"]) {
  switch (status) {
    case "active":
      return "Active";
    case "pending":
      return "Pending";
    case "idle":
      return "Idle";
    default:
      return "--";
  }
}

function isLiveMarketSupported(market?: MarketSnapshot) {
  return Boolean(market?.routeable);
}

function liveStrategySideLabel(enabledSides: StrategyDashboardCard["enabledSides"]) {
  if (enabledSides.includes("long") && enabledSides.includes("short")) {
    return "Long + Short";
  }
  if (enabledSides.includes("short")) {
    return "Short";
  }
  return "Long";
}

function indicatorBadgeLabel(indicator: StrategyIndicatorKind) {
  switch (indicator) {
    case "rolling_high":
      return "Rolling High";
    case "rolling_low":
      return "Rolling Low";
    case "candle_body_pct":
      return "Body %";
    case "candle_direction":
      return "Candle Dir";
    case "macd":
      return "MACD";
    case "rsi":
      return "RSI";
    case "atr":
      return "ATR";
    case "vwap":
      return "VWAP";
    case "ema":
      return "EMA";
    case "sma":
      return "SMA";
    case "roc":
      return "ROC";
    case "stoch":
      return "Stoch";
    case "bollinger":
      return "Bollinger";
  }
}

function renderBacktestPreview(card: StrategyDashboardCard) {
  const latestBacktest = card.latestBacktest;
  const equityPreview = latestBacktest?.equityPreview ?? [];
  if (!latestBacktest || equityPreview.length === 0) {
    return null;
  }

  const sparkline = buildSparklineGeometry(equityPreview);
  if (!sparkline) {
    return null;
  }

  return (
    <div className={`strategy-dashboard-backtest-chart ${sparkline.trendUp ? "is-positive" : "is-negative"}`}>
      <div className="strategy-dashboard-backtest-chart-meta">
        <span>Backtest preview</span>
        <strong>Last {latestBacktest.equityPreviewBars ?? equityPreview.length} candles</strong>
      </div>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <path className="strategy-dashboard-backtest-chart-area" d={sparkline.area} />
        <polyline className="strategy-dashboard-backtest-chart-line" points={sparkline.line} />
        <circle className="strategy-dashboard-backtest-chart-dot start" cx={sparkline.start.x} cy={sparkline.start.y} r="2.4" />
        <circle className="strategy-dashboard-backtest-chart-dot end" cx={sparkline.end.x} cy={sparkline.end.y} r="3.2" />
      </svg>
    </div>
  );
}

function renderBacktestTradingViewPreview(
  card: StrategyDashboardCard,
  market: MarketSnapshot | undefined,
  overlay: StrategyChartOverlay | null | undefined
) {
  if (!card.latestBacktest || !market || !overlay) {
    return null;
  }

  return (
    <div className="strategy-dashboard-backtest-tv-shell">
      <TradingViewChart
        market={market}
        timeframe={card.timeframe}
        onTimeframeChange={() => {}}
        overlay={overlay}
        variant="compact"
        initialVisibleBars={100}
      />
    </div>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M7 7h10v10H7z" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M19.4 13.5a7.8 7.8 0 0 0 0-3l2-1.5-2-3.5-2.4 1a7.2 7.2 0 0 0-2.6-1.5L14 2.5h-4L9.6 5a7.2 7.2 0 0 0-2.6 1.5l-2.4-1-2 3.5 2 1.5a7.8 7.8 0 0 0 0 3l-2 1.5 2 3.5 2.4-1a7.2 7.2 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.2 7.2 0 0 0 2.6-1.5l2.4 1 2-3.5-2-1.5ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M8 5h3v14H8zM13 5h3v14h-3z" />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M14 4h6v6M20 4l-9 9" />
      <path d="M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5" />
    </svg>
  );
}

function DotsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="19" cy="12" r="1.5" />
    </svg>
  );
}

function statusLabel(card: StrategyDashboardCard) {
  switch (card.autoExecution.status) {
    case "active":
      return card.autoExecution.expiresAt
        ? `Expires ${new Date(card.autoExecution.expiresAt).toLocaleString()}`
        : "Auto active";
    case "expired":
      return "Auto expired";
    case "needs_reactivation":
      return "Needs reactivation";
    case "paused":
      return "Paused";
    default:
      return "Auto inactive";
  }
}

function statusClass(card: StrategyDashboardCard) {
  if (card.autoExecution.status === "active") return "buy";
  if (card.autoExecution.status === "needs_reactivation" || card.autoExecution.lastError) return "sell";
  return "";
}

function tenYearsInSeconds() {
  return 60 * 60 * 24 * 365 * 10;
}

function isRealExecutionTrade(record: StrategyExecutionRecord) {
  return record.status === "completed" && record.action !== "no_action";
}

type ExecutionTradeRow = {
  id: string;
  side: "long" | "short";
  entry?: StrategyExecutionRecord;
  exit?: StrategyExecutionRecord;
  sortAt: string;
};

function buildExecutionTradeRows(records: StrategyExecutionRecord[]) {
  const sorted = [...records].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  const rows: ExecutionTradeRow[] = [];
  let openLong: StrategyExecutionRecord | undefined;
  let openShort: StrategyExecutionRecord | undefined;

  for (const record of sorted) {
    if (record.signal === "long_entry") {
      if (openLong) {
        rows.push({
          id: `trade-${openLong.id}`,
          side: "long",
          entry: openLong,
          sortAt: openLong.createdAt
        });
      }
      openLong = record;
      continue;
    }

    if (record.signal === "long_exit") {
      rows.push({
        id: `trade-${openLong?.id ?? record.id}-${record.id}`,
        side: "long",
        entry: openLong,
        exit: record,
        sortAt: record.createdAt
      });
      openLong = undefined;
      continue;
    }

    if (record.signal === "short_entry") {
      if (openShort) {
        rows.push({
          id: `trade-${openShort.id}`,
          side: "short",
          entry: openShort,
          sortAt: openShort.createdAt
        });
      }
      openShort = record;
      continue;
    }

    if (record.signal === "short_exit") {
      rows.push({
        id: `trade-${openShort?.id ?? record.id}-${record.id}`,
        side: "short",
        entry: openShort,
        exit: record,
        sortAt: record.createdAt
      });
      openShort = undefined;
    }
  }

  if (openLong) {
    rows.push({
      id: `trade-${openLong.id}`,
      side: "long",
      entry: openLong,
      sortAt: openLong.createdAt
    });
  }

  if (openShort) {
    rows.push({
      id: `trade-${openShort.id}`,
      side: "short",
      entry: openShort,
      sortAt: openShort.createdAt
    });
  }

  return rows.sort((left, right) => Date.parse(right.sortAt) - Date.parse(left.sortAt));
}

function liveTradeOverlay(
  card: StrategyDashboardCard,
  baseOverlay: StrategyChartOverlay | null,
  records: StrategyExecutionRecord[]
): StrategyChartOverlay | null {
  const realTrades = records
    .filter((record) => record.strategyId === card.strategyId)
    .filter(isRealExecutionTrade)
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));

  if (!baseOverlay && realTrades.length === 0) {
    return null;
  }

  const markers = realTrades.map((record) => {
    const time = Math.floor(Date.parse(record.createdAt) / 1000);
    switch (record.signal) {
      case "long_entry":
        return {
          id: `live-${record.id}`,
          time,
          position: "belowBar" as const,
          shape: "arrowUp" as const,
          color: "#0ecb81",
          text: "Real buy"
        };
      case "short_entry":
        return {
          id: `live-${record.id}`,
          time,
          position: "aboveBar" as const,
          shape: "arrowDown" as const,
          color: "#f6465d",
          text: "Real short"
        };
      case "long_exit":
        return {
          id: `live-${record.id}`,
          time,
          position: "aboveBar" as const,
          shape: "circle" as const,
          color: "#f0b90b",
          text: "Real sell"
        };
      case "short_exit":
        return {
          id: `live-${record.id}`,
          time,
          position: "belowBar" as const,
          shape: "circle" as const,
          color: "#1e9df2",
          text: "Real cover"
        };
      default:
        return null;
    }
  }).filter((marker): marker is NonNullable<typeof marker> => marker !== null);

  if (!baseOverlay) {
    return {
      runId: card.latestBacktest?.runId ?? `live-${card.strategyId}`,
      strategyId: card.strategyId,
      marketId: card.marketId,
      timeframe: card.timeframe,
      indicators: [],
      markers
    };
  }

  return {
    ...baseOverlay,
    markers
  };
}

export function StrategyDashboardPage({ address, markets, highlightedStrategyId, onOpenStrategy }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [cards, setCards] = useState<StrategyDashboardCard[]>([]);
  const [visibleHighlightId, setVisibleHighlightId] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [configStrategyId, setConfigStrategyId] = useState<string | null>(null);
  const [activationMode, setActivationMode] = useState<"until_disabled" | "until_timestamp">("until_disabled");
  const [activationExpiry, setActivationExpiry] = useState("");
  const [activationInitialCapital, setActivationInitialCapital] = useState("");
  const [previewOverlays, setPreviewOverlays] = useState<Record<string, StrategyChartOverlay | null>>({});
  const [backtestOverlays, setBacktestOverlays] = useState<Record<string, StrategyChartOverlay | null>>({});
  const [previewExecutions, setPreviewExecutions] = useState<Record<string, StrategyExecutionRecord[]>>({});
  const [previewExecutionSummaries, setPreviewExecutionSummaries] = useState<Record<string, StrategyExecutionStrategySummary>>({});
  const autoConfigRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const strategyCardRefs = useRef<Record<string, HTMLElement | null>>({});
  const { signTypedDataAsync } = useSignTypedData();

  async function loadDashboard(options?: { silent?: boolean }) {
    if (!address) {
      setCards([]);
      return;
    }

    if (!options?.silent) {
      setBusy(true);
    }
    try {
      const result = await fetchStrategyDashboard(address);
      setCards(result.cards);
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (!options?.silent) {
        setBusy(false);
      }
    }
  }

  useEffect(() => {
    void loadDashboard();
    if (!address) return;

    const timer = window.setInterval(() => {
      void loadDashboard({ silent: true });
    }, 15_000);

    return () => window.clearInterval(timer);
  }, [address]);

  const cardMarkets = useMemo(() => {
    return new Map(markets.map((market) => [market.id.toLowerCase(), market]));
  }, [markets]);
  const activeCards = useMemo(
    () => cards.filter((card) => card.autoExecution.status === "active"),
    [cards]
  );
  const previewCards = useMemo(() => {
    return [...activeCards]
      .sort((left, right) => {
        const rightPrimary = Date.parse(
          right.autoExecution.lastExecutedAt ??
          right.autoExecution.lastCheckedAt ??
          right.updatedAt
        );
        const leftPrimary = Date.parse(
          left.autoExecution.lastExecutedAt ??
          left.autoExecution.lastCheckedAt ??
          left.updatedAt
        );
        return rightPrimary - leftPrimary;
      })
      .slice(0, 4);
  }, [activeCards]);
  const hiddenActiveCount = Math.max(activeCards.length - previewCards.length, 0);
  const inactiveCards = useMemo(
    () => cards.filter((card) => card.autoExecution.status !== "active"),
    [cards]
  );

  useEffect(() => {
    if (!address || previewCards.length === 0) {
      setPreviewOverlays({});
      return;
    }

    const ownerAddress = address;
    let cancelled = false;

    async function loadPreviewOverlays() {
      const nextEntries = await Promise.all(
        previewCards.map(async (card) => {
          try {
            const overlay = await fetchStrategyLiveOverlay(ownerAddress, card.strategyId);
            return [card.strategyId, overlay] as const;
          } catch {
            return [card.strategyId, null] as const;
          }
        })
      );

      if (cancelled) {
        return;
      }

      const nextMap = Object.fromEntries(nextEntries);
      for (const card of previewCards) {
        if (!(card.strategyId in nextMap)) {
          nextMap[card.strategyId] = null;
        }
      }
      setPreviewOverlays(nextMap);
    }

    void loadPreviewOverlays();
    return () => {
      cancelled = true;
    };
  }, [address, previewCards]);

  useEffect(() => {
    const cardsWithBacktest = inactiveCards.filter((card) => card.latestBacktest?.runId);
    if (!address || cardsWithBacktest.length === 0) {
      setBacktestOverlays({});
      return;
    }

    const ownerAddress = address;
    let cancelled = false;

    async function loadBacktestOverlays() {
      const nextEntries = await Promise.all(
        cardsWithBacktest.map(async (card) => {
          try {
            const overlay = await fetchBacktestChartOverlay(ownerAddress, card.latestBacktest!.runId);
            return [card.strategyId, overlay] as const;
          } catch {
            return [card.strategyId, null] as const;
          }
        })
      );

      if (cancelled) {
        return;
      }

      setBacktestOverlays(Object.fromEntries(nextEntries));
    }

    void loadBacktestOverlays();
    return () => {
      cancelled = true;
    };
  }, [address, inactiveCards]);

  useEffect(() => {
    if (!address || previewCards.length === 0) {
      setPreviewExecutions({});
      setPreviewExecutionSummaries({});
      return;
    }

    const ownerAddress = address;
    let cancelled = false;
    const strategyIds = new Set(previewCards.map((card) => card.strategyId));

    async function loadPreviewExecutions() {
      try {
        const result = await fetchStrategyExecutionHistory(ownerAddress);
        if (cancelled) {
          return;
        }

        const grouped = result.trades.reduce<Record<string, StrategyExecutionRecord[]>>((acc, trade) => {
          if (!strategyIds.has(trade.strategyId)) {
            return acc;
          }
          const bucket = acc[trade.strategyId] ?? [];
          bucket.push(trade);
          acc[trade.strategyId] = bucket;
          return acc;
        }, {});

        for (const card of previewCards) {
          if (!grouped[card.strategyId]) {
            grouped[card.strategyId] = [];
          }
        }

        setPreviewExecutions(grouped);
        setPreviewExecutionSummaries(
          Object.fromEntries(
            result.strategies
              .filter((strategy) => strategyIds.has(strategy.strategyId))
              .map((strategy) => [strategy.strategyId, strategy] as const)
          )
        );
      } catch {
        if (!cancelled) {
          setPreviewExecutions({});
          setPreviewExecutionSummaries({});
        }
      }
    }

    void loadPreviewExecutions();
    return () => {
      cancelled = true;
    };
  }, [address, previewCards]);

  useEffect(() => {
    if (!configStrategyId) {
      return;
    }

    autoConfigRefs.current[configStrategyId]?.scrollIntoView({
      behavior: "smooth",
      block: "nearest"
    });
  }, [configStrategyId]);

  useEffect(() => {
    if (!highlightedStrategyId) {
      return;
    }

    setVisibleHighlightId(highlightedStrategyId);
    const scrollTimer = window.setTimeout(() => {
      strategyCardRefs.current[highlightedStrategyId]?.scrollIntoView({
        behavior: "smooth",
        block: "center"
      });
    }, 80);

    const timer = window.setTimeout(() => {
      setVisibleHighlightId((current) => (current === highlightedStrategyId ? null : current));
    }, 3_000);

    return () => {
      window.clearTimeout(scrollTimer);
      window.clearTimeout(timer);
    };
  }, [highlightedStrategyId]);

  useEffect(() => {
    if (!visibleHighlightId) {
      return;
    }

    strategyCardRefs.current[visibleHighlightId]?.scrollIntoView({
      behavior: "smooth",
      block: "center"
    });
  }, [cards, visibleHighlightId]);

  async function ensureSavedStrategy(card: StrategyDashboardCard) {
    if (!address) {
      throw new Error("Connect wallet to manage strategies.");
    }

    const result = await strategyTool<{
      strategy: { status: string; id: string; name: string };
      validation: {
        ok: boolean;
        issues: Array<{ message: string }>;
      };
    }>("save_strategy", {
      ownerAddress: address,
      strategyId: card.strategyId
    });

    if (!result.validation.ok) {
      const issueText = result.validation.issues.map((issue) => issue.message).join("; ");
      throw new Error(
        issueText
          ? `The strategy could not be saved for execution: ${issueText}`
          : "The strategy could not be saved for execution."
      );
    }

    if (result.strategy.status !== "saved") {
      throw new Error("The strategy is still not saved, so it cannot be used for live execution yet.");
    }
  }

  async function ensureApproval(strategyId: string, validForSeconds: number) {
    if (!address) {
      throw new Error("Connect wallet to authorize strategy execution.");
    }

    try {
      const approval = await fetchStrategyExecutionApproval(address, strategyId);
      const remainingSeconds = approval
        ? Math.floor((Number(approval.deadline) * 1000 - Date.now()) / 1000)
        : 0;
      if (approval && remainingSeconds >= Math.max(60, validForSeconds - 60)) {
        return approval;
      }
    } catch {
      // Fall through and mint a fresh approval.
    }

    {
      const intent = await createStrategyExecutionIntent({
        ownerAddress: address,
        strategyId,
        validForSeconds
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

      return await saveStrategyExecutionApproval({
        ownerAddress: address,
        strategyId,
        message: intent.message,
        signature
      });
    }
  }

  async function handleRunNow(card: StrategyDashboardCard) {
    if (!address) return;
    setRunningId(card.strategyId);
    setError("");
    try {
      await ensureSavedStrategy(card);
      await ensureApproval(card.strategyId, 15 * 60);
      await runStrategyNow({
        ownerAddress: address,
        strategyId: card.strategyId
      });
      await loadDashboard({ silent: true });
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError));
    } finally {
      setRunningId(null);
    }
  }

  async function handleActivate(card: StrategyDashboardCard) {
    if (!address) return;
    setTogglingId(card.strategyId);
    setError("");
    try {
      await ensureSavedStrategy(card);
      const expiresAt =
        activationMode === "until_timestamp" && activationExpiry
          ? new Date(activationExpiry).toISOString()
          : undefined;
      const validForSeconds = activationMode === "until_timestamp" && expiresAt
        ? Math.max(60, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000))
        : tenYearsInSeconds();
      const initialCapitalQuote =
        activationInitialCapital.trim().length > 0 ? Number(activationInitialCapital) : undefined;

      if (initialCapitalQuote !== undefined && (!Number.isFinite(initialCapitalQuote) || initialCapitalQuote <= 0)) {
        throw new Error("Initial capital must be a positive number.");
      }

      await ensureApproval(card.strategyId, validForSeconds);
      await activateStrategyAutoExecution({
        ownerAddress: address,
        strategyId: card.strategyId,
        mode: activationMode,
        expiresAt,
        initialCapitalQuote
      });
      setConfigStrategyId(null);
      setActivationExpiry("");
      setActivationMode("until_disabled");
      setActivationInitialCapital("");
      await loadDashboard({ silent: true });
    } catch (activateError) {
      setError(activateError instanceof Error ? activateError.message : String(activateError));
    } finally {
      setTogglingId(null);
    }
  }

  async function handleDeactivate(card: StrategyDashboardCard) {
    if (!address) return;
    setTogglingId(card.strategyId);
    setError("");
    try {
      await deactivateStrategyAutoExecution({
        ownerAddress: address,
        strategyId: card.strategyId
      });
      await loadDashboard({ silent: true });
    } catch (deactivateError) {
      setError(deactivateError instanceof Error ? deactivateError.message : String(deactivateError));
    } finally {
      setTogglingId(null);
    }
  }

  async function handleDelete(card: StrategyDashboardCard) {
    if (!address) return;
    const confirmed = window.confirm(`Delete strategy "${card.name}"? This will also remove its backtests and live execution history.`);
    if (!confirmed) return;

    setDeletingId(card.strategyId);
    setError("");
    try {
      await strategyTool<{ strategyId: string; deleted: true }>("delete_strategy", {
        ownerAddress: address,
        strategyId: card.strategyId
      });
      setConfigStrategyId((current) => (current === card.strategyId ? null : current));
      await loadDashboard({ silent: true });
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    } finally {
      setDeletingId(null);
    }
  }

  function renderStrategyCard(card: StrategyDashboardCard, options?: { spotlight?: boolean }) {
    const market = cardMarkets.get(card.marketId.toLowerCase());
    const configOpen = configStrategyId === card.strategyId;
    const liveSupported = isLiveMarketSupported(market);
    const backtestOverlay = backtestOverlays[card.strategyId];
    const cardNotes = [
      card.status !== "saved"
        ? "This strategy is still a draft. The dashboard will try to save it before running or enabling auto-trading."
        : null,
      !liveSupported
        ? "Live trading is available only on router-enabled markets with routed Initia testnet liquidity."
        : null
    ].filter((note): note is string => note !== null);

    return (
      <article
        className={`strategy-dashboard-card strategy-dashboard-library-card ${options?.spotlight ? "spotlight" : ""}`}
        key={card.strategyId}
        ref={(element) => {
          strategyCardRefs.current[card.strategyId] = element;
        }}
      >
        <div className="strategy-dashboard-card-head">
          <div>
            <strong>{card.name}</strong>
            <span className="strategy-dashboard-library-badge">
              {card.status === "saved" ? "Ready" : "Draft"}
            </span>
          </div>
          <span className={`strategy-dashboard-library-status ${statusClass(card)}`}>
            <i />
            {card.autoExecution.status === "active" ? "Live" : "Idle"}
          </span>
        </div>

        <div className="strategy-dashboard-backtest">
          {card.latestBacktest ? (
            <>
              {renderBacktestTradingViewPreview(card, market, backtestOverlay) ?? renderBacktestPreview(card)}
              <div className="strategy-dashboard-stats strategy-dashboard-library-stats">
                <div>
                  <span>PnL</span>
                  <strong className={card.latestBacktest.netPnlPct >= 0 ? "order-side buy" : "order-side sell"}>
                    {formatPercent(card.latestBacktest.netPnlPct, 2)}
                  </strong>
                </div>
                <div>
                  <span>Status</span>
                  <strong>{card.autoExecution.status === "active" ? "Live" : "Idle"}</strong>
                </div>
                <div>
                  <span>Trades</span>
                  <strong>{card.latestBacktest.tradeCount}</strong>
                </div>
              </div>
            </>
          ) : (
            <div className="portfolio-empty">No backtest has been run for this strategy yet.</div>
          )}
        </div>

        <div className="strategy-dashboard-card-note-stack" aria-hidden={cardNotes.length === 0}>
          {Array.from({ length: 2 }, (_, index) => {
            const note = cardNotes[index];
            return note ? (
              <div key={`${card.strategyId}-note-${index}`} className="strategy-dashboard-inline-note">
                {note}
              </div>
            ) : (
              <div
                key={`${card.strategyId}-note-${index}`}
                className="strategy-dashboard-inline-note strategy-dashboard-inline-note-placeholder"
              />
            );
          })}
        </div>

        <div className="strategy-dashboard-inline-error-slot">
          {card.autoExecution.lastError ? (
            <div className="strategy-dashboard-inline-error">{card.autoExecution.lastError}</div>
          ) : (
            <div className="strategy-dashboard-inline-error strategy-dashboard-inline-error-placeholder" />
          )}
        </div>

        <div className="strategy-dashboard-card-actions strategy-dashboard-library-actions">
          <button
            type="button"
            className="strategy-dashboard-icon-btn"
            disabled={runningId === card.strategyId || deletingId === card.strategyId || !liveSupported}
            onClick={() => void handleRunNow(card)}
            aria-label={runningId === card.strategyId ? "Running strategy" : "Run strategy now"}
            title={runningId === card.strategyId ? "Running..." : "Run now"}
          >
            <PlayIcon />
          </button>

          {card.autoExecution.status === "active" ? (
            <button
              type="button"
              className="strategy-dashboard-icon-btn"
              disabled={togglingId === card.strategyId || deletingId === card.strategyId}
              onClick={() => void handleDeactivate(card)}
              aria-label={togglingId === card.strategyId ? "Stopping auto execution" : "Disable auto execution"}
              title={togglingId === card.strategyId ? "Stopping..." : "Disable Auto"}
            >
              <StopIcon />
            </button>
          ) : (
            <button
              type="button"
              className="strategy-dashboard-icon-btn"
              disabled={togglingId === card.strategyId || deletingId === card.strategyId || !liveSupported}
              onClick={() => {
                if (configOpen) {
                  setConfigStrategyId(null);
                  setActivationInitialCapital("");
                  return;
                }
                setConfigStrategyId(card.strategyId);
                setActivationMode(card.autoExecution.mode ?? "until_disabled");
                setActivationExpiry(
                  card.autoExecution.expiresAt
                    ? new Date(new Date(card.autoExecution.expiresAt).getTime() - new Date().getTimezoneOffset() * 60_000)
                        .toISOString()
                        .slice(0, 16)
                    : ""
                );
                setActivationInitialCapital(
                  card.autoExecution.initialCapitalQuote
                    ? String(card.autoExecution.initialCapitalQuote)
                    : ""
                );
              }}
              aria-label={configOpen ? "Close auto execution config" : "Configure auto execution"}
              title={configOpen
                ? "Close Config"
                : card.autoExecution.status === "needs_reactivation"
                  ? "Reactivate Auto"
                  : "Enable Auto"}
            >
              <StopIcon />
            </button>
          )}

          <button
            type="button"
            className="strategy-dashboard-icon-btn"
            onClick={() => onOpenStrategy(card.strategyId, card.latestBacktest?.runId)}
            aria-label="Open strategy settings in Studio"
            title="Open in Studio"
          >
            <SettingsIcon />
          </button>
        </div>

        <button
          type="button"
          className="strategy-dashboard-library-delete"
          disabled={deletingId === card.strategyId || togglingId === card.strategyId || runningId === card.strategyId}
          onClick={() => void handleDelete(card)}
        >
          {deletingId === card.strategyId ? "Deleting..." : "Delete strategy"}
        </button>

        {configOpen && liveSupported && (
          <div
            className="strategy-dashboard-auto-config"
            ref={(element) => {
              autoConfigRefs.current[card.strategyId] = element;
            }}
          >
            <label>
              <span>Duration</span>
              <select
                value={activationMode}
                onChange={(event) =>
                  setActivationMode(event.target.value as "until_disabled" | "until_timestamp")
                }
              >
                <option value="until_disabled">Until disabled</option>
                <option value="until_timestamp">Until date/time</option>
              </select>
            </label>
            {activationMode === "until_timestamp" && (
              <label>
                <span>Expires at</span>
                <input
                  type="datetime-local"
                  value={activationExpiry}
                  onChange={(event) => setActivationExpiry(event.target.value)}
                />
              </label>
            )}
            <label>
              <span>Initial capital</span>
              <input
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                placeholder="Optional"
                value={activationInitialCapital}
                onChange={(event) => setActivationInitialCapital(event.target.value)}
              />
            </label>
            <div className="strategy-dashboard-inline-note">
              If the strategy uses percent-of-equity sizing, this value becomes the capital base for live entries.
            </div>
            <div className="strategy-dashboard-card-actions">
              <button
                type="button"
                className="strategy-agent-review-btn"
                disabled={togglingId === card.strategyId || (activationMode === "until_timestamp" && !activationExpiry)}
                onClick={() => void handleActivate(card)}
              >
                {togglingId === card.strategyId ? "Activating..." : "Confirm Auto"}
              </button>
              <button
                type="button"
                className="strategy-studio-secondary-link"
                onClick={() => {
                  setConfigStrategyId(null);
                  setActivationInitialCapital("");
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </article>
    );
  }

  function renderPreviewTile(card: StrategyDashboardCard, index: number) {
    const market = cardMarkets.get(card.marketId.toLowerCase());
    const strategyExecutionRows = (previewExecutions[card.strategyId] ?? []).filter(isRealExecutionTrade);
    const strategyTradeRows = buildExecutionTradeRows(strategyExecutionRows);
    const liveOverlay = liveTradeOverlay(card, previewOverlays[card.strategyId] ?? null, previewExecutions[card.strategyId] ?? []);
    const liveSummary = previewExecutionSummaries[card.strategyId];
    const currentPnlPct = liveSummary?.currentPnlPct ?? card.latestBacktest?.netPnlPct;
    const currentPrice = liveSummary?.currentPrice;
    const latestCheck = card.autoExecution.lastCheckedAt;
    const updatedLabel = latestCheck ? new Date(latestCheck).toLocaleTimeString() : "Waiting";

    return (
      <article
        key={card.strategyId}
        className={`strategy-preview-tile ${visibleHighlightId === card.strategyId ? "spotlight" : ""}`}
        ref={(element) => {
          strategyCardRefs.current[card.strategyId] = element;
        }}
        style={{ animationDelay: `${index * 90}ms` }}
      >
        <div className="strategy-preview-tile-head">
          <div className="strategy-preview-title-block">
            <div className="strategy-preview-kickers">
              <span className="strategy-preview-kicker">Running</span>
              <span className="strategy-preview-kicker strategy-preview-kicker-side">
                {liveStrategySideLabel(card.enabledSides)}
              </span>
              {card.indicators.map((indicator) => (
                <span
                  key={`${card.strategyId}-${indicator}`}
                  className="strategy-preview-kicker strategy-preview-kicker-indicator"
                >
                  {indicatorBadgeLabel(indicator)}
                </span>
              ))}
            </div>
            <h3>{card.name}</h3>
            <p>{market?.symbol ?? card.marketSymbol} · {card.timeframe}</p>
          </div>
          <div className="strategy-preview-live-status">
            <span><i /> Live</span>
            <small>updated {updatedLabel}</small>
          </div>
        </div>

        <div className="strategy-preview-stats">
          <div>
            <span>PnL %</span>
            <strong className={currentPnlPct !== undefined && currentPnlPct < 0 ? "order-side sell" : "order-side buy"}>
              {formatPercent(currentPnlPct, 2)}
            </strong>
            <small>Today</small>
          </div>
          <div>
            <span>Status</span>
            <strong>{liveStrategyStatusLabel(liveSummary?.status)}</strong>
            <small>&nbsp;</small>
          </div>
          <div>
            <span>Trades</span>
            <strong>{strategyTradeRows.length}</strong>
            <small>Today</small>
          </div>
          <div>
            <span>Position size</span>
            <strong>{liveSummary?.currentPositionBase || "--"}</strong>
            <small>{market?.baseToken.symbol ?? "Base"}</small>
          </div>
          <div>
            <span>Current price</span>
            <strong>{formatMetric(currentPrice, 5)}</strong>
            <small>{market?.quoteToken.symbol ?? "Quote"}</small>
          </div>
        </div>

        <div className="strategy-preview-chart-shell">
          <TradingViewChart
            market={market}
            timeframe={card.timeframe}
            onTimeframeChange={() => {}}
            overlay={liveOverlay}
            variant="compact"
          />
        </div>

        <div className="strategy-preview-actions">
          <button
            type="button"
            className="strategy-preview-action-btn strategy-preview-action-btn-primary"
            onClick={() => onOpenStrategy(card.strategyId, card.latestBacktest?.runId)}
          >
            <ExternalIcon />
            Open Strategy
          </button>
          <button
            type="button"
            className="strategy-preview-action-btn"
            disabled={togglingId === card.strategyId || deletingId === card.strategyId}
            onClick={() => void handleDeactivate(card)}
          >
            <PauseIcon />
            {togglingId === card.strategyId ? "Pausing..." : "Pause"}
          </button>
          <button
            type="button"
            className="strategy-preview-action-btn"
            disabled={deletingId === card.strategyId || togglingId === card.strategyId}
            onClick={() => void handleDeactivate(card)}
          >
            <StopIcon />
            {togglingId === card.strategyId ? "Disabling..." : "Disable"}
          </button>
          <button
            type="button"
            className="strategy-preview-action-btn"
            onClick={() => onOpenStrategy(card.strategyId, card.latestBacktest?.runId)}
          >
            More
            <DotsIcon />
          </button>
        </div>
      </article>
    );
  }

  return (
    <div className="strategy-dashboard-page">
      <div className="portfolio-hero strategy-dashboard-hero">
        <div>
          <div className="portfolio-kicker">Strategy Control</div>
          <h1>Strategy Dashboard</h1>
          <p>
            Monitor, run, and automate your trading strategies from a single control surface.
          </p>
        </div>
        <div className="portfolio-summary-grid">
          <div className="portfolio-stat-card">
            <span>Total</span>
            <strong>{cards.length}</strong>
          </div>
          <div className="portfolio-stat-card">
            <span>Live</span>
            <strong>{cards.filter((card) => card.autoExecution.status === "active").length}</strong>
          </div>
          <div className="portfolio-stat-card">
            <span>Tested</span>
            <strong>{cards.filter((card) => card.latestBacktest).length}</strong>
          </div>
        </div>
      </div>

      {error && <div className="error-bar">{error}</div>}

      <section className="strategy-dashboard-preview">
        <div className="strategy-dashboard-preview-head">
          <div>
            <span className="panel-title">Live Monitoring</span>
            <h2>Active Strategies</h2>
            <p>
              Strategies currently monitored by the execution engine. Each card shows the latest backtest snapshot and live chart.
            </p>
          </div>
          <div className="strategy-dashboard-preview-pill">
            <span>Running</span>
            <strong>{activeCards.length}</strong>
            {hiddenActiveCount > 0 && <small>+{hiddenActiveCount} more</small>}
          </div>
        </div>

        {previewCards.length === 0 ? (
          <div className="strategy-dashboard-preview-empty">
            No active strategies yet. Enable auto-trading on any strategy below to see it here.
          </div>
        ) : (
          <div className="strategy-dashboard-preview-grid">
            {previewCards.map((card, index) => renderPreviewTile(card, index))}
          </div>
        )}
      </section>

      <section className="strategy-dashboard-section">
        <div className="strategy-dashboard-section-head">
          <div>
            <span className="panel-title">Library</span>
            <h2>All Strategies</h2>
          </div>
          <span>{inactiveCards.length} inactive</span>
        </div>

        <div className="strategy-dashboard-grid">
          {cards.length === 0 ? (
            <div className="portfolio-empty">No strategies available for this wallet yet.</div>
          ) : (
            inactiveCards.map((card) =>
              renderStrategyCard(card, { spotlight: visibleHighlightId === card.strategyId })
            )
          )}
        </div>
      </section>
    </div>
  );
}
