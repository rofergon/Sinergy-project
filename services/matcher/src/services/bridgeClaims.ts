import { erc20Abi, type SinergyDeployment } from "@sinergy/shared";
import type { Account, Address, PublicClient, WalletClient } from "viem";
import { encodeFunctionData, isAddressEqual } from "viem";
import type { ResolvedToken } from "../types.js";
import { StateStore } from "./state.js";

function keyOf(value: string): string {
  return value.toLowerCase();
}

function scaleAtomic(amount: bigint, fromDecimals: number, toDecimals: number): bigint {
  if (fromDecimals === toDecimals) {
    return amount;
  }

  if (fromDecimals < toDecimals) {
    return amount * 10n ** BigInt(toDecimals - fromDecimals);
  }

  return amount / 10n ** BigInt(fromDecimals - toDecimals);
}

type BridgeClaimDeps = {
  store: StateStore;
  publicClient: PublicClient;
  walletClient: WalletClient;
  deployment: SinergyDeployment;
  tokens: Map<string, ResolvedToken>;
  bridgedDenom: string;
  bridgedSymbol: string;
  bridgedSourceDecimals: number;
  rollupRestUrl: string;
};

export class BridgeClaimService {
  private readonly destinationToken: ResolvedToken;

  constructor(private readonly deps: BridgeClaimDeps) {
    const token = Array.from(deps.tokens.values()).find(
      (item) => keyOf(item.symbol) === keyOf(deps.bridgedSymbol)
    );

    if (!token) {
      throw new Error(`Bridge claim token ${deps.bridgedSymbol} is not configured in deployment`);
    }

    this.destinationToken = token;
  }

  async preview(initiaAddress: string, evmAddress?: Address) {
    const observedBalanceAtomic = await this.queryBridgedBalance(initiaAddress);
    const claimedAtomic = this.readClaimedAtomic(initiaAddress);
    const claimableAtomic =
      observedBalanceAtomic > claimedAtomic ? observedBalanceAtomic - claimedAtomic : 0n;
    const mintableAtomic = scaleAtomic(
      claimableAtomic,
      this.deps.bridgedSourceDecimals,
      this.destinationToken.decimals
    );
    const claimedMintedAtomic = scaleAtomic(
      claimedAtomic,
      this.deps.bridgedSourceDecimals,
      this.destinationToken.decimals
    );
    const walletTokenBalanceAtomic = evmAddress
      ? await this.queryDestinationTokenBalance(evmAddress)
      : 0n;
    const redeemableAtomic = evmAddress
      ? walletTokenBalanceAtomic < claimedMintedAtomic
        ? walletTokenBalanceAtomic
        : claimedMintedAtomic
      : 0n;

    return {
      initiaAddress,
      evmAddress,
      bridgeDenom: this.deps.bridgedDenom,
      tokenSymbol: this.destinationToken.symbol,
      tokenAddress: this.destinationToken.address,
      tokenDecimals: this.destinationToken.decimals,
      observedBalanceAtomic: observedBalanceAtomic.toString(),
      claimedAtomic: claimedAtomic.toString(),
      claimableAtomic: claimableAtomic.toString(),
      mintableAtomic: mintableAtomic.toString(),
      claimedMintedAtomic: claimedMintedAtomic.toString(),
      walletTokenBalanceAtomic: walletTokenBalanceAtomic.toString(),
      redeemableAtomic: redeemableAtomic.toString()
    };
  }

  async claim(input: { initiaAddress: string; evmAddress: Address }) {
    const preview = await this.preview(input.initiaAddress, input.evmAddress);
    const claimableAtomic = BigInt(preview.claimableAtomic);
    if (claimableAtomic <= 0n) {
      throw new Error("No bridged INIT is available to claim as cINIT");
    }

    const mintableAtomic = BigInt(preview.mintableAtomic);
    if (mintableAtomic <= 0n) {
      throw new Error("Claimable bridged INIT rounds down to zero cINIT");
    }

    const matcherAccount = await this.assertMatcherCanMint();

    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "mint",
      args: [input.evmAddress, mintableAtomic],
    });
    const nonce = await this.deps.publicClient.getTransactionCount({
      address: matcherAccount.address,
    });
    const gas = await this.deps.publicClient.estimateGas({
      account: matcherAccount.address,
      to: this.destinationToken.address,
      data,
    });
    const gasPrice = await this.deps.publicClient.getGasPrice();
    if (!matcherAccount.signTransaction) {
      throw new Error("Matcher signer cannot sign raw transactions");
    }

    const serializedTransaction = await matcherAccount.signTransaction({
      chainId: this.deps.deployment.network.chainId,
      type: "legacy",
      to: this.destinationToken.address,
      data,
      nonce,
      gas,
      gasPrice,
      value: 0n,
    });
    const txHash = await this.deps.walletClient.sendRawTransaction({
      serializedTransaction,
    });

    await this.deps.publicClient.waitForTransactionReceipt({ hash: txHash });

    this.deps.store.mutate((state) => {
      const addressKey = keyOf(input.initiaAddress);
      state.bridgeClaims[addressKey] ??= {};
      const currentClaimed = BigInt(state.bridgeClaims[addressKey][this.deps.bridgedDenom] ?? "0");
      state.bridgeClaims[addressKey][this.deps.bridgedDenom] = (
        currentClaimed + claimableAtomic
      ).toString();
    });

    return {
      ...preview,
      evmAddress: input.evmAddress,
      txHash,
    };
  }

  async redeem(input: {
    initiaAddress: string;
    evmAddress: Address;
    amountAtomic: bigint;
  }) {
    if (input.amountAtomic <= 0n) {
      throw new Error("Redeem amount must be positive");
    }

    const precisionFactor = 10n ** BigInt(this.destinationToken.decimals - this.deps.bridgedSourceDecimals);
    if (input.amountAtomic % precisionFactor !== 0n) {
      throw new Error(
        `Redeem amount must align to ${this.deps.bridgedSourceDecimals} decimals of bridged INIT`
      );
    }

    const preview = await this.preview(input.initiaAddress, input.evmAddress);
    const redeemableAtomic = BigInt(preview.redeemableAtomic);
    if (input.amountAtomic > redeemableAtomic) {
      throw new Error(
        `Redeem amount exceeds the wallet-backed claimed ${this.destinationToken.symbol} available to unwrap`
      );
    }

    const releaseAtomic = scaleAtomic(
      input.amountAtomic,
      this.destinationToken.decimals,
      this.deps.bridgedSourceDecimals
    );
    const claimedAtomic = BigInt(preview.claimedAtomic);
    if (releaseAtomic > claimedAtomic) {
      throw new Error("Redeem amount exceeds the claimed bridged INIT tracked for this address");
    }

    const matcherAccount = await this.assertMatcherCanMint();
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "burn",
      args: [input.evmAddress, input.amountAtomic]
    });
    const nonce = await this.deps.publicClient.getTransactionCount({
      address: matcherAccount.address
    });
    const gas = await this.deps.publicClient.estimateGas({
      account: matcherAccount.address,
      to: this.destinationToken.address,
      data
    });
    const gasPrice = await this.deps.publicClient.getGasPrice();
    if (!matcherAccount.signTransaction) {
      throw new Error("Matcher signer cannot sign raw transactions");
    }

    const serializedTransaction = await matcherAccount.signTransaction({
      chainId: this.deps.deployment.network.chainId,
      type: "legacy",
      to: this.destinationToken.address,
      data,
      nonce,
      gas,
      gasPrice,
      value: 0n
    });
    const txHash = await this.deps.walletClient.sendRawTransaction({
      serializedTransaction
    });

    await this.deps.publicClient.waitForTransactionReceipt({ hash: txHash });

    this.deps.store.mutate((state) => {
      const addressKey = keyOf(input.initiaAddress);
      state.bridgeClaims[addressKey] ??= {};
      const currentClaimed = BigInt(state.bridgeClaims[addressKey][this.deps.bridgedDenom] ?? "0");
      state.bridgeClaims[addressKey][this.deps.bridgedDenom] = (
        currentClaimed - releaseAtomic
      ).toString();
    });

    const nextPreview = await this.preview(input.initiaAddress, input.evmAddress);

    return {
      ...nextPreview,
      evmAddress: input.evmAddress,
      releasedBridgeAtomic: releaseAtomic.toString(),
      burnedTokenAtomic: input.amountAtomic.toString(),
      txHash
    };
  }

  private async assertMatcherCanMint(): Promise<Account> {
    const matcherAccount = this.deps.walletClient.account;
    const matcherAddress = matcherAccount?.address;
    if (!matcherAddress || !matcherAccount) {
      throw new Error("Matcher signer is not configured");
    }

    const owner = await this.deps.publicClient.readContract({
      address: this.destinationToken.address,
      abi: erc20Abi,
      functionName: "owner",
    });

    if (!isAddressEqual(owner, matcherAddress)) {
      throw new Error(
        `Matcher is not the owner of ${this.destinationToken.symbol}. Current owner: ${owner}`
      );
    }

    return matcherAccount as Account;
  }

  private readClaimedAtomic(initiaAddress: string) {
    const claims = this.deps.store.get().bridgeClaims;
    return BigInt(claims[keyOf(initiaAddress)]?.[this.deps.bridgedDenom] ?? "0");
  }

  private async queryDestinationTokenBalance(evmAddress: Address) {
    return await this.deps.publicClient.readContract({
      address: this.destinationToken.address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [evmAddress]
    });
  }

  private async queryBridgedBalance(initiaAddress: string) {
    const byDenomUrl = `${this.deps.rollupRestUrl}/cosmos/bank/v1beta1/balances/${initiaAddress}/by_denom?denom=${encodeURIComponent(this.deps.bridgedDenom)}`;
    const response = await fetch(byDenomUrl);

    if (response.ok) {
      const payload = (await response.json()) as {
        balance?: {
          amount?: string;
        };
      };

      return BigInt(payload.balance?.amount ?? "0");
    }

    if (response.status === 404) {
      return 0n;
    }

    const allBalancesResponse = await fetch(
      `${this.deps.rollupRestUrl}/cosmos/bank/v1beta1/balances/${initiaAddress}`
    );

    if (!allBalancesResponse.ok) {
      if (allBalancesResponse.status === 404 || allBalancesResponse.status === 400) {
        return 0n;
      }

      throw new Error(
        `Unable to query bridged INIT balance: HTTP ${response.status} / fallback ${allBalancesResponse.status}`
      );
    }

    const allBalancesPayload = (await allBalancesResponse.json()) as {
      balances?: Array<{
        denom?: string;
        amount?: string;
      }>;
    };
    const match = allBalancesPayload.balances?.find(
      (item) => item.denom?.toLowerCase() === this.deps.bridgedDenom.toLowerCase()
    );

    return BigInt(match?.amount ?? "0");
  }
}
