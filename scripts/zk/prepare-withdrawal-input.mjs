import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { buildPoseidon } from "circomlibjs";

const MERKLE_DEPTH = 20;

function bigIntify(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") return BigInt(value);
  throw new Error(`Unsupported numeric value: ${value}`);
}

function poseidonToBigInt(poseidon, inputs) {
  return BigInt(poseidon.F.toString(poseidon(inputs)));
}

const [, , notePath, outputPathArg] = process.argv;

if (!notePath) {
  throw new Error("Usage: node scripts/zk/prepare-withdrawal-input.mjs <note.json> [output.json]");
}

const outputPath = outputPathArg ?? resolve(".tmp/zk/withdrawal/input.json");
const raw = JSON.parse(await readFile(resolve(notePath), "utf8"));
const poseidon = await buildPoseidon();

const secret = bigIntify(raw.secret);
const blinding = bigIntify(raw.blinding);
const recipient = bigIntify(raw.recipient);
const token = bigIntify(raw.token);
const amount = bigIntify(raw.amount);
const inputPathElements = (raw.pathElements ?? []).map(bigIntify);
const inputPathIndices = (raw.pathIndices ?? []).map(bigIntify);

if (inputPathElements.length > MERKLE_DEPTH || inputPathIndices.length > MERKLE_DEPTH) {
  throw new Error(`Merkle path exceeds supported depth ${MERKLE_DEPTH}`);
}

const pathElements = [
  ...inputPathElements,
  ...Array.from({ length: MERKLE_DEPTH - inputPathElements.length }, () => 0n)
];
const pathIndices = [
  ...inputPathIndices,
  ...Array.from({ length: MERKLE_DEPTH - inputPathIndices.length }, () => 0n)
];

const leaf = poseidonToBigInt(poseidon, [secret, blinding, token, amount]);
const nullifier = poseidonToBigInt(poseidon, [secret, recipient]);

let current = leaf;
for (let i = 0; i < pathElements.length; i += 1) {
  current =
    pathIndices[i] === 0n
      ? poseidonToBigInt(poseidon, [current, pathElements[i]])
      : poseidonToBigInt(poseidon, [pathElements[i], current]);
}

const input = {
  root: current.toString(),
  nullifier: nullifier.toString(),
  recipient: recipient.toString(),
  token: token.toString(),
  amount: amount.toString(),
  secret: secret.toString(),
  blinding: blinding.toString(),
  pathElements: pathElements.map((value) => value.toString()),
  pathIndices: pathIndices.map((value) => value.toString())
};

await mkdir(dirname(resolve(outputPath)), { recursive: true });
await writeFile(resolve(outputPath), JSON.stringify(input, null, 2));

console.log(`Wrote withdrawal witness input to ${resolve(outputPath)}`);
