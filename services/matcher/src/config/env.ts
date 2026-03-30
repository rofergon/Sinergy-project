import "dotenv/config";
import { resolve } from "node:path";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(8787),
  DEPLOYMENT_FILE: z.string().default(resolve(process.cwd(), "../../deployments/local.json")),
  MATCHER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  PRICE_BAND_BPS: z.coerce.number().int().positive().default(1000)
});

export const env = envSchema.parse(process.env);

