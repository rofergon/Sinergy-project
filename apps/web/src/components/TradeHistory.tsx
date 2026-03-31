import { useMemo } from "react";

type MarketSnapshot = {
  id: `0x${string}`;
  referencePrice: string;
  series: number[];
};

type Props = {
  market?: MarketSnapshot;
};

type TradeRow = {
  price: number;
  amount: number;
  time: string;
  side: "buy" | "sell";
};

function generateTrades(key: string, refPrice: number): TradeRow[] {
  let seed = Array.from(key).reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const count = 40;
  const trades: TradeRow[] = [];
  const now = Date.now();

  for (let i = 0; i < count; i++) {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    const side: "buy" | "sell" = seed % 2 === 0 ? "buy" : "sell";
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    const priceDeviation = ((seed % 1000) / 1000 - 0.5) * refPrice * 0.006;
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    const amount = 0.01 + (seed % 5000) / 1000;

    const tradeTime = new Date(now - i * 18000 - (seed % 12000));
    const timeStr = tradeTime.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    trades.push({
      price: Number((refPrice + priceDeviation).toFixed(2)),
      amount: Number(amount.toFixed(4)),
      time: timeStr,
      side,
    });
  }

  return trades;
}

export function TradeHistory({ market }: Props) {
  const trades = useMemo(() => {
    if (!market) return [];
    return generateTrades(market.id, Number(market.referencePrice));
  }, [market?.id, market?.referencePrice]);

  return (
    <div className="trades-table">
      <div className="trades-table-header">
        <span>Price</span>
        <span>Amount</span>
        <span>Time</span>
      </div>
      <div>
        {trades.map((t, i) => (
          <div key={i} className="trade-row">
            <span className={`trade-price ${t.side}`}>{t.price.toFixed(2)}</span>
            <span className="trade-amount">{t.amount.toFixed(4)}</span>
            <span className="trade-time">{t.time}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
