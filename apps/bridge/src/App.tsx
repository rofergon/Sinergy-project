import { useEffect, useMemo, useState } from "react";
import { MsgInitiateTokenDeposit, MsgInitiateTokenDepositResponse } from "@initia/opinit.proto/opinit/ophost/v1/tx";
import { useInterwovenKit } from "@initia/interwovenkit-react";
import type { Address } from "viem";
import { formatUnits, parseUnits } from "viem";
import { useBalance } from "wagmi";
import { sepolia } from "wagmi/chains";
import { buildPublicSubdomainHost, isDirectHost } from "@sinergy/shared";
import { ThemeToggle } from "./ThemeToggle";
import {
  buildBridgeDefaults,
  DEFAULT_SINERGY_BRIDGE_ASSET,
  formatInitiaIdentity,
  resolveRollupRestUrl,
  SINERGY_BRIDGE_ID,
  SINERGY_BRIDGE_ASSETS,
  resolveBridgeAsset,
} from "./initia";
import { api } from "./api";
import "./styles.css";

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

export default function App() {
  const {
    address,
    isConnected,
    initiaAddress,
    username,
    openConnect,
    openWallet,
    openBridge,
    requestTxBlock,
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
  const rollupRestUrl = useMemo(() => resolveRollupRestUrl(), []);
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
  const selectedBridgeAsset = useMemo(
    () => resolveBridgeAsset(selectedBridgeAssetSymbol),
    [selectedBridgeAssetSymbol]
  );

  async function waitForBridgeCredit(
    addressToCheck: string,
    expectedIncrease: bigint,
    destinationDenom: string
  ) {
    const startingBalance = await queryRollupBalance(
      addressToCheck,
      destinationDenom,
      rollupRestUrl
    );

    for (let attempt = 0; attempt < 15; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 3_000));
      const currentBalance = await queryRollupBalance(
        addressToCheck,
        destinationDenom,
        rollupRestUrl
      );

      if (currentBalance >= startingBalance + expectedIncrease) {
        return currentBalance;
      }
    }

    return null;
  }

  async function handleDirectBridge() {
    if (!initiaAddress) {
      openConnect();
      return;
    }

    try {
      setIsSubmitting(true);
      setTxHash("");
      setBridgeStatus("Preparing direct deposit to Sinergy...");

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

  async function refreshClaimPreview(
    nextInitiaAddress = initiaAddress,
    nextTokenSymbol = selectedBridgeAssetSymbol
  ) {
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
      openConnect();
      return;
    }

    try {
      setIsClaiming(true);
      setClaimStatus(
        `Minting ${claimPreview?.tokenSymbol ?? selectedBridgeAssetSymbol} from your bridged balance...`
      );

      const result = await api<BridgeClaimPreview & { evmAddress: Address; txHash: string }>(
        "/bridge/claim",
        {
          method: "POST",
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
      openConnect();
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
          <ThemeToggle />
          {isConnected && initiaAddress ? (
            <button className="wallet-pill" onClick={openWallet}>
              {formatInitiaIdentity(username, initiaAddress, { includeAddress: true })}
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
                <button
                  className="primary-btn"
                  onClick={() => {
                    if (!initiaAddress) {
                      openConnect();
                      return;
                    }

                    openBridge(buildBridgeDefaults());
                  }}
                >
                  Open Official Bridge
                </button>
              )}
              <button className="primary-btn direct-btn" onClick={handleDirectBridge} disabled={isSubmitting}>
                {isSubmitting ? "Submitting To Sinergy..." : "Bridge To Sinergy"}
              </button>

              <a className="secondary-btn" href={appUrl}>
                Continue To Exchange
              </a>
            </div>

            <div className="helper-copy">
              Start with the configured bridge source asset, complete the official bridge flow, and
              then continue into the exchange for deposit and trading.
            </div>

            <section className="direct-card">
              <div className="direct-head">
                <strong>Direct deposit to Sinergy</strong>
                <span>{selectedBridgeAsset?.sourceChainId ?? "initiation-2"}</span>
              </div>
              <p className="direct-copy">
                This route signs the OPinit deposit directly with InterwovenKit, so the user does
                not depend on destination discovery inside the public bridge modal.
              </p>
              {SINERGY_BRIDGE_ASSETS.length > 1 ? (
                <label className="direct-field">
                  <span>Bridge asset</span>
                  <div className="direct-input-wrap">
                    <select
                      className="direct-input"
                      value={selectedBridgeAssetSymbol}
                      onChange={(event) => setSelectedBridgeAssetSymbol(event.target.value)}
                      disabled={isSubmitting || isClaiming || isRedeeming}
                    >
                      {SINERGY_BRIDGE_ASSETS.map((asset) => (
                        <option key={asset.tokenSymbol} value={asset.tokenSymbol}>
                          {asset.sourceSymbol}
                          {" -> "}
                          {asset.tokenSymbol}
                        </option>
                      ))}
                    </select>
                  </div>
                </label>
              ) : null}
              <div className="direct-grid">
                <label className="direct-field">
                  <span>Amount</span>
                  <div className="direct-input-wrap">
                    <input
                      className="direct-input"
                      type="number"
                      min="0"
                      step="0.000001"
                      value={amount}
                      onChange={(event) => setAmount(event.target.value)}
                      disabled={isSubmitting}
                    />
                    <strong>{selectedBridgeAsset?.sourceSymbol ?? "INIT"}</strong>
                  </div>
                </label>
                <label className="direct-field">
                  <span>Recipient on Sinergy</span>
                  <div className="direct-address">
                    {initiaAddress
                      ? formatInitiaIdentity(username, initiaAddress, { includeAddress: true })
                      : "Connect your Initia wallet"}
                  </div>
                </label>
              </div>
              <div className="direct-meta">
                <span>Bridge ID {SINERGY_BRIDGE_ID.toString()}</span>
                <span>Rollup REST {rollupRestUrl}</span>
              </div>
              {bridgeStatus ? <div className="direct-status">{bridgeStatus}</div> : null}
              {txHash ? <div className="direct-hash">Tx: {txHash}</div> : null}
            </section>

            <section className="direct-card">
              <div className="direct-head">
                <strong>
                  Claim bridged {selectedBridgeAsset?.sourceSymbol ?? "INIT"} as{" "}
                  {claimPreview?.tokenSymbol ?? selectedBridgeAsset?.tokenSymbol ?? "cINIT"}
                </strong>
                <span>{claimPreview?.tokenSymbol ?? selectedBridgeAsset?.tokenSymbol ?? "cINIT"}</span>
              </div>
              <p className="direct-copy">
                Mint the EVM-side connected token from your bridged balance so you can deposit it
                into the vault and route trades through Sinergy.
              </p>
              <div className="direct-grid">
                <label className="direct-field">
                  <span>Bridged {selectedBridgeAsset?.sourceSymbol ?? "INIT"} available</span>
                  <div className="direct-address">
                    {formatClaimableLabel(claimPreview, initiaAddress)}
                  </div>
                </label>
                <label className="direct-field">
                  <span>Mintable {claimPreview?.tokenSymbol ?? selectedBridgeAsset?.tokenSymbol ?? "token"}</span>
                  <div className="direct-address">
                    {formatMintableLabel(claimPreview)}
                  </div>
                </label>
              </div>
              <div className="hero-actions">
                <button
                  className="primary-btn direct-btn"
                  onClick={handleClaimCinit}
                  disabled={isClaiming || !claimPreview || BigInt(claimPreview.claimableAtomic) <= 0n}
                >
                  {isClaiming
                    ? `Claiming ${claimPreview?.tokenSymbol ?? selectedBridgeAsset?.tokenSymbol ?? "token"}...`
                    : `Claim ${claimPreview?.tokenSymbol ?? selectedBridgeAsset?.tokenSymbol ?? "token"}`}
                </button>
                <button className="secondary-btn" onClick={() => void refreshClaimPreview()}>
                  Refresh Claimable
                </button>
              </div>
              <div className="direct-meta">
                <span>EVM recipient {address ? shorten(address) : "Not connected"}</span>
                <span>
                  Initia recipient{" "}
                  {initiaAddress
                    ? formatInitiaIdentity(username, initiaAddress, { includeAddress: true })
                    : "Not connected"}
                </span>
              </div>
              {claimStatus ? <div className="direct-status">{claimStatus}</div> : null}
            </section>

            <section className="direct-card">
              <div className="direct-head">
                <strong>
                  Redeem {claimPreview?.tokenSymbol ?? selectedBridgeAsset?.tokenSymbol ?? "token"} back to bridged{" "}
                  {claimPreview?.sourceSymbol ?? selectedBridgeAsset?.sourceSymbol ?? "asset"}
                </strong>
                <span>{claimPreview?.destinationDenom ?? selectedBridgeAsset?.destinationDenom ?? "l2 asset"}</span>
              </div>
              <p className="direct-copy">
                Burn the connected token to reopen the same amount as bridged balance on Sinergy.
                This returns you to the bridge-native balance on the rollup.
              </p>
              <div className="direct-grid">
                <label className="direct-field">
                  <span>Redeemable {claimPreview?.tokenSymbol ?? selectedBridgeAsset?.tokenSymbol ?? "token"}</span>
                  <div className="direct-address">{formatRedeemableLabel(claimPreview)}</div>
                </label>
                <label className="direct-field">
                  <span>Wallet {claimPreview?.tokenSymbol ?? selectedBridgeAsset?.tokenSymbol ?? "token"} balance</span>
                  <div className="direct-address">
                    {claimPreview
                      ? `${formatUnits(
                          BigInt(claimPreview.walletTokenBalanceAtomic),
                          claimPreview.tokenDecimals
                        )} ${claimPreview.tokenSymbol}`
                      : "--"}
                  </div>
                </label>
              </div>
              <div className="direct-grid">
                <label className="direct-field">
                  <span>Market-only {claimPreview?.tokenSymbol ?? selectedBridgeAsset?.tokenSymbol ?? "token"}</span>
                  <div className="direct-address">{formatMarketOnlyLabel(claimPreview)}</div>
                </label>
                <label className="direct-field">
                  <span>What can bridge back later</span>
                  <div className="direct-address">
                    {claimPreview
                      ? `${formatUnits(
                          BigInt(claimPreview.redeemableAtomic),
                          claimPreview.tokenDecimals
                        )} ${claimPreview.tokenSymbol}`
                      : "--"}
                  </div>
                </label>
              </div>
              <p className="direct-copy">
                `Redeemable` balance comes from your bridge history. `Market-only` balance is the
                same ERC20 token, but it was acquired inside Sinergy and cannot reopen
                bridge-native funds by itself.
              </p>
              <label className="direct-field">
                <span>Amount to redeem</span>
                <div className="direct-input-wrap">
                  <input
                    className="direct-input"
                    type="number"
                    min="0"
                    step="0.000001"
                    value={redeemAmount}
                    onChange={(event) => setRedeemAmount(event.target.value)}
                    disabled={isRedeeming}
                  />
                  <strong>{claimPreview?.tokenSymbol ?? selectedBridgeAsset?.tokenSymbol ?? "token"}</strong>
                </div>
              </label>
              <div className="hero-actions">
                <button
                  className="primary-btn direct-btn"
                  onClick={handleRedeemCinit}
                  disabled={
                    isRedeeming || !claimPreview || BigInt(claimPreview.redeemableAtomic) <= 0n
                  }
                >
                  {isRedeeming
                    ? `Redeeming ${claimPreview?.tokenSymbol ?? selectedBridgeAsset?.tokenSymbol ?? "token"}...`
                    : `Redeem ${claimPreview?.tokenSymbol ?? selectedBridgeAsset?.tokenSymbol ?? "token"}`}
                </button>
                <button className="secondary-btn" onClick={() => void refreshClaimPreview()}>
                  Refresh Redeemable
                </button>
              </div>
              {redeemStatus ? <div className="direct-status">{redeemStatus}</div> : null}
            </section>
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
