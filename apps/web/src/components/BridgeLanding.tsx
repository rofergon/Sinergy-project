import { useEffect, useMemo, useState } from "react";
import { MsgInitiateTokenDeposit, MsgInitiateTokenDepositResponse } from "@initia/opinit.proto/opinit/ophost/v1/tx";
import { useInterwovenKit } from "@initia/interwovenkit-react";
import type { Address } from "viem";
import { formatUnits, parseUnits } from "viem";
import { api } from "../lib/api";
import {
  SINERGY_BRIDGE_DESTINATION_DENOM,
  SINERGY_BRIDGE_ID,
  SINERGY_BRIDGE_SOURCE_CHAIN_ID,
  SINERGY_BRIDGE_SOURCE_DENOM,
  resolveRollupRestUrl,
} from "../initia";

type Props = {
  connected: boolean;
  address?: Address;
  initiaAddress?: string;
  onConnect: () => void;
  onOpenWallet: () => void;
  onOpenBridge: () => void;
  onGoTrade: () => void;
};

type BridgeClaimPreview = {
  initiaAddress: string;
  evmAddress?: Address;
  bridgeDenom: string;
  tokenSymbol: string;
  tokenAddress: Address;
  tokenDecimals: number;
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
    return `${formatUnits(claimableAtomic, 6)} INIT`;
  }

  if (observedAtomic > 0n && claimedAtomic >= observedAtomic) {
    return `0 INIT (already claimed)`;
  }

  return "0 INIT";
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

function shorten(addr?: string) {
  if (!addr) return "";
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
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
  onConnect,
  onOpenWallet,
  onOpenBridge,
  onGoTrade,
}: Props) {
  const { requestTxBlock } = useInterwovenKit();
  const [amount, setAmount] = useState("1");
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

  async function waitForBridgeCredit(address: string, expectedIncrease: bigint) {
    const startingBalance = await queryRollupBalance(
      address,
      SINERGY_BRIDGE_DESTINATION_DENOM,
      rollupRestUrl
    );

    for (let attempt = 0; attempt < 15; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 3_000));
      const currentBalance = await queryRollupBalance(
        address,
        SINERGY_BRIDGE_DESTINATION_DENOM,
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

      const amountAtomic = parseUnits(amount, 6);
      if (amountAtomic <= 0n) {
        throw new Error("Enter a positive INIT amount.");
      }

      const result = await requestTxBlock({
        chainId: SINERGY_BRIDGE_SOURCE_CHAIN_ID,
        gas: 250_000,
        messages: [
          {
            typeUrl: "/opinit.ophost.v1.MsgInitiateTokenDeposit",
            value: MsgInitiateTokenDeposit.fromPartial({
              sender: initiaAddress,
              bridgeId: SINERGY_BRIDGE_ID,
              to: initiaAddress,
              amount: {
                denom: SINERGY_BRIDGE_SOURCE_DENOM,
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
      const creditedBalance = await waitForBridgeCredit(initiaAddress, amountAtomic);

      if (creditedBalance !== null) {
        setBridgeStatus(
          `Bridge complete. ${amount} INIT arrived on Sinergy${
            sequence ? ` (deposit #${sequence})` : ""
          }.`
        );
        return;
      }

      setBridgeStatus(
        `Deposit submitted${sequence ? ` as #${sequence}` : ""}. Funds can take a short moment to appear on Sinergy.`
      );
    } catch (error) {
      setBridgeStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function refreshClaimPreview(nextInitiaAddress = initiaAddress) {
    setClaimStatus("");
    setRedeemStatus("");

    if (!nextInitiaAddress) {
      setClaimPreview(null);
      return;
    }

    try {
      const search = address ? `?evmAddress=${encodeURIComponent(address)}` : "";
      const preview = await api<BridgeClaimPreview>(
        `/bridge/claimable/${encodeURIComponent(nextInitiaAddress)}${search}`
      );
      setClaimPreview(preview);
      if (
        BigInt(preview.claimableAtomic) === 0n &&
        BigInt(preview.observedBalanceAtomic) > 0n &&
        BigInt(preview.claimedAtomic) >= BigInt(preview.observedBalanceAtomic)
      ) {
        setClaimStatus(
          `All bridged INIT for this Initia address has already been claimed as ${preview.tokenSymbol}. You can continue to vault deposit.`
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
      setClaimStatus("Minting cINIT from your bridged INIT...");

      const result = await api<BridgeClaimPreview & { evmAddress: Address; txHash: string }>(
        "/bridge/claim-cinit",
        {
          method: "POST",
          body: JSON.stringify({
            initiaAddress,
            evmAddress: address,
          }),
        }
      );

      setClaimStatus(
        `Claim complete. ${formatUnits(BigInt(result.mintableAtomic), result.tokenDecimals)} ${result.tokenSymbol} minted to your EVM wallet.`
      );
      await refreshClaimPreview(initiaAddress);
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
      setRedeemStatus("Burning cINIT and reopening bridged INIT on Sinergy...");

      const amountAtomic = parseUnits(redeemAmount, claimPreview.tokenDecimals);
      if (amountAtomic <= 0n) {
        throw new Error("Enter a positive cINIT amount to redeem.");
      }

      const result = await api<
        BridgeClaimPreview & {
          evmAddress: Address;
          txHash: string;
          releasedBridgeAtomic: string;
          burnedTokenAtomic: string;
        }
      >("/bridge/redeem-cinit", {
        method: "POST",
        body: JSON.stringify({
          initiaAddress,
          evmAddress: address,
          amountAtomic: amountAtomic.toString(),
        }),
      });

      setRedeemStatus(
        `Redeem complete. ${formatUnits(
          BigInt(result.releasedBridgeAtomic),
          6
        )} INIT is available again as bridged balance on Sinergy.`
      );
      await refreshClaimPreview(initiaAddress);
    } catch (error) {
      setRedeemStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsRedeeming(false);
    }
  }

  useEffect(() => {
    void refreshClaimPreview();
  }, [initiaAddress]);

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
              Connected: {shorten(initiaAddress)}
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
              <span>{SINERGY_BRIDGE_SOURCE_CHAIN_ID}</span>
            </div>

            <p className="bridge-direct-copy">
              This path skips destination discovery in the public bridge UI and signs the OPinit
              deposit directly with InterwovenKit.
            </p>

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
                  <strong>{SINERGY_BRIDGE_SOURCE_DENOM.toUpperCase()}</strong>
                </div>
              </label>

              <label className="bridge-direct-field">
                <span>Recipient on Sinergy</span>
                <div className="bridge-direct-address">
                  {initiaAddress ? shorten(initiaAddress) : "Connect your Initia wallet"}
                </div>
              </label>
            </div>

            <div className="bridge-direct-meta">
              <span>Bridge ID {SINERGY_BRIDGE_ID.toString()}</span>
              <span>Rollup REST {rollupRestUrl}</span>
            </div>

            {bridgeStatus ? <div className="bridge-direct-status">{bridgeStatus}</div> : null}
            {txHash ? <div className="bridge-direct-hash">Tx: {txHash}</div> : null}
          </div>

          <div className="bridge-direct-card">
            <div className="bridge-direct-head">
              <strong>Claim bridged INIT as cINIT</strong>
              <span>{claimPreview?.tokenSymbol ?? "cINIT"}</span>
            </div>

            <p className="bridge-direct-copy">
              Once bridged INIT reaches your Initia address on Sinergy, mint the EVM-side `cINIT`
              token so you can deposit it into the vault and route trades through the private
              router.
            </p>

            <div className="bridge-direct-grid">
              <label className="bridge-direct-field">
                <span>Bridged INIT available</span>
                <div className="bridge-direct-address">
                  {formatClaimableLabel(claimPreview, initiaAddress)}
                </div>
              </label>

              <label className="bridge-direct-field">
                <span>Mintable cINIT</span>
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
                {isClaiming ? "Claiming cINIT..." : "Claim cINIT"}
              </button>
              <button className="bridge-secondary-btn" onClick={() => void refreshClaimPreview()}>
                Refresh Claimable
              </button>
            </div>

            <div className="bridge-direct-meta">
              <span>EVM recipient {address ? shorten(address) : "Not connected"}</span>
              <span>Initia recipient {initiaAddress ? shorten(initiaAddress) : "Not connected"}</span>
            </div>

            {claimStatus ? <div className="bridge-direct-status">{claimStatus}</div> : null}
          </div>

          <div className="bridge-direct-card">
            <div className="bridge-direct-head">
              <strong>Redeem cINIT back to bridged INIT</strong>
              <span>{claimPreview?.bridgeDenom ?? "l2 INIT"}</span>
            </div>

            <p className="bridge-direct-copy">
              Burn wallet-side `cINIT` to reopen the same amount as bridged INIT on Sinergy. This
              gives you the bridge-native balance again on the rollup.
            </p>

            <div className="bridge-direct-grid">
              <label className="bridge-direct-field">
                <span>Redeemable cINIT</span>
                <div className="bridge-direct-address">{formatRedeemableLabel(claimPreview)}</div>
              </label>

              <label className="bridge-direct-field">
                <span>Wallet cINIT balance</span>
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
                <span>Market-only cINIT</span>
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
              `Redeemable cINIT` comes from your bridged INIT history. `Market-only cINIT` is the
              same ERC20 token, but it was bought inside Sinergy and cannot reopen bridge-native
              INIT by itself.
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
                <strong>{claimPreview?.tokenSymbol ?? "cINIT"}</strong>
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
                {isRedeeming ? "Redeeming cINIT..." : "Redeem cINIT"}
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
