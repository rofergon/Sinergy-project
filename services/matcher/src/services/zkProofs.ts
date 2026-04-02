import { existsSync, readFileSync } from "node:fs";
import type { Address, Hex } from "viem";

export type ZkWithdrawalPackage = {
  root: Hex;
  nullifier: Hex;
  recipient: Address;
  token: Address;
  amountAtomic: string;
  proof: Hex;
};

export class ZkProofService {
  constructor(private readonly proofPackageFile?: string) {}

  get configured() {
    return Boolean(this.proofPackageFile);
  }

  loadWithdrawalPackage(input: {
    recipient: Address;
    token: Address;
    amountAtomic: bigint;
  }): ZkWithdrawalPackage {
    if (!this.proofPackageFile) {
      throw new Error("ZK withdrawal package file is not configured");
    }

    if (!existsSync(this.proofPackageFile)) {
      throw new Error(`Missing ZK withdrawal package file: ${this.proofPackageFile}`);
    }

    const proofPackage = JSON.parse(
      readFileSync(this.proofPackageFile, "utf8")
    ) as ZkWithdrawalPackage;

    if (proofPackage.recipient.toLowerCase() !== input.recipient.toLowerCase()) {
      throw new Error("Configured proof package recipient does not match this request");
    }

    if (proofPackage.token.toLowerCase() !== input.token.toLowerCase()) {
      throw new Error("Configured proof package token does not match this request");
    }

    if (BigInt(proofPackage.amountAtomic) !== input.amountAtomic) {
      throw new Error("Configured proof package amount does not match this request");
    }

    return proofPackage;
  }
}
