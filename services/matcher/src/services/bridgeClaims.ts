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
  rollupRestUrl: string;
};

export class BridgeClaimService {
  private readonly bridgeTokens: Map<
    string,
    ResolvedToken & {
      bridge: NonNullable<ResolvedToken["bridge"]>;
    }
  >;

  constructor(private readonly deps: BridgeClaimDeps) {
    this.bridgeTokens = new Map(
      Array.from(deps.tokens.values())
        .filter(
          (item): item is ResolvedToken & { bridge: NonNullable<ResolvedToken["bridge"]> } =>
            Boolean(item.bridge)
        )
        .map((item) => [keyOf(item.symbol), item])
    );

    if (this.bridgeTokens.size === 0) {
      throw new Error("No bridge-backed tokens are configured in deployment");
    }
  }

  listAssets() {
    return Array.from(this.bridgeTokens.values()).map((token) => ({
      tokenSymbol: token.symbol,
      tokenName: token.name,
      tokenAddress: token.address,
      tokenDecimals: token.decimals,
      sourceChainId: token.bridge.sourceChainId ?? this.deps.deployment.network.l1ChainId,
      sourceDenom: token.bridge.sourceDenom,
      sourceSymbol: token.bridge.sourceSymbol,
      sourceDecimals: token.bridge.sourceDecimals,
      destinationDenom: token.bridge.destinationDenom
    }));
  }

  async preview(input: { tokenSymbol?: string; initiaAddress: string; evmAddress?: Address }) {
    const destinationToken = this.resolveBridgeToken(input.tokenSymbol);
    const bridge = destinationToken.bridge;
    const observedBalanceAtomic = await this.queryBridgedBalance(
      input.initiaAddress,
      bridge.destinationDenom
    );
    const claimedAtomic = this.readClaimedAtomic(input.initiaAddress, bridge.destinationDenom);
    const claimableAtomic =
      observedBalanceAtomic > claimedAtomic ? observedBalanceAtomic - claimedAtomic : 0n;
    const mintableAtomic = scaleAtomic(
      claimableAtomic,
      bridge.sourceDecimals,
      destinationToken.decimals
    );
    const claimedMintedAtomic = scaleAtomic(
      claimedAtomic,
      bridge.sourceDecimals,
      destinationToken.decimals
    );
    const walletTokenBalanceAtomic = input.evmAddress
      ? await this.queryDestinationTokenBalance(destinationToken.address, input.evmAddress)
      : 0n;
    const redeemableAtomic = input.evmAddress
      ? walletTokenBalanceAtomic < claimedMintedAtomic
        ? walletTokenBalanceAtomic
        : claimedMintedAtomic
      : 0n;

    return {
      tokenSymbol: destinationToken.symbol,
      tokenName: destinationToken.name,
      tokenAddress: destinationToken.address,
      tokenDecimals: destinationToken.decimals,
      sourceChainId: bridge.sourceChainId ?? this.deps.deployment.network.l1ChainId,
      sourceDenom: bridge.sourceDenom,
      sourceSymbol: bridge.sourceSymbol,
      sourceDecimals: bridge.sourceDecimals,
      destinationDenom: bridge.destinationDenom,
      initiaAddress: input.initiaAddress,
      evmAddress: input.evmAddress,
      observedBalanceAtomic: observedBalanceAtomic.toString(),
      claimedAtomic: claimedAtomic.toString(),
      claimableAtomic: claimableAtomic.toString(),
      mintableAtomic: mintableAtomic.toString(),
      claimedMintedAtomic: claimedMintedAtomic.toString(),
      walletTokenBalanceAtomic: walletTokenBalanceAtomic.toString(),
      redeemableAtomic: redeemableAtomic.toString()
    };
  }

  async claim(input: { tokenSymbol?: string; initiaAddress: string; evmAddress: Address }) {
    const preview = await this.preview(input);
    const claimableAtomic = BigInt(preview.claimableAtomic);
    if (claimableAtomic <= 0n) {
      throw new Error(`No bridged ${preview.sourceSymbol} is available to claim as ${preview.tokenSymbol}`);
    }

    const mintableAtomic = BigInt(preview.mintableAtomic);
    if (mintableAtomic <= 0n) {
      throw new Error(`Claimable bridged ${preview.sourceSymbol} rounds down to zero ${preview.tokenSymbol}`);
    }

    const matcherAccount = await this.assertMatcherCanMint(preview.tokenAddress, preview.tokenSymbol);

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
      to: preview.tokenAddress,
      data,
    });
    const gasPrice = await this.deps.publicClient.getGasPrice();
    if (!matcherAccount.signTransaction) {
      throw new Error("Matcher signer cannot sign raw transactions");
    }

    const serializedTransaction = await matcherAccount.signTransaction({
      chainId: this.deps.deployment.network.chainId,
      type: "legacy",
      to: preview.tokenAddress,
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
      const currentClaimed = BigInt(state.bridgeClaims[addressKey][preview.destinationDenom] ?? "0");
      state.bridgeClaims[addressKey][preview.destinationDenom] = (
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
    tokenSymbol?: string;
    initiaAddress: string;
    evmAddress: Address;
    amountAtomic: bigint;
  }) {
    if (input.amountAtomic <= 0n) {
      throw new Error("Redeem amount must be positive");
    }

    const preview = await this.preview(input);
    const precisionFactor = 10n ** BigInt(preview.tokenDecimals - preview.sourceDecimals);
    if (input.amountAtomic % precisionFactor !== 0n) {
      throw new Error(
        `Redeem amount must align to ${preview.sourceDecimals} decimals of bridged ${preview.sourceSymbol}`
      );
    }

    const redeemableAtomic = BigInt(preview.redeemableAtomic);
    if (input.amountAtomic > redeemableAtomic) {
      throw new Error(
        `Redeem amount exceeds the wallet-backed claimed ${preview.tokenSymbol} available to unwrap`
      );
    }

    const releaseAtomic = scaleAtomic(
      input.amountAtomic,
      preview.tokenDecimals,
      preview.sourceDecimals
    );
    const claimedAtomic = BigInt(preview.claimedAtomic);
    if (releaseAtomic > claimedAtomic) {
      throw new Error(
        `Redeem amount exceeds the claimed bridged ${preview.sourceSymbol} tracked for this address`
      );
    }

    const matcherAccount = await this.assertMatcherCanMint(preview.tokenAddress, preview.tokenSymbol);
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
      to: preview.tokenAddress,
      data
    });
    const gasPrice = await this.deps.publicClient.getGasPrice();
    if (!matcherAccount.signTransaction) {
      throw new Error("Matcher signer cannot sign raw transactions");
    }

    const serializedTransaction = await matcherAccount.signTransaction({
      chainId: this.deps.deployment.network.chainId,
      type: "legacy",
      to: preview.tokenAddress,
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
      const currentClaimed = BigInt(state.bridgeClaims[addressKey][preview.destinationDenom] ?? "0");
      state.bridgeClaims[addressKey][preview.destinationDenom] = (
        currentClaimed - releaseAtomic
      ).toString();
    });

    const nextPreview = await this.preview(input);

    return {
      ...nextPreview,
      evmAddress: input.evmAddress,
      releasedBridgeAtomic: releaseAtomic.toString(),
      burnedTokenAtomic: input.amountAtomic.toString(),
      txHash
    };
  }

  private async assertMatcherCanMint(tokenAddress: Address, tokenSymbol: string): Promise<Account> {
    const matcherAccount = this.deps.walletClient.account;
    const matcherAddress = matcherAccount?.address;
    if (!matcherAddress || !matcherAccount) {
      throw new Error("Matcher signer is not configured");
    }

    const owner = await this.deps.publicClient.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "owner",
    });

    if (!isAddressEqual(owner, matcherAddress)) {
      throw new Error(
        `Matcher is not the owner of ${tokenSymbol}. Current owner: ${owner}`
      );
    }

    return matcherAccount as Account;
  }

  private readClaimedAtomic(initiaAddress: string, destinationDenom: string) {
    const claims = this.deps.store.get().bridgeClaims;
    return BigInt(claims[keyOf(initiaAddress)]?.[destinationDenom] ?? "0");
  }

  private async queryDestinationTokenBalance(tokenAddress: Address, evmAddress: Address) {
    return await this.deps.publicClient.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [evmAddress]
    });
  }

  private async queryBridgedBalance(initiaAddress: string, destinationDenom: string) {
    const byDenomUrl = `${this.deps.rollupRestUrl}/cosmos/bank/v1beta1/balances/${initiaAddress}/by_denom?denom=${encodeURIComponent(destinationDenom)}`;
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
      (item) => item.denom?.toLowerCase() === destinationDenom.toLowerCase()
    );

    return BigInt(match?.amount ?? "0");
  }

  private resolveBridgeToken(tokenSymbol?: string) {
    const resolved = tokenSymbol
      ? this.bridgeTokens.get(keyOf(tokenSymbol))
      : Array.from(this.bridgeTokens.values())[0];
    if (!resolved) {
      throw new Error(`Bridge-backed token ${tokenSymbol ?? "(default)"} is not configured`);
    }

    return resolved;
  }
}
