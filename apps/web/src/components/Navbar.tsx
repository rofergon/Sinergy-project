import { useEffect, useRef, useState } from "react";
import type { Hex } from "viem";

type MarketSnapshot = {
  id: Hex;
  symbol: string;
  referencePrice: string;
  changePct: number;
  trend: "up" | "down";
  routePolicy: "router-enabled" | "dark-pool-only";
};

type Props = {
  markets: MarketSnapshot[];
  selectedMarketId?: Hex;
  onSelectMarket: (id: Hex) => void;
  activeView: "trade" | "strategies" | "markets" | "portfolio" | "bridge";
  onNavigate: (view: "trade" | "strategies" | "markets" | "portfolio" | "bridge") => void;
  isConnected: boolean;
  address?: string;
  onConnect: () => void;
  onOpenWallet: () => void;
  onDisconnect: () => void;
  chainOk: boolean;
  bridgeReady: boolean;
};

function shorten(addr?: string) {
  if (!addr) return "";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function Navbar({
  markets,
  selectedMarketId,
  onSelectMarket,
  activeView,
  onNavigate,
  isConnected,
  address,
  onConnect,
  onOpenWallet,
  onDisconnect,
  chainOk,
  bridgeReady,
}: Props) {
  const [ddOpen, setDdOpen] = useState(false);
  const ddRef = useRef<HTMLDivElement>(null);
  const selected = markets.find((m) => m.id === selectedMarketId);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ddRef.current && !ddRef.current.contains(e.target as Node)) {
        setDdOpen(false);
      }
    }

    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  return (
    <nav className="dex-navbar">
      <div className="nav-logo">
        <div className="nav-logo-icon">S</div>
        <span>
          Sinergy
          <span style={{ color: "var(--text-tertiary)", fontWeight: 500 }}> DEX</span>
        </span>
      </div>

      <div className="nav-market-selector" ref={ddRef} onClick={() => setDdOpen(!ddOpen)}>
        <span className="pair-name">{selected?.symbol ?? "Select pair"}</span>
        <span className="caret" style={{ transform: ddOpen ? "rotate(180deg)" : undefined }}>
          ▼
        </span>
        {ddOpen && (
          <div className="nav-market-dropdown" onClick={(e) => e.stopPropagation()}>
            {markets.map((m) => (
              <button
                key={m.id}
                className={m.id === selectedMarketId ? "active" : ""}
                onClick={() => {
                  onSelectMarket(m.id);
                  setDdOpen(false);
                }}
              >
                <span>{m.symbol}</span>
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className={`route-badge ${m.routePolicy === "router-enabled" ? "router" : "dark"}`}>
                    {m.routePolicy === "router-enabled" ? "Router" : "Dark"}
                  </span>
                  <span className={`dd-change ${m.trend}`}>
                    {m.changePct >= 0 ? "+" : ""}
                    {m.changePct.toFixed(2)}%
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="nav-links">
        <button
          className={`nav-link ${activeView === "trade" ? "active" : ""}`}
          onClick={() => onNavigate("trade")}
        >
          Trade
        </button>
        <button
          className={`nav-link ${activeView === "strategies" ? "active" : ""}`}
          onClick={() => onNavigate("strategies")}
        >
          Strategies
        </button>
        <button
          className={`nav-link ${activeView === "markets" ? "active" : ""}`}
          onClick={() => onNavigate("markets")}
        >
          Markets
        </button>
        <button
          className={`nav-link ${activeView === "portfolio" ? "active" : ""}`}
          onClick={() => onNavigate("portfolio")}
        >
          Portfolio
        </button>
        <button
          className={`nav-link ${activeView === "bridge" ? "active" : ""}`}
          onClick={() => onNavigate("bridge")}
        >
          Bridge
        </button>
      </div>

      <div className="nav-status">
        <div className="nav-status-dot" />
        {chainOk ? (bridgeReady ? "Live" : "Degraded") : "Offline"}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {!isConnected ? (
          <button className="nav-wallet-btn connect" onClick={onConnect}>
            Connect Wallet
          </button>
        ) : (
          <>
            <button className="nav-wallet-btn connected" onClick={onOpenWallet}>
              {shorten(address)}
            </button>
            <button className="nav-link" onClick={onDisconnect}>
              Disconnect
            </button>
          </>
        )}
      </div>
    </nav>
  );
}
