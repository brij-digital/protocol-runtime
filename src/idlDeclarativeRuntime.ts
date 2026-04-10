import BN from 'bn.js';
import {
  PublicKey,
  type AccountMeta,
} from '@solana/web3.js';
import {
  getProtocolById,
  loadProtocolCodamaDocument,
  loadRegistry,
  type ProtocolManifest,
} from './protocolLoader.js';
import {
  findCodamaInstructionByName,
  findCodamaTypeDefByName,
  type CodamaDocument as Idl,
  type CodamaInstructionAccountDefault,
} from './codamaIdl.js';
import { DirectInstructionCoder } from './directInstructionCoder.js';

type IdlInstructionAccount = {
  name: string;
  writable?: boolean;
  isMut?: boolean;
  signer?: boolean;
  isSigner?: boolean;
  optional?: boolean;
  isOptional?: boolean;
  address?: string;
  defaultValue?: CodamaInstructionAccountDefault;
  accounts?: IdlInstructionAccount[];
};

type IdlInstructionArg = {
  name: string;
  type: unknown;
};

type IdlInstruction = {
  name: string;
  args: IdlInstructionArg[];
  accounts: IdlInstructionAccount[];
};

type IdlTypeRef =
  | string
  | { option: IdlTypeRef }
  | { vec: IdlTypeRef }
  | { array: [IdlTypeRef, number] }
  | { defined: string | { name: string } };

type IdlStructField = {
  name: string;
  type: IdlTypeRef;
};

type IdlTypeDef = {
  name: string;
  type?: {
    kind?: string;
    fields?: IdlStructField[];
    variants?: Array<{ name: string; fields?: IdlStructField[] | IdlTypeRef[] }>;
  };
};

type RemainingAccountMetaInput = {
  pubkey: string;
  isSigner?: boolean;
  isWritable?: boolean;
};

type BnLike = {
  toString(base?: number): string;
  toArrayLike?: (arrayType: Uint8ArrayConstructor, endian: 'le' | 'be', length: number) => Uint8Array;
};

const idlCache = new Map<string, Idl>();
const INTEGER_TYPES = new Set([
  'u8',
  'u16',
  'u32',
  'u64',
  'u128',
  'i8',
  'i16',
  'i32',
  'i64',
  'i128',
]);

function toBase64(data: Uint8Array): string {
  let binary = '';
  for (const byte of data) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function isBnLike(value: unknown): value is BnLike {
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

function serializeForUi(value: unknown): unknown {
  if (isBnLike(value)) {
    return (value as { toString(): string }).toString();
  }

  if (value instanceof PublicKey) {
    return value.toBase58();
  }

  if (value instanceof Uint8Array) {
    return Array.from(value);
  }

  if (Array.isArray(value)) {
    return value.map(serializeForUi);
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      serializeForUi(nested),
    ]);
    return Object.fromEntries(entries);
  }

  return value;
}

function toSnakeCaseKey(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
}

function toCamelCaseKey(value: string): string {
  return value.replace(/[_-]([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

function findInstructionByName(idl: Idl, instructionName: string): IdlInstruction {
  const instruction = findCodamaInstructionByName(idl, instructionName) as unknown as IdlInstruction | null;

  if (!instruction) {
    throw new Error(`Instruction ${instructionName} not found in IDL.`);
  }

  return instruction;
}

function flattenInstructionAccounts(
  accounts: IdlInstructionAccount[],
  prefix = '',
): Array<{ keyName: string; definition: IdlInstructionAccount }> {
  const flattened: Array<{ keyName: string; definition: IdlInstructionAccount }> = [];

  for (const account of accounts) {
    const keyName = prefix ? `${prefix}.${account.name}` : account.name;
    if (account.accounts && account.accounts.length > 0) {
      flattened.push(...flattenInstructionAccounts(account.accounts, keyName));
      continue;
    }

    flattened.push({ keyName, definition: account });
  }

  return flattened;
}

function getArgInputValue(input: Record<string, unknown>, argName: string): unknown {
  const direct = input[argName];
  if (direct !== undefined) {
    return direct;
  }

  const snake = toSnakeCaseKey(argName);
  if (input[snake] !== undefined) {
    return input[snake];
  }

  const camel = toCamelCaseKey(argName);
  if (input[camel] !== undefined) {
    return input[camel];
  }

  return undefined;
}

function findDefinedTypeByName(idl: Idl, name: string): IdlTypeDef | null {
  return findCodamaTypeDefByName(idl, name) as unknown as IdlTypeDef | null;
}

function findEnumVariantByName(
  variants: Array<{ name: string; fields?: IdlStructField[] | IdlTypeRef[] }>,
  rawName: string,
): { name: string; fields?: IdlStructField[] | IdlTypeRef[] } | null {
  const normalized = toSnakeCaseKey(rawName);
  return (
    variants.find((variant) => variant.name === rawName) ??
    variants.find((variant) => toSnakeCaseKey(variant.name) === normalized) ??
    variants.find((variant) => toCamelCaseKey(variant.name) === rawName) ??
    null
  );
}

function normalizeValueByIdlType(idl: Idl, type: IdlTypeRef | unknown, value: unknown): unknown {
  if (typeof type === 'string') {
    if (INTEGER_TYPES.has(type)) {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
        throw new Error(`Expected integer-like value for ${type}.`);
      }
      return new BN(value.toString());
    }

    if (type === 'publicKey' || type === 'pubkey') {
      if (typeof value !== 'string') {
        throw new Error('Expected a base58 public key string.');
      }
      return new PublicKey(value);
    }

    if (type === 'bytes') {
      if (!Array.isArray(value)) {
        throw new Error('Expected byte array for bytes type.');
      }
      return Uint8Array.from(value as number[]);
    }

    return value;
  }

  if (type && typeof type === 'object') {
    if ('option' in type) {
      if (value === null || value === undefined) {
        return null;
      }
      return normalizeValueByIdlType(idl, type.option, value);
    }

    if ('vec' in type) {
      if (!Array.isArray(value)) {
        throw new Error('Expected array for vec type.');
      }
      return value.map((item) => normalizeValueByIdlType(idl, type.vec, item));
    }

    if ('array' in type) {
      if (!Array.isArray(value)) {
        throw new Error('Expected array for fixed array type.');
      }

      const arrayType = (type as { array: [IdlTypeRef, number] }).array;
      const [innerType, length] = arrayType;
      if (value.length !== Number(length)) {
        throw new Error(`Expected array of length ${String(length)}.`);
      }

      return value.map((item) => normalizeValueByIdlType(idl, innerType, item));
    }

    if ('defined' in type) {
      const definedType = (type as { defined: string | { name: string } }).defined;
      const definedName = typeof definedType === 'string' ? definedType : definedType?.name;
      if (!definedName) {
        throw new Error('Invalid defined type in IDL.');
      }

      const typeDef = findDefinedTypeByName(idl, definedName);
      if (!typeDef) {
        return value;
      }

      if (typeDef.type?.kind === 'struct') {
        const fields = typeDef.type.fields ?? [];
        const hasNamedFields = fields.every(
          (field) => typeof field === 'object' && field !== null && 'name' in field && 'type' in field,
        );
        if (!hasNamedFields) {
          // Tuple/unnamed-field structs are represented as arrays in Anchor coder input.
          // Convenience normalization: if a single field tuple receives a scalar, wrap it.
          if (!Array.isArray(value) && fields.length === 1) {
            const single = fields[0];
            if (typeof single === 'string') {
              return [normalizeValueByIdlType(idl, single, value)];
            }
            if (single && typeof single === 'object' && 'type' in single) {
              return [normalizeValueByIdlType(idl, (single as { type: IdlTypeRef }).type, value)];
            }
          }

          if (!Array.isArray(value)) {
            return value;
          }

          return value.map((item, index) => {
            const field = fields[index];
            if (typeof field === 'string') {
              return normalizeValueByIdlType(idl, field, item);
            }
            if (field && typeof field === 'object' && 'type' in field) {
              return normalizeValueByIdlType(idl, (field as { type: IdlTypeRef }).type, item);
            }
            return item;
          });
        }

        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error(`Expected object for defined struct ${definedName}.`);
        }

        const obj = value as Record<string, unknown>;
        const normalizedFields = fields.map((field) => {
          const fieldValue = getArgInputValue(obj, field.name);
          if (fieldValue === undefined) {
            throw new Error(`Missing field ${field.name} in defined struct ${definedName}.`);
          }

          return [field.name, normalizeValueByIdlType(idl, field.type, fieldValue)] as const;
        });

        return Object.fromEntries(normalizedFields);
      }

      if (typeDef.type?.kind === 'enum') {
        const variants = typeDef.type.variants ?? [];
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error(`Expected object for defined enum ${definedName}.`);
        }

        const input = value as Record<string, unknown>;
        let variant = null as { name: string; fields?: IdlStructField[] | IdlTypeRef[] } | null;
        let variantPayload: unknown = undefined;

        if (typeof input.__kind === 'string') {
          variant = findEnumVariantByName(variants, input.__kind);
          variantPayload = getArgInputValue(input, input.__kind) ?? input;
        } else {
          for (const candidate of variants) {
            const candidateValue = getArgInputValue(input, candidate.name);
            if (candidateValue !== undefined) {
              variant = candidate;
              variantPayload = candidateValue;
              break;
            }
          }
        }

        if (!variant) {
          throw new Error(`Cannot resolve enum variant for defined enum ${definedName}.`);
        }

        const fields = variant.fields ?? [];
        if (fields.length === 0) {
          return { [variant.name]: {} };
        }

        const hasNamedFields = fields.every(
          (field) => typeof field === 'object' && field !== null && 'name' in field && 'type' in field,
        );

        if (hasNamedFields) {
          const source =
            variantPayload && typeof variantPayload === 'object' && !Array.isArray(variantPayload)
              ? (variantPayload as Record<string, unknown>)
              : input;
          const normalizedFields = (fields as IdlStructField[]).map((field) => {
            const fieldValue = getArgInputValue(source, field.name);
            if (fieldValue === undefined) {
              throw new Error(`Missing field ${field.name} in enum variant ${variant.name}.`);
            }
            return [field.name, normalizeValueByIdlType(idl, field.type, fieldValue)] as const;
          });
          return { [variant.name]: Object.fromEntries(normalizedFields) };
        }

        const tupleSource =
          Array.isArray(variantPayload)
            ? variantPayload
            : Array.isArray((variantPayload as Record<string, unknown> | undefined)?.fields)
              ? ((variantPayload as Record<string, unknown>).fields as unknown[])
              : Array.isArray(input.fields)
                ? input.fields
                : variantPayload === undefined
                  ? []
                  : [variantPayload];

        const normalizedItems = (fields as IdlTypeRef[]).map((fieldType, index) =>
          normalizeValueByIdlType(idl, fieldType, tupleSource[index]),
        );
        return { [variant.name]: normalizedItems };
      }

      return value;
    }
  }

  return value;
}

async function loadProtocolAndIdl(protocolId: string): Promise<{ protocol: ProtocolManifest; idl: Idl }> {
  const protocol = await getProtocolById(protocolId);

  if (idlCache.has(protocol.id)) {
    return {
      protocol,
      idl: idlCache.get(protocol.id)!,
    };
  }

  const parsed = await loadProtocolCodamaDocument(protocolId);
  idlCache.set(protocol.id, parsed);

  return {
    protocol,
    idl: parsed,
  };
}

function resolveAccountPubkey(
  value: string,
  walletPublicKey: PublicKey,
): PublicKey {
  if (value === '$WALLET') {
    return walletPublicKey;
  }

  return new PublicKey(value);
}

function findSeedAccountKeyName(
  flattened: Array<{ keyName: string; definition: IdlInstructionAccount }>,
  accountName: string,
): string | null {
  const matches = flattened.filter(
    ({ keyName, definition }) => keyName === accountName || definition.name === accountName,
  );
  if (matches.length === 0) {
    return null;
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous Codama PDA seed account reference ${accountName}.`);
  }
  return matches[0]!.keyName;
}

function resolveInstructionAccounts(options: {
  idlInstruction: IdlInstruction;
  accountsInput: Record<string, string>;
  walletPublicKey: PublicKey;
  programId: string;
}): {
  accountMetas: AccountMeta[];
  resolvedAccounts: Record<string, string>;
} {
  const flattened = flattenInstructionAccounts(options.idlInstruction.accounts);
  const flattenedByKey = new Map(flattened.map((entry) => [entry.keyName, entry]));
  const resolved = new Map<string, PublicKey | null>();

  function resolveFlattenedAccount(keyName: string, resolving: Set<string>): PublicKey | null {
    if (resolved.has(keyName)) {
      return resolved.get(keyName)!;
    }

    const entry = flattenedByKey.get(keyName);
    if (!entry) {
      throw new Error(`Unknown instruction account ${keyName}.`);
    }

    if (resolving.has(keyName)) {
      throw new Error(`Cyclic Codama account default resolution for ${keyName}.`);
    }

    resolving.add(keyName);
    const { definition } = entry;
    const signer = Boolean(definition.signer ?? definition.isSigner);
    const optional = Boolean(definition.optional ?? definition.isOptional);

    const rawValue =
      definition.address ??
      options.accountsInput[keyName] ??
      options.accountsInput[definition.name] ??
      (signer ? '$WALLET' : undefined);

    let pubkey: PublicKey | null = null;
    if (rawValue) {
      pubkey = resolveAccountPubkey(rawValue, options.walletPublicKey);
    } else if (definition.defaultValue?.kind === 'address') {
      pubkey = new PublicKey(definition.defaultValue.address);
    } else if (definition.defaultValue?.kind === 'pda') {
      const seedBuffers = definition.defaultValue.seeds.map((seed) => {
        if (seed.kind === 'constant_bytes') {
          return Buffer.from(seed.bytes);
        }
        const seedAccountKeyName = findSeedAccountKeyName(flattened, seed.name);
        if (!seedAccountKeyName) {
          throw new Error(`Unknown Codama PDA seed account ${seed.name} for ${keyName}.`);
        }
        const seedPubkey = resolveFlattenedAccount(seedAccountKeyName, resolving);
        if (!seedPubkey) {
          throw new Error(`Codama PDA seed account ${seed.name} for ${keyName} resolved to null.`);
        }
        return seedPubkey.toBuffer();
      });
      const pdaProgramId = new PublicKey(definition.defaultValue.programId ?? options.programId);
      pubkey = PublicKey.findProgramAddressSync(seedBuffers, pdaProgramId)[0];
    } else if (!optional) {
      throw new Error(`Missing account mapping for ${keyName}.`);
    }

    // Additional signers (e.g. fresh keypairs for open_position) are valid.
    // The wallet is just one of potentially multiple signers.
    // The caller is responsible for providing the additional signer keypairs
    // when submitting the transaction.

    resolved.set(keyName, pubkey);
    resolving.delete(keyName);
    return pubkey;
  }

  const accountMetas = flattened
    .map(({ keyName, definition }) => {
      const signer = Boolean(definition.signer ?? definition.isSigner);
      const writable = Boolean(definition.writable ?? definition.isMut);
      const pubkey = resolveFlattenedAccount(keyName, new Set());
      if (!pubkey) {
        return null;
      }
      return {
        pubkey,
        isSigner: signer,
        isWritable: writable,
      } as AccountMeta;
    })
    .filter((meta): meta is AccountMeta => meta !== null);
  const resolvedAccounts = Object.fromEntries(
    flattened.flatMap(({ keyName }) => {
      const pubkey = resolved.get(keyName);
      return pubkey ? [[keyName, pubkey.toBase58()] as const] : [];
    }),
  );
  return { accountMetas, resolvedAccounts };
}

function buildAccountMetas(options: {
  idlInstruction: IdlInstruction;
  accountsInput: Record<string, string>;
  walletPublicKey: PublicKey;
  programId: string;
}): AccountMeta[] {
  return resolveInstructionAccounts(options).accountMetas;
}

function buildInstructionArgs(
  idl: Idl,
  instruction: IdlInstruction,
  rawArgs: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = instruction.args.map((arg) => {
    const rawValue = getArgInputValue(rawArgs, arg.name);
    if (rawValue === undefined) {
      throw new Error(`Missing required arg ${arg.name}.`);
    }

    return [arg.name, normalizeValueByIdlType(idl, arg.type, rawValue)] as const;
  });

  return Object.fromEntries(normalized);
}

function buildRemainingAccountMetas(
  remaining: RemainingAccountMetaInput[] | undefined,
): AccountMeta[] {
  if (!remaining || remaining.length === 0) {
    return [];
  }

  return remaining.map((entry) => {
    const pubkey = new PublicKey(entry.pubkey);
    return {
      pubkey,
      isSigner: Boolean(entry.isSigner),
      isWritable: Boolean(entry.isWritable),
    } as AccountMeta;
  });
}

function sampleValueForType(idl: Idl, type: IdlTypeRef | unknown): unknown {
  if (typeof type === 'string') {
    if (INTEGER_TYPES.has(type)) {
      return '0';
    }

    if (type === 'bool') {
      return false;
    }

    if (type === 'publicKey' || type === 'pubkey') {
      return '<PUBKEY>';
    }

    if (type === 'string') {
      return '';
    }

    if (type === 'bytes') {
      return [];
    }

    return null;
  }

  if (type && typeof type === 'object') {
    if ('option' in type) {
      return null;
    }

    if ('vec' in type) {
      return [];
    }

    if ('array' in type) {
      const arrayType = (type as { array: [IdlTypeRef, number] }).array;
      const [inner] = arrayType;
      return [sampleValueForType(idl, inner)];
    }

    if ('defined' in type) {
      const definedType = (type as { defined: string | { name: string } }).defined;
      const definedName = typeof definedType === 'string' ? definedType : definedType?.name;

      if (!definedName) {
        return {};
      }

      const typeDef = findDefinedTypeByName(idl, definedName);
      if (!typeDef || !typeDef.type) {
        return {};
      }

      if (typeDef.type.kind === 'struct') {
        const fields = (typeDef.type.fields ?? []).map((field) => [
          field.name,
          sampleValueForType(idl, field.type),
        ]);
        return Object.fromEntries(fields);
      }

      if (typeDef.type.kind === 'enum') {
        const variantNames = (typeDef.type.variants ?? []).map((variant) => variant.name).filter(Boolean);
        if (variantNames.length === 0) {
          throw new Error(`Cannot build sample for enum ${definedName}: enum has no variants.`);
        }
        return {
          variant: '__REQUIRED_ENUM_VARIANT__',
          allowed_variants: variantNames,
        };
      }
    }
  }

  return null;
}

export async function listIdlProtocols(): Promise<{
  version: string | null;
  globalCommands: string[];
    protocols: Array<{
      id: string;
      name: string;
      network: string;
      programId: string;
      codamaIdlPath: string | null;
      agentRuntimePath: string | null;
      supportedCommands: string[];
      status: 'active' | 'inactive';
    }>;
}> {
  const registry = await loadRegistry();
  return {
    version: typeof registry.version === 'string' ? registry.version : null,
    globalCommands: Array.isArray(registry.globalCommands)
      ? registry.globalCommands.filter((entry): entry is string => typeof entry === 'string')
      : [],
    protocols: registry.protocols.map((protocol) => ({
      id: protocol.id,
      name: protocol.name,
      network: protocol.network,
      programId: protocol.programId,
      codamaIdlPath: protocol.codamaIdlPath ?? null,
      agentRuntimePath: protocol.agentRuntimePath ?? null,
      supportedCommands: protocol.supportedCommands ?? [],
      status: protocol.status,
    })),
  };
}

export async function getInstructionTemplate(options: {
  protocolId: string;
  instructionName: string;
}): Promise<Record<string, unknown>> {
  const { protocol, idl } = await loadProtocolAndIdl(options.protocolId);
  const instruction = findInstructionByName(idl, options.instructionName);

  const argsTemplate = Object.fromEntries(
    instruction.args.map((arg) => [arg.name, sampleValueForType(idl, arg.type)]),
  );

  const accountsTemplate = Object.fromEntries(
    flattenInstructionAccounts(instruction.accounts).map(({ keyName, definition }) => {
      if (definition.address) {
        return [keyName, definition.address];
      }
      if (definition.defaultValue?.kind === 'address') {
        return [keyName, definition.defaultValue.address];
      }
      if (definition.defaultValue?.kind === 'pda') {
        return [keyName, `<AUTO_PDA:${definition.defaultValue.pdaName}>`];
      }

      const signer = Boolean(definition.signer ?? definition.isSigner);
      return [keyName, signer ? '$WALLET' : '<PUBKEY>'];
    }),
  );

  return {
    protocolId: protocol.id,
    protocolName: protocol.name,
    programId: protocol.programId,
    instruction: instruction.name,
    args: argsTemplate,
    accounts: accountsTemplate,
  };
}

export async function previewIdlInstruction(options: {
  protocolId: string;
  instructionName: string;
  args: Record<string, unknown>;
  accounts: Record<string, string>;
  remainingAccounts?: RemainingAccountMetaInput[];
  walletPublicKey: PublicKey;
}): Promise<{
  protocolId: string;
  instructionName: string;
  programId: string;
  dataBase64: string;
  keys: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  args: Record<string, unknown>;
  accounts: Record<string, string>;
  resolvedAccounts: Record<string, string>;
}> {
  const { protocol, idl } = await loadProtocolAndIdl(options.protocolId);
  const instruction = findInstructionByName(idl, options.instructionName);

  const args = buildInstructionArgs(idl, instruction, options.args);
  const instructionCoder = new DirectInstructionCoder(idl);
  const encodedData = instructionCoder.encode(instruction.name, args);
  if (!encodedData) {
    throw new Error('Failed to encode instruction from IDL.');
  }

  const { accountMetas, resolvedAccounts } = resolveInstructionAccounts({
    idlInstruction: instruction,
    accountsInput: options.accounts,
    walletPublicKey: options.walletPublicKey,
    programId: protocol.programId,
  });
  const remainingMetas = buildRemainingAccountMetas(options.remainingAccounts);
  const allMetas = [...accountMetas, ...remainingMetas];

  return {
    protocolId: options.protocolId,
    instructionName: instruction.name,
    programId: protocol.programId,
    dataBase64: toBase64(encodedData),
    keys: allMetas.map((meta) => ({
      pubkey: meta.pubkey.toBase58(),
      isSigner: meta.isSigner,
      isWritable: meta.isWritable,
    })),
    args: options.args,
    accounts: options.accounts,
    resolvedAccounts,
  };
}
