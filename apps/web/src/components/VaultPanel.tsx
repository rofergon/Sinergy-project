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
  return {
    gasPrice: await publicClient.getGasPrice()
  };
}

export function VaultPanel({
  connected,
  address,
  walletClient,
  publicClient,
  vaultAddress,
  tokens,
  onAfterMutation
}: Props) {
  const [tokenAddress, setTokenAddress] = useState<Address | "">("");
  const [amount, setAmount] = useState("10");
  const [status, setStatus] = useState("");
  const selectedToken = useMemo(
    () => tokens.find((token) => token.address === tokenAddress),
    [tokenAddress, tokens]
  );

  const disabled = !connected || !address || !walletClient || !publicClient || !selectedToken;

  return (
    <section className="panel">
      <div className="panel-header">
        <p className="eyebrow">Shielding Layer</p>
        <h2>Move funds into the dark vault</h2>
      </div>

      <div className="form-grid">
        <label>
          Token
          <select value={tokenAddress} onChange={(event) => setTokenAddress(event.target.value as Address)}>
            <option value="">Select token</option>
            {tokens.map((token) => (
              <option key={token.address} value={token.address}>
                {token.symbol}
              </option>
            ))}
          </select>
        </label>

        <label>
          Amount
          <input value={amount} onChange={(event) => setAmount(event.target.value)} />
        </label>
      </div>

      <div className="action-cluster">
        <button
          className="secondary"
          disabled={disabled}
          onClick={async () => {
            if (!selectedToken || !walletClient || !publicClient || !address) return;

            setStatus(`Approving ${selectedToken.symbol}...`);
            try {
              const amountAtomic = parseUnits(amount, selectedToken.decimals);
              const hash = await walletClient.writeContract({
                account: address,
                chain: walletClient.chain,
                address: selectedToken.address,
                abi: erc20Abi,
                functionName: "approve",
                args: [vaultAddress, amountAtomic],
                ...(await gasPriceOverrides(publicClient))
              });
              await publicClient.waitForTransactionReceipt({ hash });
              setStatus("Approval confirmed.");
            } catch (error) {
              setStatus(error instanceof Error ? error.message : String(error));
            }
          }}
        >
          Approve
        </button>

        <button
          className="primary"
          disabled={disabled}
          onClick={async () => {
            if (!selectedToken || !walletClient || !publicClient || !address) return;

            setStatus(`Depositing ${selectedToken.symbol} into vault...`);
            try {
              const amountAtomic = parseUnits(amount, selectedToken.decimals);
              const hash = await walletClient.writeContract({
                account: address,
                chain: walletClient.chain,
                address: vaultAddress,
                abi: darkPoolVaultAbi,
                functionName: "deposit",
                args: [selectedToken.address, amountAtomic],
                ...(await gasPriceOverrides(publicClient))
              });
              await publicClient.waitForTransactionReceipt({ hash });
              await api("/vault/sync-deposit", {
                method: "POST",
                body: JSON.stringify({ txHash: hash, userAddress: address })
              });
              await onAfterMutation();
              setStatus("Deposit synced into internal dark-vault ledger.");
            } catch (error) {
              setStatus(error instanceof Error ? error.message : String(error));
            }
          }}
        >
          Deposit
        </button>

        <button
          className="secondary"
          disabled={disabled}
          onClick={async () => {
            if (!selectedToken || !walletClient || !publicClient || !address) return;

            setStatus(`Requesting withdrawal quote for ${selectedToken.symbol}...`);
            try {
              const quote = await api<{
                nonce: number;
                deadline: number;
                signature: Hex;
              }>("/vault/withdrawal-quote", {
                method: "POST",
                body: JSON.stringify({
                  userAddress: address,
                  token: selectedToken.address,
                  amount,
                  decimals: selectedToken.decimals
                })
              });

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
                  quote.signature
                ],
                ...(await gasPriceOverrides(publicClient))
              });

              await publicClient.waitForTransactionReceipt({ hash });
              await api("/vault/sync-withdrawal", {
                method: "POST",
                body: JSON.stringify({ txHash: hash, userAddress: address })
              });
              await onAfterMutation();
              setStatus("Withdrawal settled from dark vault.");
            } catch (error) {
              setStatus(error instanceof Error ? error.message : String(error));
            }
          }}
        >
          Withdraw
        </button>
      </div>

      <p className="status-copy">{status}</p>
    </section>
  );
}

