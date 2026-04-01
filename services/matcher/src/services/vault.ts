import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { createPublicClient, createWalletClient, http, isAddressEqual, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { SinergyDeployment } from "@sinergy/shared";
import { createSinergyChain } from "@sinergy/shared";
import type { PendingWithdrawal, ResolvedMarket, ResolvedToken } from "../types.js";
import { StateStore } from "./state.js";
import { darkPoolVaultAbi } from "./deployment.js";

function keyOf(value: string): string {
  return value.toLowerCase();
}

function readBucket(
  root: Record<string, Record<string, string>>,
  address: string
): Record<string, string> {
  const key = keyOf(address);
  root[key] ??= {};
  return root[key];
}

function addAtomic(
  root: Record<string, Record<string, string>>,
  address: string,
  token: string,
  delta: bigint
): void {
  const bucket = readBucket(root, address);
  const tokenKey = keyOf(token);
  const next = BigInt(bucket[tokenKey] ?? "0") + delta;
  bucket[tokenKey] = next.toString();
}

export function createClients(privateKey: Hex, deployment: Pick<SinergyDeployment, "network">) {
  const account = privateKeyToAccount(privateKey);
  const chain = createSinergyChain(deployment);

  const publicClient = createPublicClient({
    chain,
    transport: http(deployment.network.rpcUrl)
  });

  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(deployment.network.rpcUrl)
  });

  return { publicClient, walletClient, account };
}

export class VaultService {
  constructor(
    private readonly store: StateStore,
    private readonly publicClient: PublicClient,
    private readonly walletClient: WalletClient,
    private readonly deployment: SinergyDeployment,
    private readonly tokens: Map<string, ResolvedToken>,
    private readonly markets: ResolvedMarket[]
  ) {}

  releaseExpiredWithdrawals(now = Math.floor(Date.now() / 1000)): void {
    this.store.mutate((state) => {
      const pending: PendingWithdrawal[] = [];

      for (const item of state.pendingWithdrawals) {
        if (item.deadline <= now) {
          addAtomic(state.locked, item.userAddress, item.token, -BigInt(item.amountAtomic));
          addAtomic(state.balances, item.userAddress, item.token, BigInt(item.amountAtomic));
          continue;
        }

        pending.push(item);
      }

      state.pendingWithdrawals = pending;
    });
  }

  private async resolveExecutionLogs(
    txHash: string,
    logs?: Array<{ address: Address; topics: Hex[]; data: Hex }>
  ) {
    if (logs && logs.length > 0) {
      return logs;
    }

    const receipt = await this.publicClient.getTransactionReceipt({ hash: txHash as Hex });
    return receipt.logs;
  }

  async syncDeposit(
    txHash: string,
    userAddress: Address,
    logs?: Array<{ address: Address; topics: Hex[]; data: Hex }>
  ) {
    const vault = this.deployment.contracts.vault;
    if (vault === "0x0000000000000000000000000000000000000000") {
      throw new Error("Vault address not configured");
    }

    return this.store.mutateAsync(async (state) => {
      const txKey = keyOf(txHash);
      if (state.processedDeposits.includes(txKey)) {
        return { alreadyProcessed: true };
      }

      const executionLogs = await this.resolveExecutionLogs(txHash, logs);
      const parsedLogs = parseEventLogs({
        abi: darkPoolVaultAbi,
        eventName: "Deposit",
        logs: executionLogs as any
      });

      const depositLog = parsedLogs.find((log) => isAddressEqual(log.args.user!, userAddress));
      if (!depositLog) {
        throw new Error("No vault deposit event found for this user");
      }

      addAtomic(
        state.balances,
        userAddress,
        depositLog.args.token!,
        BigInt(depositLog.args.amount!.toString())
      );
      state.processedDeposits.push(txKey);

      return {
        alreadyProcessed: false,
        token: this.tokens.get(depositLog.args.token!.toLowerCase())?.symbol ?? depositLog.args.token,
        amountAtomic: depositLog.args.amount!.toString()
      };
    });
  }

  async buildWithdrawalQuote(input: {
    userAddress: Address;
    token: Address;
    amountAtomic: bigint;
  }) {
    this.releaseExpiredWithdrawals();

    const now = Math.floor(Date.now() / 1000);
    const deadline = now + 15 * 60;
    const snapshot = this.store.get();
    const available = BigInt(readBucket(snapshot.balances, input.userAddress)[keyOf(input.token)] ?? "0");
    if (available < input.amountAtomic) {
      throw new Error("Insufficient internal balance");
    }

    const nextNonce = (snapshot.withdrawalNonces[keyOf(input.userAddress)] ?? 0) + 1;
    const signature = await this.walletClient.signTypedData({
      account: this.walletClient.account!,
      domain: {
        name: "SinergyDarkPoolVault",
        version: "1",
        chainId: this.deployment.network.chainId,
        verifyingContract: this.deployment.contracts.vault
      },
      types: {
        Withdrawal: [
          { name: "recipient", type: "address" },
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" }
        ]
      },
      primaryType: "Withdrawal",
      message: {
        recipient: input.userAddress,
        token: input.token,
        amount: input.amountAtomic,
        nonce: BigInt(nextNonce),
        deadline: BigInt(deadline)
      }
    });

    this.store.mutate((state) => {
      const currentAvailable = BigInt(readBucket(state.balances, input.userAddress)[keyOf(input.token)] ?? "0");
      if (currentAvailable < input.amountAtomic) {
        throw new Error("Insufficient internal balance");
      }

      state.withdrawalNonces[keyOf(input.userAddress)] = nextNonce;
      addAtomic(state.balances, input.userAddress, input.token, -input.amountAtomic);
      addAtomic(state.locked, input.userAddress, input.token, input.amountAtomic);
      state.pendingWithdrawals.push({
        userAddress: input.userAddress,
        token: input.token,
        amountAtomic: input.amountAtomic.toString(),
        nonce: nextNonce,
        deadline
      });
    });

    return {
      nonce: nextNonce,
      deadline,
      signature
    };
  }

  async syncWithdrawal(
    txHash: string,
    userAddress: Address,
    logs?: Array<{ address: Address; topics: Hex[]; data: Hex }>
  ) {
    return this.store.mutateAsync(async (state) => {
      const txKey = keyOf(txHash);
      if (state.processedWithdrawals.includes(txKey)) {
        return { alreadyProcessed: true };
      }

      const executionLogs = await this.resolveExecutionLogs(txHash, logs);
      const parsedLogs = parseEventLogs({
        abi: darkPoolVaultAbi,
        eventName: "Withdraw",
        logs: executionLogs as any
      });

      const withdrawLog = parsedLogs.find((log) => isAddressEqual(log.args.recipient!, userAddress));
      if (!withdrawLog) {
        throw new Error("No vault withdrawal event found for this user");
      }

      const nonce = Number(withdrawLog.args.nonce);
      const pendingIndex = state.pendingWithdrawals.findIndex(
        (item) =>
          item.userAddress.toLowerCase() === userAddress.toLowerCase() &&
          item.nonce === nonce
      );

      if (pendingIndex >= 0) {
        const pending = state.pendingWithdrawals[pendingIndex];
        addAtomic(state.locked, pending.userAddress, pending.token, -BigInt(pending.amountAtomic));
        state.pendingWithdrawals.splice(pendingIndex, 1);
      }

      state.processedWithdrawals.push(txKey);
      return {
        alreadyProcessed: false,
        nonce
      };
    });
  }
}
