import { useEffect, useMemo, useState } from "react";
import { formatUnits } from "viem";
import type { Address, Hex } from "viem";
import { api } from "../lib/api";

type Token = {
  symbol: string;
  decimals: number;
  address: Address;
};

type Market = {
  id: Hex;
  symbol: string;
  routeable: boolean;
  routePolicy: "router-enabled" | "dark-pool-only";
  baseToken: Token;
  quoteToken: Token;
};

type BridgeStatus = {
  relayer: boolean;
  opinit: boolean;
  ready: boolean;
  checkedAt: string;
  details: string[];
};

type InventoryPosition = {
  symbol: string;
  tokenAddress: Address;
  amountAtomic: string;
  minAtomic: string;
  targetAtomic: string;
  maxAtomic: string;
  routeable: boolean;
};

type QuoteResponse = {
  mode: "instant_local" | "async_rebalance_required" | "unsupported_asset";
  expiry: string;
  routeable: boolean;
  quotedOutAtomic: string;
  minOutAtomic: string;
  sourceBreakdown: {
    localInventoryAtomic: string;
    l1DexAtomic: string;
    inventoryStatus: "healthy" | "low" | "unsupported";
  };
  bridge: BridgeStatus;
  marketSymbol: string;
  fromSymbol: string;
  toSymbol: string;
};

type SwapJob = {
  id: string;
  state:
    | "queued"
    | "bridging_out"
    | "bridging_in"
    | "l1_swap"
    | "settling_back"
    | "completed"
    | "failed";
  error?: string;
  quotedOutAtomic: string;
  toToken: Address;
};

type Props = {
  connected: boolean;
  address?: Address;
  selectedMarket?: Market;
  bridgeStatus: BridgeStatus | null;
  inventory: InventoryPosition[];
  onAfterMutation: () => Promise<void>;
};

function formatAtomic(amountAtomic: string, decimals: number) {
  try {
    return Number(formatUnits(BigInt(amountAtomic), decimals)).toFixed(4);
  } catch {
    return "0.0000";
  }
}

function jobToUiStatus(state: SwapJob["state"]) {
  if (state === "completed") return "completed";
  if (state === "failed") return "failed";
  if (state === "queued") return "executing";
  return "rebalancing";
}

export function SwapPanel({
  connected,
  address,
  selectedMarket,
  bridgeStatus,
  inventory,
  onAfterMutation
}: Props) {
  const [fromToken, setFromToken] = useState<Address | undefined>(selectedMarket?.quoteToken.address);
  const [amount, setAmount] = useState("100");
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [status, setStatus] = useState("quoted");
  const [message, setMessage] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [isQuoting, setIsQuoting] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);

  useEffect(() => {
    setFromToken(selectedMarket?.quoteToken.address);
    setQuote(null);
    setStatus("quoted");
    setMessage("");
    setJobId(null);
  }, [selectedMarket?.id]);

  useEffect(() => {
    if (!jobId) return;

    const timer = window.setInterval(async () => {
      try {
        const result = await api<{ job: SwapJob }>(`/swap/status/${jobId}`);
        const nextStatus = jobToUiStatus(result.job.state);
        setStatus(nextStatus);
        if (nextStatus === "completed") {
          setMessage("Swap settled back to the vault inventory.");
          setQuote((current) =>
            current
              ? {
                  ...current,
                  minOutAtomic: result.job.quotedOutAtomic
                }
              : current
          );
          await onAfterMutation();
          window.clearInterval(timer);
        }

        if (nextStatus === "failed") {
          setMessage(result.job.error ?? "Swap job failed.");
          await onAfterMutation();
          window.clearInterval(timer);
        }
      } catch (error) {
        setStatus("failed");
        setMessage(error instanceof Error ? error.message : String(error));
        window.clearInterval(timer);
      }
    }, 4_000);

    return () => window.clearInterval(timer);
  }, [jobId, onAfterMutation]);

  const outputToken = useMemo(() => {
    if (!selectedMarket || !fromToken) return null;
    return selectedMarket.baseToken.address === fromToken
      ? selectedMarket.quoteToken
      : selectedMarket.baseToken;
  }, [selectedMarket, fromToken]);

  const outputInventory = useMemo(() => {
    if (!outputToken) return null;
    return inventory.find((item) => item.tokenAddress === outputToken.address) ?? null;
  }, [inventory, outputToken]);

  async function requestQuote() {
    if (!selectedMarket || !fromToken || !address) return;
    setIsQuoting(true);
    setJobId(null);
    setStatus("quoted");
    setMessage("Fetching InitiaDEX-backed quote…");

    try {
      const result = await api<{ quote: QuoteResponse }>("/swap/quote", {
        method: "POST",
        body: JSON.stringify({
          userAddress: address,
          marketId: selectedMarket.id,
          fromToken,
          amount
        })
      });
      setQuote(result.quote);
      setMessage(
        result.quote.mode === "instant_local"
          ? "Quote ready for instant local fill."
          : result.quote.mode === "async_rebalance_required"
            ? "Quote ready, but settlement will route through async rebalance."
            : "This market is dark-pool only for now."
      );
    } catch (error) {
      setJobId(null);
      setStatus("failed");
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsQuoting(false);
    }
  }

  async function executeSwap() {
    if (!selectedMarket || !fromToken || !address) return;
    setIsExecuting(true);
    setJobId(null);
    setStatus("executing");
    setMessage("Executing private router swap…");

    try {
      const result = await api<{
        status: "completed" | "rebalancing";
        jobId: string | null;
        settledOutAtomic: string | null;
        quote: QuoteResponse;
      }>("/swap/execute", {
        method: "POST",
        body: JSON.stringify({
          userAddress: address,
          marketId: selectedMarket.id,
          fromToken,
          amount
        })
      });

      setQuote(result.quote);
      setStatus(result.status);
      setJobId(result.status === "rebalancing" ? result.jobId : null);
      setMessage(
        result.status === "completed"
          ? "Swap completed with local liquidity."
          : "Swap queued for rebalance across L1 liquidity."
      );
      await onAfterMutation();
    } catch (error) {
      setJobId(null);
      setStatus("failed");
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsExecuting(false);
    }
  }

  return (
    <div className="swap-panel">
      <div className="panel-head" style={{ padding: "0 0 10px", border: "none" }}>
        <span className="panel-title">Private Router</span>
        <span className={`route-badge ${selectedMarket?.routeable ? "router" : "dark"}`}>
          {selectedMarket?.routeable ? "Router-enabled" : "Dark-pool only"}
        </span>
      </div>

      <div className="swap-surface">
        <div className="swap-status-row">
          <span>Bridge</span>
          <strong className={bridgeStatus?.ready ? "bridge-ready" : "bridge-down"}>
            {bridgeStatus?.ready ? "Healthy" : "Degraded"}
          </strong>
        </div>

        <div className="swap-status-row">
          <span>Flow</span>
          <strong>{status}</strong>
        </div>

        <div className="tt-field">
          <span className="tt-field-label">From</span>
          <div className="tt-input-wrap">
            <select
              value={fromToken ?? ""}
              onChange={(event) => setFromToken(event.target.value as Address)}
            >
              {selectedMarket ? (
                <>
                  <option value={selectedMarket.quoteToken.address}>
                    {selectedMarket.quoteToken.symbol}
                  </option>
                  <option value={selectedMarket.baseToken.address}>
                    {selectedMarket.baseToken.symbol}
                  </option>
                </>
              ) : (
                <option value="">Select market</option>
              )}
            </select>
          </div>
        </div>

        <div className="tt-field">
          <span className="tt-field-label">Amount</span>
          <div className="tt-input-wrap">
            <input
              type="text"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="0.00"
            />
            <span className="tt-input-suffix">
              {selectedMarket && fromToken === selectedMarket.baseToken.address
                ? selectedMarket.baseToken.symbol
                : selectedMarket?.quoteToken.symbol ?? "TOKEN"}
            </span>
          </div>
        </div>

        <div className="swap-actions">
          <button
            className="swap-btn secondary"
            disabled={!connected || !address || !selectedMarket || isQuoting || isExecuting}
            onClick={requestQuote}
          >
            Get Quote
          </button>
          <button
            className="swap-btn primary"
            disabled={
              !connected ||
              !address ||
              !selectedMarket ||
              !quote ||
              isQuoting ||
              isExecuting ||
              status === "rebalancing"
            }
            onClick={executeSwap}
          >
            Execute
          </button>
        </div>

        <div className="swap-metrics">
          <div className="swap-status-row">
            <span>Quoted out</span>
            <strong>
              {quote && outputToken ? formatAtomic(quote.quotedOutAtomic, outputToken.decimals) : "--"}{" "}
              {outputToken?.symbol ?? ""}
            </strong>
          </div>
          <div className="swap-status-row">
            <span>Min out</span>
            <strong>
              {quote && outputToken ? formatAtomic(quote.minOutAtomic, outputToken.decimals) : "--"}{" "}
              {outputToken?.symbol ?? ""}
            </strong>
          </div>
          <div className="swap-status-row">
            <span>Inventory</span>
            <strong>
              {outputInventory
                ? `${formatAtomic(outputInventory.amountAtomic, outputToken?.decimals ?? 18)} ${outputInventory.symbol}`
                : "--"}
            </strong>
          </div>
          <div className="swap-status-row">
            <span>Route mode</span>
            <strong>{quote?.mode ?? selectedMarket?.routePolicy ?? "--"}</strong>
          </div>
        </div>

        {message && <div className={`swap-message ${status}`}>{message}</div>}
      </div>
    </div>
  );
}
