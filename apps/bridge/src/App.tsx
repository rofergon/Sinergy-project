import { useMemo } from "react";
import { useInterwovenKit } from "@initia/interwovenkit-react";
import { useBalance } from "wagmi";
import { sepolia } from "wagmi/chains";
import { buildPublicSubdomainHost, isDirectHost } from "@sinergy/shared";
import { buildBridgeDefaults } from "./initia";
import "./styles.css";

function shorten(addr?: string) {
  if (!addr) return "";
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

function exchangeUrl() {
  const explicit = import.meta.env.VITE_EXCHANGE_URL;
  if (explicit) {
    return explicit;
  }

  if (typeof window === "undefined") {
    return "http://127.0.0.1:5173";
  }

  const { protocol, hostname } = window.location;
  if (!hostname || hostname === "localhost" || hostname === "127.0.0.1") {
    return "http://127.0.0.1:5173";
  }

  if (isDirectHost(hostname)) {
    return `${protocol}//${hostname}:5173`;
  }

  return `${protocol}//${buildPublicSubdomainHost(hostname, "app")}`;
}

export default function App() {
  const {
    address,
    isConnected,
    initiaAddress,
    openConnect,
    openWallet,
    openBridge,
  } = useInterwovenKit();
  const sepoliaBalance = useBalance({
    address: address as `0x${string}` | undefined,
    chainId: sepolia.id,
    query: {
      enabled: Boolean(address),
      refetchInterval: 10_000,
    },
  });

  const appUrl = useMemo(() => exchangeUrl(), []);

  return (
    <div className="bridge-shell">
      <header className="bridge-nav">
        <div className="bridge-brand">
          <div className="bridge-brand-mark">S</div>
          <div>
            <strong>Sinergy Bridge</strong>
            <p>Dedicated onboarding gateway</p>
          </div>
        </div>

        <div className="bridge-nav-actions">
          {isConnected && initiaAddress ? (
            <button className="wallet-pill" onClick={openWallet}>
              {shorten(initiaAddress)}
            </button>
          ) : (
            <button className="ghost-btn" onClick={openConnect}>
              Connect Wallet
            </button>
          )}
          <a className="ghost-btn" href={appUrl}>
            Open Exchange
          </a>
        </div>
      </header>

      <main className="bridge-main">
        <section className="hero-card">
          <div className="hero-copy">
            <div className="hero-kicker">Subdomain-ready</div>
            <h1>Bridge first. Trade second.</h1>
            <p>
              This app isolates the source-chain connection flow from the trading app so bridge
              onboarding does not compete with rollup trading state.
            </p>

            <div className="hero-actions">
              {!isConnected ? (
                <button className="primary-btn" onClick={openConnect}>
                  Connect For Bridge
                </button>
              ) : (
                <button className="primary-btn" onClick={() => openBridge(buildBridgeDefaults())}>
                  Open Official Bridge
                </button>
              )}

              <a className="secondary-btn" href={appUrl}>
                Continue To Exchange
              </a>
            </div>

            <div className="helper-copy">
              Start with the configured bridge source asset, complete the official bridge flow, and
              then continue into the exchange for deposit and trading.
            </div>
          </div>

          <div className="route-card">
            <div className="route-step">
              <span>Source</span>
              <strong>Configured bridge source</strong>
            </div>
            <div className="route-arrow">↓</div>
            <div className="route-step">
              <span>Bridge</span>
              <strong>Initia Interwoven Route</strong>
            </div>
            <div className="route-arrow">↓</div>
            <div className="route-step">
              <span>Destination</span>
              <strong>Sinergy Rollup</strong>
            </div>
          </div>
        </section>

        <section className="steps-grid">
          <article className="step-card">
            <div className="step-index">01</div>
            <h2>Start the wallet session here</h2>
            <p>
              Keep origin-chain connection and bridge state inside this app so it stays separate
              from the exchange.
            </p>
          </article>

          <article className="step-card">
            <div className="step-index">02</div>
            <h2>Confirm the source route</h2>
            <p>
              The official bridge opens with the configured source defaults so the user does not
              start from an unexpected chain or asset.
            </p>
          </article>

          <article className="step-card">
            <div className="step-index">03</div>
            <h2>Return and deposit</h2>
            <p>
              Once the bridge leg is complete, continue to the exchange app to deposit into the
              vault and trade.
            </p>
          </article>
        </section>

        <section className="diagnostic-card">
          <div className="diagnostic-head">
            <strong>Sepolia EVM Diagnostic</strong>
            <span>{sepoliaBalance.isFetching ? "Refreshing" : "Live"}</span>
          </div>
          <div className="diagnostic-grid">
            <div>
              <span className="diagnostic-label">EVM address</span>
              <code>{address ?? "Not connected"}</code>
            </div>
            <div>
              <span className="diagnostic-label">Initia address</span>
              <code>{initiaAddress ?? "Not connected"}</code>
            </div>
            <div>
              <span className="diagnostic-label">Sepolia ETH</span>
              <code>
                {sepoliaBalance.data
                  ? `${sepoliaBalance.data.formatted} ${sepoliaBalance.data.symbol}`
                  : sepoliaBalance.isLoading
                    ? "Loading..."
                    : "Unavailable"}
              </code>
            </div>
            <div>
              <span className="diagnostic-label">Status</span>
              <code>
                {sepoliaBalance.error
                  ? sepoliaBalance.error.message
                  : address
                    ? "Address readable from app"
                    : "Connect wallet first"}
              </code>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
