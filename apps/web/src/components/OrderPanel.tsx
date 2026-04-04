import { useEffect, useMemo, useState } from "react";
import { formatUnits } from "viem";
import type { Hex } from "viem";
import type { TxPopupData } from "./TransactionPopup";

type Market = {
  id: Hex;
  symbol: string;
  referencePrice: string;
  changePct?: number;
  routeable: boolean;
  routePolicy: "router-enabled" | "dark-pool-only";
  baseToken: { symbol: string; decimals: number; address: `0x${string}` };
  quoteToken: { symbol: string; decimals: number; address: `0x${string}` };
};

type Props = {
  connected: boolean;
  address?: `0x${string}`;
  markets: Market[];
  balances: {
    available: Record<string, string>;
    locked: Record<string, string>;
  } | null;
  selectedMarketId?: Hex;
  onSelectMarket: (marketId: Hex) => void;
  onSubmit: (input: {
    userAddress: `0x${string}`;
    marketId: Hex;
    side: "BUY" | "SELL";
    quantity: string;
    limitPrice: string;
  }) => Promise<void>;
  showTx: (data: TxPopupData) => void;
};

export function OrderPanel({
  connected,
  address,
  markets,
  balances,
  selectedMarketId,
  onSelectMarket,
  onSubmit,
  showTx,
}: Props) {
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [orderType, setOrderType] = useState<"limit" | "market">("market");
  const [quantity, setQuantity] = useState("1");
  const [quoteTotal, setQuoteTotal] = useState("0");
  const [limitPrice, setLimitPrice] = useState("0");
  const [pctActive, setPctActive] = useState<number | null>(null);
  const [status, setStatus] = useState("");

  const selected = useMemo(
    () => markets.find((m) => m.id === selectedMarketId),
    [selectedMarketId, markets]
  );

  const baseSymbol = selected?.baseToken?.symbol ?? "TOKEN";
  const quoteSymbol = selected?.quoteToken?.symbol ?? "USDC";
  const marketPrice = Number(selected?.referencePrice ?? "0");

  function sanitizeDecimalInput(value: string) {
    return value.replace(",", ".").replace(/[^0-9.]/g, "");
  }

  function trimDecimal(value: number, decimals = 6) {
    if (!Number.isFinite(value)) return "0";
    return value
      .toFixed(decimals)
      .replace(/\.?0+$/, "")
      .replace(/^$/, "0");
  }

  const availableBalance = useMemo(() => {
    if (!selected || !balances?.available) return 0;
    const token =
      side === "BUY" ? selected.quoteToken : selected.baseToken;
    const atomic = balances.available[token.address.toLowerCase()] ?? "0";
    return Number(formatUnits(BigInt(atomic), token.decimals));
  }, [balances, selected, side]);

  const total = useMemo(() => {
    if (orderType === "market") {
      return trimDecimal(Number(quoteTotal) || 0, 2);
    }

    const q = parseFloat(quantity) || 0;
    const p = parseFloat(limitPrice) || 0;
    return trimDecimal(q * p, 2);
  }, [quantity, limitPrice, orderType, quoteTotal]);

  useEffect(() => {
    if (!selected) return;
    setLimitPrice(selected.referencePrice);
    if (orderType === "market") {
      const nextQuantity = Number(quantity) || 0;
      setQuoteTotal(trimDecimal(nextQuantity * Number(selected.referencePrice || "0"), 2));
    }
  }, [selected, orderType]);

  function updateQuantity(nextQuantityRaw: string) {
    const nextQuantity = sanitizeDecimalInput(nextQuantityRaw);
    setQuantity(nextQuantity);
    setPctActive(null);

    if (orderType === "market") {
      const numericQuantity = Number(nextQuantity) || 0;
      setQuoteTotal(trimDecimal(numericQuantity * marketPrice, 2));
    }
  }

  function updateQuoteTotal(nextQuoteRaw: string) {
    const nextQuote = sanitizeDecimalInput(nextQuoteRaw);
    setQuoteTotal(nextQuote);
    setPctActive(null);

    if (orderType === "market") {
      const numericQuote = Number(nextQuote) || 0;
      const nextQuantity = marketPrice > 0 ? numericQuote / marketPrice : 0;
      setQuantity(trimDecimal(nextQuantity));
    }
  }

  function applyPercentage(pct: number) {
    if (!selected) return;
    setPctActive(pct);

    const fraction = pct / 100;
    if (side === "BUY") {
      const totalQuote = availableBalance * fraction;
      setQuoteTotal(trimDecimal(totalQuote, 2));
      const baseAmount = marketPrice > 0 ? totalQuote / marketPrice : 0;
      setQuantity(trimDecimal(baseAmount));
      return;
    }

    const baseAmount = availableBalance * fraction;
    setQuantity(trimDecimal(baseAmount));
    setQuoteTotal(trimDecimal(baseAmount * marketPrice, 2));
  }

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
          onClick={() => setStatus("Limit quedara para despues; por ahora Market es el flujo activo.")}
          disabled
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
                if (m) {
                  setLimitPrice(m.referencePrice);
                  const nextQuantity = Number(quantity) || 0;
                  setQuoteTotal(trimDecimal(nextQuantity * Number(m.referencePrice || "0"), 2));
                }
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
          <>
            <div className="tt-info-row" style={{ padding: "6px 0" }}>
              <span>Reference price</span>
              <span style={{ color: "var(--accent)", fontFamily: "var(--font-mono)" }}>
                {selected?.referencePrice ?? "--"} {quoteSymbol}
              </span>
            </div>

            <div className="tt-field">
              <span className="tt-field-label">Total</span>
              <div className="tt-input-wrap">
                <input
                  type="text"
                  value={quoteTotal}
                  onChange={(e) => updateQuoteTotal(e.target.value)}
                  placeholder="0.00"
                />
                <span className="tt-input-suffix">{quoteSymbol}</span>
              </div>
            </div>
          </>
        )}

        {/* Amount */}
        <div className="tt-field">
          <span className="tt-field-label">Amount</span>
          <div className="tt-input-wrap">
            <input
              type="text"
              value={quantity}
              onChange={(e) => updateQuantity(e.target.value)}
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
              onClick={() => applyPercentage(pct)}
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
          <span>{selected?.routeable ? "Dark pool / block flow" : "Off-chain dark pool"}</span>
        </div>
        <div className="tt-info-row">
          <span>Settlement</span>
          <span>On-chain via vault</span>
        </div>
        <div className="tt-info-row">
          <span>Market policy</span>
          <span>{selected?.routeable ? "Use Private Router for retail swaps" : "Dark-pool only"}</span>
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
                limitPrice: selected?.referencePrice ?? limitPrice,
              });
              setStatus("Order accepted ✓");
              setTimeout(() => setStatus(""), 3000);
              showTx({
                type: "success",
                title: `${side} Order Accepted`,
                message: `Your ${side.toLowerCase()} order for ${quantity} ${baseSymbol} has been submitted to the dark pool for execution.`,
                amount: `${quantity} ${baseSymbol}`,
                operation: `${side} Order`,
              });
            } catch (err) {
              const errorMsg = err instanceof Error ? err.message : String(err);
              setStatus(errorMsg);
              showTx({
                type: "error",
                title: "Order Rejected",
                message: errorMsg,
                amount: `${quantity} ${baseSymbol}`,
                operation: `${side} Order`,
              });
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
