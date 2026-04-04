import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StrategyChartOverlay, StrategyTimeframe } from "@sinergy/shared";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type SeriesType,
  type UTCTimestamp
} from "lightweight-charts";
import { api } from "../lib/api";
import type { MarketSnapshot } from "../types";

type Props = {
  market?: MarketSnapshot;
  timeframe: StrategyTimeframe;
  onTimeframeChange: (timeframe: StrategyTimeframe) => void;
  overlay?: StrategyChartOverlay | null;
};

type Candle = {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type CandleResponse = {
  candles: Array<{
    ts: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>;
  hasMore?: boolean;
};

type LogicalRange = {
  from: number;
  to: number;
};

const TIMEFRAMES: Array<{ value: StrategyTimeframe; label: string }> = [
  { value: "1m", label: "1m" },
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
  { value: "1h", label: "1H" },
  { value: "4h", label: "4H" },
  { value: "1d", label: "1D" }
];

function tfMinutes(tf: StrategyTimeframe): number {
  switch (tf) {
    case "1m":
      return 1;
    case "5m":
      return 5;
    case "15m":
      return 15;
    case "1h":
      return 60;
    case "4h":
      return 240;
    case "1d":
      return 1440;
  }
}

function fallbackCandles(series: number[], anchor: number, tf: StrategyTimeframe): Candle[] {
  const values = series.length > 0 ? series : [anchor];
  const tfMin = tfMinutes(tf);
  const now = Math.floor(Date.now() / 1000);
  const baseTime = now - values.length * tfMin * 60;

  return values.map((value, index) => ({
    time: (baseTime + index * tfMin * 60) as UTCTimestamp,
    open: value,
    high: value,
    low: value,
    close: value,
    volume: 0
  }));
}

function candleRequestLimit(timeframe: StrategyTimeframe, mode: "initial" | "refresh" | "older") {
  switch (timeframe) {
    case "1m":
      return mode === "refresh" ? 240 : 720;
    case "5m":
      return mode === "refresh" ? 240 : 720;
    case "15m":
      return mode === "refresh" ? 320 : 960;
    case "1h":
      return mode === "refresh" ? 240 : 720;
    case "4h":
      return mode === "refresh" ? 180 : 540;
    case "1d":
      return mode === "refresh" ? 120 : 365;
  }
}

function normalizeCandles(
  candles: CandleResponse["candles"]
): Candle[] {
  return candles.map((bar) => ({
    time: bar.ts as UTCTimestamp,
    open: Number(bar.open),
    high: Number(bar.high),
    low: Number(bar.low),
    close: Number(bar.close),
    volume: Number(bar.volume ?? 0)
  }));
}

function mergeCandles(existing: Candle[], incoming: Candle[]) {
  const merged = new Map<number, Candle>();
  for (const candle of existing) merged.set(Number(candle.time), candle);
  for (const candle of incoming) merged.set(Number(candle.time), candle);
  return [...merged.values()].sort((left, right) => Number(left.time) - Number(right.time));
}

export function TradingViewChart({ market, timeframe, onTimeframeChange, overlay }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const [chartType, setChartType] = useState<"candle" | "line">("candle");
  const [candles, setCandles] = useState<Candle[]>([]);
  const [feedState, setFeedState] = useState<"live" | "fallback" | "loading">("loading");
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [loadingMoreHistory, setLoadingMoreHistory] = useState(false);
  const candlesRef = useRef<Candle[]>([]);
  const hasMoreHistoryRef = useRef(false);
  const loadingMoreHistoryRef = useRef(false);
  const visibleRangeRef = useRef<LogicalRange | null>(null);
  const pendingRangeRef = useRef<LogicalRange | null>(null);
  const shouldFitContentRef = useRef(true);
  const activeDatasetRef = useRef("");

  useEffect(() => {
    candlesRef.current = candles;
  }, [candles]);

  useEffect(() => {
    hasMoreHistoryRef.current = hasMoreHistory;
  }, [hasMoreHistory]);

  useEffect(() => {
    loadingMoreHistoryRef.current = loadingMoreHistory;
  }, [loadingMoreHistory]);

  const activeOverlay = useMemo(() => {
    if (!overlay || !market) return null;
    if (overlay.marketId !== market.id || overlay.timeframe !== timeframe) return null;
    return overlay;
  }, [market, overlay, timeframe]);

  const indicatorLegendItems = useMemo(() => {
    if (!activeOverlay) return [];
    return activeOverlay.indicators
      .map((indicator) => {
        const lastPoint = indicator.values[indicator.values.length - 1];
        if (!lastPoint) return null;
        return {
          id: indicator.id,
          label: indicator.label,
          color: indicator.color,
          pane: indicator.pane,
          value: lastPoint.value
        };
      })
      .filter((item): item is {
        id: string;
        label: string;
        color: string;
        pane: "price" | "oscillator";
        value: number;
      } => item !== null);
  }, [activeOverlay]);

  const loadCandles = useCallback(
    async (mode: "initial" | "refresh" | "older") => {
      const assetSymbol = market?.baseToken.symbol;
      if (!assetSymbol) {
        setCandles([]);
        setHasMoreHistory(false);
        setFeedState("fallback");
        return;
      }

      const datasetKey = `${assetSymbol}:${timeframe}`;
      const beforeTs =
        mode === "older" ? Number(candlesRef.current[0]?.time ?? 0) : undefined;

      if (mode === "older") {
        if (!beforeTs || loadingMoreHistoryRef.current) return;
        setLoadingMoreHistory(true);
      }

      try {
        const result = await api<CandleResponse>(
          `/prices/${assetSymbol}/candles?interval=${timeframe}&limit=${candleRequestLimit(timeframe, mode)}${beforeTs ? `&before=${beforeTs}` : ""}`
        );

        if (activeDatasetRef.current !== datasetKey) return;

        const incoming = normalizeCandles(result.candles);
        if (mode === "initial") {
          shouldFitContentRef.current = true;
          visibleRangeRef.current = null;
          setCandles(incoming);
          setHasMoreHistory(Boolean(result.hasMore));
        } else if (mode === "refresh") {
          setCandles((current) => mergeCandles(current, incoming));
          setHasMoreHistory((current) => current || Boolean(result.hasMore));
        } else {
          const current = candlesRef.current;
          const merged = mergeCandles(current, incoming);
          const added = Math.max(merged.length - current.length, 0);
          if (visibleRangeRef.current && added > 0) {
            pendingRangeRef.current = {
              from: visibleRangeRef.current.from + added,
              to: visibleRangeRef.current.to + added
            };
          }
          setCandles(merged);
          setHasMoreHistory(Boolean(result.hasMore));
        }
        setFeedState("live");
      } catch (error) {
        if (activeDatasetRef.current !== datasetKey) return;
        if (mode === "initial") {
          console.error("Failed to load chart candles:", error);
          setCandles([]);
          setHasMoreHistory(false);
          setFeedState("fallback");
        }
      } finally {
        if (mode === "older") {
          setLoadingMoreHistory(false);
        }
      }
    },
    [market?.baseToken.symbol, timeframe]
  );

  useEffect(() => {
    const assetSymbol = market?.baseToken.symbol;
    activeDatasetRef.current = assetSymbol ? `${assetSymbol}:${timeframe}` : "";
    shouldFitContentRef.current = true;
    visibleRangeRef.current = null;
    pendingRangeRef.current = null;
    setFeedState("loading");
    void loadCandles("initial");
    const timer = window.setInterval(() => {
      void loadCandles("refresh");
    }, 60_000);

    return () => {
      window.clearInterval(timer);
    };
  }, [loadCandles, market?.baseToken.symbol, timeframe]);

  const buildChart = useCallback(() => {
    if (!containerRef.current) return;

    if (cleanupRef.current) {
      cleanupRef.current();
      cleanupRef.current = null;
    }

    if (chartRef.current) {
      const previousRange = chartRef.current.timeScale().getVisibleLogicalRange();
      if (previousRange) {
        visibleRangeRef.current = previousRange as LogicalRange;
      }
      chartRef.current.remove();
      chartRef.current = null;
      seriesRef.current = null;
    }

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "#0b0e11" },
        textColor: "#848e9c",
        fontFamily: "'Inter', sans-serif",
        fontSize: 11
      },
      grid: {
        vertLines: { color: "rgba(43, 49, 57, 0.5)" },
        horzLines: { color: "rgba(43, 49, 57, 0.5)" }
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: "rgba(240, 185, 11, 0.3)",
          labelBackgroundColor: "#2b3139"
        },
        horzLine: {
          color: "rgba(240, 185, 11, 0.3)",
          labelBackgroundColor: "#2b3139"
        }
      },
      rightPriceScale: {
        borderColor: "#2b3139",
        scaleMargins: { top: 0.1, bottom: 0.2 }
      },
      timeScale: {
        borderColor: "#2b3139",
        timeVisible: true,
        secondsVisible: false
      },
      handleScroll: true,
      handleScale: true
    });

    chartRef.current = chart;

    if (market) {
      const chartCandles =
        candles.length > 0
          ? candles
          : fallbackCandles(market.series, Number(market.referencePrice), timeframe);

      if (chartType === "candle") {
        const series = chart.addSeries(CandlestickSeries, {
          upColor: "#0ecb81",
          downColor: "#f6465d",
          borderUpColor: "#0ecb81",
          borderDownColor: "#f6465d",
          wickUpColor: "#0ecb81",
          wickDownColor: "#f6465d"
        });
        series.setData(chartCandles);
        seriesRef.current = series;
      } else {
        const series = chart.addSeries(LineSeries, {
          color: "#f0b90b",
          lineWidth: 2
        });
        series.setData(chartCandles.map((candle) => ({ time: candle.time, value: candle.close })));
        seriesRef.current = series;
      }

      const volumeSeries = chart.addSeries(HistogramSeries, {
        priceFormat: { type: "volume" },
        priceScaleId: "volume"
      });
      chart.priceScale("volume").applyOptions({
        scaleMargins: { top: 0.8, bottom: 0 }
      });
      volumeSeries.setData(
        chartCandles.map((candle) => ({
          time: candle.time,
          value: candle.volume,
          color:
            candle.close >= candle.open
              ? "rgba(14, 203, 129, 0.25)"
              : "rgba(246, 70, 93, 0.25)"
        }))
      );

      if (activeOverlay) {
        let hasOscillatorPane = false;
        for (const indicator of activeOverlay.indicators) {
          const paneIndex = indicator.pane === "oscillator" ? 1 : 0;
          if (indicator.pane === "oscillator") {
            hasOscillatorPane = true;
          }
          const indicatorSeries = chart.addSeries(LineSeries, {
            color: indicator.color,
            lineWidth: indicator.pane === "oscillator" ? 1 : 2,
            lineStyle: indicator.pane === "oscillator" ? LineStyle.Dashed : LineStyle.Solid,
            lastValueVisible: false,
            priceLineVisible: false,
            title: indicator.label
          }, paneIndex);
          indicatorSeries.setData(
            indicator.values.map((value) => ({
              time: value.time as UTCTimestamp,
              value: value.value
            }))
          );
        }

        if (hasOscillatorPane) {
          chart.priceScale("right", 1).applyOptions({
            scaleMargins: { top: 0.1, bottom: 0.08 },
            autoScale: true
          });
          chart.priceScale("left", 1).applyOptions({
            visible: false
          });
        }

        if (seriesRef.current) {
          createSeriesMarkers(
            seriesRef.current,
            activeOverlay.markers.map((marker) => ({
              id: marker.id,
              time: marker.time as UTCTimestamp,
              position: marker.position,
              shape: marker.shape,
              color: marker.color,
              text: marker.text
            }))
          );
        }
      }

      if (pendingRangeRef.current) {
        chart.timeScale().setVisibleLogicalRange(pendingRangeRef.current);
        visibleRangeRef.current = pendingRangeRef.current;
        pendingRangeRef.current = null;
        shouldFitContentRef.current = false;
      } else if (shouldFitContentRef.current) {
        chart.timeScale().fitContent();
        shouldFitContentRef.current = false;
      } else if (visibleRangeRef.current) {
        chart.timeScale().setVisibleLogicalRange(visibleRangeRef.current);
      }

      chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        if (!range) return;
        visibleRangeRef.current = range as LogicalRange;

        if (
          range.from < 50 &&
          hasMoreHistoryRef.current &&
          !loadingMoreHistoryRef.current &&
          candlesRef.current.length > 0
        ) {
          void loadCandles("older");
        }
      });
    }

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        chart.applyOptions({
          width: entry.contentRect.width,
          height: entry.contentRect.height
        });
      }
    });

    ro.observe(containerRef.current);
    cleanupRef.current = () => ro.disconnect();
  }, [activeOverlay, candles, chartType, loadCandles, market, timeframe]);

  useEffect(() => {
    buildChart();
    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
      chartRef.current?.remove();
      chartRef.current = null;
    };
  }, [buildChart]);

  return (
    <div className="tv-chart-wrapper">
      <div className="tv-chart-toolbar">
        {TIMEFRAMES.map((item) => (
          <button
            key={item.value}
            className={`tv-tf-btn ${timeframe === item.value ? "active" : ""}`}
            onClick={() => onTimeframeChange(item.value)}
          >
            {item.label}
          </button>
        ))}
        <div className="tv-tf-sep" />
        <button
          className={`tv-tf-btn ${chartType === "candle" ? "active" : ""}`}
          onClick={() => setChartType("candle")}
          title="Candlestick"
        >
          Candles
        </button>
        <button
          className={`tv-tf-btn ${chartType === "line" ? "active" : ""}`}
          onClick={() => setChartType("line")}
          title="Line"
        >
          Line
        </button>
        <div className="tv-tf-sep" />
        <span style={{ fontSize: 11, color: "var(--text-tertiary)", marginLeft: "auto" }}>
          {market?.symbol ?? "---"} · {feedState === "live" ? "live data" : feedState}
          {loadingMoreHistory ? " · loading history" : ""}
        </span>
      </div>
      {indicatorLegendItems.length > 0 && (
        <div className="tv-indicator-legend">
          {indicatorLegendItems.map((item) => (
            <div key={item.id} className="tv-indicator-chip">
              <span className="tv-indicator-dot" style={{ backgroundColor: item.color }} />
              <div className="tv-indicator-copy">
                <strong>{item.label}</strong>
                <small>
                  {item.pane === "oscillator" ? "Oscillator" : "Price"} · {item.value.toFixed(2)}
                </small>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="tv-chart-container" ref={containerRef} />
    </div>
  );
}
