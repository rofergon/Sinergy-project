import { useEffect, useMemo, useState } from "react";
import { useInterwovenKit } from "@initia/interwovenkit-react";
import type { Address } from "viem";
import { formatUnits, parseUnits } from "viem";
import { api } from "../lib/api";
import { depositToSinergyRollup } from "../lib/bridgeDeposit";
import {
  DEFAULT_SINERGY_BRIDGE_ASSET,
  formatInitiaIdentity,
  SINERGY_BRIDGE_ID,
  SINERGY_BRIDGE_ASSETS,
  resolveBridgeAsset,
  resolveRollupRestUrl,
} from "../initia";
import type { TxPopupData } from "./TransactionPopup";

type Props = {
  connected: boolean;
  address?: Address;
  initiaAddress?: string;
  username?: string | null;
  onConnect: () => void;
  onOpenWallet: () => void;
  onOpenBridge: () => void;
  onGoTrade: () => void;
  showTx?: (data: TxPopupData) => void;
};

type BridgeClaimPreview = {
  tokenSymbol: string;
  tokenName: string;
  tokenAddress: Address;
  tokenDecimals: number;
  sourceChainId: string;
  sourceDenom: string;
  sourceSymbol: string;
  sourceDecimals: number;
  destinationDenom: string;
  initiaAddress: string;
  evmAddress?: Address;
  observedBalanceAtomic: string;
  claimedAtomic: string;
  claimableAtomic: string;
  mintableAtomic: string;
  claimedMintedAtomic: string;
  walletTokenBalanceAtomic: string;
  redeemableAtomic: string;
};

function formatClaimableLabel(preview: BridgeClaimPreview | null, initiaAddress?: string) {
  if (!preview) {
    return initiaAddress ? "Loading..." : "Connect your Initia wallet";
  }
  const claimableAtomic = BigInt(preview.claimableAtomic);
  const observedAtomic = BigInt(preview.observedBalanceAtomic);
  const claimedAtomic = BigInt(preview.claimedAtomic);
  if (claimableAtomic > 0n) {
    return `${formatUnits(claimableAtomic, preview.sourceDecimals)} ${preview.sourceSymbol}`;
  }
  if (observedAtomic > 0n && claimedAtomic >= observedAtomic) {
    return `0 ${preview.sourceSymbol} (already claimed)`;
  }
  return `0 ${preview.sourceSymbol}`;
}

function formatMintableLabel(preview: BridgeClaimPreview | null) {
  if (!preview) return "--";
  const mintableAtomic = BigInt(preview.mintableAtomic);
  const observedAtomic = BigInt(preview.observedBalanceAtomic);
  const claimedAtomic = BigInt(preview.claimedAtomic);
  if (mintableAtomic > 0n) {
    return `${formatUnits(mintableAtomic, preview.tokenDecimals)} ${preview.tokenSymbol}`;
  }
  if (observedAtomic > 0n && claimedAtomic >= observedAtomic) {
    return `0 ${preview.tokenSymbol} (already minted)`;
  }
  return `0 ${preview.tokenSymbol}`;
}

function formatRedeemableLabel(preview: BridgeClaimPreview | null) {
  if (!preview) return "--";
  const redeemableAtomic = BigInt(preview.redeemableAtomic);
  if (redeemableAtomic > 0n) {
    return `${formatUnits(redeemableAtomic, preview.tokenDecimals)} ${preview.tokenSymbol}`;
  }
  return `0 ${preview.tokenSymbol}`;
}

function formatMarketOnlyLabel(preview: BridgeClaimPreview | null) {
  if (!preview) return "--";
  const walletAtomic = BigInt(preview.walletTokenBalanceAtomic);
  const redeemableAtomic = BigInt(preview.redeemableAtomic);
  const marketOnlyAtomic = walletAtomic > redeemableAtomic ? walletAtomic - redeemableAtomic : 0n;
  return `${formatUnits(marketOnlyAtomic, preview.tokenDecimals)} ${preview.tokenSymbol}`;
}

/** Spinner SVG */
function Spinner({ size = 18 }: { size?: number }) {
  return (
    <svg className="bridge-spinner" width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5" strokeDasharray="31.4" strokeDashoffset="10" strokeLinecap="round" />
    </svg>
  );
}

/** Icon components */
function IconDeposit() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2v14M5 9l7 7 7-7" /><rect x="3" y="19" width="18" height="2" rx="1" />
    </svg>
  );
}
function IconClaim() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 12l2 2 4-4" /><circle cx="12" cy="12" r="10" />
    </svg>
  );
}
function IconRedeem() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22V8M5 15l7-7 7 7" /><rect x="3" y="3" width="18" height="2" rx="1" />
    </svg>
  );
}
function IconLink() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}
function IconCheck() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}
function IconWallet() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z" />
      <path d="M16 3l-4 4-4-4" /><circle cx="17" cy="13" r="1" />
    </svg>
  );
}

export function BridgeLanding({
  connected,
  address,
  initiaAddress,
  username,
  onConnect,
  onOpenWallet,
  onOpenBridge,
  onGoTrade,
  showTx,
}: Props) {
  const { requestTxBlock } = useInterwovenKit();
  const [amount, setAmount] = useState("1");
  const [selectedBridgeAssetSymbol, setSelectedBridgeAssetSymbol] = useState(
    DEFAULT_SINERGY_BRIDGE_ASSET?.tokenSymbol ?? "cINIT"
  );
  const [bridgeStatus, setBridgeStatus] = useState("");
  const [bridgeStatusType, setBridgeStatusType] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [txHash, setTxHash] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [claimStatus, setClaimStatus] = useState("");
  const [claimStatusType, setClaimStatusType] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [claimPreview, setClaimPreview] = useState<BridgeClaimPreview | null>(null);
  const [isClaiming, setIsClaiming] = useState(false);
  const [redeemAmount, setRedeemAmount] = useState("1");
  const [redeemStatus, setRedeemStatus] = useState("");
  const [redeemStatusType, setRedeemStatusType] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [isRedeeming, setIsRedeeming] = useState(false);

  const rollupRestUrl = useMemo(() => resolveRollupRestUrl(), []);
  const selectedBridgeAsset = useMemo(
    () => resolveBridgeAsset(selectedBridgeAssetSymbol),
    [selectedBridgeAssetSymbol]
  );

  async function handleBridgeToSinergy() {
    if (!initiaAddress) { onConnect(); return; }
    try {
      setIsSubmitting(true);
      setTxHash("");
      setBridgeStatusType("loading");
      setBridgeStatus("Preparing deposit to Sinergy…");
      const bridgeAsset = selectedBridgeAsset;
      if (!bridgeAsset) throw new Error("No bridge-backed asset is configured for this deployment.");
      const deposit = await depositToSinergyRollup({
        requestTxBlock,
        initiaAddress,
        amount,
        bridgeAsset,
        restUrl: rollupRestUrl,
        onSubmitted: (result) => {
          setTxHash(result.transactionHash);
          setBridgeStatus("Deposit submitted. Waiting for Sinergy balance…");
        },
      });
      if (deposit.creditedBalance !== null) {
        const successMsg = `${amount} ${bridgeAsset.sourceSymbol} arrived on Sinergy${deposit.sequence ? ` (deposit #${deposit.sequence})` : ""}.`;
        setBridgeStatusType("success");
        setBridgeStatus(`Bridge complete! ${successMsg}`);
        showTx?.({ type: "bridge-success", title: "Bridge Complete!", message: successMsg, amount: `${amount} ${bridgeAsset.sourceSymbol}`, operation: "Bridge Deposit", txHash: deposit.result.transactionHash, duration: 10000 });
        return;
      }
      setBridgeStatusType("success");
      setBridgeStatus(`Deposit submitted${deposit.sequence ? ` as #${deposit.sequence}` : ""}. ${bridgeAsset.sourceSymbol} can take a short moment to appear on Sinergy.`);
    } catch (error) {
      setBridgeStatusType("error");
      setBridgeStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function refreshClaimPreview(nextInitiaAddress = initiaAddress, nextTokenSymbol = selectedBridgeAssetSymbol) {
    setClaimStatus(""); setClaimStatusType("idle");
    setRedeemStatus(""); setRedeemStatusType("idle");
    if (!nextInitiaAddress) { setClaimPreview(null); return; }
    try {
      const search = address ? `?evmAddress=${encodeURIComponent(address)}` : "";
      const preview = await api<BridgeClaimPreview>(
        `/bridge/claimable/${encodeURIComponent(nextTokenSymbol)}/${encodeURIComponent(nextInitiaAddress)}${search}`
      );
      setClaimPreview(preview);
      if (BigInt(preview.claimableAtomic) === 0n && BigInt(preview.observedBalanceAtomic) > 0n && BigInt(preview.claimedAtomic) >= BigInt(preview.observedBalanceAtomic)) {
        setClaimStatusType("success");
        setClaimStatus(`All bridged ${preview.sourceSymbol} has been claimed as ${preview.tokenSymbol}. Proceed to vault deposit.`);
      }
    } catch (error) {
      setClaimPreview(null);
      setClaimStatusType("error");
      setClaimStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleClaimCinit() {
    if (!initiaAddress || !address) { onConnect(); return; }
    try {
      setIsClaiming(true);
      setClaimStatusType("loading");
      setClaimStatus(`Minting ${claimPreview?.tokenSymbol ?? selectedBridgeAssetSymbol} from your bridged balance…`);
      const result = await api<BridgeClaimPreview & { evmAddress: Address; txHash: string }>(
        "/bridge/claim",
        { method: "POST", authAddress: address, body: JSON.stringify({ tokenSymbol: selectedBridgeAssetSymbol, initiaAddress, evmAddress: address }) }
      );
      setClaimStatusType("success");
      setClaimStatus(`Claim complete! ${formatUnits(BigInt(result.mintableAtomic), result.tokenDecimals)} ${result.tokenSymbol} minted to your EVM wallet.`);
      showTx?.({ type: "success", title: "Claim Successful", message: `${formatUnits(BigInt(result.mintableAtomic), result.tokenDecimals)} ${result.tokenSymbol} minted to your EVM wallet.`, amount: `${formatUnits(BigInt(result.mintableAtomic), result.tokenDecimals)} ${result.tokenSymbol}`, operation: "Bridge Claim", txHash: result.txHash });
      await refreshClaimPreview(initiaAddress, selectedBridgeAssetSymbol);
    } catch (error) {
      setClaimStatusType("error");
      setClaimStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsClaiming(false);
    }
  }

  async function handleRedeemCinit() {
    if (!initiaAddress || !address || !claimPreview) { onConnect(); return; }
    try {
      setIsRedeeming(true);
      setRedeemStatusType("loading");
      setRedeemStatus(`Burning ${claimPreview.tokenSymbol} and reopening bridged ${claimPreview.sourceSymbol} on Sinergy…`);
      const amountAtomic = parseUnits(redeemAmount, claimPreview.tokenDecimals);
      if (amountAtomic <= 0n) throw new Error(`Enter a positive ${claimPreview.tokenSymbol} amount to redeem.`);
      const result = await api<BridgeClaimPreview & { evmAddress: Address; txHash: string; releasedBridgeAtomic: string; burnedTokenAtomic: string }>(
        "/bridge/redeem",
        { method: "POST", authAddress: address, body: JSON.stringify({ tokenSymbol: selectedBridgeAssetSymbol, initiaAddress, evmAddress: address, amountAtomic: amountAtomic.toString() }) }
      );
      setRedeemStatusType("success");
      setRedeemStatus(`Redeem complete! ${formatUnits(BigInt(result.releasedBridgeAtomic), result.sourceDecimals)} ${result.sourceSymbol} is available again as bridged balance.`);
      showTx?.({ type: "success", title: "Redeem Successful", message: `${formatUnits(BigInt(result.releasedBridgeAtomic), result.sourceDecimals)} ${result.sourceSymbol} reopened as bridged balance.`, amount: `${formatUnits(BigInt(result.releasedBridgeAtomic), result.sourceDecimals)} ${result.sourceSymbol}`, operation: "Bridge Redeem", txHash: result.txHash });
      await refreshClaimPreview(initiaAddress, selectedBridgeAssetSymbol);
    } catch (error) {
      setRedeemStatusType("error");
      setRedeemStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsRedeeming(false);
    }
  }

  useEffect(() => { void refreshClaimPreview(); }, [initiaAddress, selectedBridgeAssetSymbol]);

  const claimableAmount = claimPreview ? BigInt(claimPreview.claimableAtomic) : 0n;
  const redeemableAmount = claimPreview ? BigInt(claimPreview.redeemableAtomic) : 0n;

  return (
    <div className="bv2-page">

      {/* ── HERO ─────────────────────────────────────────── */}
      <div className="bv2-hero">
        <div className="bv2-hero-content">
          <div className="bv2-kicker">
            <span className="bv2-kicker-dot" />
            Bridge Gateway
          </div>
          <h1 className="bv2-hero-title">
            Move assets to<br />
            <span className="bv2-hero-accent">Sinergy Rollup</span>
          </h1>
          <p className="bv2-hero-sub">
            Bridge your assets through the Initia Interwoven Path and start trading with private execution on the rollup.
          </p>

          <div className="bv2-hero-actions">
            {!connected ? (
              <button id="bv2-connect-btn" className="bv2-btn-primary" onClick={onConnect}>
                <IconWallet />
                Connect Wallet
              </button>
            ) : (
              <button id="bv2-official-bridge-btn" className="bv2-btn-primary" onClick={onOpenBridge}>
                <IconLink />
                Open Official Bridge
              </button>
            )}
            <button id="bv2-go-trade-btn" className="bv2-btn-ghost" onClick={onGoTrade}>
              Go To Exchange →
            </button>
          </div>

          {connected && initiaAddress ? (
            <button className="bv2-wallet-pill" onClick={onOpenWallet}>
              <div className="bv2-wallet-dot" />
              <span>{formatInitiaIdentity(username, initiaAddress, { includeAddress: true })}</span>
            </button>
          ) : null}
        </div>

        {/* Chain flow panel */}
        <div className="bv2-flow-panel">
          <div className="bv2-flow-label">Asset Path</div>
          <div className="bv2-flow-chain bv2-flow-source">
            <div className="bv2-flow-chain-icon bv2-flow-icon-source">↗</div>
            <div>
              <div className="bv2-flow-chain-label">Source</div>
              <div className="bv2-flow-chain-name">
                {selectedBridgeAsset?.sourceChainId ?? "Configured bridge source"}
              </div>
            </div>
          </div>
          <div className="bv2-flow-connector">
            <div className="bv2-flow-line" />
            <div className="bv2-flow-pill">Initia Interwoven</div>
            <div className="bv2-flow-line" />
          </div>
          <div className="bv2-flow-chain bv2-flow-dest">
            <div className="bv2-flow-chain-icon bv2-flow-icon-dest">⬡</div>
            <div>
              <div className="bv2-flow-chain-label">Destination</div>
              <div className="bv2-flow-chain-name">Sinergy Rollup</div>
            </div>
          </div>
          <div className="bv2-flow-meta">
            <span>Bridge ID <strong>#{SINERGY_BRIDGE_ID.toString()}</strong></span>
            <span>Source <strong>{selectedBridgeAsset?.sourceSymbol ?? "--"}</strong></span>
            <span>Receives <strong>{selectedBridgeAsset?.tokenSymbol ?? "--"}</strong></span>
          </div>
        </div>
      </div>

      {/* ── STEPS PIPELINE ───────────────────────────────── */}
      <div className="bv2-pipeline">

        {/* STEP 1: Deposit */}
        <div className="bv2-step-card" id="bv2-step-deposit">
          <div className="bv2-step-header">
            <div className="bv2-step-badge bv2-step-badge--blue">
              <IconDeposit />
            </div>
            <div className="bv2-step-meta">
              <div className="bv2-step-num">Step 1</div>
              <div className="bv2-step-title">Direct Deposit to Sinergy</div>
            </div>
            <div className="bv2-step-chain-tag">
              {selectedBridgeAsset?.sourceChainId ?? "initiation-2"}
            </div>
          </div>

          <p className="bv2-step-desc">
            Sign an OPinit deposit directly with InterwovenKit. This skips destination discovery in the public bridge UI.
          </p>

          {SINERGY_BRIDGE_ASSETS.length > 1 && (
            <div className="bv2-field">
              <label className="bv2-field-label">Bridge Asset</label>
              <div className="bv2-select-wrap">
                <select
                  className="bv2-select"
                  value={selectedBridgeAssetSymbol}
                  onChange={(e) => setSelectedBridgeAssetSymbol(e.target.value)}
                  disabled={isSubmitting || isClaiming || isRedeeming}
                >
                  {SINERGY_BRIDGE_ASSETS.map((asset) => (
                    <option key={asset.tokenSymbol} value={asset.tokenSymbol}>
                      {asset.tokenSymbol} ({asset.sourceSymbol})
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          <div className="bv2-fields-row">
            <div className="bv2-field bv2-field--grow">
              <label className="bv2-field-label">Amount</label>
              <div className="bv2-input-wrap">
                <input
                  id="bv2-deposit-amount"
                  className="bv2-input"
                  type="number"
                  min="0"
                  step="0.000001"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  disabled={isSubmitting}
                  placeholder="0.00"
                />
                <span className="bv2-input-token">{selectedBridgeAsset?.sourceSymbol ?? "ASSET"}</span>
              </div>
            </div>

            <div className="bv2-field bv2-field--grow">
              <label className="bv2-field-label">Recipient on Sinergy</label>
              <div className="bv2-address-box">
                {initiaAddress
                  ? formatInitiaIdentity(username, initiaAddress, { includeAddress: true })
                  : <span className="bv2-address-placeholder">Connect your Initia wallet</span>}
              </div>
            </div>
          </div>

          <div className="bv2-step-footer">
            <button
              id="bv2-bridge-submit-btn"
              className="bv2-btn-action bv2-btn-action--blue"
              onClick={handleBridgeToSinergy}
              disabled={isSubmitting}
            >
              {isSubmitting ? <><Spinner /> Submitting…</> : <><IconDeposit /> Bridge To Sinergy</>}
            </button>

            <div className="bv2-meta-row">
              <span>Source denom: <code>{selectedBridgeAsset?.sourceDenom ?? "--"}</code></span>
              <span>REST: <code>{rollupRestUrl}</code></span>
            </div>
          </div>

          {bridgeStatus && (
            <div className={`bv2-status bv2-status--${bridgeStatusType}`}>
              {bridgeStatusType === "loading" && <Spinner size={14} />}
              {bridgeStatusType === "success" && <IconCheck />}
              <span>{bridgeStatus}</span>
            </div>
          )}
          {txHash && (
            <div className="bv2-tx-hash">
              <span>Tx:</span>
              <code>{txHash}</code>
            </div>
          )}
        </div>

        <div className="bv2-step-connector">
          <div className="bv2-step-connector-line" />
          <div className="bv2-step-connector-arrow">↓</div>
        </div>

        {/* STEP 2: Claim */}
        <div className="bv2-step-card" id="bv2-step-claim">
          <div className="bv2-step-header">
            <div className="bv2-step-badge bv2-step-badge--green">
              <IconClaim />
            </div>
            <div className="bv2-step-meta">
              <div className="bv2-step-num">Step 2</div>
              <div className="bv2-step-title">Claim as Connected Token</div>
            </div>
            <div className="bv2-step-chain-tag bv2-step-chain-tag--green">
              {claimPreview?.tokenSymbol ?? selectedBridgeAssetSymbol}
            </div>
          </div>

          <p className="bv2-step-desc">
            Once bridged {claimPreview?.sourceSymbol ?? selectedBridgeAsset?.sourceSymbol ?? "assets"} arrive on your Initia address, mint the EVM token to deposit into the vault and route trades.
          </p>

          <div className="bv2-balances-grid">
            <div className="bv2-balance-card">
              <div className="bv2-balance-label">
                Bridged {claimPreview?.sourceSymbol ?? selectedBridgeAsset?.sourceSymbol ?? "asset"} Available
              </div>
              <div className={`bv2-balance-value ${claimableAmount > 0n ? "bv2-balance-value--positive" : ""}`}>
                {formatClaimableLabel(claimPreview, initiaAddress)}
              </div>
            </div>
            <div className="bv2-balance-card">
              <div className="bv2-balance-label">
                Mintable {claimPreview?.tokenSymbol ?? selectedBridgeAssetSymbol}
              </div>
              <div className="bv2-balance-value">
                {formatMintableLabel(claimPreview)}
              </div>
            </div>
          </div>

          <div className="bv2-step-footer">
            <button
              id="bv2-claim-btn"
              className="bv2-btn-action bv2-btn-action--green"
              onClick={handleClaimCinit}
              disabled={isClaiming || !claimPreview || claimableAmount <= 0n}
            >
              {isClaiming
                ? <><Spinner /> Claiming {claimPreview?.tokenSymbol ?? selectedBridgeAssetSymbol}…</>
                : <><IconClaim /> Claim {claimPreview?.tokenSymbol ?? selectedBridgeAssetSymbol}</>}
            </button>
            <button
              id="bv2-refresh-claim-btn"
              className="bv2-btn-ghost bv2-btn-ghost--sm"
              onClick={() => void refreshClaimPreview()}
            >
              ↻ Refresh
            </button>
          </div>

          <div className="bv2-meta-row">
            <span>EVM: <code>{address ? `${address.slice(0, 8)}…${address.slice(-6)}` : "Not connected"}</code></span>
            <span>Initia: <code>{initiaAddress ? formatInitiaIdentity(username, initiaAddress, { includeAddress: true }) : "Not connected"}</code></span>
          </div>

          {claimStatus && (
            <div className={`bv2-status bv2-status--${claimStatusType}`}>
              {claimStatusType === "loading" && <Spinner size={14} />}
              {claimStatusType === "success" && <IconCheck />}
              <span>{claimStatus}</span>
            </div>
          )}
        </div>

        <div className="bv2-step-connector">
          <div className="bv2-step-connector-line" />
          <div className="bv2-step-connector-arrow">↓</div>
        </div>

        {/* STEP 3: Redeem */}
        <div className="bv2-step-card" id="bv2-step-redeem">
          <div className="bv2-step-header">
            <div className="bv2-step-badge bv2-step-badge--amber">
              <IconRedeem />
            </div>
            <div className="bv2-step-meta">
              <div className="bv2-step-num">Step 3 — Optional</div>
              <div className="bv2-step-title">Redeem Back to Bridged Balance</div>
            </div>
            <div className="bv2-step-chain-tag bv2-step-chain-tag--amber">
              {claimPreview?.destinationDenom ?? selectedBridgeAsset?.destinationDenom ?? "l2 asset"}
            </div>
          </div>

          <p className="bv2-step-desc">
            Burn wallet-side <strong>{claimPreview?.tokenSymbol ?? selectedBridgeAssetSymbol}</strong> to reopen the same amount as bridged {claimPreview?.sourceSymbol ?? selectedBridgeAsset?.sourceSymbol ?? "asset"} on Sinergy.
          </p>

          <div className="bv2-balances-grid bv2-balances-grid--4">
            <div className="bv2-balance-card">
              <div className="bv2-balance-label">Redeemable {claimPreview?.tokenSymbol ?? selectedBridgeAssetSymbol}</div>
              <div className={`bv2-balance-value ${redeemableAmount > 0n ? "bv2-balance-value--positive" : ""}`}>
                {formatRedeemableLabel(claimPreview)}
              </div>
            </div>
            <div className="bv2-balance-card">
              <div className="bv2-balance-label">Wallet {claimPreview?.tokenSymbol ?? selectedBridgeAssetSymbol} Balance</div>
              <div className="bv2-balance-value">
                {claimPreview
                  ? `${formatUnits(BigInt(claimPreview.walletTokenBalanceAtomic), claimPreview.tokenDecimals)} ${claimPreview.tokenSymbol}`
                  : "--"}
              </div>
            </div>
            <div className="bv2-balance-card">
              <div className="bv2-balance-label">Market-only {claimPreview?.tokenSymbol ?? selectedBridgeAssetSymbol}</div>
              <div className="bv2-balance-value bv2-balance-value--muted">{formatMarketOnlyLabel(claimPreview)}</div>
            </div>
            <div className="bv2-balance-card">
              <div className="bv2-balance-label">Can Bridge Back Later</div>
              <div className="bv2-balance-value">
                {claimPreview
                  ? `${formatUnits(BigInt(claimPreview.redeemableAtomic), claimPreview.tokenDecimals)} ${claimPreview.tokenSymbol}`
                  : "--"}
              </div>
            </div>
          </div>

          <div className="bv2-info-box">
            <strong>Redeemable</strong> comes from your bridged history. <strong>Market-only</strong> was bought inside Sinergy and cannot reopen bridge-native balance.
          </div>

          <div className="bv2-fields-row">
            <div className="bv2-field bv2-field--grow">
              <label className="bv2-field-label">Amount to Redeem</label>
              <div className="bv2-input-wrap">
                <input
                  id="bv2-redeem-amount"
                  className="bv2-input"
                  type="number"
                  min="0"
                  step="0.000001"
                  value={redeemAmount}
                  onChange={(e) => setRedeemAmount(e.target.value)}
                  disabled={isRedeeming}
                  placeholder="0.00"
                />
                <span className="bv2-input-token">{claimPreview?.tokenSymbol ?? selectedBridgeAssetSymbol}</span>
              </div>
            </div>
          </div>

          <div className="bv2-step-footer">
            <button
              id="bv2-redeem-btn"
              className="bv2-btn-action bv2-btn-action--amber"
              onClick={handleRedeemCinit}
              disabled={isRedeeming || !claimPreview || redeemableAmount <= 0n}
            >
              {isRedeeming
                ? <><Spinner /> Redeeming {claimPreview?.tokenSymbol ?? selectedBridgeAssetSymbol}…</>
                : <><IconRedeem /> Redeem {claimPreview?.tokenSymbol ?? selectedBridgeAssetSymbol}</>}
            </button>
            <button
              id="bv2-refresh-redeem-btn"
              className="bv2-btn-ghost bv2-btn-ghost--sm"
              onClick={() => void refreshClaimPreview()}
            >
              ↻ Refresh
            </button>
          </div>

          {redeemStatus && (
            <div className={`bv2-status bv2-status--${redeemStatusType}`}>
              {redeemStatusType === "loading" && <Spinner size={14} />}
              {redeemStatusType === "success" && <IconCheck />}
              <span>{redeemStatus}</span>
            </div>
          )}
        </div>
      </div>

      {/* ── GUIDE STEPS ──────────────────────────────────── */}
      <div className="bv2-guide-grid">
        {[
          { n: "01", title: "Connect cleanly", desc: "Keep the bridge session separate from the trading session so origin-chain detection has less room to fail." },
          { n: "02", title: "Confirm bridge source", desc: "Verify the source chain and asset before checking balances or entering the amount." },
          { n: "03", title: "Bridge → Deposit → Trade", desc: "After bridging, deposit assets into the vault and start swaps or orders on the rollup." },
        ].map((step) => (
          <div key={step.n} className="bv2-guide-card">
            <div className="bv2-guide-num">{step.n}</div>
            <h3 className="bv2-guide-title">{step.title}</h3>
            <p className="bv2-guide-desc">{step.desc}</p>
          </div>
        ))}
      </div>

      {/* ── CALLOUT ──────────────────────────────────────── */}
      <div className="bv2-callout">
        <div className="bv2-callout-icon">⬡</div>
        <div>
          <strong>Built for subdomain extraction</strong>
          <p>This page is intentionally isolated so we can move it to a dedicated bridge subdomain later without redesigning the flow.</p>
        </div>
      </div>
    </div>
  );
}
