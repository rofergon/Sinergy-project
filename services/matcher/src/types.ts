export type Side = "BUY" | "SELL";
export type OrderStatus = "OPEN" | "PARTIAL" | "FILLED" | "CANCELLED";
export type RouteMode =
  | "instant_local"
  | "async_rebalance_required"
  | "unsupported_asset";
export type RebalanceJobState =
  | "queued"
  | "bridging_out"
  | "bridging_in"
  | "l1_swap"
  | "settling_back"
  | "completed"
  | "failed";

export type BridgeHealth = {
  relayer: boolean;
  opinit: boolean;
  ready: boolean;
  checkedAt: string;
  details: string[];
};

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

export type CanonicalAssetConfig = {
  localSymbol: string;
  l1Symbol: string;
  bridgeDenom: string;
  metadataObjectId: string;
  minInventoryAtomic: string;
  targetInventoryAtomic: string;
  maxInventoryAtomic: string;
};

export type RouterMarketConfig = {
  pairObjectId: string;
  baseSymbol: string;
  quoteSymbol: string;
};

export type RouterInventoryPosition = {
  symbol: string;
  tokenAddress: `0x${string}`;
  amountAtomic: string;
  minAtomic: string;
  targetAtomic: string;
  maxAtomic: string;
  routeable: boolean;
};

export type SwapQuote = {
  mode: RouteMode;
  expiry: string;
  routeable: boolean;
  quotedOutAtomic: string;
  minOutAtomic: string;
  sourceBreakdown: {
    localInventoryAtomic: string;
    l1DexAtomic: string;
    inventoryStatus: "healthy" | "low" | "unsupported";
  };
  bridge: BridgeHealth;
  marketSymbol: string;
  fromSymbol: string;
  toSymbol: string;
};

export type SwapJob = {
  id: string;
  userAddress: `0x${string}`;
  marketId: `0x${string}`;
  marketSymbol: string;
  fromToken: `0x${string}`;
  toToken: `0x${string}`;
  fromSymbol: string;
  toSymbol: string;
  amountInAtomic: string;
  quotedOutAtomic: string;
  minOutAtomic: string;
  mode: RouteMode;
  state: RebalanceJobState;
  createdAt: string;
  updatedAt: string;
  error?: string;
  l1TxHash?: string;
  settleImmediately: boolean;
};

export type RebalanceJob = {
  id: string;
  marketId: `0x${string}`;
  marketSymbol: string;
  state: RebalanceJobState;
  reason: "inventory_low" | "inventory_high" | "user_async_swap";
  inputSymbol: string;
  outputSymbol: string;
  amountInAtomic: string;
  minAmountOutAtomic: string;
  createdAt: string;
  updatedAt: string;
  linkedSwapJobId?: string;
  error?: string;
  l1TxHash?: string;
};

export type AppState = {
  balances: Record<string, Record<string, string>>;
  locked: Record<string, Record<string, string>>;
  orders: StoredOrder[];
  processedDeposits: string[];
  processedWithdrawals: string[];
  pendingWithdrawals: PendingWithdrawal[];
  withdrawalNonces: Record<string, number>;
  routerInventory: Record<string, string>;
  swapJobs: SwapJob[];
  rebalanceJobs: RebalanceJob[];
};

export type ResolvedToken = {
  symbol: string;
  name: string;
  address: `0x${string}`;
  decimals: number;
  kind: "quote" | "rwa" | "crypto";
};

export type ResolvedMarket = {
  id: `0x${string}`;
  symbol: string;
  baseToken: ResolvedToken;
  quoteToken: ResolvedToken;
  routeable: boolean;
  routePolicy: "router-enabled" | "dark-pool-only";
};
