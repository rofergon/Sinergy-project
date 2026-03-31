import { useState, useRef, useEffect } from "react";
import type { Hex } from "viem";

type MarketSnapshot = {
  id: Hex;
  symbol: string;
  referencePrice: string;
  changePct: number;
  trend: "up" | "down";
};

type Props = {
  markets: MarketSnapshot[];
  selectedMarketId?: Hex;
  onSelectMarket: (id: Hex) => void;
  isConnected: boolean;
  address?: string;
  connectors: Array<{ id: string; name: string }>;
  isPending: boolean;
  onConnect: (connectorId: string) => void;
  onDisconnect: () => void;
  chainOk: boolean;
};

function shorten(addr?: string) {
  if (!addr) return "";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function walletLabel(name: string) {
  if (name.toLowerCase().includes("meta")) return "MetaMask";
  if (name.toLowerCase().includes("coinbase")) return "Coinbase";
  return name;
}

export function Navbar({
  markets,
  selectedMarketId,
  onSelectMarket,
  isConnected,
  address,
  connectors,
  isPending,
  onConnect,
  onDisconnect,
  chainOk,
}: Props) {
  const [ddOpen, setDdOpen] = useState(false);
  const [walletDd, setWalletDd] = useState(false);
  const ddRef = useRef<HTMLDivElement>(null);
  const walletRef = useRef<HTMLDivElement>(null);
  const selected = markets.find((m) => m.id === selectedMarketId);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ddRef.current && !ddRef.current.contains(e.target as Node)) setDdOpen(false);
      if (walletRef.current && !walletRef.current.contains(e.target as Node)) setWalletDd(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  return (
    <nav className="dex-navbar">
      <div className="nav-logo">
        <div className="nav-logo-icon">S</div>
        <span>Sinergy<span style={{ color: "var(--text-tertiary)", fontWeight: 500 }}> DEX</span></span>
      </div>

      {/* Market Selector */}
      <div className="nav-market-selector" ref={ddRef} onClick={() => setDdOpen(!ddOpen)}>
        <span className="pair-name">{selected?.symbol ?? "Select pair"}</span>
        <span className="caret" style={{ transform: ddOpen ? "rotate(180deg)" : undefined }}>▼</span>
        {ddOpen && (
          <div className="nav-market-dropdown" onClick={(e) => e.stopPropagation()}>
            {markets.map((m) => (
              <button
                key={m.id}
                className={m.id === selectedMarketId ? "active" : ""}
                onClick={() => { onSelectMarket(m.id); setDdOpen(false); }}
              >
                <span>{m.symbol}</span>
                <span className={`dd-change ${m.trend}`}>
                  {m.changePct >= 0 ? "+" : ""}{m.changePct.toFixed(2)}%
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Nav Links */}
      <div className="nav-links">
        <button className="nav-link active">Trade</button>
        <button className="nav-link">Markets</button>
        <button className="nav-link">Portfolio</button>
      </div>

      {/* Network Status */}
      <div className="nav-status">
        <div className="nav-status-dot" />
        {chainOk ? "Live" : "Offline"}
      </div>

      {/* Wallet */}
      <div style={{ position: "relative" }} ref={walletRef}>
        {!isConnected ? (
          connectors.length === 1 ? (
            <button
              className="nav-wallet-btn connect"
              onClick={() => onConnect(connectors[0].id)}
              disabled={isPending}
            >
              {isPending ? "Connecting…" : "Connect Wallet"}
            </button>
          ) : (
            <>
              <button
                className="nav-wallet-btn connect"
                onClick={() => setWalletDd(!walletDd)}
                disabled={isPending}
              >
                {isPending ? "Connecting…" : "Connect Wallet"}
              </button>
              {walletDd && (
                <div className="wallet-dropdown">
                  {connectors.map((c) => (
                    <button key={c.id} onClick={() => { onConnect(c.id); setWalletDd(false); }}>
                      {walletLabel(c.name)}
                    </button>
                  ))}
                </div>
              )}
            </>
          )
        ) : (
          <>
            <button className="nav-wallet-btn connected" onClick={() => setWalletDd(!walletDd)}>
              {shorten(address)}
            </button>
            {walletDd && (
              <div className="wallet-dropdown">
                <button onClick={() => { onDisconnect(); setWalletDd(false); }}>
                  Disconnect
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </nav>
  );
}
