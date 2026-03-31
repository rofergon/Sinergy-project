import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BridgeHealth } from "../types.js";
import { nowIso } from "./routerUtils.js";

type HealthDeps = {
  relayerHealthUrl?: string;
  opinitHealthUrl?: string;
  requireRelayer?: boolean;
};

export class BridgeHealthService {
  constructor(private readonly deps: HealthDeps) {}

  async getStatus(): Promise<BridgeHealth> {
    const details: string[] = [];
    const requireRelayer = this.deps.requireRelayer ?? false;
    const relayerUrl = this.deps.relayerHealthUrl;
    const opinitUrl = this.deps.opinitHealthUrl ?? this.discoverOpinitHealthUrl();

    const relayer = await this.checkEndpoint(
      relayerUrl,
      "relayer",
      details,
      !requireRelayer
    );
    const opinit = await this.checkEndpoint(
      opinitUrl,
      "opinit",
      details
    );

    return {
      relayer,
      opinit,
      ready: opinit && (requireRelayer ? relayer : true),
      checkedAt: nowIso(),
      details
    };
  }

  private async checkEndpoint(
    url: string | undefined,
    label: string,
    details: string[],
    optional = false
  ): Promise<boolean> {
    if (!url) {
      details.push(
        optional
          ? `${label}: not configured (optional for current route mode)`
          : `${label}: missing health endpoint`
      );
      return optional;
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

  private discoverOpinitHealthUrl(): string | undefined {
    const configPath = join(homedir(), ".opinit", "executor.json");
    if (!existsSync(configPath)) {
      return undefined;
    }

    try {
      const raw = JSON.parse(readFileSync(configPath, "utf8")) as {
        server?: { address?: string };
      };
      const address = raw.server?.address?.trim();
      if (!address) {
        return undefined;
      }

      const normalized = address.startsWith("http://") || address.startsWith("https://")
        ? address
        : `http://${address}`;
      return `${normalized.replace(/\/$/, "")}/status`;
    } catch {
      return undefined;
    }
  }
}
