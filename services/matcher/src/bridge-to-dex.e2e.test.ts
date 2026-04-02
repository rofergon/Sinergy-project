import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SinergyDeployment } from "@sinergy/shared";
import { erc20Abi } from "@sinergy/shared";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  type Address,
  type Hex
} from "viem";
import { darkPoolVaultAbi, resolveMarkets, resolveTokens } from "./services/deployment.js";
import { StateStore } from "./services/state.js";
import { BridgeClaimService } from "./services/bridgeClaims.js";
import { VaultService } from "./services/vault.js";
import { InventoryService } from "./services/inventory.js";
import { LiquidityRouter } from "./services/router.js";
import { RebalanceWorker } from "./services/rebalanceWorker.js";
import type { CanonicalAssetConfig, ResolvedMarket, RouterMarketConfig } from "./types.js";

type TokenLedger = Map<string, Map<string, bigint>>;

const MATCHER_ADDRESS = "0x6eC8AcC95Da5f752eCeAB1c214C1b62080023283" as Address;
const USER_ADDRESS = "0x6710B53Fad43E53ce0d3d3AbE299c38b4a39239d" as Address;
const VAULT_ADDRESS = "0x3fF37bE2C8B8179cBfd97CB1e75fEd91e5e38B19" as Address;
const MARKET_ADDRESS = "0xe1d9c4EcC2ba58274733C61Fb25919F0eA902575" as Address;
const CUSDC_ADDRESS = "0x6Ef1eB5AE5C6824F8B6ECA81E2DB193966D95967" as Address;
const CINIT_ADDRESS = "0x308B830b96998E9080616C504C7562473E2d85df" as Address;
const CETH_ADDRESS = "0x76Ada1d256D45806EF736B0F3CDb15c90188AFe6" as Address;
const INITIA_ADDRESS = "init1m667d6pvwwqlgljv2qm2pmrs66t6g6ff0gjs7e";
const BRIDGED_USDC_DENOM =
  "l2/57a38da2740f206b92f5d853951f2072982ee11aa8aeeefdab63aa6550a51bb2";

function keyOf(value: string) {
  return value.toLowerCase();
}

function bucket(root: TokenLedger, token: Address) {
  const tokenKey = keyOf(token);
  let inner = root.get(tokenKey);
  if (!inner) {
    inner = new Map<string, bigint>();
    root.set(tokenKey, inner);
  }
  return inner;
}

function getTokenBalance(root: TokenLedger, token: Address, owner: Address) {
  return bucket(root, token).get(keyOf(owner)) ?? 0n;
}

function setTokenBalance(root: TokenLedger, token: Address, owner: Address, amount: bigint) {
  bucket(root, token).set(keyOf(owner), amount);
}

function addTokenBalance(root: TokenLedger, token: Address, owner: Address, delta: bigint) {
  setTokenBalance(root, token, owner, getTokenBalance(root, token, owner) + delta);
}

function makeDepositLog(user: Address, token: Address, amountAtomic: bigint, vaultAddress: Address) {
  const rawTopics = encodeEventTopics({
    abi: darkPoolVaultAbi,
    eventName: "Deposit",
    args: {
      user,
      token
    }
  });
  const topics = (Array.isArray(rawTopics) ? rawTopics.flat() : [rawTopics]).filter(
    (topic): topic is Hex => typeof topic === "string" && topic.startsWith("0x")
  );

  return {
    address: vaultAddress,
    topics,
    data: encodeAbiParameters([{ name: "amount", type: "uint256" }], [amountAtomic])
  };
}

function makeDeployment(): SinergyDeployment {
  return {
    network: {
      name: "Sinergy Test E2E",
      chainId: 1716124615666775,
      chainIdHex: "0x618ce661b6c57",
      rollupChainId: "Sinergy-2",
      l1ChainId: "initiation-2",
      gasDenom: "GAS",
      rpcUrl: "http://127.0.0.1:8545",
      wsUrl: "ws://127.0.0.1:8546",
      tendermintRpc: "http://127.0.0.1:26657",
      restUrl: "http://127.0.0.1:1317",
      explorerUrl: "http://127.0.0.1:8545",
      nativeCurrency: {
        name: "Gas",
        symbol: "GAS",
        decimals: 18
      }
    },
    contracts: {
      vault: VAULT_ADDRESS,
      market: MARKET_ADDRESS,
      quoteToken: CUSDC_ADDRESS
    },
    tokens: [
      {
        symbol: "cUSDC",
        name: "Connected USD Coin",
        address: CUSDC_ADDRESS,
        decimals: 6,
        kind: "quote",
        bridge: {
          sourceChainId: "initiation-2",
          sourceDenom: "uusdc",
          sourceSymbol: "USDC",
          sourceDecimals: 6,
          destinationDenom: BRIDGED_USDC_DENOM
        }
      },
      {
        symbol: "cINIT",
        name: "Connected Initia",
        address: CINIT_ADDRESS,
        decimals: 18,
        kind: "crypto",
        bridge: {
          sourceChainId: "initiation-2",
          sourceDenom: "uinit",
          sourceSymbol: "INIT",
          sourceDecimals: 6,
          destinationDenom: "l2/7835b9ce5f65720a12cd653306cfe00afb93dcf1b73e69eb5eeddc568fc455cf"
        }
      },
      {
        symbol: "cETH",
        name: "Connected Ether",
        address: CETH_ADDRESS,
        decimals: 18,
        kind: "crypto"
      }
    ]
  };
}

function canonicalAssetFor(symbol: "cINIT" | "cETH"): CanonicalAssetConfig {
  if (symbol === "cINIT") {
    return {
      localSymbol: "cINIT",
      l1Symbol: "INIT",
      bridgeDenom: "uinit",
      l1Decimals: 6,
      minInventoryAtomic: "0",
      targetInventoryAtomic: "1000000000000000000",
      maxInventoryAtomic: "10000000000000000000"
    };
  }

  return {
    localSymbol: "cETH",
    l1Symbol: "ETH",
    bridgeDenom: "ueth",
    l1Decimals: 6,
    minInventoryAtomic: "0",
    targetInventoryAtomic: "100000000000000000",
    maxInventoryAtomic: "1000000000000000000"
  };
}

function createHarness(bridgedUsdcAtomic: bigint) {
  const root = mkdtempSync(join(tmpdir(), "sinergy-e2e-"));
  const originalFetch = globalThis.fetch;
  const deployment = makeDeployment();
  const tokens = resolveTokens(deployment);
  const markets = resolveMarkets(deployment);
  const store = new StateStore(join(root, "state.json"));
  const chainBalances: TokenLedger = new Map();
  const owners = new Map<string, Address>([
    [keyOf(CUSDC_ADDRESS), MATCHER_ADDRESS],
    [keyOf(CINIT_ADDRESS), MATCHER_ADDRESS],
    [keyOf(CETH_ADDRESS), MATCHER_ADDRESS]
  ]);

  let pendingTx:
    | {
        to: Address;
        data: Hex;
      }
    | null = null;
  let txCounter = 0;

  const matcherAccount = {
    address: MATCHER_ADDRESS,
    async signTransaction(tx: { to: Address; data: Hex }) {
      pendingTx = { to: tx.to, data: tx.data };
      txCounter += 1;
      return `0x${txCounter.toString(16).padStart(64, "0")}` as Hex;
    },
    async signTypedData() {
      return `0x${"11".repeat(65)}` as Hex;
    }
  };

  const publicClient = {
    async readContract({
      address,
      functionName,
      args
    }: {
      address: Address;
      functionName: string;
      args?: unknown[];
    }) {
      if (functionName === "owner") {
        return owners.get(keyOf(address)) ?? MATCHER_ADDRESS;
      }

      if (functionName === "balanceOf") {
        return getTokenBalance(chainBalances, address, args?.[0] as Address);
      }

      throw new Error(`Unsupported readContract call: ${functionName}`);
    },
    async getTransactionCount() {
      return BigInt(txCounter);
    },
    async estimateGas() {
      return 120_000n;
    },
    async getGasPrice() {
      return 1n;
    },
    async waitForTransactionReceipt({ hash }: { hash: Hex }) {
      return { hash };
    }
  };

  const walletClient = {
    account: matcherAccount,
    async sendRawTransaction({ serializedTransaction }: { serializedTransaction: Hex }) {
      if (!pendingTx) {
        throw new Error(`No pending transaction for ${serializedTransaction}`);
      }

      const txHash = `0x${(txCounter + 1000).toString(16).padStart(64, "0")}` as Hex;
      const decoded = decodeFunctionData({
        abi: erc20Abi,
        data: pendingTx.data
      });

      if (decoded.functionName === "mint") {
        const [to, amount] = decoded.args as [Address, bigint];
        addTokenBalance(chainBalances, pendingTx.to, to, amount);
      } else if (decoded.functionName === "burn") {
        const [from, amount] = decoded.args as [Address, bigint];
        addTokenBalance(chainBalances, pendingTx.to, from, -amount);
      } else if (decoded.functionName === "transfer") {
        const [to, amount] = decoded.args as [Address, bigint];
        addTokenBalance(chainBalances, pendingTx.to, MATCHER_ADDRESS, -amount);
        addTokenBalance(chainBalances, pendingTx.to, to, amount);
      }

      pendingTx = null;
      return txHash;
    },
    async signTypedData() {
      return `0x${"22".repeat(65)}` as Hex;
    }
  };

  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input);

    if (
      url.includes(
        `/cosmos/bank/v1beta1/balances/${INITIA_ADDRESS}/by_denom?denom=${encodeURIComponent(BRIDGED_USDC_DENOM)}`
      )
    ) {
      return new Response(
        JSON.stringify({
          balance: {
            amount: bridgedUsdcAtomic.toString()
          }
        }),
        { status: 200 }
      );
    }

    if (url.includes(`/cosmos/bank/v1beta1/balances/${INITIA_ADDRESS}`)) {
      return new Response(
        JSON.stringify({
          balances: [
            {
              denom: BRIDGED_USDC_DENOM,
              amount: bridgedUsdcAtomic.toString()
            }
          ]
        }),
        { status: 200 }
      );
    }

    return new Response(JSON.stringify({}), { status: 404 });
  };

  const bridgeClaimService = new BridgeClaimService({
    store,
    publicClient: publicClient as any,
    walletClient: walletClient as any,
    deployment,
    tokens,
    rollupRestUrl: deployment.network.restUrl
  });

  return {
    root,
    deployment,
    tokens,
    markets,
    store,
    chainBalances,
    bridgeClaimService,
    publicClient,
    walletClient,
    restore() {
      globalThis.fetch = originalFetch;
      rmSync(root, { recursive: true, force: true });
    }
  };
}

async function claimAndDepositQuote(
  harness: ReturnType<typeof createHarness>,
  amountAtomic: bigint,
  txHash: Hex
) {
  const preview = await harness.bridgeClaimService.preview({
    tokenSymbol: "cUSDC",
    initiaAddress: INITIA_ADDRESS,
    evmAddress: USER_ADDRESS
  });

  assert.equal(preview.claimableAtomic, amountAtomic.toString());

  const claimResult = await harness.bridgeClaimService.claim({
    tokenSymbol: "cUSDC",
    initiaAddress: INITIA_ADDRESS,
    evmAddress: USER_ADDRESS
  });
  assert.ok(claimResult.txHash.startsWith("0x"));
  assert.equal(getTokenBalance(harness.chainBalances, CUSDC_ADDRESS, USER_ADDRESS), amountAtomic);

  addTokenBalance(harness.chainBalances, CUSDC_ADDRESS, USER_ADDRESS, -amountAtomic);
  addTokenBalance(harness.chainBalances, CUSDC_ADDRESS, VAULT_ADDRESS, amountAtomic);

  const vaultService = new VaultService(
    harness.store,
    harness.publicClient as any,
    harness.walletClient as any,
    harness.deployment,
    harness.tokens,
    harness.markets
  );
  const syncDeposit = await vaultService.syncDeposit(
    txHash,
    USER_ADDRESS,
    [makeDepositLog(USER_ADDRESS, CUSDC_ADDRESS, amountAtomic, VAULT_ADDRESS)]
  );

  assert.equal(syncDeposit.alreadyProcessed, false);
  assert.equal(syncDeposit.token, "cUSDC");
  assert.equal(syncDeposit.amountAtomic, amountAtomic.toString());
}

function createRouterStack(
  harness: ReturnType<typeof createHarness>,
  marketSymbol: "cINIT/cUSDC" | "cETH/cUSDC",
  l1SimulatedOutAtomic: bigint,
  baseTokenExpectedOutAtomic: bigint
) {
  const market = harness.markets.find((item) => item.symbol === marketSymbol);
  assert.ok(market);
  const baseSymbol = market.baseToken.symbol as "cINIT" | "cETH";

  const canonicalAssets = new Map<string, CanonicalAssetConfig>([
    [keyOf(baseSymbol), canonicalAssetFor(baseSymbol)],
    [
      "cusdc",
      {
        localSymbol: "cUSDC",
        l1Symbol: "USDC",
        bridgeDenom: "uusdc",
        l1Decimals: 6,
        minInventoryAtomic: "1000000",
        targetInventoryAtomic: "10000000",
        maxInventoryAtomic: "1000000000"
      }
    ]
  ]);

  const routerMarkets = new Map<string, RouterMarketConfig>([
    [
      keyOf(marketSymbol),
      {
        pairDenom: `move/test-${keyOf(baseSymbol)}-usdc-pool`,
        pairObjectId: baseSymbol === "cINIT" ? "0x33" : "0x44",
        baseSymbol,
        quoteSymbol: "cUSDC"
      }
    ]
  ]);

  const inventoryService = new InventoryService({
    store: harness.store,
    tokens: harness.tokens,
    markets: [market],
    canonicalAssets,
    routerMarkets,
    bootstrapInventory: {
      [baseSymbol]: "0",
      cUSDC: "10000000"
    }
  });
  const routedMarket: ResolvedMarket = {
    ...market,
    ...inventoryService.getMarketPolicy(market)
  };

  const router = new LiquidityRouter({
    store: harness.store,
    markets: [routedMarket],
    priceService: {
      getReferencePrice: () => (baseSymbol === "cINIT" ? "1" : "2500")
    } as any,
    inventoryService,
    initiaDexClient: {
      simulateSwap: async () => l1SimulatedOutAtomic
    } as any,
    bridgeHealthService: {
      getStatus: async () => ({
        relayer: true,
        opinit: true,
        ready: true,
        checkedAt: new Date().toISOString(),
        details: []
      })
    } as any,
    vaultService: {
      getMatcherWalletBalance: async () => 0n,
      settleInstantLocalSwap: async () => undefined
    } as any,
    quoteSpreadBps: 0,
    maxLocalFillUsd: 1
  });

  const worker = new RebalanceWorker({
    inventoryService,
    bridgeHealthService: {
      getStatus: async () => ({
        relayer: true,
        opinit: true,
        ready: true,
        checkedAt: new Date().toISOString(),
        details: []
      })
    } as any,
    initiaDexClient: {
      canSubmitTransactions: true,
      executeSwap: async () => ({
        txHash:
          baseSymbol === "cINIT"
            ? ("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hex)
            : ("0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as Hex),
        returnAmountAtomic: l1SimulatedOutAtomic
      })
    } as any,
    intervalMs: 1,
    markets: [routedMarket]
  });

  return {
    market: routedMarket,
    router,
    worker,
    expectedOutAtomic: baseTokenExpectedOutAtomic
  };
}

async function drainWorker(worker: RebalanceWorker) {
  await (worker as any).tick();
  await (worker as any).tick();
  await (worker as any).tick();
  await (worker as any).tick();
}

test("end-to-end bridge-backed cUSDC can be claimed, deposited, and swapped into cINIT", async () => {
  const harness = createHarness(5_000_000n);

  try {
    assert.deepEqual(
      harness.bridgeClaimService.listAssets().map((asset) => asset.tokenSymbol).sort(),
      ["cINIT", "cUSDC"]
    );

    await claimAndDepositQuote(
      harness,
      5_000_000n,
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );

    const { market, router, worker, expectedOutAtomic } = createRouterStack(
      harness,
      "cINIT/cUSDC",
      2_500_000n,
      2_500_000_000_000_000_000n
    );

    const quote = await router.quote({
      userAddress: USER_ADDRESS,
      marketId: market.id,
      fromToken: CUSDC_ADDRESS,
      amount: "5",
      routePreference: "dex"
    });

    assert.equal(quote.marketSymbol, "cINIT/cUSDC");
    assert.equal(quote.executionPath, "dex");
    assert.equal(quote.toSymbol, "cINIT");
    assert.equal(quote.fromSymbol, "cUSDC");

    const execution = await router.execute({
      userAddress: USER_ADDRESS,
      marketId: market.id,
      fromToken: CUSDC_ADDRESS,
      amount: "5",
      routePreference: "dex"
    });

    assert.equal(execution.status, "rebalancing");
    assert.ok(execution.jobId);

    await drainWorker(worker);

    const snapshot = harness.store.get();
    const userBalances = snapshot.balances[keyOf(USER_ADDRESS)];
    const userLocked = snapshot.locked[keyOf(USER_ADDRESS)];
    const [swapJob] = snapshot.swapJobs;
    const [rebalanceJob] = snapshot.rebalanceJobs;

    assert.equal(userBalances[keyOf(CUSDC_ADDRESS)], "0");
    assert.equal(userLocked[keyOf(CUSDC_ADDRESS)], "0");
    assert.equal(userBalances[keyOf(CINIT_ADDRESS)], expectedOutAtomic.toString());
    assert.equal(swapJob.marketSymbol, "cINIT/cUSDC");
    assert.equal(swapJob.state, "completed");
    assert.equal(rebalanceJob.marketSymbol, "cINIT/cUSDC");
    assert.equal(rebalanceJob.state, "completed");
    assert.equal(rebalanceJob.actualAmountOutAtomic, expectedOutAtomic.toString());
  } finally {
    harness.restore();
  }
});

test("end-to-end bridge-backed cUSDC can be claimed, deposited, and swapped into cETH", async () => {
  const harness = createHarness(100_000_000n);

  try {
    await claimAndDepositQuote(
      harness,
      100_000_000n,
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    );

    const { market, router, worker, expectedOutAtomic } = createRouterStack(
      harness,
      "cETH/cUSDC",
      8_671n,
      8_671_000_000_000_000n
    );

    const quote = await router.quote({
      userAddress: USER_ADDRESS,
      marketId: market.id,
      fromToken: CUSDC_ADDRESS,
      amount: "100",
      routePreference: "dex"
    });

    assert.equal(quote.marketSymbol, "cETH/cUSDC");
    assert.equal(quote.executionPath, "dex");
    assert.equal(quote.toSymbol, "cETH");
    assert.equal(quote.fromSymbol, "cUSDC");

    const execution = await router.execute({
      userAddress: USER_ADDRESS,
      marketId: market.id,
      fromToken: CUSDC_ADDRESS,
      amount: "100",
      routePreference: "dex"
    });

    assert.equal(execution.status, "rebalancing");
    assert.ok(execution.jobId);

    await drainWorker(worker);

    const snapshot = harness.store.get();
    const userBalances = snapshot.balances[keyOf(USER_ADDRESS)];
    const [swapJob] = snapshot.swapJobs;
    const [rebalanceJob] = snapshot.rebalanceJobs;

    assert.equal(userBalances[keyOf(CUSDC_ADDRESS)], "0");
    assert.equal(userBalances[keyOf(CETH_ADDRESS)], expectedOutAtomic.toString());
    assert.equal(swapJob.marketSymbol, "cETH/cUSDC");
    assert.equal(swapJob.state, "completed");
    assert.equal(rebalanceJob.marketSymbol, "cETH/cUSDC");
    assert.equal(rebalanceJob.state, "completed");
    assert.equal(rebalanceJob.actualAmountOutAtomic, expectedOutAtomic.toString());
  } finally {
    harness.restore();
  }
});

test("end-to-end bridge-backed cUSDC can be claimed and redeemed back into bridged USDC", async () => {
  const harness = createHarness(12_345_678n);

  try {
    const initialPreview = await harness.bridgeClaimService.preview({
      tokenSymbol: "cUSDC",
      initiaAddress: INITIA_ADDRESS,
      evmAddress: USER_ADDRESS
    });

    assert.equal(initialPreview.claimableAtomic, "12345678");
    assert.equal(initialPreview.claimedAtomic, "0");
    assert.equal(initialPreview.walletTokenBalanceAtomic, "0");
    assert.equal(initialPreview.redeemableAtomic, "0");

    const claimResult = await harness.bridgeClaimService.claim({
      tokenSymbol: "cUSDC",
      initiaAddress: INITIA_ADDRESS,
      evmAddress: USER_ADDRESS
    });

    assert.ok(claimResult.txHash.startsWith("0x"));
    assert.equal(getTokenBalance(harness.chainBalances, CUSDC_ADDRESS, USER_ADDRESS), 12_345_678n);

    const afterClaim = await harness.bridgeClaimService.preview({
      tokenSymbol: "cUSDC",
      initiaAddress: INITIA_ADDRESS,
      evmAddress: USER_ADDRESS
    });

    assert.equal(afterClaim.claimableAtomic, "0");
    assert.equal(afterClaim.claimedAtomic, "12345678");
    assert.equal(afterClaim.walletTokenBalanceAtomic, "12345678");
    assert.equal(afterClaim.redeemableAtomic, "12345678");

    const redeemResult = await harness.bridgeClaimService.redeem({
      tokenSymbol: "cUSDC",
      initiaAddress: INITIA_ADDRESS,
      evmAddress: USER_ADDRESS,
      amountAtomic: 12_345_678n
    });

    assert.ok(redeemResult.txHash.startsWith("0x"));
    assert.equal(redeemResult.releasedBridgeAtomic, "12345678");
    assert.equal(redeemResult.burnedTokenAtomic, "12345678");
    assert.equal(getTokenBalance(harness.chainBalances, CUSDC_ADDRESS, USER_ADDRESS), 0n);

    const afterRedeem = await harness.bridgeClaimService.preview({
      tokenSymbol: "cUSDC",
      initiaAddress: INITIA_ADDRESS,
      evmAddress: USER_ADDRESS
    });

    assert.equal(afterRedeem.claimedAtomic, "0");
    assert.equal(afterRedeem.claimableAtomic, "12345678");
    assert.equal(afterRedeem.walletTokenBalanceAtomic, "0");
    assert.equal(afterRedeem.redeemableAtomic, "0");
  } finally {
    harness.restore();
  }
});
