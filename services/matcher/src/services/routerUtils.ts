import type { Address } from "viem";

export function keyOf(value: string): string {
  return value.toLowerCase();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function readBucket(
  root: Record<string, Record<string, string>>,
  address: string
): Record<string, string> {
  const key = keyOf(address);
  root[key] ??= {};
  return root[key];
}

export function addAtomic(
  root: Record<string, Record<string, string>>,
  address: string,
  token: string,
  delta: bigint
): void {
  const bucket = readBucket(root, address);
  const tokenKey = keyOf(token);
  const next = BigInt(bucket[tokenKey] ?? "0") + delta;
  bucket[tokenKey] = next.toString();
}

export function getAtomic(
  root: Record<string, Record<string, string>>,
  address: string,
  token: string
): bigint {
  return BigInt(readBucket(root, address)[keyOf(token)] ?? "0");
}

export function readInventoryAtomic(
  root: Record<string, string>,
  symbol: string
): bigint {
  return BigInt(root[keyOf(symbol)] ?? "0");
}

export function setInventoryAtomic(
  root: Record<string, string>,
  symbol: string,
  value: bigint
): void {
  root[keyOf(symbol)] = value.toString();
}

export function addInventoryAtomic(
  root: Record<string, string>,
  symbol: string,
  delta: bigint
): void {
  setInventoryAtomic(root, symbol, readInventoryAtomic(root, symbol) + delta);
}

export function isAddressString(value: string | undefined): value is Address {
  return Boolean(value && value.startsWith("0x"));
}

export function scaleAtomic(
  amount: bigint,
  fromDecimals: number,
  toDecimals: number
): bigint {
  if (fromDecimals === toDecimals) {
    return amount;
  }

  if (fromDecimals > toDecimals) {
    return amount / 10n ** BigInt(fromDecimals - toDecimals);
  }

  return amount * 10n ** BigInt(toDecimals - fromDecimals);
}
