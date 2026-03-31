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
    const response = await this.restClient.move.view(
      "0x1",
      "dex",
      "get_swap_simulation",
      [],
      [
        bcs.object().serialize(input.market.pairObjectId).toBase64(),
        bcs.object().serialize(input.offerAsset.metadataObjectId).toBase64(),
        bcs.u64().serialize(input.offerAmountAtomic).toBase64()
      ]
    );

    return this.parseViewAmount(response.data);
  }

  async executeSwap(input: ExecuteSwapInput): Promise<{ txHash: string }> {
    if (!this.wallet) {
      throw new Error("L1 router mnemonic not configured");
    }

    const key = this.wallet.key;
    const msgs = [
      new MsgExecute(
        key.accAddress,
        "0x1",
        "dex",
        "swap_script",
        [],
        [
          bcs.object().serialize(input.market.pairObjectId),
          bcs.object().serialize(input.offerAsset.metadataObjectId),
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
}
