import { useEffect, useMemo, useState } from "react";
import { formatUnits } from "viem";
import type { Address, Hex } from "viem";
import { api } from "../lib/api";
import type { TxPopupData } from "./TransactionPopup";

type RoutePreference = "auto" | "local" | "dex";

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
  requestedRoute: RoutePreference;
  executionPath: "local" | "dex" | "unavailable";
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
  inventory: InventoryPosition[];
  onAfterMutation: () => Promise<void>;
  showTx: (data: TxPopupData) => void;
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
  inventory,
  onAfterMutation,
  showTx
}: Props) {
  const [fromToken, setFromToken] = useState<Address | undefined>(selectedMarket?.quoteToken.address);
  const [amount, setAmount] = useState("100");
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [status, setStatus] = useState("quoted");
  const [message, setMessage] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [isQuoting, setIsQuoting] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [routePreference, setRoutePreference] = useState<RoutePreference>("auto");

  useEffect(() => {
    setFromToken(selectedMarket?.quoteToken.address);
    setQuote(null);
    setStatus("quoted");
    setMessage("");
    setJobId(null);
    setRoutePreference("auto");
  }, [selectedMarket?.id]);

  useEffect(() => {
    setQuote(null);
    setJobId(null);
    setStatus("quoted");
    setMessage("");
  }, [routePreference]);

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
          showTx({
            type: "success",
            title: "Swap Completed",
            message: "Your private router swap has been settled back to the vault inventory.",
            operation: "Private Router Swap",
          });
          await onAfterMutation();
          window.clearInterval(timer);
        }

        if (nextStatus === "failed") {
          setMessage(result.job.error ?? "Swap job failed.");
          showTx({
            type: "error",
            title: "Swap Failed",
            message: result.job.error ?? "The swap job encountered an error during rebalancing.",
            operation: "Private Router Swap",
          });
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
        authAddress: address,
        body: JSON.stringify({
          userAddress: address,
          marketId: selectedMarket.id,
          fromToken,
          amount,
          routePreference
        })
      });
      setQuote(result.quote);
      if (result.quote.mode === "unsupported_asset") {
        setMessage("This market is dark-pool only for now.");
      } else if (result.quote.executionPath === "unavailable") {
        setMessage("Local-only routing is unavailable for this trade size. Try Auto or DEX-routed.");
      } else if (result.quote.executionPath === "local") {
        setMessage("Quote ready for instant local fill.");
      } else {
        setMessage("Quote ready, settlement will route through InitiaDEX liquidity.");
      }
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
        authAddress: address,
        body: JSON.stringify({
          userAddress: address,
          marketId: selectedMarket.id,
          fromToken,
          amount,
          routePreference
        })
      });

      setQuote(result.quote);
      setStatus(result.status);
      setJobId(result.status === "rebalancing" ? result.jobId : null);
      setMessage(
        result.status === "completed"
          ? "Swap completed with local liquidity."
          : "Swap queued for rebalance across InitiaDEX liquidity."
      );
      if (result.status === "completed") {
        showTx({
          type: "success",
          title: "Swap Completed",
          message: "Your swap was filled instantly using local vault liquidity.",
          amount: `${amount} ${selectedMarket?.quoteToken.symbol ?? "TOKEN"}`,
          operation: "Private Router Swap",
        });
      } else {
        showTx({
          type: "pending",
          title: "Swap Queued",
          message: "Your swap is being routed through InitiaDEX for rebalancing. This may take a moment.",
          amount: `${amount} ${selectedMarket?.quoteToken.symbol ?? "TOKEN"}`,
          operation: "Private Router Swap",
          duration: 0,
        });
      }
      await onAfterMutation();
    } catch (error) {
      setJobId(null);
      setStatus("failed");
      const errorMsg = error instanceof Error ? error.message : String(error);
      setMessage(errorMsg);
      showTx({
        type: "error",
        title: "Swap Failed",
        message: errorMsg,
        amount: `${amount} ${selectedMarket?.quoteToken.symbol ?? "TOKEN"}`,
        operation: "Private Router Swap",
      });
    } finally {
      setIsExecuting(false);
    }
  }

  const executeDisabled =
    !connected ||
    !address ||
    !selectedMarket ||
    !quote ||
    isQuoting ||
    isExecuting ||
    status === "rebalancing" ||
    quote.executionPath === "unavailable";

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
          <span>Flow</span>
          <strong>{status}</strong>
        </div>

        <div className="tt-field">
          <span className="tt-field-label">Route source</span>
          <div className="route-toggle" role="group" aria-label="Route source">
            <button
              type="button"
              className={`route-toggle-btn ${routePreference === "auto" ? "active" : ""}`}
              onClick={() => setRoutePreference("auto")}
            >
              Auto
            </button>
            <button
              type="button"
              className={`route-toggle-btn ${routePreference === "local" ? "active" : ""}`}
              onClick={() => setRoutePreference("local")}
            >
              Local
            </button>
            <button
              type="button"
              className={`route-toggle-btn ${routePreference === "dex" ? "active" : ""}`}
              onClick={() => setRoutePreference("dex")}
            >
              DEX-routed
            </button>
          </div>
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
            disabled={executeDisabled}
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
            <span>Route pref</span>
            <strong>{quote?.requestedRoute ?? routePreference}</strong>
          </div>
          <div className="swap-status-row">
            <span>Execution path</span>
            <strong>{quote?.executionPath ?? "--"}</strong>
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
