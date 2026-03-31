import { useMemo, useState } from "react";
import { parseUnits } from "viem";
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { darkPoolVaultAbi, erc20Abi } from "@sinergy/shared";
import { api } from "../lib/api";

type Token = {
  symbol: string;
  name: string;
  address: Address;
  decimals: number;
};

type Props = {
  connected: boolean;
  address?: Address;
  walletClient?: WalletClient;
  publicClient?: PublicClient;
  vaultAddress: Address;
  tokens: Token[];
  onAfterMutation: () => Promise<void>;
};

async function gasPriceOverrides(publicClient: PublicClient) {
  return { gasPrice: await publicClient.getGasPrice() };
}

export function VaultPanel({
  connected,
  address,
  walletClient,
  publicClient,
  vaultAddress,
  tokens,
  onAfterMutation,
}: Props) {
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [tokenAddress, setTokenAddress] = useState<Address | "">("");
  const [amount, setAmount] = useState("10");
  const [status, setStatus] = useState("");

  const selectedToken = useMemo(
    () => tokens.find((t) => t.address === tokenAddress),
    [tokenAddress, tokens]
  );

  const disabled = !connected || !address || !walletClient || !publicClient || !selectedToken;

  async function handleDeposit() {
    if (!selectedToken || !walletClient || !publicClient || !address) return;
    setStatus(`Approving ${selectedToken.symbol}…`);
    try {
      const amountAtomic = parseUnits(amount, selectedToken.decimals);

      // Approve
      const approveHash = await walletClient.writeContract({
        account: address,
        chain: walletClient.chain,
        address: selectedToken.address,
        abi: erc20Abi,
        functionName: "approve",
        args: [vaultAddress, amountAtomic],
        ...(await gasPriceOverrides(publicClient)),
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });

      setStatus(`Depositing ${selectedToken.symbol}…`);
      const hash = await walletClient.writeContract({
        account: address,
        chain: walletClient.chain,
        address: vaultAddress,
        abi: darkPoolVaultAbi,
        functionName: "deposit",
        args: [selectedToken.address, amountAtomic],
        ...(await gasPriceOverrides(publicClient)),
      });
      await publicClient.waitForTransactionReceipt({ hash });
      await api("/vault/sync-deposit", {
        method: "POST",
        body: JSON.stringify({ txHash: hash, userAddress: address }),
      });
      await onAfterMutation();
      setStatus("Deposit synced ✓");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleWithdraw() {
    if (!selectedToken || !walletClient || !publicClient || !address) return;
    setStatus(`Requesting withdrawal…`);
    try {
      const quote = await api<{ nonce: number; deadline: number; signature: Hex }>(
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
      const hash = await walletClient.writeContract({
        account: address,
        chain: walletClient.chain,
        address: vaultAddress,
        abi: darkPoolVaultAbi,
        functionName: "withdraw",
        args: [
          selectedToken.address,
          amountAtomic,
          BigInt(quote.nonce),
          BigInt(quote.deadline),
          quote.signature,
        ],
        ...(await gasPriceOverrides(publicClient)),
      });
      await publicClient.waitForTransactionReceipt({ hash });
      await api("/vault/sync-withdrawal", {
        method: "POST",
        body: JSON.stringify({ txHash: hash, userAddress: address }),
      });
      await onAfterMutation();
      setStatus("Withdrawal settled ✓");
    } catch (err) {
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
