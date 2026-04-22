import { useEffect, useRef, useState } from "react";
import type { Hex } from "viem";
import logoDarkUrl from "/SinergyDarkmode.png";
import logoLightUrl from "/Sinergylightmode.png";
import { useTheme } from "../ThemeContext";
import { ThemeToggle } from "../ThemeToggle";

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
  activeView: "strategies" | "agent" | "portfolio" | "history" | "bridge";
  onNavigate: (view: "strategies" | "agent" | "portfolio" | "history" | "bridge") => void;
  isConnected: boolean;
  initiaAddress?: string;
  username?: string | null;
  onConnect: () => void;
  onOpenWallet: () => void;
  onDisconnect: () => void;
  chainOk: boolean;
  bridgeReady: boolean;
};

function formatInitiaUsername(username?: string | null) {
  if (!username) return null;
  return username.endsWith(".init") ? username : `${username}.init`;
}

function shorten(addr?: string) {
  if (!addr) return "";
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

export function Navbar({
  markets,
  selectedMarketId,
  onSelectMarket,
  activeView,
  onNavigate,
  isConnected,
  initiaAddress,
  username,
  onConnect,
  onOpenWallet,
  onDisconnect,
  chainOk,
  bridgeReady,
}: Props) {
  const [ddOpen, setDdOpen] = useState(false);
  const ddRef = useRef<HTMLDivElement>(null);
  const { theme } = useTheme();
  const selected = markets.find((m) => m.id === selectedMarketId);
  const connectedLabel = formatInitiaUsername(username) ?? shorten(initiaAddress);

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
        <img
          className="nav-logo-full"
          src={theme === "dark" ? logoDarkUrl : logoLightUrl}
          alt="Sinergy DEX"
        />
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
          className={`nav-link ${activeView === "strategies" ? "active" : ""}`}
          onClick={() => onNavigate("strategies")}
        >
          Strategies
        </button>
        <button
          className={`nav-link ${activeView === "agent" ? "active" : ""}`}
          onClick={() => onNavigate("agent")}
        >
          Agent
        </button>
        <button
          className={`nav-link ${activeView === "portfolio" ? "active" : ""}`}
          onClick={() => onNavigate("portfolio")}
        >
          Portfolio
        </button>
        <button
          className={`nav-link ${activeView === "history" ? "active" : ""}`}
          onClick={() => onNavigate("history")}
        >
          History
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
        <ThemeToggle />
        {!isConnected ? (
          <button className="nav-wallet-btn connect" onClick={onConnect}>
            Connect Wallet
          </button>
        ) : (
          <>
            <button className="nav-wallet-btn connected" onClick={onOpenWallet}>
              {connectedLabel}
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
