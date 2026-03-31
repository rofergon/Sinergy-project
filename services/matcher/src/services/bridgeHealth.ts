import type { BridgeHealth } from "../types.js";
import { nowIso } from "./routerUtils.js";

type HealthDeps = {
  relayerHealthUrl?: string;
  opinitHealthUrl?: string;
};

export class BridgeHealthService {
  constructor(private readonly deps: HealthDeps) {}

  async getStatus(): Promise<BridgeHealth> {
    const details: string[] = [];
    const relayer = await this.checkEndpoint(
      this.deps.relayerHealthUrl,
      "relayer",
      details
    );
    const opinit = await this.checkEndpoint(
      this.deps.opinitHealthUrl,
      "opinit",
      details
    );

    return {
      relayer,
      opinit,
      ready: relayer && opinit,
      checkedAt: nowIso(),
      details
    };
  }

  private async checkEndpoint(
    url: string | undefined,
    label: string,
    details: string[]
  ): Promise<boolean> {
    if (!url) {
      details.push(`${label}: missing health endpoint`);
      return false;
    }

    try {
      const response = await fetch(url);
      if (!response.ok) {
        details.push(`${label}: HTTP ${response.status}`);
        return false;
      }

      details.push(`${label}: healthy`);
      return true;
    } catch (error) {
      details.push(
        `${label}: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  }
}
