import { useMemo, useState } from "react";
import type { Hex } from "viem";

type Market = {
  id: Hex;
  symbol: string;
  referencePrice: string;
};

type Props = {
  connected: boolean;
  address?: `0x${string}`;
  markets: Market[];
  onSubmit: (input: {
    userAddress: `0x${string}`;
    marketId: Hex;
    side: "BUY" | "SELL";
    quantity: string;
    limitPrice: string;
  }) => Promise<void>;
};

export function OrderPanel({ connected, address, markets, onSubmit }: Props) {
  const [marketId, setMarketId] = useState<Hex | "">("");
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [quantity, setQuantity] = useState("1");
  const [limitPrice, setLimitPrice] = useState("0");
  const [status, setStatus] = useState<string>("");
  const selected = useMemo(
    () => markets.find((item) => item.id === marketId),
    [marketId, markets]
  );

  return (
    <section className="panel">
      <div className="panel-header">
        <p className="eyebrow">Private Matching</p>
        <h2>Submit a dark order</h2>
      </div>

      <div className="form-grid">
        <label>
          Market
          <select
            value={marketId}
            onChange={(event) => {
              const next = event.target.value as Hex;
              setMarketId(next);
              const market = markets.find((item) => item.id === next);
              if (market) setLimitPrice(market.referencePrice);
            }}
          >
            <option value="">Select market</option>
            {markets.map((market) => (
              <option key={market.id} value={market.id}>
                {market.symbol}
              </option>
            ))}
          </select>
        </label>

        <label>
          Side
          <select value={side} onChange={(event) => setSide(event.target.value as "BUY" | "SELL")}>
            <option value="BUY">Buy</option>
            <option value="SELL">Sell</option>
          </select>
        </label>

        <label>
          Quantity
          <input value={quantity} onChange={(event) => setQuantity(event.target.value)} />
        </label>

        <label>
          Limit price
          <input value={limitPrice} onChange={(event) => setLimitPrice(event.target.value)} />
        </label>
      </div>

      {selected ? (
        <p className="muted inline-note">
          Reference price for {selected.symbol}: {selected.referencePrice}
        </p>
      ) : null}

      <div className="action-row">
        <button
          className="primary"
          disabled={!connected || !marketId || !address}
          onClick={async () => {
            if (!address || !marketId) return;

            setStatus("Submitting order to matcher...");
            try {
              await onSubmit({
                userAddress: address,
                marketId,
                side,
                quantity,
                limitPrice
              });
              setStatus("Order accepted by matcher.");
            } catch (error) {
              setStatus(error instanceof Error ? error.message : String(error));
            }
          }}
        >
          Submit order
        </button>
        <span className="status-copy">{status}</span>
      </div>
    </section>
  );
}

