import { RESTClient, bcs, MnemonicKey, MsgExecute, Wallet } from "@initia/initia.js";
import type { CanonicalAssetConfig, RouterMarketConfig } from "../types.js";

type InitiaDexClientDeps = {
  restUrl: string;
  chainId: string;
  gasPrices: string;
  gasAdjustment: string;
  mnemonic?: string;
};

type SimulateSwapInput = {
  market: RouterMarketConfig;
  offerAsset: CanonicalAssetConfig;
  offerAmountAtomic: bigint;
};

type ExecuteSwapInput = {
  market: RouterMarketConfig;
  offerAsset: CanonicalAssetConfig;
  offerAmountAtomic: bigint;
  minOutAtomic: bigint;
};

export class InitiaDexClient {
  private readonly restClient: RESTClient;
  private readonly wallet?: Wallet;
  private readonly metadataByDenom = new Map<string, string>();

  constructor(private readonly deps: InitiaDexClientDeps) {
    this.restClient = new RESTClient(deps.restUrl, {
      gasPrices: deps.gasPrices,
      gasAdjustment: deps.gasAdjustment
    });

    if (deps.mnemonic) {
      const key = new MnemonicKey({ mnemonic: deps.mnemonic });
      this.wallet = new Wallet(this.restClient, key);
    }
  }

  get canSubmitTransactions() {
    return Boolean(this.wallet);
  }

  async simulateSwap(input: SimulateSwapInput): Promise<bigint> {
    const pairObjectId = this.resolvePairObjectId(input.market);
    const metadataObjectId = await this.resolveMetadataObjectId(input.offerAsset);
    const response = await this.restClient.move.view(
      "0x1",
      "dex",
      "get_swap_simulation",
      [],
      [
        bcs.object().serialize(pairObjectId).toBase64(),
        bcs.object().serialize(metadataObjectId).toBase64(),
        bcs.u64().serialize(input.offerAmountAtomic).toBase64()
      ]
    );

    return this.parseViewAmount(response.data);
  }

  async executeSwap(input: ExecuteSwapInput): Promise<{ txHash: string }> {
    if (!this.wallet) {
      throw new Error("L1 router mnemonic not configured");
    }

    const pairObjectId = this.resolvePairObjectId(input.market);
    const metadataObjectId = await this.resolveMetadataObjectId(input.offerAsset);
    const key = this.wallet.key;
    const msgs = [
      new MsgExecute(
        key.accAddress,
        "0x1",
        "dex",
        "swap_script",
        [],
        [
          bcs.object().serialize(pairObjectId),
          bcs.object().serialize(metadataObjectId),
          bcs.u64().serialize(input.offerAmountAtomic),
          bcs.option(bcs.u64()).serialize(input.minOutAtomic)
        ].map((value) => value.toBase64())
      )
    ];

    const signedTx = await this.wallet.createAndSignTx({ msgs });
    const result = await this.restClient.tx.broadcastSync(signedTx);
    return { txHash: result.txhash };
  }

  private parseViewAmount(value: unknown): bigint {
    if (typeof value === "string") {
      return BigInt(value.replace(/"/g, ""));
    }

    if (typeof value === "number" || typeof value === "bigint") {
      return BigInt(value);
    }

    if (Array.isArray(value) && value.length > 0) {
      return this.parseViewAmount(value[0]);
    }

    if (value && typeof value === "object" && "data" in value) {
      return this.parseViewAmount((value as { data: unknown }).data);
    }

    throw new Error(`Unsupported InitiaDEX simulation response: ${JSON.stringify(value)}`);
  }

  private parseViewAddress(value: unknown): string {
    if (typeof value === "string") {
      return value.replace(/"/g, "");
    }

    if (Array.isArray(value) && value.length > 0) {
      return this.parseViewAddress(value[0]);
    }

    if (value && typeof value === "object" && "data" in value) {
      return this.parseViewAddress((value as { data: unknown }).data);
    }

    throw new Error(`Unsupported Initia metadata response: ${JSON.stringify(value)}`);
  }

  private resolvePairObjectId(market: RouterMarketConfig): string {
    if (market.pairObjectId) {
      return market.pairObjectId;
    }

    if (!market.pairDenom.startsWith("move/")) {
      throw new Error(`Cannot derive pair object id from denom: ${market.pairDenom}`);
    }

    return `0x${market.pairDenom.slice("move/".length)}`;
  }

  private async resolveMetadataObjectId(asset: CanonicalAssetConfig): Promise<string> {
    if (asset.metadataObjectId) {
      return asset.metadataObjectId;
    }

    const cacheKey = asset.bridgeDenom.toLowerCase();
    const cached = this.metadataByDenom.get(cacheKey);
    if (cached) {
      return cached;
    }

    const response = await this.restClient.move.view(
      "0x1",
      "coin",
      "denom_to_metadata",
      [],
      [bcs.string().serialize(asset.bridgeDenom).toBase64()]
    );
    const metadata = this.parseViewAddress(response.data);
    this.metadataByDenom.set(cacheKey, metadata);
    return metadata;
  }
}
