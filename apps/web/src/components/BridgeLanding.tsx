type Props = {
  connected: boolean;
  initiaAddress?: string;
  onConnect: () => void;
  onOpenWallet: () => void;
  onOpenBridge: () => void;
  onGoTrade: () => void;
};

function shorten(addr?: string) {
  if (!addr) return "";
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

export function BridgeLanding({
  connected,
  initiaAddress,
  onConnect,
  onOpenWallet,
  onOpenBridge,
  onGoTrade,
}: Props) {
  return (
    <div className="bridge-page">
      <div className="bridge-hero">
        <div className="bridge-copy">
          <div className="bridge-kicker">Bridge Gateway</div>
          <h1>Bring assets in before you trade</h1>
          <p>
            Use a clean bridge flow first, then return to the exchange to deposit into the vault and
            continue trading on the rollup.
          </p>
          <div className="bridge-cta-row">
            {!connected ? (
              <button className="bridge-primary-btn" onClick={onConnect}>
                Connect Wallet
              </button>
            ) : (
              <button className="bridge-primary-btn" onClick={onOpenBridge}>
                Open Official Bridge
              </button>
            )}
            <button className="bridge-secondary-btn" onClick={onGoTrade}>
              Go To Exchange
            </button>
          </div>
          {connected && initiaAddress ? (
            <button className="bridge-wallet-pill" onClick={onOpenWallet}>
              Connected: {shorten(initiaAddress)}
            </button>
          ) : (
            <div className="bridge-note">
              Start here, confirm the configured bridge source, and only then continue into the
              exchange.
            </div>
          )}
        </div>

        <div className="bridge-visual-card">
          <div className="bridge-chain-row">
            <span className="bridge-chain-label">Source</span>
            <strong>Configured bridge source</strong>
          </div>
          <div className="bridge-arrow">↓</div>
          <div className="bridge-chain-row">
            <span className="bridge-chain-label">Settlement</span>
            <strong>Initia Interwoven Path</strong>
          </div>
          <div className="bridge-arrow">↓</div>
          <div className="bridge-chain-row">
            <span className="bridge-chain-label">Destination</span>
            <strong>Sinergy Rollup</strong>
          </div>
        </div>
      </div>

      <div className="bridge-steps-grid">
        <section className="bridge-step-card">
          <span className="bridge-step-index">01</span>
          <h2>Connect cleanly</h2>
          <p>
            Keep the bridge session separate from the trading session so origin-chain detection has
            less room to fail.
          </p>
        </section>

        <section className="bridge-step-card">
          <span className="bridge-step-index">02</span>
          <h2>Confirm the bridge source</h2>
          <p>
            Confirm the source chain and asset the bridge opens with before checking balances or
            entering the amount.
          </p>
        </section>

        <section className="bridge-step-card">
          <span className="bridge-step-index">03</span>
          <h2>Bridge, deposit, trade</h2>
          <p>
            After bridging, return to the exchange, deposit assets into the vault, and continue with
            swaps or orders.
          </p>
        </section>
      </div>

      <div className="bridge-callout">
        <strong>Built for subdomain extraction</strong>
        <p>
          This page is intentionally isolated so we can move it to a dedicated bridge subdomain
          later without redesigning the flow.
        </p>
      </div>
    </div>
  );
}
