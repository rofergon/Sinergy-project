import { useCallback, useEffect, useRef, useState } from "react";
import type { StrategyChartOverlay, StrategyTimeframe } from "@sinergy/shared";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
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

export function TradingViewChart({ market, timeframe, onTimeframeChange, overlay }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const [chartType, setChartType] = useState<"candle" | "line">("candle");
  const [candles, setCandles] = useState<Candle[]>([]);
  const [feedState, setFeedState] = useState<"live" | "fallback" | "loading">("loading");

  useEffect(() => {
    const assetSymbol = market?.baseToken.symbol;
    if (!assetSymbol) {
      setCandles([]);
      setFeedState("fallback");
      return;
    }

    let cancelled = false;
    const interval = timeframe;

    async function loadCandles() {
      try {
        const result = await api<{
          candles: Array<{
            ts: number;
            open: number;
            high: number;
            low: number;
            close: number;
            volume: number;
          }>;
        }>(`/prices/${assetSymbol}/candles?interval=${interval}&limit=200`);

        if (cancelled) return;
        setCandles(
          result.candles.map((bar) => ({
            time: bar.ts as UTCTimestamp,
            open: Number(bar.open),
            high: Number(bar.high),
            low: Number(bar.low),
            close: Number(bar.close),
            volume: Number(bar.volume ?? 0)
          }))
        );
        setFeedState("live");
      } catch (error) {
        if (cancelled) return;
        console.error("Failed to load chart candles:", error);
        setCandles([]);
        setFeedState("fallback");
      }
    }

    setFeedState("loading");
    void loadCandles();
    const timer = window.setInterval(() => {
      void loadCandles();
    }, 60_000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [market?.baseToken.symbol, timeframe]);

  const buildChart = useCallback(() => {
    if (!containerRef.current) return;

    if (cleanupRef.current) {
      cleanupRef.current();
      cleanupRef.current = null;
    }

    if (chartRef.current) {
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

      if (overlay && overlay.marketId === market.id && overlay.timeframe === timeframe) {
        for (const indicator of overlay.indicators) {
          const indicatorSeries = chart.addSeries(LineSeries, {
            color: indicator.color,
            lineWidth: 2,
            lastValueVisible: false,
            priceLineVisible: false
          });
          indicatorSeries.setData(
            indicator.values.map((value) => ({
              time: value.time as UTCTimestamp,
              value: value.value
            }))
          );
        }

        if (seriesRef.current) {
          createSeriesMarkers(
            seriesRef.current,
            overlay.markers.map((marker) => ({
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

      chart.timeScale().fitContent();
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
  }, [candles, chartType, market, overlay, timeframe]);

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
        </span>
      </div>
      <div className="tv-chart-container" ref={containerRef} />
    </div>
  );
}
