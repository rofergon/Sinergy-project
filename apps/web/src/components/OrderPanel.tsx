import { useMemo, useState } from "react";
import type { Hex } from "viem";

type Market = {
  id: Hex;
  symbol: string;
  referencePrice: string;
  changePct?: number;
  baseToken: { symbol: string; decimals: number };
  quoteToken: { symbol: string; decimals: number };
};

type Props = {
  connected: boolean;
  address?: `0x${string}`;
  markets: Market[];
  selectedMarketId?: Hex;
  onSelectMarket: (marketId: Hex) => void;
  onSubmit: (input: {
    userAddress: `0x${string}`;
    marketId: Hex;
    side: "BUY" | "SELL";
    quantity: string;
    limitPrice: string;
  }) => Promise<void>;
};

export function OrderPanel({
  connected,
  address,
  markets,
  selectedMarketId,
  onSelectMarket,
  onSubmit,
}: Props) {
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [orderType, setOrderType] = useState<"limit" | "market">("limit");
  const [quantity, setQuantity] = useState("1");
  const [limitPrice, setLimitPrice] = useState("0");
  const [pctActive, setPctActive] = useState<number | null>(null);
  const [status, setStatus] = useState("");

  const selected = useMemo(
    () => markets.find((m) => m.id === selectedMarketId),
    [selectedMarketId, markets]
  );

  const baseSymbol = selected?.baseToken?.symbol ?? "TOKEN";
  const quoteSymbol = selected?.quoteToken?.symbol ?? "USDC";

  const total = useMemo(() => {
    const q = parseFloat(quantity) || 0;
    const p = orderType === "market" ? parseFloat(selected?.referencePrice ?? "0") : parseFloat(limitPrice) || 0;
    return (q * p).toFixed(2);
  }, [quantity, limitPrice, orderType, selected]);

  return (
    <div className="trade-ticket">
      {/* Buy / Sell tabs */}
      <div className="tt-side-tabs">
        <button
          className={`tt-side-btn buy ${side === "BUY" ? "active" : ""}`}
          onClick={() => setSide("BUY")}
        >
          Buy
        </button>
        <button
          className={`tt-side-btn sell ${side === "SELL" ? "active" : ""}`}
          onClick={() => setSide("SELL")}
        >
          Sell
        </button>
      </div>

      {/* Order Type */}
      <div className="tt-type-tabs">
        <button
          className={`tt-type-btn ${orderType === "limit" ? "active" : ""}`}
          onClick={() => setOrderType("limit")}
        >
          Limit
        </button>
        <button
          className={`tt-type-btn ${orderType === "market" ? "active" : ""}`}
          onClick={() => setOrderType("market")}
        >
          Market
        </button>
      </div>

      <div className="tt-body">
        {/* Market selector (compact) */}
        <div className="tt-field">
          <span className="tt-field-label">Market</span>
          <div className="tt-input-wrap">
            <select
              value={selectedMarketId ?? ""}
              onChange={(e) => {
                const next = e.target.value as Hex;
                onSelectMarket(next);
                const m = markets.find((item) => item.id === next);
                if (m) setLimitPrice(m.referencePrice);
              }}
              style={{
                background: "none",
                border: "none",
                color: "var(--text-primary)",
                fontFamily: "var(--font-mono)",
                fontSize: 14,
                fontWeight: 600,
                padding: "10px 0",
                outline: "none",
                width: "100%",
                cursor: "pointer",
              }}
            >
              <option value="">Select pair</option>
              {markets.map((m) => (
                <option key={m.id} value={m.id}>{m.symbol}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Price */}
        {orderType === "limit" && (
          <div className="tt-field">
            <span className="tt-field-label">Price</span>
            <div className="tt-input-wrap">
              <input
                type="text"
                value={limitPrice}
                onChange={(e) => setLimitPrice(e.target.value)}
                placeholder="0.00"
              />
              <span className="tt-input-suffix">{quoteSymbol}</span>
            </div>
          </div>
        )}

        {orderType === "market" && (
          <div className="tt-info-row" style={{ padding: "6px 0" }}>
            <span>Price</span>
            <span style={{ color: "var(--accent)", fontFamily: "var(--font-mono)" }}>
              Market ({selected?.referencePrice ?? "--"})
            </span>
          </div>
        )}

        {/* Amount */}
        <div className="tt-field">
          <span className="tt-field-label">Amount</span>
          <div className="tt-input-wrap">
            <input
              type="text"
              value={quantity}
              onChange={(e) => { setQuantity(e.target.value); setPctActive(null); }}
              placeholder="0.00"
            />
            <span className="tt-input-suffix">{baseSymbol}</span>
          </div>
        </div>

        {/* Percentage Quick Buttons */}
        <div className="tt-pct-row">
          {[25, 50, 75, 100].map((pct) => (
            <button
              key={pct}
              className={`tt-pct-btn ${pctActive === pct ? "active" : ""}`}
              onClick={() => setPctActive(pct)}
            >
              {pct}%
            </button>
          ))}
        </div>

        {/* Total */}
        <div className="tt-total">
          <span>Total</span>
          <strong>{total} {quoteSymbol}</strong>
        </div>

        {/* Info rows */}
        <div className="tt-info-row">
          <span>Execution</span>
          <span>Off-chain dark pool</span>
        </div>
        <div className="tt-info-row">
          <span>Settlement</span>
          <span>On-chain via vault</span>
        </div>

        {/* Submit */}
        <button
          className={`tt-submit ${side === "BUY" ? "buy" : "sell"}`}
          disabled={!connected || !selectedMarketId || !address}
          onClick={async () => {
            if (!address || !selectedMarketId) return;
            setStatus("Submitting…");
            try {
              await onSubmit({
                userAddress: address,
                marketId: selectedMarketId,
                side,
                quantity,
                limitPrice: orderType === "market" ? (selected?.referencePrice ?? "0") : limitPrice,
              });
              setStatus("Order accepted ✓");
              setTimeout(() => setStatus(""), 3000);
            } catch (err) {
              setStatus(err instanceof Error ? err.message : String(err));
            }
          }}
        >
          {side === "BUY" ? `Buy ${baseSymbol}` : `Sell ${baseSymbol}`}
        </button>

        {status && <div className="tt-status">{status}</div>}
      </div>
    </div>
  );
}
