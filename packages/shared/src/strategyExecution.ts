import { keccak256, stringToHex } from "viem";
import type { HexString, StrategyTimeframe, StrategyStatus } from "./strategy";

export const STRATEGY_EXECUTION_DOMAIN_NAME = "SinergyStrategyExecutor";
export const STRATEGY_EXECUTION_DOMAIN_VERSION = "1";
export const STRATEGY_APPROVAL_PRIMARY_TYPE = "StrategyApproval";

export const strategyApprovalTypes = {
  StrategyApproval: [
    { name: "owner", type: "address" },
    { name: "strategyIdHash", type: "bytes32" },
    { name: "strategyHash", type: "bytes32" },
    { name: "marketId", type: "bytes32" },
    { name: "maxSlippageBps", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" }
  ]
} as const;

export type StrategyApprovalMessage = {
  owner: HexString;
  strategyIdHash: HexString;
  strategyHash: HexString;
  marketId: HexString;
  maxSlippageBps: string;
  nonce: string;
  deadline: string;
};

export type StrategyApprovalIntent = {
  strategyId: string;
  strategyName: string;
  chainId: number;
  verifyingContract: HexString;
  primaryType: typeof STRATEGY_APPROVAL_PRIMARY_TYPE;
  domain: {
    name: typeof STRATEGY_EXECUTION_DOMAIN_NAME;
    version: typeof STRATEGY_EXECUTION_DOMAIN_VERSION;
    chainId: number;
    verifyingContract: HexString;
  };
  types: typeof strategyApprovalTypes;
  message: StrategyApprovalMessage;
  digest: HexString;
};

export type StrategyApprovalRecord = {
  strategyId: string;
  ownerAddress: HexString;
  marketId: HexString;
  strategyHash: HexString;
  maxSlippageBps: number;
  nonce: string;
  deadline: string;
  signature: HexString;
  verifyingContract: HexString;
  chainId: number;
  status: "active" | "superseded" | "consumed";
  createdAt: string;
  updatedAt: string;
};

export type StrategyExecutionAction = "router_swap" | "dark_pool_order" | "no_action";
export type StrategyExecutionSignal = "long_entry" | "long_exit" | "short_entry" | "short_exit" | "none";

export type StrategyExecutionRecord = {
  id: string;
  ownerAddress: HexString;
  strategyId: string;
  strategyName: string;
  marketId: HexString;
  signal: StrategyExecutionSignal;
  action: StrategyExecutionAction;
  approvalCreatedAt: string;
  approvalNonce: string;
  approvalTxHash?: HexString;
  status: string;
  fromToken?: HexString;
  toToken?: HexString;
  amountInAtomic?: string;
  quotedOutAtomic?: string;
  actualOutAtomic?: string;
  executionPrice?: number;
  routePreference?: "auto" | "local" | "dex";
  swapJobId?: string;
  orderId?: string;
  orderSide?: "BUY" | "SELL";
  orderQuantity?: string;
  orderLimitPrice?: string;
  l1TxHash?: string;
  reason?: string;
  createdAt: string;
  updatedAt: string;
};

export type StrategyExecutionStrategySummary = {
  strategyId: string;
  strategyName: string;
  marketId: HexString;
  marketSymbol: string;
  startedAt: string;
  lastTradeAt?: string;
  status: "active" | "pending" | "idle";
  tradesCount: number;
  currentPositionBase: string;
  currentPnlQuote?: number;
  currentPrice?: number;
};

export type StrategyAutoExecutionMode = "until_disabled" | "until_timestamp";
export type StrategyAutoExecutionStatus = "inactive" | "active" | "expired" | "paused" | "needs_reactivation";

export type StrategyLastBacktestPreview = {
  runId: string;
  createdAt: string;
  timeframe: StrategyTimeframe;
  tradeCount: number;
  netPnl: number;
  netPnlPct: number;
  winRate: number;
  maxDrawdownPct: number;
  profitFactor: number;
};

export type StrategyAutoExecutionState = {
  strategyId: string;
  ownerAddress: HexString;
  status: StrategyAutoExecutionStatus;
  mode?: StrategyAutoExecutionMode;
  expiresAt?: string;
  activationCreatedAt?: string;
  activationUpdatedAt?: string;
  approvalExpiresAt?: string;
  approvalCreatedAt?: string;
  lastCheckedAt?: string;
  lastCheckedCandleTs?: number;
  lastExecutedAt?: string;
  lastExecutedCandleTs?: number;
  lastSignal?: StrategyExecutionSignal;
  lastExecutionId?: string;
  lastError?: string;
};

export type StrategyDashboardCard = {
  strategyId: string;
  ownerAddress: HexString;
  name: string;
  marketId: HexString;
  marketSymbol: string;
  timeframe: StrategyTimeframe;
  status: StrategyStatus;
  updatedAt: string;
  latestBacktest?: StrategyLastBacktestPreview;
  autoExecution: StrategyAutoExecutionState;
};

export type ActivateStrategyAutoExecutionInput = {
  ownerAddress: HexString;
  strategyId: string;
  mode: StrategyAutoExecutionMode;
  expiresAt?: string;
};

export type DeactivateStrategyAutoExecutionInput = {
  ownerAddress: HexString;
  strategyId: string;
};

export function hashStrategyId(strategyId: string): HexString {
  return keccak256(stringToHex(strategyId));
}

export function hashStrategyPayload(strategyPayload: string): HexString {
  return keccak256(stringToHex(strategyPayload));
}
