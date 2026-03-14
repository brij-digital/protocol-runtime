import type { Idl } from '@coral-xyz/anchor';
import { sha256 } from '@noble/hashes/sha256';

type LegacyIdlAccountWithInlineType = {
  name?: string;
  type?: unknown;
  discriminator?: number[];
};

type LegacyIdlInstruction = {
  name?: string;
  discriminator?: number[];
};

type LegacyIdlTypeDef = {
  name?: string;
  type?: unknown;
};

function computeAnchorDiscriminator(namespace: string, name: string): number[] {
  const preimage = new TextEncoder().encode(`${namespace}:${name}`);
  return Array.from(sha256(preimage).slice(0, 8));
}

function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
}

function rewriteLegacyTypeRefs(value: unknown): unknown {
  if (value === 'publicKey') {
    return 'pubkey';
  }

  if (Array.isArray(value)) {
    return value.map((entry) => rewriteLegacyTypeRefs(entry));
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if ('defined' in record && typeof record.defined === 'string') {
      return {
        ...Object.fromEntries(
          Object.entries(record)
            .filter(([key]) => key !== 'defined')
            .map(([key, nested]) => [key, rewriteLegacyTypeRefs(nested)]),
        ),
        defined: { name: record.defined },
      };
    }

    return Object.fromEntries(
      Object.entries(record).map(([key, nested]) => [key, rewriteLegacyTypeRefs(nested)]),
    );
  }

  return value;
}

export function normalizeIdlForAnchorCoder(idl: Idl): Idl {
  const rewritten = rewriteLegacyTypeRefs(idl) as Idl;
  const accountEntries = (
    (rewritten as unknown as { accounts?: unknown[] }).accounts ?? []
  ) as LegacyIdlAccountWithInlineType[];
  const instructionEntries = (
    (rewritten as unknown as { instructions?: unknown[] }).instructions ?? []
  ) as LegacyIdlInstruction[];
  const types = ((rewritten as unknown as { types?: unknown[] }).types ?? []) as LegacyIdlTypeDef[];
  const typeNames = new Set(
    types
      .map((entry) => (typeof entry?.name === 'string' ? entry.name : null))
      .filter((name): name is string => name !== null),
  );

  const normalizedAccounts = accountEntries.map((account) => {
    if (!account || typeof account.name !== 'string') {
      return account;
    }

    if (Array.isArray(account.discriminator) && account.discriminator.length === 8) {
      return account;
    }

    return {
      ...account,
      discriminator: computeAnchorDiscriminator('account', account.name),
    };
  });
  const normalizedInstructions = instructionEntries.map((instruction) => {
    if (!instruction || typeof instruction.name !== 'string') {
      return instruction;
    }

    if (Array.isArray(instruction.discriminator) && instruction.discriminator.length === 8) {
      return instruction;
    }

    return {
      ...instruction,
      // Legacy IDLs often expose camelCase names, while Anchor computes the
      // discriminator from the snake_case Rust method name.
      discriminator: computeAnchorDiscriminator('global', toSnakeCase(instruction.name)),
    };
  });

  const extraTypeDefs: LegacyIdlTypeDef[] = [];
  for (const account of normalizedAccounts) {
    if (typeof account?.name !== 'string' || !account.type) {
      continue;
    }
    if (typeNames.has(account.name)) {
      continue;
    }
    typeNames.add(account.name);
    extraTypeDefs.push({
      name: account.name,
      type: account.type,
    });
  }

  if (extraTypeDefs.length === 0) {
    return {
      ...(rewritten as Record<string, unknown>),
      accounts: normalizedAccounts,
      instructions: normalizedInstructions,
    } as Idl;
  }

  return {
    ...(rewritten as Record<string, unknown>),
    accounts: normalizedAccounts,
    instructions: normalizedInstructions,
    types: [...types, ...extraTypeDefs],
  } as Idl;
}
