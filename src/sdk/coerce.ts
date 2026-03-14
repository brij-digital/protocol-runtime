import { PublicKey } from '@solana/web3.js';

export function asPubkey(value: unknown, label: string): PublicKey {
  if (value instanceof PublicKey) {
    return value;
  }
  if (typeof value === 'string') {
    return new PublicKey(value);
  }
  throw new Error(`${label} must be a public key.`);
}

export function asBool(value: unknown, label: string): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  throw new Error(`${label} must be boolean.`);
}

export function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must resolve to an object.`);
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown, label: string): string {
  if (typeof value === 'string') {
    return value;
  }
  throw new Error(`${label} must be a string.`);
}

export function asIntegerString(value: unknown, label: string): string {
  const normalized = typeof value === 'number' || typeof value === 'bigint' ? value.toString() : value;
  if (typeof normalized !== 'string' || !/^-?\d+$/.test(normalized)) {
    throw new Error(`${label} must be an integer string.`);
  }
  return normalized;
}

export function asU64String(value: unknown, label: string): string {
  const normalized = asIntegerString(value, label);
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${label} must be an unsigned integer string.`);
  }
  return normalized;
}

export function asSafeInteger(value: unknown, label: string): number {
  const parsed = Number(asIntegerString(value, label));
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} must be a safe integer.`);
  }
  return parsed;
}

export function asBigInt(value: unknown, label: string): bigint {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`${label} must be a safe integer.`);
    }
    return BigInt(value);
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    return BigInt(value);
  }
  throw new Error(`${label} must be an integer-like value.`);
}

export function getRecordValue(record: Record<string, unknown>, candidates: string[], label: string): unknown {
  for (const candidate of candidates) {
    if (record[candidate] !== undefined) {
      return record[candidate];
    }
  }
  throw new Error(`Missing field ${label}. Expected one of: ${candidates.join(', ')}`);
}
