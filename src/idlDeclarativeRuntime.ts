import BN from 'bn.js';
import type { WalletContextState } from '@solana/wallet-adapter-react';
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  type Connection,
  type AccountMeta,
} from '@solana/web3.js';
import {
  getProtocolById,
  loadRegistry,
  type ProtocolManifest,
} from './idlRegistry.js';
import {
  findCodamaAccountByName,
  findCodamaInstructionByName,
  findCodamaTypeDefByName,
  loadProtocolCodamaFromRuntime,
  type CodamaDocument as Idl,
} from './codamaIdl.js';
import { DirectAccountsCoder } from './directAccountsCoder.js';
import { DirectInstructionCoder } from './directInstructionCoder.js';
import { isBnLike } from './bnLike.js';

type IdlInstructionAccount = {
  name: string;
  writable?: boolean;
  isMut?: boolean;
  signer?: boolean;
  isSigner?: boolean;
  optional?: boolean;
  isOptional?: boolean;
  address?: string;
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

type IdlAccountDef = {
  name: string;
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
    variants?: Array<{ name: string }>;
  };
};

type RemainingAccountMetaInput = {
  pubkey: string;
  isSigner?: boolean;
  isWritable?: boolean;
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

  return undefined;
}

function findDefinedTypeByName(idl: Idl, name: string): IdlTypeDef | null {
  return findCodamaTypeDefByName(idl, name) as unknown as IdlTypeDef | null;
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

  const parsed = await loadProtocolCodamaFromRuntime(protocolId);
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

function buildAccountMetas(options: {
  idlInstruction: IdlInstruction;
  accountsInput: Record<string, string>;
  walletPublicKey: PublicKey;
}): AccountMeta[] {
  const flattened = flattenInstructionAccounts(options.idlInstruction.accounts);

  return flattened
    .map(({ keyName, definition }) => {
      const signer = Boolean(definition.signer ?? definition.isSigner);
      const writable = Boolean(definition.writable ?? definition.isMut);
      const optional = Boolean(definition.optional ?? definition.isOptional);

      const rawValue =
        definition.address ??
        options.accountsInput[keyName] ??
        options.accountsInput[definition.name] ??
        (signer ? '$WALLET' : undefined);

      if (!rawValue) {
        if (optional) {
          return null;
        }

        throw new Error(`Missing account mapping for ${keyName}.`);
      }

      const pubkey = resolveAccountPubkey(rawValue, options.walletPublicKey);

      if (signer && !pubkey.equals(options.walletPublicKey)) {
        throw new Error(
          `Unsupported signer ${keyName}: only the connected wallet signer is currently supported.`,
        );
      }

      return {
        pubkey,
        isSigner: signer,
        isWritable: writable,
      } as AccountMeta;
    })
    .filter((meta): meta is AccountMeta => meta !== null);
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
      indexingSpecPath: string | null;
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
      indexingSpecPath: protocol.indexingSpecPath ?? null,
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

export async function decodeIdlAccount(options: {
  protocolId: string;
  accountType: string;
  address: string;
  connection: Connection;
}): Promise<{ accountType: string; address: string; data: unknown }> {
  const { idl } = await loadProtocolAndIdl(options.protocolId);

  const resolvedAccount = findCodamaAccountByName(idl, options.accountType) as unknown as IdlAccountDef | null;

  if (!resolvedAccount) {
    throw new Error(`Account type ${options.accountType} not found in IDL.`);
  }

  const pubkey = new PublicKey(options.address);
  const accountInfo = await options.connection.getAccountInfo(pubkey, 'confirmed');
  if (!accountInfo) {
    throw new Error(`Account ${options.address} not found on-chain.`);
  }

  const coder = new DirectAccountsCoder(idl);
  const decoded = coder.decode(resolvedAccount.name, accountInfo.data);

  return {
    accountType: resolvedAccount.name,
    address: options.address,
    data: serializeForUi(decoded),
  };
}

async function prepareSignedIdlTransaction(options: {
  protocolId: string;
  instructionName: string;
  args: Record<string, unknown>;
  accounts: Record<string, string>;
  remainingAccounts?: RemainingAccountMetaInput[];
  preInstructions?: TransactionInstruction[];
  postInstructions?: TransactionInstruction[];
  connection: Connection;
  wallet: WalletContextState;
}): Promise<{
  tx: Transaction;
  latestBlockhash: { blockhash: string; lastValidBlockHeight: number };
}> {
  if (!options.wallet.publicKey) {
    throw new Error('Connect a wallet first.');
  }

  const { protocol, idl } = await loadProtocolAndIdl(options.protocolId);
  const instruction = findInstructionByName(idl, options.instructionName);

  const args = buildInstructionArgs(idl, instruction, options.args);
  const instructionCoder = new DirectInstructionCoder(idl);
  const encodedData = instructionCoder.encode(instruction.name, args);
  if (!encodedData) {
    throw new Error('Failed to encode instruction from IDL.');
  }

  const accountMetas = buildAccountMetas({
    idlInstruction: instruction,
    accountsInput: options.accounts,
    walletPublicKey: options.wallet.publicKey,
  });
  const remainingMetas = buildRemainingAccountMetas(options.remainingAccounts);

  const txInstruction = new TransactionInstruction({
    programId: new PublicKey(protocol.programId),
    keys: [...accountMetas, ...remainingMetas],
    data: encodedData,
  });

  const tx = new Transaction();
  for (const preIx of options.preInstructions ?? []) {
    tx.add(preIx);
  }
  tx.add(txInstruction);
  for (const postIx of options.postInstructions ?? []) {
    tx.add(postIx);
  }
  tx.feePayer = options.wallet.publicKey;

  const latestBlockhash = await options.connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = latestBlockhash.blockhash;

  return { tx, latestBlockhash };
}

function formatSimulationError(simulation: Awaited<ReturnType<Connection['simulateTransaction']>>): string {
  const logs = simulation.value.logs?.join('\n') ?? 'No simulation logs available.';
  return `Simulation failed: ${JSON.stringify(simulation.value.err)}\n${logs}`;
}

export async function sendIdlInstruction(options: {
  protocolId: string;
  instructionName: string;
  args: Record<string, unknown>;
  accounts: Record<string, string>;
  remainingAccounts?: RemainingAccountMetaInput[];
  preInstructions?: TransactionInstruction[];
  postInstructions?: TransactionInstruction[];
  connection: Connection;
  wallet: WalletContextState;
  onStatus?: (status: 'preparing' | 'simulating' | 'awaiting_wallet_approval' | 'submitting' | 'confirming' | 'confirmed') => void;
}): Promise<{ signature: string; explorerUrl: string }> {
  if (!options.wallet.signTransaction) {
    throw new Error('Connected wallet does not support transaction signing.');
  }

  options.onStatus?.('preparing');
  const { tx, latestBlockhash } = await prepareSignedIdlTransaction(options);

  options.onStatus?.('simulating');
  const simulation = await options.connection.simulateTransaction(tx);

  if (simulation.value.err) {
    throw new Error(formatSimulationError(simulation));
  }

  options.onStatus?.('awaiting_wallet_approval');
  const signedTx = await options.wallet.signTransaction(tx);
  options.onStatus?.('submitting');
  const signature = await options.connection.sendRawTransaction(signedTx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });

  options.onStatus?.('confirming');
  await options.connection.confirmTransaction(
    {
      signature,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    },
    'confirmed',
  );

  options.onStatus?.('confirmed');

  return {
    signature,
    explorerUrl: `https://solscan.io/tx/${signature}`,
  };
}

export async function simulateIdlInstruction(options: {
  protocolId: string;
  instructionName: string;
  args: Record<string, unknown>;
  accounts: Record<string, string>;
  remainingAccounts?: RemainingAccountMetaInput[];
  preInstructions?: TransactionInstruction[];
  postInstructions?: TransactionInstruction[];
  includeAccounts?: string[];
  connection: Connection;
  wallet: WalletContextState;
}): Promise<{
  ok: boolean;
  logs: string[];
  unitsConsumed: number | null;
  error: string | null;
  accounts: Array<{ address: string; dataBase64: string | null }>;
}> {
  const { tx } = await prepareSignedIdlTransaction(options);
  const includeAccounts = options.includeAccounts?.map((address) => new PublicKey(address));
  const simulation = await options.connection.simulateTransaction(tx, undefined, includeAccounts);

  return {
    ok: simulation.value.err === null,
    logs: simulation.value.logs ?? [],
    unitsConsumed: simulation.value.unitsConsumed ?? null,
    error: simulation.value.err ? JSON.stringify(simulation.value.err) : null,
    accounts:
      includeAccounts?.map((pubkey, index) => {
        const account = simulation.value.accounts?.[index];
        let dataBase64: string | null = null;
        if (account?.data && Array.isArray(account.data) && typeof account.data[0] === 'string') {
          dataBase64 = account.data[0];
        }

        return {
          address: pubkey.toBase58(),
          dataBase64,
        };
      }) ?? [],
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
}> {
  const { protocol, idl } = await loadProtocolAndIdl(options.protocolId);
  const instruction = findInstructionByName(idl, options.instructionName);

  const args = buildInstructionArgs(idl, instruction, options.args);
  const instructionCoder = new DirectInstructionCoder(idl);
  const encodedData = instructionCoder.encode(instruction.name, args);
  if (!encodedData) {
    throw new Error('Failed to encode instruction from IDL.');
  }

  const accountMetas = buildAccountMetas({
    idlInstruction: instruction,
    accountsInput: options.accounts,
    walletPublicKey: options.walletPublicKey,
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
  };
}
