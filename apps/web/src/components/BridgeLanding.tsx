import { useEffect, useMemo, useState } from "react";
import { MsgInitiateTokenDeposit, MsgInitiateTokenDepositResponse } from "@initia/opinit.proto/opinit/ophost/v1/tx";
import { useInterwovenKit } from "@initia/interwovenkit-react";
import type { Address } from "viem";
import { formatUnits, parseUnits } from "viem";
import { api } from "../lib/api";
import {
  DEFAULT_SINERGY_BRIDGE_ASSET,
  formatInitiaIdentity,
  SINERGY_BRIDGE_ID,
  SINERGY_BRIDGE_ASSETS,
  resolveBridgeAsset,
  resolveRollupRestUrl,
} from "../initia";

type Props = {
  connected: boolean;
  address?: Address;
  initiaAddress?: string;
  username?: string | null;
  onConnect: () => void;
  onOpenWallet: () => void;
  onOpenBridge: () => void;
  onGoTrade: () => void;
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
  if (!preview) {
    return "--";
  }

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
  if (!preview) {
    return "--";
  }

  const redeemableAtomic = BigInt(preview.redeemableAtomic);
  if (redeemableAtomic > 0n) {
    return `${formatUnits(redeemableAtomic, preview.tokenDecimals)} ${preview.tokenSymbol}`;
  }

  return `0 ${preview.tokenSymbol}`;
}

function formatMarketOnlyLabel(preview: BridgeClaimPreview | null) {
  if (!preview) {
    return "--";
  }

  const walletAtomic = BigInt(preview.walletTokenBalanceAtomic);
  const redeemableAtomic = BigInt(preview.redeemableAtomic);
  const marketOnlyAtomic = walletAtomic > redeemableAtomic ? walletAtomic - redeemableAtomic : 0n;

  return `${formatUnits(marketOnlyAtomic, preview.tokenDecimals)} ${preview.tokenSymbol}`;
}

async function queryRollupBalance(address: string, denom: string, restUrl: string) {
  const response = await fetch(
    `${restUrl}/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=${encodeURIComponent(denom)}`
  );

  if (!response.ok) {
    return 0n;
  }

  const payload = (await response.json()) as {
    balance?: {
      amount?: string;
    };
  };

  return BigInt(payload.balance?.amount ?? "0");
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
}: Props) {
  const { requestTxBlock } = useInterwovenKit();
  const [amount, setAmount] = useState("1");
  const [selectedBridgeAssetSymbol, setSelectedBridgeAssetSymbol] = useState(
    DEFAULT_SINERGY_BRIDGE_ASSET?.tokenSymbol ?? "cINIT"
  );
  const [bridgeStatus, setBridgeStatus] = useState("");
  const [txHash, setTxHash] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [claimStatus, setClaimStatus] = useState("");
  const [claimPreview, setClaimPreview] = useState<BridgeClaimPreview | null>(null);
  const [isClaiming, setIsClaiming] = useState(false);
  const [redeemAmount, setRedeemAmount] = useState("1");
  const [redeemStatus, setRedeemStatus] = useState("");
  const [isRedeeming, setIsRedeeming] = useState(false);
  const rollupRestUrl = useMemo(() => resolveRollupRestUrl(), []);
  const selectedBridgeAsset = useMemo(
    () => resolveBridgeAsset(selectedBridgeAssetSymbol),
    [selectedBridgeAssetSymbol]
  );

  async function waitForBridgeCredit(address: string, expectedIncrease: bigint, destinationDenom: string) {
    const startingBalance = await queryRollupBalance(
      address,
      destinationDenom,
      rollupRestUrl
    );

    for (let attempt = 0; attempt < 15; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 3_000));
      const currentBalance = await queryRollupBalance(
        address,
        destinationDenom,
        rollupRestUrl
      );

      if (currentBalance >= startingBalance + expectedIncrease) {
        return currentBalance;
      }
    }

    return null;
  }

  async function handleBridgeToSinergy() {
    if (!initiaAddress) {
      onConnect();
      return;
    }

    try {
      setIsSubmitting(true);
      setTxHash("");
      setBridgeStatus("Preparing deposit to Sinergy...");

      const bridgeAsset = selectedBridgeAsset;
      if (!bridgeAsset) {
        throw new Error("No bridge-backed asset is configured for this deployment.");
      }
      const amountAtomic = parseUnits(amount, bridgeAsset.sourceDecimals);
      if (amountAtomic <= 0n) {
        throw new Error(`Enter a positive ${bridgeAsset.sourceSymbol} amount.`);
      }

      const result = await requestTxBlock({
        chainId: bridgeAsset.sourceChainId,
        gas: 250_000,
        messages: [
          {
            typeUrl: "/opinit.ophost.v1.MsgInitiateTokenDeposit",
            value: MsgInitiateTokenDeposit.fromPartial({
              sender: initiaAddress,
              bridgeId: SINERGY_BRIDGE_ID,
              to: initiaAddress,
              amount: {
                denom: bridgeAsset.sourceDenom,
                amount: amountAtomic.toString(),
              },
              data: new Uint8Array(0),
            }),
          },
        ],
      });

      if (result.code !== 0) {
        throw new Error(result.rawLog || "Bridge transaction failed.");
      }

      setTxHash(result.transactionHash);
      const response = result.msgResponses.find(
        (item) => item.typeUrl === "/opinit.ophost.v1.MsgInitiateTokenDepositResponse"
      );
      const sequence = response
        ? MsgInitiateTokenDepositResponse.decode(response.value).sequence.toString()
        : null;

      setBridgeStatus("Deposit submitted. Waiting for Sinergy balance...");
      const creditedBalance = await waitForBridgeCredit(
        initiaAddress,
        amountAtomic,
        bridgeAsset.destinationDenom
      );

      if (creditedBalance !== null) {
        setBridgeStatus(
          `Bridge complete. ${amount} ${bridgeAsset.sourceSymbol} arrived on Sinergy${
            sequence ? ` (deposit #${sequence})` : ""
          }.`
        );
        return;
      }

      setBridgeStatus(
        `Deposit submitted${sequence ? ` as #${sequence}` : ""}. ${bridgeAsset.sourceSymbol} can take a short moment to appear on Sinergy.`
      );
    } catch (error) {
      setBridgeStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function refreshClaimPreview(nextInitiaAddress = initiaAddress, nextTokenSymbol = selectedBridgeAssetSymbol) {
    setClaimStatus("");
    setRedeemStatus("");

    if (!nextInitiaAddress) {
      setClaimPreview(null);
      return;
    }

    try {
      const search = address ? `?evmAddress=${encodeURIComponent(address)}` : "";
      const preview = await api<BridgeClaimPreview>(
        `/bridge/claimable/${encodeURIComponent(nextTokenSymbol)}/${encodeURIComponent(nextInitiaAddress)}${search}`
      );
      setClaimPreview(preview);
      if (
        BigInt(preview.claimableAtomic) === 0n &&
        BigInt(preview.observedBalanceAtomic) > 0n &&
        BigInt(preview.claimedAtomic) >= BigInt(preview.observedBalanceAtomic)
      ) {
        setClaimStatus(
          `All bridged ${preview.sourceSymbol} for this Initia address has already been claimed as ${preview.tokenSymbol}. You can continue to vault deposit.`
        );
      }
    } catch (error) {
      setClaimPreview(null);
      setClaimStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleClaimCinit() {
    if (!initiaAddress || !address) {
      onConnect();
      return;
    }

    try {
      setIsClaiming(true);
      setClaimStatus(`Minting ${claimPreview?.tokenSymbol ?? selectedBridgeAssetSymbol} from your bridged balance...`);

      const result = await api<BridgeClaimPreview & { evmAddress: Address; txHash: string }>(
        "/bridge/claim",
        {
          method: "POST",
          authAddress: address,
          body: JSON.stringify({
            tokenSymbol: selectedBridgeAssetSymbol,
            initiaAddress,
            evmAddress: address,
          }),
        }
      );

      setClaimStatus(
        `Claim complete. ${formatUnits(BigInt(result.mintableAtomic), result.tokenDecimals)} ${result.tokenSymbol} minted to your EVM wallet.`
      );
      await refreshClaimPreview(initiaAddress, selectedBridgeAssetSymbol);
    } catch (error) {
      setClaimStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsClaiming(false);
    }
  }

  async function handleRedeemCinit() {
    if (!initiaAddress || !address || !claimPreview) {
      onConnect();
      return;
    }

    try {
      setIsRedeeming(true);
      setRedeemStatus(
        `Burning ${claimPreview.tokenSymbol} and reopening bridged ${claimPreview.sourceSymbol} on Sinergy...`
      );

      const amountAtomic = parseUnits(redeemAmount, claimPreview.tokenDecimals);
      if (amountAtomic <= 0n) {
        throw new Error(`Enter a positive ${claimPreview.tokenSymbol} amount to redeem.`);
      }

      const result = await api<
        BridgeClaimPreview & {
          evmAddress: Address;
          txHash: string;
          releasedBridgeAtomic: string;
          burnedTokenAtomic: string;
        }
      >("/bridge/redeem", {
        method: "POST",
        authAddress: address,
        body: JSON.stringify({
          tokenSymbol: selectedBridgeAssetSymbol,
          initiaAddress,
          evmAddress: address,
          amountAtomic: amountAtomic.toString(),
        }),
      });

      setRedeemStatus(
        `Redeem complete. ${formatUnits(
          BigInt(result.releasedBridgeAtomic),
          result.sourceDecimals
        )} ${result.sourceSymbol} is available again as bridged balance on Sinergy.`
      );
      await refreshClaimPreview(initiaAddress, selectedBridgeAssetSymbol);
    } catch (error) {
      setRedeemStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsRedeeming(false);
    }
  }

  useEffect(() => {
    void refreshClaimPreview();
  }, [initiaAddress, selectedBridgeAssetSymbol]);

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
            <button
              className="bridge-primary-btn bridge-direct-btn"
              onClick={handleBridgeToSinergy}
              disabled={isSubmitting}
            >
              {isSubmitting ? "Submitting To Sinergy..." : "Bridge To Sinergy"}
            </button>
            <button className="bridge-secondary-btn" onClick={onGoTrade}>
              Go To Exchange
            </button>
          </div>
          {connected && initiaAddress ? (
            <button className="bridge-wallet-pill" onClick={onOpenWallet}>
              Connected: {formatInitiaIdentity(username, initiaAddress, { includeAddress: true })}
            </button>
          ) : (
            <div className="bridge-note">
              Start here, confirm the configured bridge source, and only then continue into the
              exchange.
            </div>
          )}

          <div className="bridge-direct-card">
            <div className="bridge-direct-head">
              <strong>Direct deposit to Sinergy</strong>
              <span>{selectedBridgeAsset?.sourceChainId ?? "initiation-2"}</span>
            </div>

            <p className="bridge-direct-copy">
              This path skips destination discovery in the public bridge UI and signs the OPinit
              deposit directly with InterwovenKit.
            </p>

            {SINERGY_BRIDGE_ASSETS.length > 1 ? (
              <label className="bridge-direct-field">
                <span>Bridge asset</span>
                <div className="tt-input-wrap">
                  <select
                    value={selectedBridgeAssetSymbol}
                    onChange={(event) => setSelectedBridgeAssetSymbol(event.target.value)}
                    disabled={isSubmitting || isClaiming || isRedeeming}
                  >
                    {SINERGY_BRIDGE_ASSETS.map((asset) => (
                      <option key={asset.tokenSymbol} value={asset.tokenSymbol}>
                        {asset.tokenSymbol} ({asset.sourceSymbol})
                      </option>
                    ))}
                  </select>
                </div>
              </label>
            ) : null}

            <div className="bridge-direct-grid">
              <label className="bridge-direct-field">
                <span>Amount</span>
                <div className="bridge-direct-input-wrap">
                  <input
                    className="bridge-direct-input"
                    type="number"
                    min="0"
                    step="0.000001"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    disabled={isSubmitting}
                  />
                  <strong>{selectedBridgeAsset?.sourceSymbol ?? "ASSET"}</strong>
                </div>
              </label>

              <label className="bridge-direct-field">
                <span>Recipient on Sinergy</span>
                <div className="bridge-direct-address">
                  {initiaAddress
                    ? formatInitiaIdentity(username, initiaAddress, { includeAddress: true })
                    : "Connect your Initia wallet"}
                </div>
              </label>
            </div>

            <div className="bridge-direct-meta">
              <span>Bridge ID {SINERGY_BRIDGE_ID.toString()}</span>
              <span>Source denom {selectedBridgeAsset?.sourceDenom ?? "--"}</span>
              <span>Rollup REST {rollupRestUrl}</span>
            </div>

            {bridgeStatus ? <div className="bridge-direct-status">{bridgeStatus}</div> : null}
            {txHash ? <div className="bridge-direct-hash">Tx: {txHash}</div> : null}
          </div>

          <div className="bridge-direct-card">
            <div className="bridge-direct-head">
              <strong>Claim bridged asset as connected token</strong>
              <span>{claimPreview?.tokenSymbol ?? selectedBridgeAssetSymbol}</span>
            </div>

            <p className="bridge-direct-copy">
              Once bridged{" "}
              {claimPreview?.sourceSymbol ?? selectedBridgeAsset?.sourceSymbol ?? "asset"} reaches
              your Initia address on Sinergy, mint the connected EVM token so you can deposit it
              into the vault and route trades through the private router.
            </p>

            <div className="bridge-direct-grid">
              <label className="bridge-direct-field">
                <span>Bridged {claimPreview?.sourceSymbol ?? selectedBridgeAsset?.sourceSymbol ?? "asset"} available</span>
                <div className="bridge-direct-address">
                  {formatClaimableLabel(claimPreview, initiaAddress)}
                </div>
              </label>

              <label className="bridge-direct-field">
                <span>Mintable {claimPreview?.tokenSymbol ?? selectedBridgeAssetSymbol}</span>
                <div className="bridge-direct-address">
                  {formatMintableLabel(claimPreview)}
                </div>
              </label>
            </div>

            <div className="bridge-cta-row bridge-claim-actions">
              <button
                className="bridge-primary-btn bridge-direct-btn"
                onClick={handleClaimCinit}
                disabled={isClaiming || !claimPreview || BigInt(claimPreview.claimableAtomic) <= 0n}
              >
                {isClaiming ? `Claiming ${claimPreview?.tokenSymbol ?? selectedBridgeAssetSymbol}...` : `Claim ${claimPreview?.tokenSymbol ?? selectedBridgeAssetSymbol}`}
              </button>
              <button className="bridge-secondary-btn" onClick={() => void refreshClaimPreview()}>
                Refresh Claimable
              </button>
            </div>

            <div className="bridge-direct-meta">
              <span>EVM recipient {address ? `${address.slice(0, 8)}…${address.slice(-6)}` : "Not connected"}</span>
              <span>
                Initia recipient{" "}
                {initiaAddress
                  ? formatInitiaIdentity(username, initiaAddress, { includeAddress: true })
                  : "Not connected"}
              </span>
            </div>

            {claimStatus ? <div className="bridge-direct-status">{claimStatus}</div> : null}
          </div>

          <div className="bridge-direct-card">
            <div className="bridge-direct-head">
              <strong>Redeem connected token back to bridged balance</strong>
              <span>{claimPreview?.destinationDenom ?? selectedBridgeAsset?.destinationDenom ?? "l2 asset"}</span>
            </div>

            <p className="bridge-direct-copy">
              Burn wallet-side{" "}
              <code>{claimPreview?.tokenSymbol ?? selectedBridgeAssetSymbol}</code> to reopen the
              same amount as bridged{" "}
              {claimPreview?.sourceSymbol ?? selectedBridgeAsset?.sourceSymbol ?? "asset"} on
              Sinergy.
            </p>

            <div className="bridge-direct-grid">
              <label className="bridge-direct-field">
                <span>Redeemable {claimPreview?.tokenSymbol ?? selectedBridgeAssetSymbol}</span>
                <div className="bridge-direct-address">{formatRedeemableLabel(claimPreview)}</div>
              </label>

              <label className="bridge-direct-field">
                <span>Wallet {claimPreview?.tokenSymbol ?? selectedBridgeAssetSymbol} balance</span>
                <div className="bridge-direct-address">
                  {claimPreview
                    ? `${formatUnits(
                        BigInt(claimPreview.walletTokenBalanceAtomic),
                        claimPreview.tokenDecimals
                      )} ${claimPreview.tokenSymbol}`
                    : "--"}
                </div>
              </label>
            </div>

            <div className="bridge-direct-grid">
              <label className="bridge-direct-field">
                <span>Market-only {claimPreview?.tokenSymbol ?? selectedBridgeAssetSymbol}</span>
                <div className="bridge-direct-address">{formatMarketOnlyLabel(claimPreview)}</div>
              </label>

              <label className="bridge-direct-field">
                <span>What can bridge back later</span>
                <div className="bridge-direct-address">
                  {claimPreview
                    ? `${formatUnits(BigInt(claimPreview.redeemableAtomic), claimPreview.tokenDecimals)} ${
                        claimPreview.tokenSymbol
                      }`
                    : "--"}
                </div>
              </label>
            </div>

            <p className="bridge-direct-copy">
              <code>Redeemable {claimPreview?.tokenSymbol ?? selectedBridgeAssetSymbol}</code>{" "}
              comes from your bridged{" "}
              {claimPreview?.sourceSymbol ?? selectedBridgeAsset?.sourceSymbol ?? "asset"} history.{" "}
              <code>Market-only {claimPreview?.tokenSymbol ?? selectedBridgeAssetSymbol}</code> is
              the same ERC20 token, but it was bought inside Sinergy and cannot reopen bridge-native
              balance by itself.
            </p>

            <label className="bridge-direct-field">
              <span>Amount to redeem</span>
              <div className="bridge-direct-input-wrap">
                <input
                  className="bridge-direct-input"
                  type="number"
                  min="0"
                  step="0.000001"
                  value={redeemAmount}
                  onChange={(event) => setRedeemAmount(event.target.value)}
                  disabled={isRedeeming}
                />
                  <strong>{claimPreview?.tokenSymbol ?? selectedBridgeAssetSymbol}</strong>
                </div>
              </label>

            <div className="bridge-cta-row bridge-claim-actions">
              <button
                className="bridge-primary-btn bridge-direct-btn"
                onClick={handleRedeemCinit}
                disabled={
                  isRedeeming || !claimPreview || BigInt(claimPreview.redeemableAtomic) <= 0n
                }
              >
                {isRedeeming
                  ? `Redeeming ${claimPreview?.tokenSymbol ?? selectedBridgeAssetSymbol}...`
                  : `Redeem ${claimPreview?.tokenSymbol ?? selectedBridgeAssetSymbol}`}
              </button>
              <button className="bridge-secondary-btn" onClick={() => void refreshClaimPreview()}>
                Refresh Redeemable
              </button>
            </div>

            {redeemStatus ? <div className="bridge-direct-status">{redeemStatus}</div> : null}
          </div>
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
