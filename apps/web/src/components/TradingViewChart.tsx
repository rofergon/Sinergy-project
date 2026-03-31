import { useEffect, useRef, useState, useCallback } from "react";
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type SeriesType,
  ColorType,
  CrosshairMode,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  type UTCTimestamp,
} from "lightweight-charts";
import { api } from "../lib/api";

type MarketSnapshot = {
  id: `0x${string}`;
  symbol: string;
  referencePrice: string;
  series: number[];
  trend: "up" | "down";
  baseToken: {
    symbol: string;
  };
};

type Props = {
  market?: MarketSnapshot;
};

type Candle = {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

const TIMEFRAMES = ["1m", "5m", "15m", "1H", "4H", "1D"] as const;
type Timeframe = (typeof TIMEFRAMES)[number];

function tfMinutes(tf: Timeframe): number {
  switch (tf) {
    case "1m": return 1;
    case "5m": return 5;
    case "15m": return 15;
    case "1H": return 60;
    case "4H": return 240;
    case "1D": return 1440;
  }
}

function apiInterval(tf: Timeframe) {
  switch (tf) {
    case "1m":
      return "1m";
    case "5m":
      return "5m";
    case "15m":
      return "15m";
    case "1H":
      return "1h";
    case "4H":
      return "4h";
    case "1D":
      return "1d";
  }
}

function fallbackCandles(series: number[], anchor: number, tf: Timeframe): Candle[] {
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
    volume: 0,
  }));
}

export function TradingViewChart({ market }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const volumeRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const [tf, setTf] = useState<Timeframe>("15m");
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
        }>(`/prices/${assetSymbol}/candles?interval=${apiInterval(tf)}&limit=200`);

        if (cancelled) return;

        setCandles(
          result.candles.map((bar) => ({
            time: bar.ts as UTCTimestamp,
            open: Number(bar.open),
            high: Number(bar.high),
            low: Number(bar.low),
            close: Number(bar.close),
            volume: Number(bar.volume ?? 0),
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
  }, [market?.baseToken.symbol, tf]);

  const buildChart = useCallback(() => {
    if (!containerRef.current) return;

    // Cleanup existing
    if (cleanupRef.current) {
      cleanupRef.current();
      cleanupRef.current = null;
    }
    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
      seriesRef.current = null;
      volumeRef.current = null;
    }

    const container = containerRef.current;

    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: "#0b0e11" },
        textColor: "#848e9c",
        fontFamily: "'Inter', sans-serif",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "rgba(43, 49, 57, 0.5)" },
        horzLines: { color: "rgba(43, 49, 57, 0.5)" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: "rgba(240, 185, 11, 0.3)",
          labelBackgroundColor: "#2b3139",
        },
        horzLine: {
          color: "rgba(240, 185, 11, 0.3)",
          labelBackgroundColor: "#2b3139",
        },
      },
      rightPriceScale: {
        borderColor: "#2b3139",
        scaleMargins: { top: 0.1, bottom: 0.2 },
      },
      timeScale: {
        borderColor: "#2b3139",
        timeVisible: true,
        secondsVisible: false,
      },
      handleScroll: true,
      handleScale: true,
    });

    chartRef.current = chart;

    if (market) {
      const chartCandles =
        candles.length > 0
          ? candles
          : fallbackCandles(market.series, Number(market.referencePrice), tf);

      if (chartType === "candle") {
        const series = chart.addSeries(CandlestickSeries, {
          upColor: "#0ecb81",
          downColor: "#f6465d",
          borderUpColor: "#0ecb81",
          borderDownColor: "#f6465d",
          wickUpColor: "#0ecb81",
          wickDownColor: "#f6465d",
        });
        series.setData(chartCandles);
        seriesRef.current = series;
      } else {
        const series = chart.addSeries(LineSeries, {
          color: "#f0b90b",
          lineWidth: 2,
        });
        series.setData(
          chartCandles.map((c) => ({ time: c.time, value: c.close }))
        );
        seriesRef.current = series;
      }

      // Volume histogram
      const volumeSeries = chart.addSeries(HistogramSeries, {
        priceFormat: { type: "volume" },
        priceScaleId: "volume",
      });

      chart.priceScale("volume").applyOptions({
        scaleMargins: { top: 0.8, bottom: 0 },
      });

      volumeSeries.setData(
        chartCandles.map((c) => ({
          time: c.time,
          value: c.volume,
          color: c.close >= c.open ? "rgba(14, 203, 129, 0.25)" : "rgba(246, 70, 93, 0.25)",
        }))
      );
      volumeRef.current = volumeSeries;

      chart.timeScale().fitContent();
    }

    // Resize observer
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        chart.applyOptions({ width, height });
      }
    });

    ro.observe(container);

    cleanupRef.current = () => {
      ro.disconnect();
    };
  }, [candles, chartType, market, tf]);

  useEffect(() => {
    buildChart();
    return () => {
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
      }
    };
  }, [buildChart]);

  return (
    <div className="tv-chart-wrapper">
      <div className="tv-chart-toolbar">
        {TIMEFRAMES.map((t) => (
          <button key={t} className={`tv-tf-btn ${tf === t ? "active" : ""}`} onClick={() => setTf(t)}>
            {t}
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
