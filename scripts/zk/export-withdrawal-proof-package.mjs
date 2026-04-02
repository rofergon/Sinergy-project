import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { encodeAbiParameters } from "viem";

function encodeGroth16Proof(proof) {
  return encodeAbiParameters(
    [{ type: "uint256[2]" }, { type: "uint256[2][2]" }, { type: "uint256[2]" }],
    [proof.a, proof.b, proof.c]
  );
}

const [, , proofPathArg, publicPathArg] = process.argv;
const proofPath = resolve(proofPathArg ?? ".tmp/zk/withdrawal/proof.json");
const publicPath = resolve(publicPathArg ?? ".tmp/zk/withdrawal/public.json");

const proof = JSON.parse(await readFile(proofPath, "utf8"));
const publicSignals = JSON.parse(await readFile(publicPath, "utf8"));

if (!Array.isArray(publicSignals) || publicSignals.length !== 5) {
  throw new Error("Expected 5 public signals: root, nullifier, recipient, token, amount");
}

const encodedProof = encodeGroth16Proof({
  a: [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])],
  b: [
    [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])],
    [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])]
  ],
  c: [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])]
});

const packageJson = {
  root: `0x${BigInt(publicSignals[0]).toString(16).padStart(64, "0")}`,
  nullifier: `0x${BigInt(publicSignals[1]).toString(16).padStart(64, "0")}`,
  recipient: `0x${BigInt(publicSignals[2]).toString(16).padStart(40, "0")}`,
  token: `0x${BigInt(publicSignals[3]).toString(16).padStart(40, "0")}`,
  amountAtomic: BigInt(publicSignals[4]).toString(),
  proof: encodedProof
};

console.log(JSON.stringify(packageJson, null, 2));
