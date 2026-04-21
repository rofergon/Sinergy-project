import type { HexString } from "@sinergy/shared";
import { StrategyExecutionService } from "./strategyExecution.js";
import { StrategyService } from "./strategyService.js";

type AutoStrategyWorkerDeps = {
  strategyService: StrategyService;
  executionService: StrategyExecutionService;
  intervalMs: number;
};

export class AutoStrategyWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: AutoStrategyWorkerDeps) {}

  start() {
    if (this.timer) {
      return;
    }

    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.deps.intervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick() {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      const activeStrategies = this.deps.strategyService.listActiveAutoExecutions();
      for (const item of activeStrategies) {
        await this.processStrategy(item.strategyId, item.ownerAddress);
      }
    } finally {
      this.running = false;
    }
  }

  private async processStrategy(strategyId: string, ownerAddress: HexString) {
    const autoState = this.deps.strategyService.getAutoExecutionState(strategyId, ownerAddress);
    if (autoState.status !== "active") {
      return;
    }

    try {
      const inspection = this.deps.executionService.inspectApprovedStrategy({
        ownerAddress,
        strategyId
      });
      const now = new Date().toISOString();
      const lastCandleTs = inspection.lastCandleTs;

      if (autoState.mode === "until_timestamp" && autoState.expiresAt) {
        const expiresAtMs = Date.parse(autoState.expiresAt);
        if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
          this.deps.strategyService.markAutoExecutionEvaluation({
            ownerAddress,
            strategyId,
            status: "expired",
            lastCheckedAt: now,
            lastCheckedCandleTs: lastCandleTs,
            lastSignal: inspection.signal,
            lastError: null
          });
          return;
        }
      }

      if (
        lastCandleTs !== undefined &&
        autoState.lastCheckedCandleTs === lastCandleTs &&
        autoState.lastSignal === inspection.signal
      ) {
        return;
      }

      if (
        inspection.signal !== "none" &&
        lastCandleTs !== undefined &&
        autoState.lastExecutedCandleTs === lastCandleTs &&
        autoState.lastSignal === inspection.signal
      ) {
        this.deps.strategyService.markAutoExecutionEvaluation({
          ownerAddress,
          strategyId,
          lastCheckedAt: now,
          lastCheckedCandleTs: lastCandleTs,
          lastSignal: inspection.signal,
          lastError: null
        });
        return;
      }

      const result = await this.deps.executionService.executeApprovedStrategy({
        ownerAddress,
        strategyId,
        consumeApproval: false
      });
      if (!result) {
        throw new Error("Live strategy execution returned no result.");
      }

      this.deps.strategyService.markAutoExecutionEvaluation({
        ownerAddress,
        strategyId,
        lastCheckedAt: now,
        lastCheckedCandleTs: lastCandleTs,
        lastExecutedAt: result.action === "no_action" ? autoState.lastExecutedAt : now,
        lastExecutedCandleTs: result.action === "no_action" ? autoState.lastExecutedCandleTs : result.candleTs,
        lastSignal: inspection.signal,
        lastExecutionId: result.executionId,
        lastError: null
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const needsReactivation =
        /approval/i.test(message) ||
        /expired/i.test(message) ||
        /stale/i.test(message) ||
        /reactivate/i.test(message);

      this.deps.strategyService.markAutoExecutionEvaluation({
        ownerAddress,
        strategyId,
        status: needsReactivation ? "needs_reactivation" : undefined,
        lastCheckedAt: new Date().toISOString(),
        lastError: message
      });
    }
  }
}
