import "dotenv/config";
import { resolve } from "node:path";
import { z } from "zod";

const zkBuildDir = resolve(process.cwd(), "../../.tmp/zk/withdrawal");

const envSchema = z.object({
  PORT: z.coerce.number().default(8787),
  DEPLOYMENT_FILE: z.string().default(resolve(process.cwd(), "../../deployments/local.json")),
  MATCHER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  PRICE_BAND_BPS: z.coerce.number().int().positive().default(1000),
  PRICE_DB_FILE: z.string().default(resolve(process.cwd(), "./data/prices.sqlite")),
  STRATEGY_DB_FILE: z.string().default(resolve(process.cwd(), "./data/strategies.sqlite")),
  AUTO_STRATEGY_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  PRICE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  T_BOND_PROXY_SYMBOL: z.string().default("TLT"),
  TWELVE_DATA_API_KEY: z.string().optional(),
  COINGECKO_DEMO_API_KEY: z.string().optional(),
  INITIA_CONNECT_REST_URL: z.string().default("https://rest.testnet.initia.xyz"),
  L1_REST_URL: z.string().default("https://rest.testnet.initia.xyz"),
  L1_RPC_URL: z.string().default("https://rpc.testnet.initia.xyz"),
  L1_CHAIN_ID: z.string().default("initiation-2"),
  L1_GAS_PRICES: z.string().default("0.015uinit"),
  L1_GAS_ADJUSTMENT: z.string().default("1.75"),
  L1_ROUTER_MNEMONIC: z.string().optional(),
  L1_ROUTER_KEY_NAME: z.string().optional(),
  L1_ROUTER_KEYRING_BACKEND: z.string().optional(),
  L1_ROUTER_HOME: z.string().optional(),
  L1_GAS_STATION_KEY_NAME: z.string().default("gas-station"),
  L1_GAS_STATION_KEYRING_BACKEND: z.string().default("test"),
  L1_GAS_STATION_KEYRING_HOME: z.string().optional(),
  RELAYER_HEALTH_URL: z.string().optional(),
  OPINIT_HEALTH_URL: z.string().optional(),
  OPINIT_BRIDGE_ID: z.string().optional(),
  BRIDGE_REQUIRE_RELAYER: z
    .enum(["true", "false", "1", "0"])
    .default("true")
    .transform((value) => value === "true" || value === "1"),
  BRIDGED_INIT_DENOM: z
    .string()
    .default("l2/7835b9ce5f65720a12cd653306cfe00afb93dcf1b73e69eb5eeddc568fc455cf"),
  BRIDGED_INIT_SYMBOL: z.string().default("cINIT"),
  BRIDGED_INIT_SOURCE_DECIMALS: z.coerce.number().int().nonnegative().default(6),
  ROUTER_QUOTE_SPREAD_BPS: z.coerce.number().int().nonnegative().default(35),
  ROUTER_MAX_LOCAL_FILL_USD: z.coerce.number().positive().default(25_000),
  ROUTER_REBALANCE_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  ROUTER_CANONICAL_ASSETS_JSON: z.string().default("{}"),
  ROUTER_MARKETS_JSON: z.string().default("{}"),
  ROUTER_BOOTSTRAP_INVENTORY_JSON: z.string().default("{}"),
  AUTH_TOKEN_SECRET: z.string().optional(),
  AUTH_NONCE_TTL_MS: z.coerce.number().int().positive().default(5 * 60_000),
  AUTH_TOKEN_TTL_MS: z.coerce.number().int().positive().default(8 * 60 * 60_000),
  ZK_WITHDRAWAL_PACKAGE_FILE: z.string().optional(),
  ZK_WITHDRAWAL_WASM_FILE: z.string().default(resolve(zkBuildDir, "withdrawal_js/withdrawal.wasm")),
  ZK_WITHDRAWAL_ZKEY_FILE: z.string().default(resolve(zkBuildDir, "withdrawal_final.zkey"))
});

export const env = envSchema.parse(process.env);
