import { useMemo, useState } from "react";
import { MsgCallResponse } from "@initia/initia.proto/minievm/evm/v1/tx";
import { useInterwovenKit } from "@initia/interwovenkit-react";
import { encodeFunctionData, formatUnits, parseUnits } from "viem";
import type { Address, Hex } from "viem";
import { useReadContract } from "wagmi";
import { darkPoolVaultAbi, erc20Abi } from "@sinergy/shared";
import { api } from "../lib/api";
import { SINERGY_ROLLUP_CHAIN_ID } from "../initia";

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
  tokens: Token[];
  onAfterMutation: () => Promise<void>;
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

    const decoded = MsgCallResponse.decode(response.value);
    return decoded.logs.map(
      (log) =>
        ({
          address: log.address as Address,
          topics: log.topics as Hex[],
          data: (log.data || "0x") as Hex,
        }) satisfies SyncLog
    );
  });
}

export function VaultPanel({
  connected,
  address,
  initiaAddress,
  vaultAddress,
  tokens,
  onAfterMutation,
}: Props) {
  const { requestTxBlock } = useInterwovenKit();
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [tokenAddress, setTokenAddress] = useState<Address | "">("");
  const [amount, setAmount] = useState("10");
  const [status, setStatus] = useState("");

  const selectedToken = useMemo(
    () => tokens.find((t) => t.address === tokenAddress),
    [tokenAddress, tokens]
  );
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

  async function submitMsgCall(contractAddr: Address, input: Hex) {
    if (!initiaAddress) {
      throw new Error("Connect your Initia wallet first.");
    }

    const result = await requestTxBlock({
      chainId: SINERGY_ROLLUP_CHAIN_ID,
      messages: [
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
      ],
    });

    if (result.code !== 0) {
      throw new Error(result.rawLog || "Transaction reverted on Sinergy.");
    }

    return result;
  }

  async function handleDeposit() {
    if (!selectedToken || !address || !initiaAddress) return;
    setStatus(`Approving ${selectedToken.symbol}…`);

    try {
      const amountAtomic = parseUnits(amount, selectedToken.decimals);
      if (amountAtomic <= 0n) {
        throw new Error("Enter a positive amount to deposit.");
      }

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
          args: [vaultAddress, amountAtomic],
        })
      );

      setStatus(`Depositing ${selectedToken.symbol}…`);
      const depositTx = await submitMsgCall(
        vaultAddress,
        encodeFunctionData({
          abi: darkPoolVaultAbi,
          functionName: "deposit",
          args: [selectedToken.address, amountAtomic],
        })
      );

      const logs = decodeMsgCallLogs(depositTx.msgResponses);
      if (logs.length === 0) {
        throw new Error("Deposit completed but no EVM logs were returned.");
      }

      await api("/vault/sync-deposit", {
        method: "POST",
        body: JSON.stringify({
          txHash: depositTx.transactionHash,
          userAddress: address,
          logs,
        }),
      });

      await onAfterMutation();
      await walletBalance.refetch();
      setStatus("Deposit synced ✓");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
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
    let broadcasted = false;

    try {
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

      const amountAtomic = parseUnits(amount, selectedToken.decimals);
      const withdrawTx = await submitMsgCall(
        vaultAddress,
        encodeFunctionData({
          abi: darkPoolVaultAbi,
          functionName: "withdraw",
          args: [
            selectedToken.address,
            amountAtomic,
            BigInt(quote.nonce),
            BigInt(quote.deadline),
            quote.signature,
          ],
        })
      );
      broadcasted = true;

      const logs = decodeMsgCallLogs(withdrawTx.msgResponses);
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

      await onAfterMutation();
      setStatus("Withdrawal settled ✓");
    } catch (err) {
      if (!broadcasted && quote && selectedToken && address) {
        try {
          await api("/vault/cancel-withdrawal", {
            method: "POST",
            body: JSON.stringify({
              userAddress: address,
              token: selectedToken.address,
              nonce: quote.nonce,
            }),
          });
          await onAfterMutation();
        } catch {
          // Preserve the original error and avoid masking the failed withdrawal reason.
        }
      }
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="vault-compact">
      <div className="panel-head" style={{ padding: "0 0 10px", border: "none" }}>
        <span className="panel-title">Dark Vault</span>
      </div>

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
