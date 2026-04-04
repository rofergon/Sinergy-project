import { buildMerkleProof, computeMerkleRoot, ZK_MERKLE_DEPTH } from "@sinergy/shared";
import type { Address, Hex } from "viem";
import type { AppState, StoredZkNote } from "../types.js";

export const ZK_NOTE_LOCK_WINDOW_MS = 5 * 60_000;

function keyOf(value: string): string {
  return value.toLowerCase();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function releaseExpiredZkNoteLocks(
  state: AppState,
  now = Date.now(),
  lockWindowMs = ZK_NOTE_LOCK_WINDOW_MS
) {
  for (const note of state.zkNotes) {
    if (
      note.status === "pending" &&
      note.pendingSince !== undefined &&
      now - note.pendingSince >= lockWindowMs
    ) {
      note.status = "unspent";
      delete note.pendingRecipient;
      delete note.pendingNullifier;
      delete note.pendingSince;
    }
  }
}

export function findExactZkNote(
  state: AppState,
  input: {
    userAddress: Address;
    token: Address;
    amountAtomic: bigint;
  }
): { note: StoredZkNote; index: number } | undefined {
  const userKey = keyOf(input.userAddress);
  const tokenKey = keyOf(input.token);
  const amountAtomic = input.amountAtomic.toString();

  for (let index = 0; index < state.zkNotes.length; index += 1) {
    const note = state.zkNotes[index];
    if (
      keyOf(note.userAddress) === userKey &&
      keyOf(note.token) === tokenKey &&
      note.amountAtomic === amountAtomic &&
      note.status === "unspent"
    ) {
      return { note, index };
    }
  }

  return undefined;
}

export async function getZkMerkleRoot(state: Pick<AppState, "zkNotes">): Promise<Hex> {
  return computeMerkleRoot(state.zkNotes.map((note) => note.commitment), ZK_MERKLE_DEPTH);
}

export async function buildZkNoteProof(
  state: Pick<AppState, "zkNotes">,
  noteIndex: number
): Promise<{
  root: Hex;
  pathElements: bigint[];
  pathIndices: number[];
}> {
  return buildMerkleProof(
    state.zkNotes.map((note) => note.commitment),
    noteIndex,
    ZK_MERKLE_DEPTH
  );
}
