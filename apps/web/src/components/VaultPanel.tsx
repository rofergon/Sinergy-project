import { useEffect, useMemo, useState } from "react";
import type { TxPopupData } from "./TransactionPopup";
import { MsgCallResponse } from "@initia/initia.proto/minievm/evm/v1/tx";
import { useInterwovenKit } from "@initia/interwovenkit-react";
import type { EncodeObject } from "@cosmjs/proto-signing";
import type { StdFee } from "@cosmjs/amino";
import { encodeFunctionData, formatUnits, parseUnits } from "viem";
import type { Address, Hex } from "viem";
import { useReadContract } from "wagmi";
import { darkPoolVaultAbi, darkVaultV2Abi, erc20Abi } from "@sinergy/shared";
import { api } from "../lib/api";
import {
  createClientZkNote,
  listClientZkNotes,
  markClientZkNoteSpent,
  persistClientZkNote
} from "../lib/zkNotes";
import { deployment, SINERGY_ROLLUP_CHAIN_ID } from "../initia";

type Token = {
  symbol: string;
  name: string;
  address: Address;
  decimals: number;
};

type Props = {
  connected: boolean;
  address?: Address;
  initiaAddress?: string;
  vaultAddress: Address;
  zkVaultAddress?: Address;
  tokens: Token[];
  onAfterMutation: () => Promise<void>;
  showTx: (data: TxPopupData) => void;
};

type SyncLog = {
  address: Address;
  topics: Hex[];
  data: Hex;
};

function decodeMsgCallLogs(messageResponses: Array<{ typeUrl: string; value: Uint8Array }>) {
  return messageResponses.flatMap((response) => {
    if (response.typeUrl !== "/minievm.evm.v1.MsgCallResponse") {
      return [];
    }

    try {
      const decoded = MsgCallResponse.decode(response.value);
      return decoded.logs.map(
        (log) =>
          ({
            address: log.address as Address,
            topics: log.topics as Hex[],
            data: (log.data || "0x") as Hex,
          }) satisfies SyncLog
      );
    } catch {
      return [];
    }
  });
}

/**
 * Fallback: extract EVM logs from tx events when msgResponses-based
 * decoding returns nothing (can happen with certain InterwovenKit /
 * CosmJS versions on minievm chains).
 */
function extractEvmLogsFromEvents(
  events: readonly { readonly type: string; readonly attributes: readonly { readonly key: string; readonly value: string }[] }[]
): SyncLog[] {
  return events.flatMap((event) => {
    if (event.type !== "evm") return [];
    return event.attributes.flatMap((attr) => {
      if (attr.key !== "log") return [];
      try {
        const parsed = JSON.parse(attr.value) as {
          address: string;
          topics: string[];
          data: string;
        };
        return [
          {
            address: parsed.address as Address,
            topics: parsed.topics as Hex[],
            data: (parsed.data || "0x") as Hex,
          } satisfies SyncLog,
        ];
      } catch {
        return [];
      }
    });
  });
}

export function VaultPanel({
  connected,
  address,
  initiaAddress,
  vaultAddress,
  zkVaultAddress,
  tokens,
  onAfterMutation,
  showTx,
}: Props) {
  const { autoSign, estimateGas, requestTxBlock, submitTxBlock } = useInterwovenKit();
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [tokenAddress, setTokenAddress] = useState<Address | "">("");
  const [amount, setAmount] = useState("10");
  const [status, setStatus] = useState("");
  const [autoSignStatus, setAutoSignStatus] = useState("");
  const [isAutoSignPending, setIsAutoSignPending] = useState(false);
  const [localZkNoteCount, setLocalZkNoteCount] = useState(0);

  const selectedToken = useMemo(
    () => tokens.find((t) => t.address === tokenAddress),
    [tokenAddress, tokens]
  );
  const zkEnabled =
    Boolean(zkVaultAddress) &&
    zkVaultAddress !== "0x0000000000000000000000000000000000000000";
  const activeVaultAddress = (zkEnabled ? zkVaultAddress : vaultAddress) as Address;
  const vaultAutoSignEnabled = autoSign.isEnabledByChain[SINERGY_ROLLUP_CHAIN_ID] ?? false;
  const walletBalance = useReadContract({
    address: selectedToken?.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: {
      enabled: Boolean(address && selectedToken),
      refetchInterval: 10_000,
    },
  });

  const disabled = !connected || !address || !initiaAddress || !selectedToken;
  const availableLocalZkNotes = useMemo(() => {
    if (!address || !selectedToken || !zkEnabled) {
      return localZkNoteCount;
    }

    return listClientZkNotes(address, selectedToken.address).filter((note) => note.status === "unspent")
      .length;
  }, [address, localZkNoteCount, selectedToken, zkEnabled]);

  useEffect(() => {
    if (!address || !selectedToken || !zkEnabled) {
      setLocalZkNoteCount(0);
      return;
    }

    setLocalZkNoteCount(
      listClientZkNotes(address, selectedToken.address).filter((note) => note.status === "unspent")
        .length
    );
  }, [address, selectedToken, zkEnabled]);

  async function broadcastMessages(messages: EncodeObject[]) {
    if (vaultAutoSignEnabled) {
      const gasEstimate = await estimateGas({
        chainId: SINERGY_ROLLUP_CHAIN_ID,
        messages,
      });
      const fee: StdFee = {
        amount: [],
        gas: Math.ceil(gasEstimate * 1.4).toString(),
      };

      return submitTxBlock({
        chainId: SINERGY_ROLLUP_CHAIN_ID,
        messages,
        fee,
        preferredFeeDenom: deployment.network.gasDenom,
      });
    }

    return requestTxBlock({
      chainId: SINERGY_ROLLUP_CHAIN_ID,
      messages,
    });
  }

  async function submitMsgCall(contractAddr: Address, input: Hex) {
    if (!initiaAddress) {
      throw new Error("Connect your Initia wallet first.");
    }

    const result = await broadcastMessages([
      {
        typeUrl: "/minievm.evm.v1.MsgCall",
        value: {
          sender: initiaAddress,
          contractAddr,
          input,
          value: "0",
          accessList: [],
          authList: [],
        },
      },
    ]);

    if (result.code !== 0) {
      throw new Error(result.rawLog || "Transaction reverted on Sinergy.");
    }

    return result;
  }

  async function handleToggleAutoSign() {
    if (!initiaAddress) {
      setAutoSignStatus("Connect your Initia wallet first.");
      return;
    }

    try {
      setIsAutoSignPending(true);
      setAutoSignStatus(
        vaultAutoSignEnabled
          ? "Disabling auto-sign on Sinergy..."
          : "Opening Initia auto-sign setup..."
      );

      if (vaultAutoSignEnabled) {
        await autoSign.disable(SINERGY_ROLLUP_CHAIN_ID);
        setAutoSignStatus("Auto-sign disabled for Sinergy vault actions.");
      } else {
        await autoSign.enable(SINERGY_ROLLUP_CHAIN_ID);
        setAutoSignStatus("Auto-sign enabled for Sinergy vault actions.");
      }
    } catch (err) {
      setAutoSignStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setIsAutoSignPending(false);
    }
  }

  async function handleDeposit() {
    if (!selectedToken || !address || !initiaAddress) return;
    setStatus(`Approving ${selectedToken.symbol}…`);

    try {
      const amountAtomic = parseUnits(amount, selectedToken.decimals);
      if (amountAtomic <= 0n) {
        throw new Error("Enter a positive amount to deposit.");
      }
      const preparedZkNote =
        zkEnabled
          ? await createClientZkNote({
              owner: address,
              token: selectedToken.address,
              amountAtomic,
            })
          : undefined;

      const availableWalletBalance = walletBalance.data ?? 0n;
      if (amountAtomic > availableWalletBalance) {
        throw new Error(
          `Insufficient ${selectedToken.symbol} wallet balance. You have ${formatUnits(
            availableWalletBalance,
            selectedToken.decimals
          )} ${selectedToken.symbol} available.`
        );
      }

      await submitMsgCall(
        selectedToken.address,
        encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [activeVaultAddress, amountAtomic],
        })
      );

      setStatus(`${zkEnabled ? "Depositing into ZK vault" : `Depositing ${selectedToken.symbol}`}…`);
      const depositTx = await submitMsgCall(
        activeVaultAddress,
        encodeFunctionData({
          abi: zkEnabled ? darkVaultV2Abi : darkPoolVaultAbi,
          functionName: "deposit",
          args: zkEnabled
            ? [selectedToken.address, amountAtomic, preparedZkNote!.commitment]
            : [selectedToken.address, amountAtomic],
        })
      );

      let logs = decodeMsgCallLogs(depositTx.msgResponses);
      if (logs.length === 0 && depositTx.events) {
        logs = extractEvmLogsFromEvents(depositTx.events);
      }
      if (logs.length === 0) {
        throw new Error("Deposit completed but no EVM logs were returned.");
      }

      await api("/vault/sync-deposit", {
        method: "POST",
        body: JSON.stringify({
          txHash: depositTx.transactionHash,
          userAddress: address,
          logs,
          zkNote: preparedZkNote
            ? {
                commitment: preparedZkNote.commitment,
                secret: preparedZkNote.secret,
                blinding: preparedZkNote.blinding,
              }
            : undefined,
        }),
      });

      if (preparedZkNote) {
        persistClientZkNote({
          ...preparedZkNote,
          txHash: depositTx.transactionHash,
        });
        setLocalZkNoteCount((current) => current + 1);
      }

      await onAfterMutation();
      await walletBalance.refetch();
      const successLabel = zkEnabled ? "ZK deposit synced ✓" : "Deposit synced ✓";
      setStatus(successLabel);
      showTx({
        type: "success",
        title: "Deposit Complete",
        message: zkEnabled
          ? "Your funds have been deposited into the ZK-shielded vault. A private commitment note was created."
          : "Your funds have been deposited into the Dark Vault and are ready for trading.",
        amount: `${amount} ${selectedToken.symbol}`,
        operation: "Deposit",
        txHash: depositTx.transactionHash,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      setStatus(errorMsg);
      showTx({
        type: "error",
        title: "Deposit Failed",
        message: errorMsg,
        amount: `${amount} ${selectedToken?.symbol ?? "TOKEN"}`,
        operation: "Deposit",
      });
    }
  }

  async function handleWithdraw() {
    if (!selectedToken || !address || !initiaAddress) return;
    setStatus("Requesting withdrawal…");

    let quote:
      | {
          nonce: number;
          deadline: number;
          signature: Hex;
        }
      | undefined;
    let zkPackage:
      | {
          root: Hex;
          nullifier: Hex;
          recipient: Address;
          token: Address;
          amountAtomic: string;
          proof: Hex;
        }
      | undefined;
    let broadcasted = false;

    try {
      const amountAtomic = parseUnits(amount, selectedToken.decimals);
      if (zkEnabled) {
        zkPackage = await api<{
          root: Hex;
          nullifier: Hex;
          recipient: Address;
          token: Address;
          amountAtomic: string;
          proof: Hex;
        }>("/vault/zk-withdrawal-package", {
          method: "POST",
          body: JSON.stringify({
            userAddress: address,
            token: selectedToken.address,
            amountAtomic: amountAtomic.toString(),
          }),
        });
      } else {
        quote = await api<{ nonce: number; deadline: number; signature: Hex }>(
          "/vault/withdrawal-quote",
          {
            method: "POST",
            body: JSON.stringify({
              userAddress: address,
              token: selectedToken.address,
              amount,
              decimals: selectedToken.decimals,
            }),
          }
        );
      }

      if (zkEnabled && !zkPackage) {
        throw new Error("Missing ZK withdrawal package.");
      }
      const activeZkPackage = zkPackage;

      const withdrawTx = await submitMsgCall(
        activeVaultAddress,
        encodeFunctionData({
          abi: zkEnabled ? darkVaultV2Abi : darkPoolVaultAbi,
          functionName: "withdraw",
          args: zkEnabled
            ? [
                selectedToken.address,
                amountAtomic,
                address,
                activeZkPackage!.root,
                activeZkPackage!.nullifier,
                activeZkPackage!.proof,
              ]
            : [
                selectedToken.address,
                amountAtomic,
                BigInt((quote as { nonce: number }).nonce),
                BigInt((quote as { deadline: number }).deadline),
                (quote as { signature: Hex }).signature,
              ],
        })
      );
      broadcasted = true;

      let logs = decodeMsgCallLogs(withdrawTx.msgResponses);
      if (logs.length === 0 && withdrawTx.events) {
        logs = extractEvmLogsFromEvents(withdrawTx.events);
      }
      if (logs.length === 0) {
        throw new Error("Withdrawal completed but no EVM logs were returned.");
      }

      await api("/vault/sync-withdrawal", {
        method: "POST",
        body: JSON.stringify({
          txHash: withdrawTx.transactionHash,
          userAddress: address,
          logs,
        }),
      });

      if (zkEnabled && activeZkPackage) {
        const marked = await markClientZkNoteSpent({
          owner: address,
          recipient: address,
          nullifier: activeZkPackage.nullifier,
        });
        if (marked) {
          setLocalZkNoteCount((current) => Math.max(0, current - 1));
        }
      }

      await onAfterMutation();
      const successLabel = zkEnabled ? "ZK withdrawal settled ✓" : "Withdrawal settled ✓";
      setStatus(successLabel);
      showTx({
        type: "success",
        title: "Withdrawal Complete",
        message: zkEnabled
          ? "Your ZK withdrawal has been settled. Funds are back in your wallet."
          : "Your withdrawal has been settled on-chain. Funds are in your wallet.",
        amount: `${amount} ${selectedToken.symbol}`,
        operation: "Withdraw",
        txHash: withdrawTx.transactionHash,
      });
    } catch (err) {
      if (zkEnabled && !broadcasted && zkPackage && selectedToken && address) {
        try {
          await api("/vault/cancel-zk-withdrawal", {
            method: "POST",
            body: JSON.stringify({
              userAddress: address,
              token: selectedToken.address,
              amountAtomic: zkPackage.amountAtomic,
              nullifier: zkPackage.nullifier,
            }),
          });
        } catch {
          // Preserve the original error and avoid masking the failed withdrawal reason.
        }
      }
      if (!zkEnabled && !broadcasted && quote && selectedToken && address) {
        try {
          await api("/vault/cancel-withdrawal", {
            method: "POST",
            body: JSON.stringify({
              userAddress: address,
              token: selectedToken.address,
              nonce: (quote as { nonce: number }).nonce,
            }),
          });
          await onAfterMutation();
        } catch {
          // Preserve the original error and avoid masking the failed withdrawal reason.
        }
      }
      const errorMsg = err instanceof Error ? err.message : String(err);
      setStatus(errorMsg);
      showTx({
        type: "error",
        title: "Withdrawal Failed",
        message: errorMsg,
        amount: `${amount} ${selectedToken?.symbol ?? "TOKEN"}`,
        operation: "Withdraw",
      });
    }
  }

  return (
    <div className="vault-compact">
      <div className="panel-head" style={{ padding: "0 0 10px", border: "none" }}>
        <span className="panel-title">{zkEnabled ? "Dark Vault ZK" : "Dark Vault"}</span>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 12,
          padding: "10px 12px",
          border: "1px solid var(--border)",
          borderRadius: 14,
          background: "rgba(255,255,255,0.03)",
        }}
      >
        <div
          style={{
            display: "grid",
            gap: 4,
          }}
        >
          <span
            style={{
              color: "var(--text-primary)",
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
            }}
          >
            Auto-sign
          </span>
          <span
            style={{
              color: "var(--text-tertiary)",
              fontSize: 12,
              fontFamily: "var(--font-mono)",
            }}
          >
            {vaultAutoSignEnabled
              ? "Vault MsgCall tx on Sinergy-2 can sign without extra popups."
              : "Approve, deposit, and withdraw will still ask for wallet confirmation."}
          </span>
        </div>
        <button
          className="vault-btn"
          type="button"
          disabled={!connected || isAutoSignPending || autoSign.isLoading}
          onClick={handleToggleAutoSign}
        >
          {vaultAutoSignEnabled ? "Disable" : "Enable"}
        </button>
      </div>

      {autoSignStatus ? <div className="vault-status">{autoSignStatus}</div> : null}

      <div className="vault-tabs">
        <button
          className={`vault-tab ${mode === "deposit" ? "active" : ""}`}
          onClick={() => setMode("deposit")}
        >
          Deposit
        </button>
        <button
          className={`vault-tab ${mode === "withdraw" ? "active" : ""}`}
          onClick={() => setMode("withdraw")}
        >
          Withdraw
        </button>
      </div>

      <div className="vault-form">
        <select
          value={tokenAddress}
          onChange={(e) => setTokenAddress(e.target.value as Address)}
        >
          <option value="">Select token</option>
          {tokens.map((t) => (
            <option key={t.address} value={t.address}>
              {t.symbol} — {t.name}
            </option>
          ))}
        </select>

        <div className="tt-input-wrap">
          <input
            type="text"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            style={{
              background: "none",
              border: "none",
              color: "var(--text-primary)",
              fontFamily: "var(--font-mono)",
              fontSize: 14,
              fontWeight: 600,
              padding: "10px 0",
              outline: "none",
              width: "100%",
            }}
          />
          <span className="tt-input-suffix">{selectedToken?.symbol ?? "TOKEN"}</span>
        </div>

        {selectedToken && address ? (
          <>
            <div
              style={{
                color: "var(--text-tertiary)",
                fontSize: 12,
                fontFamily: "var(--font-mono)",
              }}
            >
              Wallet balance:{" "}
              {walletBalance.data !== undefined
                ? `${formatUnits(walletBalance.data, selectedToken.decimals)} ${selectedToken.symbol}`
                : walletBalance.isLoading
                  ? "Loading..."
                  : "Unavailable"}
            </div>
            {zkEnabled ? (
              <div
                style={{
                  color: "var(--text-tertiary)",
                  fontSize: 12,
                  fontFamily: "var(--font-mono)",
                }}
              >
                ZK mode enabled. Deposits and withdrawals route through `DarkVaultV2`.
                {selectedToken ? ` Local notes ready: ${availableLocalZkNotes}.` : ""}
              </div>
            ) : null}
          </>
        ) : null}

        <div className="vault-actions">
          {mode === "deposit" ? (
            <button className="vault-btn primary-action" disabled={disabled} onClick={handleDeposit}>
              Deposit
            </button>
          ) : (
            <button className="vault-btn primary-action" disabled={disabled} onClick={handleWithdraw}>
              Withdraw
            </button>
          )}
        </div>

        {status && <div className="vault-status">{status}</div>}
      </div>
    </div>
  );
}
