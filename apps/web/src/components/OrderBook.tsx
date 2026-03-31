import { useMemo } from "react";

type MarketSnapshot = {
  id: `0x${string}`;
  referencePrice: string;
  series: number[];
  trend: "up" | "down";
};

type Props = {
  market?: MarketSnapshot;
};

type OrderRow = {
  price: number;
  size: number;
  total: number;
};

function generateOrderBook(key: string, refPrice: number): { asks: OrderRow[]; bids: OrderRow[] } {
  let seed = Array.from(key).reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const depth = 16;
  const tickSize = Math.max(0.01, refPrice * 0.001);
  const spread = tickSize * 2;

  const asks: OrderRow[] = [];
  const bids: OrderRow[] = [];
  let askTotal = 0;
  let bidTotal = 0;

  for (let i = 0; i < depth; i++) {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    const askSize = Number((0.3 + (seed % 500) / 100).toFixed(4));
    askTotal += askSize;
    asks.push({
      price: Number((refPrice + spread / 2 + i * tickSize).toFixed(2)),
      size: askSize,
      total: Number(askTotal.toFixed(4)),
    });

    seed = (seed * 1664525 + 1013904223) % 4294967296;
    const bidSize = Number((0.3 + (seed % 500) / 100).toFixed(4));
    bidTotal += bidSize;
    bids.push({
      price: Number((refPrice - spread / 2 - i * tickSize).toFixed(2)),
      size: bidSize,
      total: Number(bidTotal.toFixed(4)),
    });
  }

  return { asks: asks.reverse(), bids };
}

export function OrderBook({ market }: Props) {
  const { asks, bids, maxTotal, spreadPct } = useMemo(() => {
    if (!market) return { asks: [], bids: [], maxTotal: 1, spreadPct: "0.00" };
    const refPrice = Number(market.referencePrice);
    const book = generateOrderBook(market.id, refPrice);
    const mt = Math.max(
      book.asks[book.asks.length - 1]?.total ?? 1,
      book.bids[book.bids.length - 1]?.total ?? 1
    );
    const askBest = book.asks[book.asks.length - 1]?.price ?? refPrice;
    const bidBest = book.bids[0]?.price ?? refPrice;
    const sp = (((askBest - bidBest) / askBest) * 100).toFixed(2);
    return { asks: book.asks, bids: book.bids, maxTotal: mt, spreadPct: sp };
  }, [market?.id, market?.referencePrice]);

  const mid = asks.length > 0 ? asks[asks.length - 1].price : Number(market?.referencePrice ?? 0);

  return (
    <div className="orderbook">
      <div className="panel-head">
        <span className="panel-title">Order Book</span>
      </div>

      <div className="ob-header-row">
        <span>Price</span>
        <span>Size</span>
        <span>Total</span>
      </div>

      <div className="ob-asks">
        {asks.map((row, i) => (
          <div key={`ask-${i}`} className="ob-row ask">
            <div className="ob-depth" style={{ width: `${(row.total / maxTotal) * 100}%` }} />
            <span className="ob-price">{row.price.toFixed(2)}</span>
            <span className="ob-size">{row.size.toFixed(4)}</span>
            <span className="ob-total">{row.total.toFixed(4)}</span>
          </div>
        ))}
      </div>

      <div className="ob-spread">
        <span className={market?.trend === "up" ? "" : ""} style={{ color: market?.trend === "up" ? "var(--green)" : "var(--red)" }}>
          {mid.toFixed(2)}
        </span>
        <span className="spread-label">Spread {spreadPct}%</span>
      </div>

      <div className="ob-bids">
        {bids.map((row, i) => (
          <div key={`bid-${i}`} className="ob-row bid">
            <div className="ob-depth" style={{ width: `${(row.total / maxTotal) * 100}%` }} />
            <span className="ob-price">{row.price.toFixed(2)}</span>
            <span className="ob-size">{row.size.toFixed(4)}</span>
            <span className="ob-total">{row.total.toFixed(4)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
