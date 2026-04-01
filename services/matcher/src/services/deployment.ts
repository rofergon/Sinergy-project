import { readFileSync } from "node:fs";
import { darkPoolMarketAbi, darkPoolVaultAbi, type SinergyDeployment } from "@sinergy/shared";
import { encodePacked, keccak256, zeroAddress } from "viem";
import type { ResolvedMarket, ResolvedToken } from "../types.js";

const ZERO = zeroAddress.toLowerCase();

export function loadDeployment(path: string): SinergyDeployment {
  return JSON.parse(readFileSync(path, "utf8")) as SinergyDeployment;
}

export function resolveTokens(deployment: SinergyDeployment): Map<string, ResolvedToken> {
  return new Map(
    deployment.tokens.map((token) => [token.address.toLowerCase(), token])
  );
}

export function resolveMarkets(deployment: SinergyDeployment): ResolvedMarket[] {
  const quote = deployment.tokens.find((token) => token.kind === "quote");
  if (!quote || quote.address.toLowerCase() === ZERO) {
    return [];
  }

  return deployment.tokens
    .filter((token) => token.kind !== "quote" && token.address.toLowerCase() !== ZERO)
    .map((token) => {
      const symbol = `${token.symbol}/${quote.symbol}`;
      const id = keccak256(
        encodePacked(["string", "address", "address"], [symbol, token.address, quote.address])
      );

      return {
        id,
        symbol,
        baseToken: token,
        quoteToken: quote,
        routeable: false,
        routePolicy: "dark-pool-only"
      };
    });
}

export { darkPoolMarketAbi, darkPoolVaultAbi };
