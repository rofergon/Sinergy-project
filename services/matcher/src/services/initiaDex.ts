import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
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
  gasStationKeyName?: string;
  gasStationKeyringBackend?: string;
  gasStationKeyringHome?: string;
};

type SimulateSwapInput = {
  market: RouterMarketConfig;
  offerAsset: CanonicalAssetConfig;
  offerAmountAtomic: bigint;
};

type ExecuteSwapInput = {
  market: RouterMarketConfig;
  offerAsset: CanonicalAssetConfig;
  returnAsset: CanonicalAssetConfig;
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

  async executeSwap(
    input: ExecuteSwapInput
  ): Promise<{ txHash: string; returnAmountAtomic?: bigint }> {
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
            // `Some(min_out)` currently aborts on the live Initia DEX path for this pool.
            // We use `None` and read the actual filled amount from `SwapEvent`.
            bcs.option(bcs.u64()).serialize(undefined)
          ].map((value) => value.toBase64())
        )
      ];

      const signedTx = await this.wallet.createAndSignTx({ msgs });
      const result = await this.restClient.tx.broadcastSync(signedTx);
      return this.enrichSwapResult(result.txhash);
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
      `object:${pairObjectId}`,
      `object:${metadataObjectId}`,
      `u64:${input.offerAmountAtomic.toString()}`,
      // The CLI path accepts typed args here, while `raw_base64` aborts for this pool.
      // `Some(min_out)` also aborts on-chain, so we use `None` and read `SwapEvent`.
      "option<u64>:null"
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

      return this.enrichSwapResult(txHash);
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

  private async enrichSwapResult(txHash: string) {
    const returnAmountAtomic = await this.waitForSwapReturnAmount(txHash);
    return { txHash, returnAmountAtomic };
  }

  private async waitForSwapReturnAmount(txHash: string) {
    const normalizedHash = txHash.toUpperCase();
    const baseUrl = this.deps.restUrl.replace(/\/+$/, "");

    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const response = await fetch(`${baseUrl}/cosmos/tx/v1beta1/txs/${normalizedHash}`);
        if (response.ok) {
          const parsed = (await response.json()) as {
            tx_response?: {
              code?: number;
              raw_log?: string;
              events?: Array<{
                type?: string;
                attributes?: Array<{ key?: string; value?: string }>;
              }>;
            };
          };

          const code = parsed.tx_response?.code ?? 0;
          if (code !== 0) {
            throw new Error(parsed.tx_response?.raw_log || `Swap tx failed with code ${code}`);
          }

          const returnAmount = parsed.tx_response?.events
            ?.filter((event) => event.type === "move")
            .flatMap((event) => event.attributes ?? [])
            .find((attribute) => attribute.key === "return_amount")?.value;

          if (returnAmount) {
            return BigInt(returnAmount);
          }

          return undefined;
        }
      } catch {
        // The tx index can lag behind broadcast sync for a few seconds.
      }

      await delay(1_000);
    }

    return undefined;
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
    const available = await this.queryL1Balance(signerAddress, denom);

    if (available >= requiredAmountAtomic) {
      return;
    }

    // Attempt auto-fund from gas-station
    const funded = await this.autoFundFromGasStation(
      signerAddress,
      denom,
      requiredAmountAtomic,
      available
    );

    if (!funded) {
      throw new Error(
        `L1 signer ${signerAddress} has ${available.toString()} ${denom} but needs ${requiredAmountAtomic.toString()} for ${symbol} swap; bridge-out inventory is not funded on L1 yet`
      );
    }
  }

  private async queryL1Balance(address: string, denom: string): Promise<bigint> {
    const { stdout } = await execFile("initiad", [
      "query",
      "bank",
      "balances",
      address,
      "--node",
      this.deps.rpcUrl,
      "--output",
      "json"
    ]);
    const parsed = JSON.parse(stdout) as {
      balances?: Array<{ denom?: string; amount?: string }>;
    };
    return BigInt(
      parsed.balances?.find((coin) => coin.denom === denom)?.amount ?? "0"
    );
  }

  private async autoFundFromGasStation(
    recipientAddress: string,
    denom: string,
    requiredAmountAtomic: bigint,
    currentBalance: bigint
  ): Promise<boolean> {
    const gsKeyName = this.deps.gasStationKeyName;
    const gsKeyringBackend = this.deps.gasStationKeyringBackend;
    const gsKeyringHome = this.deps.gasStationKeyringHome;

    if (!gsKeyName || !gsKeyringBackend || !gsKeyringHome) {
      console.warn(
        "[router] Gas-station L1 auto-fund is not configured. Set L1_GAS_STATION_KEY_NAME, L1_GAS_STATION_KEYRING_BACKEND, L1_GAS_STATION_KEYRING_HOME."
      );
      return false;
    }

    // Request 2x the deficit to reduce the frequency of auto-fund txs
    const deficit = requiredAmountAtomic - currentBalance;
    const transferAmount = deficit * 2n;

    // Check gas-station balance first
    let gsAddress: string;
    try {
      const { stdout } = await execFile("initiad", [
        "keys",
        "show",
        gsKeyName,
        "-a",
        "--home",
        gsKeyringHome,
        "--keyring-backend",
        gsKeyringBackend
      ]);
      gsAddress = stdout.trim();
    } catch {
      console.warn("[router] Failed to resolve gas-station address on L1");
      return false;
    }

    const gsBalance = await this.queryL1Balance(gsAddress, denom);
    if (gsBalance < transferAmount) {
      console.warn(
        `[router] Gas-station ${gsAddress} has ${gsBalance.toString()} ${denom} ` +
        `but needs ${transferAmount.toString()} to auto-fund L1 signer. ` +
        `Please fund the gas-station on L1 from the Initia faucet (https://faucet.testnet.initia.xyz/).`
      );
      return false;
    }

    const coins = `${transferAmount.toString()}${denom}`;

    console.log(
      `[router] Auto-funding L1 signer ${recipientAddress} with ${coins} from gas-station ${gsAddress}`
    );

    try {
      await execFile("initiad", [
        "tx",
        "bank",
        "send",
        gsKeyName,
        recipientAddress,
        coins,
        "--from",
        gsKeyName,
        "--home",
        gsKeyringHome,
        "--keyring-backend",
        gsKeyringBackend,
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

      // Wait for tx to be included
      await delay(5_000);

      // Verify the transfer succeeded
      const newBalance = await this.queryL1Balance(recipientAddress, denom);
      if (newBalance >= requiredAmountAtomic) {
        console.log(
          `[router] Auto-fund successful. L1 signer now has ${newBalance.toString()} ${denom}`
        );
        return true;
      }

      console.warn(
        `[router] Auto-fund tx sent but balance still insufficient (${newBalance.toString()} ${denom}). ` +
        `May need more time to confirm.`
      );
      // Give another few seconds for block finalization
      await delay(5_000);
      const retryBalance = await this.queryL1Balance(recipientAddress, denom);
      return retryBalance >= requiredAmountAtomic;
    } catch (error) {
      console.error(
        "[router] Auto-fund from gas-station failed:",
        error instanceof Error ? error.message : String(error)
      );
      return false;
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
