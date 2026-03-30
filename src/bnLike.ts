export type BnLike = {
  toString(base?: number): string;
  toArrayLike?: (arrayType: Uint8ArrayConstructor, endian: 'le' | 'be', length: number) => Uint8Array;
};

export function isBnLike(value: unknown): value is BnLike {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as {
    constructor?: { name?: string };
    toString?: (base?: number) => string;
    toArrayLike?: (arrayType: Uint8ArrayConstructor, endian: 'le' | 'be', length: number) => Uint8Array;
  };

  return (
    candidate.constructor?.name === 'BN' &&
    typeof candidate.toString === 'function' &&
    typeof candidate.toArrayLike === 'function'
  );
}
