export type Side = "BUY" | "SELL";
export type OrderStatus = "OPEN" | "PARTIAL" | "FILLED" | "CANCELLED";

export type StoredOrder = {
  id: string;
  userAddress: `0x${string}`;
  marketId: `0x${string}`;
  side: Side;
  limitPriceAtomic: string;
  quantityAtomic: string;
  remainingAtomic: string;
  reservedToken: `0x${string}`;
  reservedAtomic: string;
  status: OrderStatus;
  createdAt: string;
  updatedAt: string;
};

export type PendingWithdrawal = {
  userAddress: `0x${string}`;
  token: `0x${string}`;
  amountAtomic: string;
  nonce: number;
  deadline: number;
};

export type AppState = {
  balances: Record<string, Record<string, string>>;
  locked: Record<string, Record<string, string>>;
  orders: StoredOrder[];
  processedDeposits: string[];
  processedWithdrawals: string[];
  pendingWithdrawals: PendingWithdrawal[];
  withdrawalNonces: Record<string, number>;
};

export type ResolvedToken = {
  symbol: string;
  name: string;
  address: `0x${string}`;
  decimals: number;
  kind: "quote" | "rwa";
};

export type ResolvedMarket = {
  id: `0x${string}`;
  symbol: string;
  baseToken: ResolvedToken;
  quoteToken: ResolvedToken;
};

