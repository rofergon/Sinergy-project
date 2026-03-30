import { readFileSync } from "node:fs";
import { darkPoolMarketAbi, darkPoolVaultAbi, type LocalDeployment } from "@sinergy/shared";
import { encodePacked, keccak256, zeroAddress } from "viem";
import type { ResolvedMarket, ResolvedToken } from "../types.js";

const ZERO = zeroAddress.toLowerCase();

export function loadDeployment(path: string): LocalDeployment {
  return JSON.parse(readFileSync(path, "utf8")) as LocalDeployment;
}

export function resolveTokens(deployment: LocalDeployment): Map<string, ResolvedToken> {
  return new Map(
    deployment.tokens.map((token) => [token.address.toLowerCase(), token])
  );
}

export function resolveMarkets(deployment: LocalDeployment): ResolvedMarket[] {
  const quote = deployment.tokens.find((token) => token.kind === "quote");
  if (!quote || quote.address.toLowerCase() === ZERO) {
    return [];
  }

  return deployment.tokens
    .filter((token) => token.kind === "rwa" && token.address.toLowerCase() !== ZERO)
    .map((token) => {
      const symbol = `${token.symbol}/${quote.symbol}`;
      const id = keccak256(
        encodePacked(["string", "address", "address"], [symbol, token.address, quote.address])
      );

      return {
        id,
        symbol,
        baseToken: token,
        quoteToken: quote
      };
    });
}

export { darkPoolMarketAbi, darkPoolVaultAbi };

