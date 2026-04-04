import { encodeAbiParameters } from "viem";
import type { Address, Hex } from "viem";

export const SNARK_SCALAR_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const ZK_MERKLE_DEPTH = 20;

type PoseidonHasher = ((inputs: bigint[]) => unknown) & {
  F: {
    toString(value: unknown): string;
  };
};

type ZkLeafLike = {
  commitment: Hex;
};

type SerializableZkNoteInput = {
  secret: bigint | string;
  blinding: bigint | string;
  token: Address;
  amountAtomic: bigint | string;
};

let poseidonPromise: Promise<PoseidonHasher> | undefined;

function bigintify(value: bigint | string | number): bigint {
  return typeof value === "bigint" ? value : BigInt(value);
}

function bigintToHex(value: bigint, bytes = 32): Hex {
  return `0x${value.toString(16).padStart(bytes * 2, "0")}` as Hex;
}

async function getPoseidon(): Promise<PoseidonHasher> {
  if (!poseidonPromise) {
    poseidonPromise = import("circomlibjs").then(
      ({ buildPoseidon }) => buildPoseidon() as Promise<PoseidonHasher>
    );
  }

  return poseidonPromise;
}

export async function poseidonHash(inputs: readonly (bigint | string | number)[]): Promise<bigint> {
  const poseidon = await getPoseidon();
  return BigInt(poseidon.F.toString(poseidon(inputs.map(bigintify))));
}

export async function computeNoteCommitment(input: SerializableZkNoteInput): Promise<Hex> {
  return bigintToHex(
    await poseidonHash([
      input.secret,
      input.blinding,
      BigInt(input.token),
      bigintify(input.amountAtomic)
    ])
  );
}

export async function computeWithdrawalNullifier(input: {
  secret: bigint | string;
  recipient: Address;
}): Promise<Hex> {
  return bigintToHex(await poseidonHash([input.secret, BigInt(input.recipient)]));
}

export async function computeMerkleRoot(leaves: readonly Hex[], depth = ZK_MERKLE_DEPTH): Promise<Hex> {
  return (await buildMerkleTree(leaves, depth)).root;
}

export async function buildMerkleTree(
  leaves: readonly (Hex | ZkLeafLike)[],
  depth = ZK_MERKLE_DEPTH
): Promise<{
  root: Hex;
  levels: bigint[][];
 }> {
  const levelZero = leaves.map((leaf) =>
    typeof leaf === "string" ? BigInt(leaf) : BigInt(leaf.commitment)
  );
  const levels: bigint[][] = [levelZero];

  let current = levelZero;
  for (let level = 0; level < depth; level += 1) {
    const next: bigint[] = [];
    const pairCount = Math.max(1, Math.ceil(current.length / 2));

    for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
      const left = current[pairIndex * 2] ?? 0n;
      const right = current[pairIndex * 2 + 1] ?? 0n;
      next.push(await poseidonHash([left, right]));
    }

    current = next;
    levels.push(current);
  }

  return {
    root: bigintToHex(current[0] ?? 0n),
    levels
  };
}

export async function buildMerkleProof(
  leaves: readonly (Hex | ZkLeafLike)[],
  leafIndex: number,
  depth = ZK_MERKLE_DEPTH
): Promise<{
  root: Hex;
  pathElements: bigint[];
  pathIndices: number[];
}> {
  if (leafIndex < 0 || leafIndex >= leaves.length) {
    throw new Error(`Leaf index ${leafIndex} is out of range for ${leaves.length} leaves`);
  }

  const { root, levels } = await buildMerkleTree(leaves, depth);
  const pathElements: bigint[] = [];
  const pathIndices: number[] = [];

  let currentIndex = leafIndex;
  for (let level = 0; level < depth; level += 1) {
    const nodes = levels[level] ?? [];
    const isRightNode = currentIndex % 2 === 1;
    const siblingIndex = isRightNode ? currentIndex - 1 : currentIndex + 1;
    pathElements.push(nodes[siblingIndex] ?? 0n);
    pathIndices.push(isRightNode ? 1 : 0);
    currentIndex = Math.floor(currentIndex / 2);
  }

  return { root, pathElements, pathIndices };
}

export type Groth16Proof = {
  a: readonly [bigint, bigint];
  b: readonly [[bigint, bigint], [bigint, bigint]];
  c: readonly [bigint, bigint];
};

export function computeWithdrawalPublicSignals(input: {
  root: Hex;
  nullifier: Hex;
  recipient: Address;
  token: Address;
  amountAtomic: bigint;
}): readonly [bigint, bigint, bigint, bigint, bigint] {
  return [
    BigInt(input.root),
    BigInt(input.nullifier),
    BigInt(input.recipient),
    BigInt(input.token),
    input.amountAtomic
  ] as const;
}

export function encodeGroth16Proof(proof: Groth16Proof): Hex {
  return encodeAbiParameters(
    [{ type: "uint256[2]" }, { type: "uint256[2][2]" }, { type: "uint256[2]" }],
    [proof.a, proof.b, proof.c]
  );
}

export function encodeGroth16PublicSignals(
  signals: readonly [bigint, bigint, bigint, bigint, bigint]
): Hex {
  return encodeAbiParameters([{ type: "uint256[5]" }], [signals]);
}
