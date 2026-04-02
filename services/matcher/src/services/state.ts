import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AppState } from "../types.js";

const EMPTY_STATE: AppState = {
  balances: {},
  locked: {},
  bridgeClaims: {},
  orders: [],
  processedDeposits: [],
  processedWithdrawals: [],
  pendingWithdrawals: [],
  withdrawalNonces: {},
  routerInventory: {},
  swapJobs: [],
  rebalanceJobs: []
};

export class StateStore {
  private readonly filePath: string;
  private state: AppState;

  constructor(filePath = resolve(process.cwd(), "data/state.json")) {
    this.filePath = filePath;
    this.state = this.load();
  }

  get(): AppState {
    return this.state;
  }

  mutate<T>(updater: (draft: AppState) => T): T {
    const result = updater(this.state);
    this.flush();
    return result;
  }

  async mutateAsync<T>(updater: (draft: AppState) => Promise<T>): Promise<T> {
    const result = await updater(this.state);
    this.flush();
    return result;
  }

  private load(): AppState {
    if (!existsSync(this.filePath)) {
      writeFileSync(this.filePath, JSON.stringify(EMPTY_STATE, null, 2), "utf8");
      return structuredClone(EMPTY_STATE);
    }

    return {
      ...EMPTY_STATE,
      ...JSON.parse(readFileSync(this.filePath, "utf8"))
    } as AppState;
  }

  private flush(): void {
    writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf8");
  }
}
