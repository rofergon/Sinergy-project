type MarketSnapshot = {
  symbol: string;
  referencePrice: string;
  changePct: number;
  trend: "up" | "down";
  volumeLabel: string;
  series: number[];
};

type Props = {
  market?: MarketSnapshot;
};

export function TickerStrip({ market }: Props) {
  if (!market) return <div className="ticker-strip" />;

  const last = market.series[market.series.length - 1] ?? Number(market.referencePrice);
  const high24 = Math.max(...market.series).toFixed(2);
  const low24 = Math.min(...market.series).toFixed(2);

  return (
    <div className="ticker-strip">
      <div className="ticker-item">
        <span className={`ticker-value ticker-price-main ${market.trend}`}>
          {last.toFixed(2)}
        </span>
        <span className="ticker-label">Last Price</span>
      </div>

      <div className="ticker-divider" />

      <div className="ticker-item">
        <span className={`ticker-value ${market.trend}`}>
          {market.changePct >= 0 ? "+" : ""}{market.changePct.toFixed(2)}%
        </span>
        <span className="ticker-label">Window Change</span>
      </div>

      <div className="ticker-divider" />

      <div className="ticker-item">
        <span className="ticker-value">{high24}</span>
        <span className="ticker-label">Window High</span>
      </div>

      <div className="ticker-divider" />

      <div className="ticker-item">
        <span className="ticker-value">{low24}</span>
        <span className="ticker-label">Window Low</span>
      </div>

      <div className="ticker-divider" />

      <div className="ticker-item">
        <span className="ticker-value">{market.volumeLabel}</span>
        <span className="ticker-label">Activity</span>
      </div>

      <div className="ticker-divider" />

      <div className="ticker-item">
        <span className="ticker-value" style={{ color: "var(--accent)" }}>{market.referencePrice}</span>
        <span className="ticker-label">Reference</span>
      </div>
    </div>
  );
}
