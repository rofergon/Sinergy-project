import { setTimeout as delay } from "node:timers/promises";
import type { ResolvedMarket } from "../types.js";
import { InitiaDexClient } from "./initiaDex.js";
import { InventoryService } from "./inventory.js";
import { BridgeHealthService } from "./bridgeHealth.js";
import { scaleAtomic } from "./routerUtils.js";

type WorkerDeps = {
  inventoryService: InventoryService;
  bridgeHealthService: BridgeHealthService;
  initiaDexClient: InitiaDexClient;
  intervalMs: number;
  markets: ResolvedMarket[];
};

export class RebalanceWorker {
  private started = false;

  constructor(private readonly deps: WorkerDeps) {}

  start() {
    if (this.started) return;
    this.started = true;
    void this.loop();
  }

  private async loop() {
    while (this.started) {
      try {
        await this.tick();
      } catch (error) {
        console.error("[router] rebalance worker error:", error);
      }

      await delay(this.deps.intervalMs);
    }
  }

  private async tick() {
    const { rebalances } = this.deps.inventoryService.listJobs();
    const next = rebalances.find((job) =>
      ["queued", "bridging_out", "bridging_in", "l1_swap", "settling_back"].includes(job.state)
    );

    if (!next) return;

    const bridge = await this.deps.bridgeHealthService.getStatus();
    if (!bridge.ready) {
      this.fail(next.id, next.linkedSwapJobId, "Bridge infrastructure is not healthy");
      return;
    }

    if (next.linkedSwapJobId) {
      this.deps.inventoryService.markSwapState(next.linkedSwapJobId, next.state);
    }

    if (next.state === "queued") {
      this.advance(next.id, "bridging_out", next.linkedSwapJobId);
      return;
    }

    if (next.state === "bridging_out") {
      this.advance(next.id, "l1_swap", next.linkedSwapJobId);
      return;
    }

    if (next.state === "l1_swap") {
      if (!this.deps.initiaDexClient.canSubmitTransactions) {
        this.fail(next.id, next.linkedSwapJobId, "L1 router mnemonic not configured");
        return;
      }

      try {
        const market = this.deps.markets.find((item) => item.id === next.marketId);
        if (!market) {
          this.fail(next.id, next.linkedSwapJobId, "Rebalance market not found");
          return;
        }

        const routeConfig = this.deps.inventoryService.getRouteConfigForMarket(market);
        if (!routeConfig) {
          this.fail(next.id, next.linkedSwapJobId, "Rebalance market is not routeable");
          return;
        }

        const offerAsset =
          next.inputSymbol === routeConfig.baseAsset.localSymbol
            ? routeConfig.baseAsset
            : routeConfig.quoteAsset;
        const returnAsset =
          next.outputSymbol === routeConfig.baseAsset.localSymbol
            ? routeConfig.baseAsset
            : routeConfig.quoteAsset;
        const inputToken =
          market.baseToken.symbol === next.inputSymbol ? market.baseToken : market.quoteToken;
        const outputToken =
          market.baseToken.symbol === next.outputSymbol ? market.baseToken : market.quoteToken;
        const result = await this.deps.initiaDexClient.executeSwap({
          market: routeConfig.market,
          offerAsset,
          offerAmountAtomic: scaleAtomic(
            BigInt(next.amountInAtomic),
            inputToken.decimals,
            offerAsset.l1Decimals
          ),
          minOutAtomic: scaleAtomic(
            BigInt(next.minAmountOutAtomic),
            outputToken.decimals,
            returnAsset.l1Decimals
          )
        });

        this.deps.inventoryService.updateRebalanceJob(next.id, (job) => {
          job.state = "settling_back";
          job.l1TxHash = result.txHash;
        });
        if (next.linkedSwapJobId) {
          this.deps.inventoryService.markSwapState(next.linkedSwapJobId, "settling_back");
        }
      } catch (error) {
        this.fail(
          next.id,
          next.linkedSwapJobId,
          error instanceof Error ? error.message : String(error)
        );
      }
      return;
    }

    if (next.state === "settling_back") {
      this.deps.inventoryService.settleRebalanceInventory(next.id);
      if (next.linkedSwapJobId) {
        this.deps.inventoryService.settleAsyncSwap(
          next.linkedSwapJobId,
          BigInt(next.minAmountOutAtomic)
        );
      }
    }
  }

  private advance(
    jobId: string,
    state: "bridging_out" | "l1_swap" | "settling_back",
    linkedSwapJobId?: string
  ) {
    this.deps.inventoryService.updateRebalanceJob(jobId, (job) => {
      job.state = state;
    });

    if (linkedSwapJobId) {
      this.deps.inventoryService.markSwapState(linkedSwapJobId, state);
    }
  }

  private fail(jobId: string, linkedSwapJobId: string | undefined, message: string) {
    this.deps.inventoryService.updateRebalanceJob(jobId, (job) => {
      job.state = "failed";
      job.error = message;
    });

    if (linkedSwapJobId) {
      this.deps.inventoryService.failSwap(linkedSwapJobId, message);
    }
  }
}
