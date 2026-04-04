import { createHash, randomUUID } from "node:crypto";
import type { Address, Hex } from "viem";
import { encodePacked, parseUnits, zeroHash } from "viem";
import type { ResolvedMarket, StoredOrder } from "../types.js";
import { StateStore } from "./state.js";
import { PriceService } from "./priceService.js";
import { darkPoolMarketAbi } from "./deployment.js";
import { getZkMerkleRoot } from "./zkState.js";

type MatcherDeps = {
  store: StateStore;
  markets: ResolvedMarket[];
  priceService: PriceService;
  priceBandBps: number;
  walletClient: any;
  publicClient: any;
  marketAddress: Address;
};

function keyOf(address: string): string {
  return address.toLowerCase();
}

function readBucket(
  root: Record<string, Record<string, string>>,
  address: string
): Record<string, string> {
  const key = keyOf(address);
  root[key] ??= {};
  return root[key];
}

function addAtomic(
  root: Record<string, Record<string, string>>,
  address: string,
  token: string,
  delta: bigint
): void {
  const bucket = readBucket(root, address);
  const tokenKey = keyOf(token);
  const next = BigInt(bucket[tokenKey] ?? "0") + delta;
  bucket[tokenKey] = next.toString();
}

function getAtomic(
  root: Record<string, Record<string, string>>,
  address: string,
  token: string
): bigint {
  return BigInt(readBucket(root, address)[keyOf(token)] ?? "0");
}

function nowIso(): string {
  return new Date().toISOString();
}

export class MatchingService {
  constructor(private readonly deps: MatcherDeps) {}

  getBalances(address: Address) {
    const state = this.deps.store.get();
    const available = readBucket(state.balances, address);
    const locked = readBucket(state.locked, address);
    return { available, locked };
  }

  getOrders(address?: Address): StoredOrder[] {
    const orders = this.deps.store.get().orders;
    if (!address) return orders;
    return orders.filter((order) => order.userAddress.toLowerCase() === address.toLowerCase());
  }

  placeOrder(input: {
    userAddress: Address;
    marketId: Hex;
    side: "BUY" | "SELL";
    quantity: string;
    limitPrice: string;
  }): StoredOrder {
    const market = this.deps.markets.find((item) => item.id === input.marketId);
    if (!market) {
      throw new Error("Market not found");
    }

    const quantityAtomic = parseUnits(input.quantity, market.baseToken.decimals);
    const priceAtomic = parseUnits(input.limitPrice, market.quoteToken.decimals);
    const reservedToken =
      input.side === "BUY" ? market.quoteToken.address : market.baseToken.address;
    const reservedAtomic =
      input.side === "BUY"
        ? (quantityAtomic * priceAtomic) / 10n ** BigInt(market.baseToken.decimals)
        : quantityAtomic;

    if (reservedAtomic <= 0n) {
      throw new Error("Order reserve must be positive");
    }

    const created = this.deps.store.mutate((state) => {
      const available = getAtomic(state.balances, input.userAddress, reservedToken);
      if (available < reservedAtomic) {
        throw new Error("Insufficient available balance in dark vault ledger");
      }

      addAtomic(state.balances, input.userAddress, reservedToken, -reservedAtomic);
      addAtomic(state.locked, input.userAddress, reservedToken, reservedAtomic);

      const order: StoredOrder = {
        id: randomUUID(),
        userAddress: input.userAddress,
        marketId: input.marketId,
        side: input.side,
        limitPriceAtomic: priceAtomic.toString(),
        quantityAtomic: quantityAtomic.toString(),
        remainingAtomic: quantityAtomic.toString(),
        reservedToken,
        reservedAtomic: reservedAtomic.toString(),
        status: "OPEN",
        createdAt: nowIso(),
        updatedAt: nowIso()
      };

      state.orders.push(order);
      return order;
    });

    this.tryMatch(input.marketId);
    return created;
  }

  cancelOrder(orderId: string, userAddress: Address): StoredOrder {
    return this.deps.store.mutate((state) => {
      const order = state.orders.find((entry) => entry.id === orderId);
      if (!order) throw new Error("Order not found");
      if (order.userAddress.toLowerCase() !== userAddress.toLowerCase()) {
        throw new Error("Order owner mismatch");
      }
      if (order.status !== "OPEN" && order.status !== "PARTIAL") {
        throw new Error("Only open orders can be cancelled");
      }

      const refundable = this.remainingReserve(order);
      addAtomic(state.locked, order.userAddress, order.reservedToken, -refundable);
      addAtomic(state.balances, order.userAddress, order.reservedToken, refundable);

      order.status = "CANCELLED";
      order.remainingAtomic = "0";
      order.updatedAt = nowIso();
      return order;
    });
  }

  private remainingReserve(order: StoredOrder): bigint {
    if (order.side === "SELL") {
      return BigInt(order.remainingAtomic);
    }

    const remainingBase = BigInt(order.remainingAtomic);
    const price = BigInt(order.limitPriceAtomic);
    return (remainingBase * price) / 10n ** 18n;
  }

  private tryMatch(marketId: Hex): void {
    this.deps.store.mutate((state) => {
      const market = this.deps.markets.find((item) => item.id === marketId);
      if (!market) return;

      while (true) {
        const buys = state.orders
          .filter(
            (order) =>
              order.marketId === marketId &&
              order.side === "BUY" &&
              (order.status === "OPEN" || order.status === "PARTIAL")
          )
          .sort((a, b) => {
            const priceDiff = BigInt(b.limitPriceAtomic) - BigInt(a.limitPriceAtomic);
            if (priceDiff !== 0n) return priceDiff > 0n ? 1 : -1;
            return a.createdAt.localeCompare(b.createdAt);
          });

        const sells = state.orders
          .filter(
            (order) =>
              order.marketId === marketId &&
              order.side === "SELL" &&
              (order.status === "OPEN" || order.status === "PARTIAL")
          )
          .sort((a, b) => {
            const priceDiff = BigInt(a.limitPriceAtomic) - BigInt(b.limitPriceAtomic);
            if (priceDiff !== 0n) return priceDiff > 0n ? 1 : -1;
            return a.createdAt.localeCompare(b.createdAt);
          });

        const bestBuy = buys[0];
        const bestSell = sells[0];
        if (!bestBuy || !bestSell) return;

        if (BigInt(bestBuy.limitPriceAtomic) < BigInt(bestSell.limitPriceAtomic)) return;

        const referencePrice = parseUnits(
          this.deps.priceService.getReferencePrice(market.baseToken.symbol),
          market.quoteToken.decimals
        );
        const executionPrice = BigInt(bestSell.limitPriceAtomic);
        const diff = executionPrice > referencePrice
          ? executionPrice - referencePrice
          : referencePrice - executionPrice;
        if ((diff * 10_000n) / referencePrice > BigInt(this.deps.priceBandBps)) {
          return;
        }

        const tradedBase = BigInt(bestBuy.remainingAtomic) < BigInt(bestSell.remainingAtomic)
          ? BigInt(bestBuy.remainingAtomic)
          : BigInt(bestSell.remainingAtomic);
        const quoteCost =
          (tradedBase * executionPrice) / 10n ** BigInt(market.baseToken.decimals);

        const buyerReservedAtLimit =
          (tradedBase * BigInt(bestBuy.limitPriceAtomic)) /
          10n ** BigInt(market.baseToken.decimals);
        const buyerRefund = buyerReservedAtLimit - quoteCost;

        addAtomic(state.locked, bestBuy.userAddress, market.quoteToken.address, -buyerReservedAtLimit);
        addAtomic(state.locked, bestSell.userAddress, market.baseToken.address, -tradedBase);
        addAtomic(state.balances, bestBuy.userAddress, market.baseToken.address, tradedBase);
        addAtomic(state.balances, bestSell.userAddress, market.quoteToken.address, quoteCost);
        if (buyerRefund > 0n) {
          addAtomic(state.balances, bestBuy.userAddress, market.quoteToken.address, buyerRefund);
        }

        bestBuy.remainingAtomic = (BigInt(bestBuy.remainingAtomic) - tradedBase).toString();
        bestSell.remainingAtomic = (BigInt(bestSell.remainingAtomic) - tradedBase).toString();
        bestBuy.status = BigInt(bestBuy.remainingAtomic) === 0n ? "FILLED" : "PARTIAL";
        bestSell.status = BigInt(bestSell.remainingAtomic) === 0n ? "FILLED" : "PARTIAL";
        bestBuy.updatedAt = nowIso();
        bestSell.updatedAt = nowIso();

        if (bestBuy.status === "FILLED") bestBuy.reservedAtomic = "0";
        if (bestSell.status === "FILLED") bestSell.reservedAtomic = "0";

        void this.anchorBatch(bestBuy, bestSell);
      }
    });
  }

  private async anchorBatch(buy: StoredOrder, sell: StoredOrder): Promise<void> {
    if (!this.deps.marketAddress || this.deps.marketAddress === ("0x0000000000000000000000000000000000000000" as Address)) {
      return;
    }

    const batchId = ("0x" +
      createHash("sha256")
        .update(`${buy.id}:${sell.id}:${Date.now()}`)
        .digest("hex")) as Hex;
    const stateRoot =
      this.deps.store.get().zkNotes.length > 0
        ? await getZkMerkleRoot(this.deps.store.get())
        : zeroHash;
    const settlementRoot = ("0x" +
      createHash("sha256")
        .update(
          encodePacked(
            ["string", "string", "string", "string"],
            [buy.id, sell.id, buy.remainingAtomic, sell.remainingAtomic]
          ).slice(2)
        )
        .digest("hex")) as Hex;

    await this.deps.walletClient.writeContract({
      account: this.deps.walletClient.account,
      address: this.deps.marketAddress,
      abi: darkPoolMarketAbi,
      functionName: "anchorBatch",
      args: [batchId, stateRoot, settlementRoot, 1n],
      chain: this.deps.walletClient.chain
    });
  }
}
