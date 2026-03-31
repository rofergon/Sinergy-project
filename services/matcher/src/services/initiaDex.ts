import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import { RESTClient, bcs, MnemonicKey, MsgExecute, Wallet } from "@initia/initia.js";
import type { CanonicalAssetConfig, RouterMarketConfig } from "../types.js";

const execFile = promisify(execFileCallback);

type InitiaDexClientDeps = {
  restUrl: string;
  rpcUrl: string;
  chainId: string;
  gasPrices: string;
  gasAdjustment: string;
  mnemonic?: string;
  keyName?: string;
  keyringBackend?: string;
  keyringHome?: string;
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
  private readonly cliSigner?: {
    keyName: string;
    keyringBackend: string;
    keyringHome: string;
  };
  private readonly metadataByDenom = new Map<string, string>();
  private cliSignerAddress?: string;

  constructor(private readonly deps: InitiaDexClientDeps) {
    this.restClient = new RESTClient(deps.restUrl, {
      gasPrices: deps.gasPrices,
      gasAdjustment: deps.gasAdjustment
    });

    if (deps.mnemonic) {
      const key = new MnemonicKey({ mnemonic: deps.mnemonic });
      this.wallet = new Wallet(this.restClient, key);
    } else if (deps.keyName && deps.keyringBackend && deps.keyringHome) {
      this.cliSigner = {
        keyName: deps.keyName,
        keyringBackend: deps.keyringBackend,
        keyringHome: deps.keyringHome
      };
    }
  }

  get canSubmitTransactions() {
    return Boolean(this.wallet || this.cliSigner);
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
    if (this.wallet) {
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

    if (!this.cliSigner) {
      throw new Error("L1 router signer not configured");
    }

    const pairObjectId = this.resolvePairObjectId(input.market);
    const metadataObjectId = await this.resolveMetadataObjectId(input.offerAsset);
    await this.assertCliSignerHasBalance(
      input.offerAsset.bridgeDenom,
      input.offerAmountAtomic,
      input.offerAsset.l1Symbol
    );
    const args = JSON.stringify([
      `raw_base64:${bcs.object().serialize(pairObjectId).toBase64()}`,
      `raw_base64:${bcs.object().serialize(metadataObjectId).toBase64()}`,
      `raw_base64:${bcs.u64().serialize(input.offerAmountAtomic).toBase64()}`,
      `raw_base64:${bcs.option(bcs.u64()).serialize(input.minOutAtomic).toBase64()}`
    ]);

    try {
      const { stdout, stderr } = await execFile("initiad", [
        "tx",
        "move",
        "execute",
        "0x1",
        "dex",
        "swap_script",
        "--args",
        args,
        "--from",
        this.cliSigner.keyName,
        "--home",
        this.cliSigner.keyringHome,
        "--keyring-backend",
        this.cliSigner.keyringBackend,
        "--chain-id",
        this.deps.chainId,
        "--node",
        this.deps.rpcUrl,
        "--gas",
        "auto",
        "--gas-adjustment",
        this.deps.gasAdjustment,
        "--gas-prices",
        this.deps.gasPrices,
        "--broadcast-mode",
        "sync",
        "--yes",
        "--output",
        "json"
      ]);

      const parsed = JSON.parse(stdout);
      const txHash = parsed.txhash ?? parsed.tx_response?.txhash;
      if (!txHash) {
        throw new Error(
          `Missing txhash in initiad response${stderr ? `: ${stderr.trim()}` : ""}`
        );
      }

      return { txHash };
    } catch (error) {
      const stderr =
        error && typeof error === "object" && "stderr" in error
          ? String((error as { stderr?: unknown }).stderr ?? "").trim()
          : "";
      const stdout =
        error && typeof error === "object" && "stdout" in error
          ? String((error as { stdout?: unknown }).stdout ?? "").trim()
          : "";
      const details = [stderr, stdout].filter(Boolean).join(" | ");
      throw new Error(
        details ? `initiad swap execution failed: ${details}` : "initiad swap execution failed"
      );
    }
  }

  private async assertCliSignerHasBalance(
    denom: string,
    requiredAmountAtomic: bigint,
    symbol: string
  ) {
    if (!this.cliSigner) {
      return;
    }

    const signerAddress = await this.getCliSignerAddress();
    const { stdout } = await execFile("initiad", [
      "query",
      "bank",
      "balances",
      signerAddress,
      "--node",
      this.deps.rpcUrl,
      "--output",
      "json"
    ]);
    const parsed = JSON.parse(stdout) as {
      balances?: Array<{ denom?: string; amount?: string }>;
    };
    const available = BigInt(
      parsed.balances?.find((coin) => coin.denom === denom)?.amount ?? "0"
    );

    if (available < requiredAmountAtomic) {
      throw new Error(
        `L1 signer ${signerAddress} has ${available.toString()} ${denom} but needs ${requiredAmountAtomic.toString()} for ${symbol} swap; bridge-out inventory is not funded on L1 yet`
      );
    }
  }

  private async getCliSignerAddress() {
    if (this.cliSignerAddress) {
      return this.cliSignerAddress;
    }

    const { stdout } = await execFile("initiad", [
      "keys",
      "show",
      this.cliSigner!.keyName,
      "-a",
      "--home",
      this.cliSigner!.keyringHome,
      "--keyring-backend",
      this.cliSigner!.keyringBackend
    ]);
    this.cliSignerAddress = stdout.trim();
    return this.cliSignerAddress;
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
