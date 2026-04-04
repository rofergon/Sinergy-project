import { existsSync, readFileSync } from "node:fs";
import type { Address, Hex, PublicClient } from "viem";
import {
  buildZkNoteProof,
  findExactZkNote,
  releaseExpiredZkNoteLocks,
  ZK_NOTE_LOCK_WINDOW_MS
} from "./zkState.js";
import { StateStore } from "./state.js";
import type { AppState } from "../types.js";
import {
  computeWithdrawalNullifier,
  darkStateAnchorAbi,
  encodeGroth16Proof
} from "@sinergy/shared";

export type ZkWithdrawalPackage = {
  root: Hex;
  nullifier: Hex;
  recipient: Address;
  token: Address;
  amountAtomic: string;
  proof: Hex;
};

type ZkProofServiceOptions = {
  store: StateStore;
  publicClient: PublicClient;
  proofPackageFile?: string;
  wasmFile: string;
  zkeyFile: string;
  stateAnchorAddress?: Address;
};

type FullProveResult = {
  proof: {
    pi_a: [string, string, string];
    pi_b: [[string, string], [string, string], [string, string]];
    pi_c: [string, string, string];
  };
  publicSignals: string[];
};

function keyOf(value: string): string {
  return value.toLowerCase();
}

export class ZkProofService {
  private readonly store: StateStore;
  private readonly publicClient: PublicClient;
  private readonly proofPackageFile?: string;
  private readonly wasmFile: string;
  private readonly zkeyFile: string;
  private readonly stateAnchorAddress?: Address;

  constructor(options: ZkProofServiceOptions) {
    this.store = options.store;
    this.publicClient = options.publicClient;
    this.proofPackageFile = options.proofPackageFile;
    this.wasmFile = options.wasmFile;
    this.zkeyFile = options.zkeyFile;
    this.stateAnchorAddress = options.stateAnchorAddress;
  }

  get configured() {
    return (
      (existsSync(this.wasmFile) && existsSync(this.zkeyFile)) ||
      (this.proofPackageFile !== undefined && existsSync(this.proofPackageFile))
    );
  }

  releaseExpiredLocks(now = Date.now()) {
    this.store.mutate((state) => {
      releaseExpiredZkNoteLocks(state, now);
    });
  }

  async prepareWithdrawalPackage(input: {
    recipient: Address;
    token: Address;
    amountAtomic: bigint;
  }): Promise<ZkWithdrawalPackage> {
    this.releaseExpiredLocks();

    const selection = this.store.mutate((state) => {
      const found = findExactZkNote(state, {
        userAddress: input.recipient,
        token: input.token,
        amountAtomic: input.amountAtomic
      });
      if (!found) {
        return undefined;
      }

      found.note.status = "pending";
      found.note.pendingRecipient = input.recipient;
      found.note.pendingSince = Date.now();

      return {
        noteId: found.note.id,
        noteIndex: found.index,
        noteSecret: found.note.secret,
        noteBlinding: found.note.blinding,
        amountAtomic: found.note.amountAtomic,
        token: found.note.token
      };
    });

    if (!selection) {
      return this.loadFallbackWithdrawalPackage(input);
    }

    try {
      const nullifier = await computeWithdrawalNullifier({
        secret: selection.noteSecret,
        recipient: input.recipient
      });
      const state = this.store.mutate((draft) => {
        const activeNote = draft.zkNotes[selection.noteIndex];
        if (!activeNote || activeNote.id !== selection.noteId || activeNote.status !== "pending") {
          throw new Error("Selected ZK note is no longer available");
        }

        activeNote.pendingNullifier = nullifier;
        return draft;
      });

      const { root, pathElements, pathIndices } = await buildZkNoteProof(state, selection.noteIndex);
      await this.ensureKnownRoot(root);

      const proof = await this.generateProof({
        root,
        nullifier,
        recipient: input.recipient,
        token: input.token,
        amountAtomic: input.amountAtomic,
        secret: selection.noteSecret,
        blinding: selection.noteBlinding,
        pathElements,
        pathIndices
      });

      return {
        root,
        nullifier,
        recipient: input.recipient,
        token: input.token,
        amountAtomic: input.amountAtomic.toString(),
        proof
      };
    } catch (error) {
      this.cancelPendingWithdrawal({
        recipient: input.recipient,
        token: input.token,
        amountAtomic: input.amountAtomic
      });
      throw error;
    }
  }

  cancelPendingWithdrawal(input: {
    recipient: Address;
    token: Address;
    amountAtomic: bigint;
    nullifier?: Hex;
  }) {
    return this.store.mutate((state) => {
      const recipientKey = keyOf(input.recipient);
      const tokenKey = keyOf(input.token);
      const amountAtomic = input.amountAtomic.toString();

      for (const note of state.zkNotes) {
        if (
          note.status === "pending" &&
          keyOf(note.userAddress) === recipientKey &&
          keyOf(note.token) === tokenKey &&
          note.amountAtomic === amountAtomic &&
          (!input.nullifier || note.pendingNullifier === input.nullifier)
        ) {
          note.status = "unspent";
          delete note.pendingRecipient;
          delete note.pendingNullifier;
          delete note.pendingSince;
          return { cancelled: true };
        }
      }

      return { cancelled: false };
    });
  }

  confirmWithdrawal(input: { nullifier: Hex }) {
    return this.store.mutate((state) => {
      for (const note of state.zkNotes) {
        if (note.pendingNullifier === input.nullifier) {
          note.status = "spent";
          note.spentNullifier = input.nullifier;
          note.spentAt = new Date().toISOString();
          delete note.pendingRecipient;
          delete note.pendingNullifier;
          delete note.pendingSince;
          return { spent: true, noteId: note.id };
        }
      }

      return { spent: false };
    });
  }

  private loadFallbackWithdrawalPackage(input: {
    recipient: Address;
    token: Address;
    amountAtomic: bigint;
  }): ZkWithdrawalPackage {
    if (!this.proofPackageFile) {
      throw new Error("No exact ZK note found for this token and amount");
    }

    if (!existsSync(this.proofPackageFile)) {
      throw new Error("No exact ZK note found for this token and amount");
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

  private async ensureKnownRoot(root: Hex) {
    if (!this.stateAnchorAddress || this.stateAnchorAddress === "0x0000000000000000000000000000000000000000") {
      throw new Error("ZK state anchor contract is not configured");
    }

    const isKnown = await this.publicClient.readContract({
      address: this.stateAnchorAddress,
      abi: darkStateAnchorAbi,
      functionName: "isKnownRoot",
      args: [root]
    });

    if (!isKnown) {
      throw new Error("The current private root is not anchored on-chain yet");
    }
  }

  private async generateProof(input: {
    root: Hex;
    nullifier: Hex;
    recipient: Address;
    token: Address;
    amountAtomic: bigint;
    secret: string;
    blinding: string;
    pathElements: bigint[];
    pathIndices: number[];
  }): Promise<Hex> {
    if (!existsSync(this.wasmFile)) {
      throw new Error(`Missing withdrawal circuit wasm: ${this.wasmFile}`);
    }
    if (!existsSync(this.zkeyFile)) {
      throw new Error(`Missing withdrawal final zkey: ${this.zkeyFile}`);
    }

    const snarkjsModule = (await import("snarkjs")) as {
      groth16: {
        fullProve(
          input: Record<string, unknown>,
          wasmFile: string,
          zkeyFile: string
        ): Promise<FullProveResult>;
      };
    };

    const result = await snarkjsModule.groth16.fullProve(
      {
        root: BigInt(input.root).toString(),
        nullifier: BigInt(input.nullifier).toString(),
        recipient: BigInt(input.recipient).toString(),
        token: BigInt(input.token).toString(),
        amount: input.amountAtomic.toString(),
        secret: input.secret,
        blinding: input.blinding,
        pathElements: input.pathElements.map((value) => value.toString()),
        pathIndices: input.pathIndices.map((value) => value.toString())
      },
      this.wasmFile,
      this.zkeyFile
    );

    if (!Array.isArray(result.publicSignals) || result.publicSignals.length !== 5) {
      throw new Error("Generated proof did not return the expected public signals");
    }

    return encodeGroth16Proof({
      a: [BigInt(result.proof.pi_a[0]), BigInt(result.proof.pi_a[1])],
      b: [
        [BigInt(result.proof.pi_b[0][1]), BigInt(result.proof.pi_b[0][0])],
        [BigInt(result.proof.pi_b[1][1]), BigInt(result.proof.pi_b[1][0])]
      ],
      c: [BigInt(result.proof.pi_c[0]), BigInt(result.proof.pi_c[1])]
    });
  }
}

export function enrichZkStateSnapshot(state: AppState) {
  releaseExpiredZkNoteLocks(state, Date.now(), ZK_NOTE_LOCK_WINDOW_MS);
  return state;
}
