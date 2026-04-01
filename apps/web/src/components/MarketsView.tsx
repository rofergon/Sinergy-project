import type { Hex } from "viem";

type Token = {
  symbol: string;
  name: string;
  address: `0x${string}`;
  decimals: number;
  kind: "quote" | "rwa" | "crypto";
};

type Market = {
  id: Hex;
  symbol: string;
  baseToken: Token;
  quoteToken: Token;
  referencePrice: string;
  series: number[];
  changePct: number;
  trend: "up" | "down";
  volumeLabel: string;
  routeable: boolean;
  routePolicy: "router-enabled" | "dark-pool-only";
};

type Props = {
  markets: Market[];
  selectedMarketId?: Hex;
  onSelectMarket: (id: Hex) => void;
  onGoTrade: () => void;
};

function fmtPrice(value: string) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return value;
  return `$${amount.toLocaleString(undefined, {
    minimumFractionDigits: amount >= 100 ? 2 : 4,
    maximumFractionDigits: amount >= 100 ? 2 : 4,
  })}`;
}

function fmtPercent(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function sparklinePoints(series: number[]) {
  if (series.length === 0) return "";

  const min = Math.min(...series);
  const max = Math.max(...series);
  const range = max - min || 1;

  return series
    .map((point, index) => {
      const x = (index / Math.max(series.length - 1, 1)) * 100;
      const y = 100 - ((point - min) / range) * 100;
      return `${x},${y}`;
    })
    .join(" ");
}

export function MarketsView({
  markets,
  selectedMarketId,
  onSelectMarket,
  onGoTrade,
}: Props) {
  const selectedMarket =
    markets.find((market) => market.id === selectedMarketId) ?? markets[0];
  const routedCount = markets.filter((market) => market.routePolicy === "router-enabled").length;
  const winners = [...markets].sort((a, b) => b.changePct - a.changePct).slice(0, 3);

  return (
    <div className="markets-page">
      <section className="markets-hero">
        <div className="markets-hero-copy">
          <div className="markets-kicker">Market Pulse</div>
          <h1>Descubre pares listos para operar en Sinergy</h1>
          <p>
            Revisa momentum, liquidez simulada y disponibilidad de ruteo antes de saltar al terminal.
          </p>

          <div className="markets-hero-actions">
            <button
              className="markets-primary-btn"
              onClick={() => {
                if (selectedMarket) {
                  onSelectMarket(selectedMarket.id);
                }
                onGoTrade();
              }}
            >
              Abrir Trading
            </button>
            <div className="markets-hero-pill">
              {routedCount}/{markets.length} markets con router activo
            </div>
          </div>
        </div>

        {selectedMarket && (
          <div className="markets-spotlight">
            <div className="markets-spotlight-head">
              <div>
                <span className="markets-spotlight-label">Featured Pair</span>
                <h2>{selectedMarket.symbol}</h2>
              </div>
              <span
                className={`route-badge ${
                  selectedMarket.routePolicy === "router-enabled" ? "router" : "dark"
                }`}
              >
                {selectedMarket.routePolicy === "router-enabled" ? "Router" : "Dark pool"}
              </span>
            </div>

            <div className="markets-spotlight-metrics">
              <div>
                <span>Reference</span>
                <strong>{fmtPrice(selectedMarket.referencePrice)}</strong>
              </div>
              <div>
                <span>24h move</span>
                <strong className={selectedMarket.trend}>{fmtPercent(selectedMarket.changePct)}</strong>
              </div>
              <div>
                <span>Flow</span>
                <strong>{selectedMarket.volumeLabel}</strong>
              </div>
            </div>

            <div className="markets-spotlight-chart">
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                <polyline
                  points={sparklinePoints(selectedMarket.series)}
                  className={selectedMarket.trend}
                />
              </svg>
            </div>
          </div>
        )}
      </section>

      <section className="markets-top-movers">
        {winners.map((market, index) => (
          <button
            key={market.id}
            className={`markets-mover-card ${market.id === selectedMarket?.id ? "active" : ""}`}
            onClick={() => onSelectMarket(market.id)}
          >
            <span className="markets-mover-rank">0{index + 1}</span>
            <strong>{market.symbol}</strong>
            <span className={`markets-mover-change ${market.trend}`}>{fmtPercent(market.changePct)}</span>
            <small>{market.volumeLabel} est. volume</small>
          </button>
        ))}
      </section>

      <section className="markets-board">
        <div className="markets-board-head">
          <div>
            <span className="markets-board-label">All Markets</span>
            <h2>Explora y entra al par correcto</h2>
          </div>
          <p>
            Selecciona un mercado para destacarlo arriba o ábrelo directo en la vista de trading.
          </p>
        </div>

        <div className="markets-table">
          <div className="markets-table-head">
            <span>Pair</span>
            <span>Reference</span>
            <span>24h</span>
            <span>Liquidity</span>
            <span>Access</span>
            <span>Action</span>
          </div>

          {markets.map((market) => (
            <div
              key={market.id}
              className={`markets-table-row ${market.id === selectedMarket?.id ? "active" : ""}`}
            >
              <button
                className="markets-pair-btn"
                onClick={() => onSelectMarket(market.id)}
              >
                <strong>{market.symbol}</strong>
                <small>
                  {market.baseToken.symbol} / {market.quoteToken.symbol}
                </small>
              </button>

              <span className="markets-table-mono">{fmtPrice(market.referencePrice)}</span>
              <span className={`markets-table-change ${market.trend}`}>{fmtPercent(market.changePct)}</span>
              <span className="markets-table-mono">{market.volumeLabel}</span>
              <span>
                <span className={`route-badge ${market.routePolicy === "router-enabled" ? "router" : "dark"}`}>
                  {market.routeable ? "Routeable" : "Dark only"}
                </span>
              </span>
              <button
                className="markets-open-btn"
                onClick={() => {
                  onSelectMarket(market.id);
                  onGoTrade();
                }}
              >
                Trade now
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
