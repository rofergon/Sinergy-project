import "dotenv/config";
import { resolve } from "node:path";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(8787),
  DEPLOYMENT_FILE: z.string().default(resolve(process.cwd(), "../../deployments/local.json")),
  MATCHER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  PRICE_BAND_BPS: z.coerce.number().int().positive().default(1000),
  PRICE_DB_FILE: z.string().default(resolve(process.cwd(), "./data/prices.sqlite")),
  PRICE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  T_BOND_PROXY_SYMBOL: z.string().default("TLT"),
  TWELVE_DATA_API_KEY: z.string().optional(),
  COINGECKO_DEMO_API_KEY: z.string().optional(),
  INITIA_CONNECT_REST_URL: z.string().default("https://rest.testnet.initia.xyz")
});

export const env = envSchema.parse(process.env);
