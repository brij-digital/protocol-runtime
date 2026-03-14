import { BN } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';

export function normalizeRuntimeValue(value: unknown): unknown {
  if (BN.isBN(value)) {
    return (value as BN).toString();
  }

  if (value instanceof PublicKey) {
    return value.toBase58();
  }

  if (Array.isArray(value)) {
    return value.map(normalizeRuntimeValue);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, normalizeRuntimeValue(nested)]),
    );
  }

  return value;
}
