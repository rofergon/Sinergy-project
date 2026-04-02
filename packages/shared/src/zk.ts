import { encodeAbiParameters } from "viem";
import type { Address, Hex } from "viem";

export const SNARK_SCALAR_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

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
