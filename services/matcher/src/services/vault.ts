import { randomUUID } from "node:crypto";
import type { Account, Address, Hex, PublicClient, WalletClient } from "viem";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  isAddressEqual,
  parseEventLogs
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { SinergyDeployment } from "@sinergy/shared";
import {
  computeNoteCommitment,
  createSinergyChain,
  darkPoolMarketAbi,
  darkStateAnchorAbi,
  darkVaultV2Abi,
  erc20Abi
} from "@sinergy/shared";
import type { PendingWithdrawal, ResolvedMarket, ResolvedToken } from "../types.js";
import { StateStore } from "./state.js";
import { darkPoolVaultAbi } from "./deployment.js";
import { getZkMerkleRoot, nowIso, releaseExpiredZkNoteLocks } from "./zkState.js";

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

  getAvailableBalance(userAddress: Address, token: Address) {
    return BigInt(readBucket(this.store.get().balances, userAddress)[keyOf(token)] ?? "0");
  }

  async getCurrentZkRoot() {
    return getZkMerkleRoot(this.store.get());
  }

  releaseExpiredZkWithdrawals(now = Date.now()) {
    this.store.mutate((state) => {
      releaseExpiredZkNoteLocks(state, now);
    });
  }

  private async anchorZkRoot(stateRoot: Hex, settlementRoot: Hex) {
    const stateAnchor = this.deployment.contracts.stateAnchor;
    if (!stateAnchor || stateAnchor === "0x0000000000000000000000000000000000000000") {
      throw new Error("State anchor address is not configured");
    }

    const batchId = (`0x${randomUUID().replace(/-/g, "").padEnd(64, "0").slice(0, 64)}`) as Hex;
    await this.sendMatcherTransaction(
      stateAnchor,
      encodeFunctionData({
        abi: darkStateAnchorAbi,
        functionName: "anchorBatch",
        args: [batchId, stateRoot, settlementRoot, 1n]
      })
    );

    const marketAddress = this.deployment.contracts.market;
    if (marketAddress && marketAddress !== "0x0000000000000000000000000000000000000000") {
      await this.sendMatcherTransaction(
        marketAddress,
        encodeFunctionData({
          abi: darkPoolMarketAbi,
          functionName: "anchorBatch",
          args: [batchId, stateRoot, settlementRoot, 1n]
        })
      );
    }
  }

  private async sendMatcherTransaction(to: Address, data: Hex) {
    const matcherAccount = this.walletClient.account as Account | undefined;
    if (!matcherAccount?.address || !matcherAccount.signTransaction) {
      throw new Error("Matcher signer is not configured for vault settlement");
    }

    const nonce = await this.publicClient.getTransactionCount({
      address: matcherAccount.address
    });
    const gas = await this.publicClient.estimateGas({
      account: matcherAccount.address,
      to,
      data
    });
    const gasPrice = await this.publicClient.getGasPrice();
    const serializedTransaction = await matcherAccount.signTransaction({
      chainId: this.deployment.network.chainId,
      type: "legacy",
      to,
      data,
      nonce,
      gas,
      gasPrice,
      value: 0n
    });
    const txHash = await this.walletClient.sendRawTransaction({
      serializedTransaction
    });
    await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    return txHash;
  }

  async settleInstantLocalSwap(input: {
    inputToken: Address;
    outputToken: Address;
    inputAmountAtomic: bigint;
    outputAmountAtomic: bigint;
  }) {
    const matcherAccount = this.walletClient.account as Account | undefined;
    const matcherAddress = matcherAccount?.address;
    if (!matcherAddress) {
      throw new Error("Matcher signer is not configured for instant settlement");
    }

    const vaultAddress = this.deployment.contracts.vault;
    const [matcherOutputBalance, vaultInputBalance] = await Promise.all([
      this.publicClient.readContract({
        address: input.outputToken,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [matcherAddress]
      }),
      this.publicClient.readContract({
        address: input.inputToken,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [vaultAddress]
      })
    ]);

    if (matcherOutputBalance < input.outputAmountAtomic) {
      throw new Error("Matcher inventory wallet lacks enough output token to settle this swap");
    }

    if (vaultInputBalance < input.inputAmountAtomic) {
      throw new Error("Vault lacks enough input token to settle this swap");
    }

    await this.sendMatcherTransaction(
      input.outputToken,
      encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [vaultAddress, input.outputAmountAtomic]
      })
    );

    const nonce = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 15 * 60);
    const signature = await this.walletClient.signTypedData({
      account: matcherAccount,
      domain: {
        name: "SinergyDarkPoolVault",
        version: "1",
        chainId: this.deployment.network.chainId,
        verifyingContract: vaultAddress
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
        recipient: matcherAddress,
        token: input.inputToken,
        amount: input.inputAmountAtomic,
        nonce,
        deadline
      }
    });

    await this.sendMatcherTransaction(
      vaultAddress,
      encodeFunctionData({
        abi: darkPoolVaultAbi,
        functionName: "withdraw",
        args: [
          input.inputToken,
          input.inputAmountAtomic,
          nonce,
          deadline,
          signature
        ]
      })
    );
  }

  async getMatcherWalletBalance(token: Address) {
    const matcherAddress = (this.walletClient.account as Account | undefined)?.address;
    if (!matcherAddress) {
      return 0n;
    }

    return this.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [matcherAddress]
    });
  }

  releaseExpiredWithdrawals(now = Math.floor(Date.now() / 1000)): void {
    this.store.mutate((state) => {
      const pending: PendingWithdrawal[] = [];
      releaseExpiredZkNoteLocks(state);

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
    logs?: Array<{ address: Address; topics: Hex[]; data: Hex }>,
    zkNote?: {
      commitment: Hex;
      secret: string;
      blinding: string;
    }
  ) {
    const txKey = keyOf(txHash);
    if (this.store.get().processedDeposits.includes(txKey)) {
      return { alreadyProcessed: true };
    }

    const executionLogs = await this.resolveExecutionLogs(txHash, logs);
    const parsedLegacyLogs = parseEventLogs({
      abi: darkPoolVaultAbi,
      eventName: "Deposit",
      logs: executionLogs as any
    });
    const parsedZkLogs = parseEventLogs({
      abi: darkVaultV2Abi,
      eventName: "Deposit",
      logs: executionLogs as any
    });

    const legacyDepositLog = parsedLegacyLogs.find((log) =>
      isAddressEqual(log.args.user!, userAddress)
    );
    const zkDepositLog = parsedZkLogs.find((log) =>
      isAddressEqual(log.args.depositor!, userAddress)
    );
    const token = legacyDepositLog?.args.token ?? zkDepositLog?.args.token;
    const amount = legacyDepositLog?.args.amount ?? zkDepositLog?.args.amount;

    if (!token || amount === undefined) {
      throw new Error("No vault deposit event found for this user");
    }

    const amountAtomic = BigInt(amount.toString());
    if (zkDepositLog) {
      if (!zkNote) {
        throw new Error("Missing ZK note payload for deposit sync");
      }

      const expectedCommitment = await computeNoteCommitment({
        secret: zkNote.secret,
        blinding: zkNote.blinding,
        token,
        amountAtomic
      });
      const receiverCommitment = zkDepositLog.args.receiverCommitment!;
      if (expectedCommitment.toLowerCase() !== zkNote.commitment.toLowerCase()) {
        throw new Error("Provided ZK note commitment does not match the supplied note");
      }
      if (expectedCommitment.toLowerCase() !== receiverCommitment.toLowerCase()) {
        throw new Error("Provided ZK note does not match the on-chain deposit commitment");
      }

      const draft = structuredClone(this.store.get());
      if (draft.processedDeposits.includes(txKey)) {
        return { alreadyProcessed: true };
      }

      addAtomic(draft.balances, userAddress, token, amountAtomic);
      draft.processedDeposits.push(txKey);
      draft.zkNotes.push({
        id: randomUUID(),
        userAddress,
        token,
        amountAtomic: amountAtomic.toString(),
        commitment: expectedCommitment,
        secret: zkNote.secret,
        blinding: zkNote.blinding,
        txHash,
        createdAt: nowIso(),
        status: "unspent"
      });

      const nextRoot = await getZkMerkleRoot(draft);
      await this.anchorZkRoot(nextRoot, zkDepositLog.args.receiverCommitment!);

      return this.store.mutate((state) => {
        if (state.processedDeposits.includes(txKey)) {
          return { alreadyProcessed: true };
        }

        addAtomic(state.balances, userAddress, token, amountAtomic);
        state.processedDeposits.push(txKey);
        state.zkNotes.push({
          id: randomUUID(),
          userAddress,
          token,
          amountAtomic: amountAtomic.toString(),
          commitment: expectedCommitment,
          secret: zkNote.secret,
          blinding: zkNote.blinding,
          txHash,
          createdAt: nowIso(),
          status: "unspent"
        });

        return {
          alreadyProcessed: false,
          token: this.tokens.get(token.toLowerCase())?.symbol ?? token,
          amountAtomic: amount.toString(),
          mode: "zk" as const,
          root: nextRoot
        };
      });
    }

    return this.store.mutate((state) => {
      if (state.processedDeposits.includes(txKey)) {
        return { alreadyProcessed: true };
      }

      addAtomic(state.balances, userAddress, token, amountAtomic);
      state.processedDeposits.push(txKey);

      return {
        alreadyProcessed: false,
        token: this.tokens.get(token.toLowerCase())?.symbol ?? token,
        amountAtomic: amount.toString(),
        mode: "legacy" as const
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

  cancelPendingWithdrawal(input: {
    userAddress: Address;
    token: Address;
    nonce: number;
  }) {
    return this.store.mutate((state) => {
      const pendingIndex = state.pendingWithdrawals.findIndex(
        (item) =>
          item.userAddress.toLowerCase() === input.userAddress.toLowerCase() &&
          item.token.toLowerCase() === input.token.toLowerCase() &&
          item.nonce === input.nonce
      );

      if (pendingIndex < 0) {
        return { cancelled: false };
      }

      const pending = state.pendingWithdrawals[pendingIndex];
      addAtomic(state.locked, pending.userAddress, pending.token, -BigInt(pending.amountAtomic));
      addAtomic(state.balances, pending.userAddress, pending.token, BigInt(pending.amountAtomic));
      state.pendingWithdrawals.splice(pendingIndex, 1);

      return { cancelled: true };
    });
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
      const parsedLegacyLogs = parseEventLogs({
        abi: darkPoolVaultAbi,
        eventName: "Withdraw",
        logs: executionLogs as any
      });
      const parsedZkLogs = parseEventLogs({
        abi: darkVaultV2Abi,
        eventName: "Withdraw",
        logs: executionLogs as any
      });

      const legacyWithdrawLog = parsedLegacyLogs.find((log) =>
        isAddressEqual(log.args.recipient!, userAddress)
      );
      const zkWithdrawLog = parsedZkLogs.find((log) =>
        isAddressEqual(log.args.recipient!, userAddress)
      );

      if (!legacyWithdrawLog && !zkWithdrawLog) {
        throw new Error("No vault withdrawal event found for this user");
      }

      let nonce: number | undefined;
      let nullifier: Hex | undefined;

      if (legacyWithdrawLog) {
        nonce = Number(legacyWithdrawLog.args.nonce);
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
      }

      if (zkWithdrawLog) {
        const amount = BigInt(zkWithdrawLog.args.amount!.toString());
        const token = zkWithdrawLog.args.token!;
        const available = BigInt(readBucket(state.balances, userAddress)[keyOf(token)] ?? "0");
        if (available < amount) {
          throw new Error("Insufficient internal balance to sync ZK withdrawal");
        }

        addAtomic(state.balances, userAddress, token, -amount);
        nullifier = zkWithdrawLog.args.nullifier!;

        const note = state.zkNotes.find((entry) => entry.pendingNullifier === nullifier);
        if (note) {
          note.status = "spent";
          note.spentNullifier = nullifier;
          note.spentAt = nowIso();
          delete note.pendingRecipient;
          delete note.pendingNullifier;
          delete note.pendingSince;
        }
      }

      state.processedWithdrawals.push(txKey);
      return {
        alreadyProcessed: false,
        nonce,
        nullifier,
        mode: zkWithdrawLog ? "zk" : "legacy"
      };
    });
  }
}
