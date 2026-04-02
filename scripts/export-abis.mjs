import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const sourceDir = resolve("contracts/out");
const targetDir = resolve("packages/shared/abi");

const contracts = [
  "DarkPoolVault",
  "DarkVaultV2",
  "DarkPoolMarket",
  "DarkStateAnchor",
  "Groth16WithdrawalVerifier",
  "MockUSDC",
  "RwaShareToken"
];

await mkdir(targetDir, { recursive: true });

for (const name of contracts) {
  const artifactPath = resolve(sourceDir, `${name}.sol`, `${name}.json`);
  const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
  await writeFile(
    resolve(targetDir, `${name}.json`),
    JSON.stringify({ abi: artifact.abi }, null, 2),
    "utf8"
  );
}

console.log(`Exported ${contracts.length} ABI files to ${targetDir}`);
