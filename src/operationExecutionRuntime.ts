import BN from 'bn.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { Connection } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import { getProtocolById } from './idlRegistry.js';
import { previewIdlInstruction } from './idlDeclarativeRuntime.js';
import { runRegisteredComputeStep } from './metaComputeRegistry.js';
import {
  loadProtocolCodamaFromRuntime,
  type CodamaDocument as Idl,
} from './codamaIdl.js';
import { DirectAccountsCoder } from './directAccountsCoder.js';
import {
  hydrateAndValidateRuntimeInputs,
  type MaterializedRuntimeOperation,
  type RuntimeOperationExplain,
  type RuntimePack,
  explainRuntimeOperation,
  resolveRuntimeOperation,
} from './operationPackRuntime.js';

const DEFAULT_SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const DEFAULT_ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

type JsonRecord = Record<string, unknown>;

type ResolveStep = {
  name: string;
  kind: string;
  [key: string]: unknown;
};

type ComputeStep = {
  name: string;
  kind: string;
  [key: string]: unknown;
};

type MetaCondition =
  | { equals: [unknown, unknown] }
  | { all: MetaCondition[] }
  | { any: MetaCondition[] }
  | { not: MetaCondition };

type PostInstructionSpec = {
  kind: 'spl_token_close_account';
  account: unknown;
  destination: unknown;
  owner: unknown;
  token_program?: unknown;
  when?: MetaCondition;
};

type PreInstructionSpec =
  | {
      kind: 'spl_ata_create_idempotent';
      payer: unknown;
      ata: unknown;
      owner: unknown;
      mint: unknown;
      token_program?: unknown;
      associated_token_program?: unknown;
      when?: MetaCondition;
    }
  | {
      kind: 'system_transfer';
      from: unknown;
      to: unknown;
      lamports: unknown;
      when?: MetaCondition;
    }
  | {
      kind: 'spl_token_sync_native';
      account: unknown;
      token_program?: unknown;
      when?: MetaCondition;
    };

export type PreparedPreInstruction =
  | {
      kind: 'spl_ata_create_idempotent';
      payer: string;
      ata: string;
      owner: string;
      mint: string;
      tokenProgram: string;
      associatedTokenProgram: string;
    }
  | {
      kind: 'system_transfer';
      from: string;
      to: string;
      lamports: string;
    }
  | {
      kind: 'spl_token_sync_native';
      account: string;
      tokenProgram: string;
    };

export type PreparedPostInstruction = {
  kind: 'spl_token_close_account';
  account: string;
  destination: string;
  owner: string;
  tokenProgram: string;
};

export type PreparedMetaInstruction = {
  protocolId: string;
  instructionName: string;
  args: Record<string, unknown>;
  accounts: Record<string, string>;
  remainingAccounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  derived: Record<string, unknown>;
  preInstructions: PreparedPreInstruction[];
  postInstructions: PreparedPostInstruction[];
};

export type PreparedMetaOperation = {
  protocolId: string;
  operationId: string;
  instructionName: string | null;
  args: Record<string, unknown>;
  accounts: Record<string, string>;
  remainingAccounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  derived: Record<string, unknown>;
  readOutput?: {
    type: 'array' | 'object' | 'scalar' | 'list';
    source: string;
    objectSchema?: {
      entity_type?: string;
      identity_fields?: string[];
      fields: Record<string, { type: string; required?: boolean; description?: string }>;
    };
    itemSchema?: {
      entity_type?: string;
      identity_fields?: string[];
      fields: Record<string, { type: string; required?: boolean; description?: string }>;
    };
    scalarType?: string;
  };
  preInstructions: PreparedPreInstruction[];
  postInstructions: PreparedPostInstruction[];
};

export type PreparedMetaCompute = {
  protocolId: string;
  operationId: string;
  derived: Record<string, unknown>;
  output: unknown;
  readOutput?: {
    type: 'array' | 'object' | 'scalar' | 'list';
    source: string;
    objectSchema?: {
      entity_type?: string;
      identity_fields?: string[];
      fields: Record<string, { type: string; required?: boolean; description?: string }>;
    };
    itemSchema?: {
      entity_type?: string;
      identity_fields?: string[];
      fields: Record<string, { type: string; required?: boolean; description?: string }>;
    };
    scalarType?: string;
  };
};

type ResolverContext = {
  protocol: {
    id: string;
    name: string;
    network: string;
    programId: string;
  };
  runtime: RuntimePack;
  input: Record<string, unknown>;
  idl: Idl;
  connection: Connection;
  walletPublicKey: PublicKey;
  scope: Record<string, unknown>;
};

const idlCache = new Map<string, Idl>();

function asRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must resolve to an object.`);
  }
  return value as JsonRecord;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string.`);
  }
  return value;
}

function normalizeRuntimeValue(value: unknown): unknown {
  if (BN.isBN(value)) {
    return (value as { toString(): string }).toString();
  }
  if (value instanceof PublicKey) {
    return value.toBase58();
  }
  if (Array.isArray(value)) {
    return value.map(normalizeRuntimeValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as JsonRecord).map(([key, nested]) => [key, normalizeRuntimeValue(nested)]),
    );
  }
  return value;
}

function readPathFromValue(value: unknown, path: string): unknown {
  const cleaned = path.startsWith('$') ? path.slice(1) : path;
  const parts = cleaned.split('.').filter(Boolean);
  let current: unknown = value;
  for (const part of parts) {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    current = (current as JsonRecord)[part];
  }
  return current;
}

function resolvePath(scope: JsonRecord, path: string): unknown {
  const resolved = readPathFromValue(scope, path);
  if (resolved === undefined) {
    throw new Error(`Cannot resolve path ${path}`);
  }
  return resolved;
}

function resolveTemplateValue(value: unknown, scope: JsonRecord): unknown {
  if (typeof value === 'string' && value.startsWith('$')) {
    return resolvePath(scope, value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplateValue(item, scope));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as JsonRecord).map(([key, nested]) => [key, resolveTemplateValue(nested, scope)]),
    );
  }
  return value;
}

function normalizeComparable(value: unknown): unknown {
  const normalized = normalizeRuntimeValue(value);
  if (Array.isArray(normalized)) {
    return normalized.map(normalizeComparable);
  }
  if (normalized && typeof normalized === 'object') {
    const entries = Object.entries(normalized as JsonRecord)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => [key, normalizeComparable(nested)] as const);
    return Object.fromEntries(entries);
  }
  return normalized;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizeComparable(left)) === JSON.stringify(normalizeComparable(right));
}

function asU64String(value: unknown, label: string): string {
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value)) {
      throw new Error(`${label} must be an unsigned integer string.`);
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
      throw new Error(`${label} must be a non-negative integer.`);
    }
    return String(value);
  }
  if (typeof value === 'bigint') {
    if (value < 0n) {
      throw new Error(`${label} must be non-negative.`);
    }
    return value.toString();
  }
  throw new Error(`${label} must resolve to u64-compatible value.`);
}

function asPubkey(value: unknown, label: string): PublicKey {
  if (value instanceof PublicKey) {
    return value;
  }
  if (typeof value === 'string') {
    return new PublicKey(value);
  }
  throw new Error(`${label} must be a public key.`);
}

function assertStringRecord(value: unknown, label: string): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must resolve to an object.`);
  }
  const mapped = Object.entries(value as JsonRecord).map(([key, entry]) => {
    const normalized = normalizeRuntimeValue(entry);
    if (typeof normalized !== 'string') {
      throw new Error(`${label}.${key} must resolve to string.`);
    }
    return [key, normalized] as const;
  });
  return Object.fromEntries(mapped);
}

function assertRemainingAccounts(
  value: unknown,
  label: string,
): Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }> {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must resolve to an array.`);
  }
  return value.map((entry, index) => {
    const item = asRecord(entry, `${label}[${index}]`);
    const pubkey = normalizeRuntimeValue(item.pubkey);
    if (typeof pubkey !== 'string') {
      throw new Error(`${label}[${index}].pubkey must resolve to string.`);
    }
    return { pubkey, isSigner: Boolean(item.isSigner), isWritable: Boolean(item.isWritable) };
  });
}

function normalizeReadOutputSpec(
  spec: MaterializedRuntimeOperation['readOutput'] | undefined,
  context: string,
): PreparedMetaOperation['readOutput'] | undefined {
  if (!spec) {
    return undefined;
  }
  if (!spec.source || typeof spec.source !== 'string' || spec.source.trim().length === 0) {
    throw new Error(`${context}: read_output.source is required.`);
  }
  const normalized: NonNullable<PreparedMetaOperation['readOutput']> = { type: spec.type, source: spec.source };
  if (spec.object_schema && typeof spec.object_schema === 'object') {
    normalized.objectSchema = normalizeRuntimeValue(spec.object_schema) as NonNullable<typeof normalized.objectSchema>;
  }
  if (spec.item_schema && typeof spec.item_schema === 'object') {
    normalized.itemSchema = normalizeRuntimeValue(spec.item_schema) as NonNullable<typeof normalized.itemSchema>;
  }
  if (typeof spec.scalar_type === 'string' && spec.scalar_type.length > 0) {
    normalized.scalarType = spec.scalar_type;
  }
  return normalized;
}

async function loadProtocolIdl(protocolId: string): Promise<Idl> {
  const cached = idlCache.get(protocolId);
  if (cached) {
    return cached;
  }
  const parsed = await loadProtocolCodamaFromRuntime(protocolId);
  idlCache.set(protocolId, parsed);
  return parsed;
}

function evaluateCondition(condition: MetaCondition, scope: JsonRecord): boolean {
  if ('equals' in condition) {
    const [left, right] = condition.equals;
    return valuesEqual(normalizeRuntimeValue(resolveTemplateValue(left, scope)), normalizeRuntimeValue(resolveTemplateValue(right, scope)));
  }
  if ('all' in condition) {
    return condition.all.every((entry) => evaluateCondition(entry, scope));
  }
  if ('any' in condition) {
    return condition.any.some((entry) => evaluateCondition(entry, scope));
  }
  return !evaluateCondition(condition.not, scope);
}

function resolvePostInstructions(post: PostInstructionSpec[] | undefined, scope: JsonRecord): PreparedPostInstruction[] {
  if (!post || post.length === 0) {
    return [];
  }
  return post
    .filter((spec) => (spec.when ? evaluateCondition(spec.when, scope) : true))
    .map((spec) => ({
      kind: 'spl_token_close_account',
      account: asString(resolveTemplateValue(spec.account, scope), 'post.account'),
      destination: asString(resolveTemplateValue(spec.destination, scope), 'post.destination'),
      owner: asString(resolveTemplateValue(spec.owner, scope), 'post.owner'),
      tokenProgram: spec.token_program
        ? asString(resolveTemplateValue(spec.token_program, scope), 'post.token_program')
        : DEFAULT_SPL_TOKEN_PROGRAM,
    }));
}

function resolvePreInstructions(pre: PreInstructionSpec[] | undefined, scope: JsonRecord): PreparedPreInstruction[] {
  if (!pre || pre.length === 0) {
    return [];
  }
  return pre
    .filter((spec) => (spec.when ? evaluateCondition(spec.when, scope) : true))
    .map((spec) => {
      if (spec.kind === 'spl_ata_create_idempotent') {
        return {
          kind: 'spl_ata_create_idempotent',
          payer: asString(resolveTemplateValue(spec.payer, scope), 'pre.payer'),
          ata: asString(resolveTemplateValue(spec.ata, scope), 'pre.ata'),
          owner: asString(resolveTemplateValue(spec.owner, scope), 'pre.owner'),
          mint: asString(resolveTemplateValue(spec.mint, scope), 'pre.mint'),
          tokenProgram: spec.token_program
            ? asString(resolveTemplateValue(spec.token_program, scope), 'pre.token_program')
            : DEFAULT_SPL_TOKEN_PROGRAM,
          associatedTokenProgram: spec.associated_token_program
            ? asString(resolveTemplateValue(spec.associated_token_program, scope), 'pre.associated_token_program')
            : DEFAULT_ASSOCIATED_TOKEN_PROGRAM,
        };
      }
      if (spec.kind === 'system_transfer') {
        return {
          kind: 'system_transfer',
          from: asString(resolveTemplateValue(spec.from, scope), 'pre.from'),
          to: asString(resolveTemplateValue(spec.to, scope), 'pre.to'),
          lamports: asU64String(resolveTemplateValue(spec.lamports, scope), 'pre.lamports'),
        };
      }
      return {
        kind: 'spl_token_sync_native',
        account: asString(resolveTemplateValue(spec.account, scope), 'pre.account'),
        tokenProgram: spec.token_program
          ? asString(resolveTemplateValue(spec.token_program, scope), 'pre.token_program')
          : DEFAULT_SPL_TOKEN_PROGRAM,
      };
    });
}

async function runResolver(step: ResolveStep, ctx: ResolverContext): Promise<unknown> {
  if (step.kind === 'wallet_pubkey') {
    return ctx.walletPublicKey.toBase58();
  }
  if (step.kind === 'decode_account') {
    const address = asPubkey(resolveTemplateValue(step.address, ctx.scope), `decode_account:${step.name}:address`);
    const accountType = asString(step.account_type, `decode_account:${step.name}:account_type`);
    const info = await ctx.connection.getAccountInfo(address, 'confirmed');
    if (!info) {
      throw new Error(`Account not found for decode_account ${step.name}: ${address.toBase58()}`);
    }
    const coder = new DirectAccountsCoder(ctx.idl);
    return normalizeRuntimeValue(coder.decode(accountType, info.data));
  }
  if (step.kind === 'account_owner') {
    const address = asPubkey(resolveTemplateValue(step.address, ctx.scope), `account_owner:${step.name}:address`);
    const info = await ctx.connection.getAccountInfo(address, 'confirmed');
    if (!info) {
      throw new Error(`Account not found for account_owner ${step.name}: ${address.toBase58()}`);
    }
    return info.owner.toBase58();
  }
  if (step.kind === 'token_account_balance') {
    const address = asPubkey(resolveTemplateValue(step.address, ctx.scope), `token_account_balance:${step.name}:address`);
    try {
      const balance = await ctx.connection.getTokenAccountBalance(address, 'confirmed');
      return balance.value.amount;
    } catch (error) {
      const allowMissing = step.allow_missing === undefined ? false : Boolean(resolveTemplateValue(step.allow_missing, ctx.scope));
      if (!allowMissing) {
        throw error;
      }
      const defaultValue = step.default === undefined ? '0' : normalizeRuntimeValue(resolveTemplateValue(step.default, ctx.scope));
      return String(defaultValue);
    }
  }
  if (step.kind === 'token_supply') {
    const mint = asPubkey(resolveTemplateValue(step.mint, ctx.scope), `token_supply:${step.name}:mint`);
    const supply = await ctx.connection.getTokenSupply(mint, 'confirmed');
    return supply.value.amount;
  }
  if (step.kind === 'ata') {
    const owner = asPubkey(resolveTemplateValue(step.owner, ctx.scope), `ata:${step.name}:owner`);
    const mint = asPubkey(resolveTemplateValue(step.mint, ctx.scope), `ata:${step.name}:mint`);
    const tokenProgram = step.token_program === undefined ? undefined : asPubkey(resolveTemplateValue(step.token_program, ctx.scope), `ata:${step.name}:token_program`);
    const allowOwnerOffCurve = step.allow_owner_off_curve === undefined ? false : Boolean(resolveTemplateValue(step.allow_owner_off_curve, ctx.scope));
    return getAssociatedTokenAddressSync(mint, owner, allowOwnerOffCurve, tokenProgram).toBase58();
  }
  if (step.kind === 'pda') {
    const programId = asPubkey(resolveTemplateValue(step.program_id, ctx.scope), `pda:${step.name}:program_id`);
    const seeds = Array.isArray(step.seeds) ? step.seeds.map((seed, index) => {
      if (typeof seed === 'string' && seed.startsWith('utf8:')) {
        return new TextEncoder().encode(seed.slice('utf8:'.length));
      }
      return asPubkey(resolveTemplateValue(seed, ctx.scope), `pda:${step.name}:seed[${index}]`).toBuffer();
    }) : [];
    return PublicKey.findProgramAddressSync(seeds, programId)[0].toBase58();
  }
  if (step.kind === 'unix_timestamp') {
    return Math.floor(Date.now() / 1000);
  }
  throw new Error(`Unsupported resolver: ${step.kind}`);
}

async function runComputeStep(step: ComputeStep, ctx: ResolverContext): Promise<unknown> {
  const resolvedStep = asRecord(normalizeRuntimeValue(resolveTemplateValue(step, ctx.scope)), `compute:${step.name}`);
  const kind = asString(resolvedStep.kind, `compute:${step.name}:kind`);
  return runRegisteredComputeStep(
    { ...resolvedStep, name: step.name, kind },
    {
      protocolId: ctx.protocol.id,
      programId: ctx.protocol.programId,
      connection: ctx.connection,
      walletPublicKey: ctx.walletPublicKey,
      idl: ctx.idl,
      scope: ctx.scope,
      previewInstruction: async ({ instructionName, args, accounts }) => {
        const preview = await previewIdlInstruction({
          protocolId: ctx.protocol.id,
          instructionName,
          args,
          accounts,
          walletPublicKey: ctx.walletPublicKey,
        });
        return { programId: preview.programId, dataBase64: preview.dataBase64, keys: preview.keys };
      },
    },
  );
}

export async function prepareRuntimeOperation(options: {
  protocolId: string;
  operationId: string;
  input: Record<string, unknown>;
  connection: Connection;
  walletPublicKey: PublicKey;
}): Promise<PreparedMetaOperation> {
  const protocol = await getProtocolById(options.protocolId);
  const resolved = await resolveRuntimeOperation({
    protocolId: options.protocolId,
    operationId: options.operationId,
  });
  if (resolved.kind !== 'contract_write') {
    throw new Error(`Operation ${options.operationId} is not a contract write.`);
  }
  const runtime = resolved.pack;
  const idl = await loadProtocolIdl(options.protocolId);
  const operation = resolved.materialized;
  const hydratedInput = hydrateAndValidateRuntimeInputs({
    input: options.input,
    materialized: operation,
    context: `${options.protocolId}/${options.operationId}`,
  });
  const scope: JsonRecord = {
    input: hydratedInput,
    protocol: {
      id: protocol.id,
      name: protocol.name,
      network: protocol.network,
      programId: protocol.programId,
    },
    runtime,
  };
  const derived: Record<string, unknown> = {};
  scope.derived = derived;
  const resolverCtx: ResolverContext = {
    protocol: scope.protocol as ResolverContext['protocol'],
    runtime,
    input: hydratedInput,
    idl,
    connection: options.connection,
    walletPublicKey: options.walletPublicKey,
    scope,
  };
  for (const step of operation.resolve as ResolveStep[]) {
    const value = await runResolver(step, resolverCtx);
    derived[step.name] = value;
    scope[step.name] = value;
    scope.derived = derived;
  }
  for (const step of operation.compute as ComputeStep[]) {
    const value = await runComputeStep(step, resolverCtx);
    derived[step.name] = value;
    scope[step.name] = value;
    scope.derived = derived;
  }
  const resolvedArgs = normalizeRuntimeValue(resolveTemplateValue(operation.args ?? {}, scope));
  const resolvedAccounts = normalizeRuntimeValue(resolveTemplateValue(operation.accounts ?? {}, scope));
  const resolvedRemainingAccounts = normalizeRuntimeValue(resolveTemplateValue(operation.remainingAccounts ?? [], scope));
  const explicitAccounts = assertStringRecord(resolvedAccounts, 'accounts');
  const finalAccounts =
    operation.instruction
      ? (
          await previewIdlInstruction({
            protocolId: options.protocolId,
            instructionName: operation.instruction,
            args: resolvedArgs as Record<string, unknown>,
            accounts: explicitAccounts,
            walletPublicKey: options.walletPublicKey,
          })
        ).resolvedAccounts
      : explicitAccounts;
  scope.instruction_accounts = finalAccounts;
  return {
    protocolId: options.protocolId,
    operationId: options.operationId,
    instructionName: operation.instruction ? operation.instruction : null,
    args: resolvedArgs as Record<string, unknown>,
    accounts: finalAccounts,
    remainingAccounts: assertRemainingAccounts(resolvedRemainingAccounts, 'remaining_accounts'),
    derived,
    readOutput: normalizeReadOutputSpec(operation.readOutput, `${options.protocolId}/${options.operationId}`),
    preInstructions: resolvePreInstructions(operation.pre as PreInstructionSpec[] | undefined, scope),
    postInstructions: resolvePostInstructions(operation.post as PostInstructionSpec[] | undefined, scope),
  };
}

export async function runRuntimeCompute(options: {
  protocolId: string;
  operationId: string;
  input: Record<string, unknown>;
  connection: Connection;
  walletPublicKey: PublicKey;
}): Promise<PreparedMetaCompute> {
  const protocol = await getProtocolById(options.protocolId);
  const resolved = await resolveRuntimeOperation({
    protocolId: options.protocolId,
    operationId: options.operationId,
  });
  if (resolved.kind !== 'compute') {
    throw new Error(`Operation ${options.operationId} is not a compute capability.`);
  }
  const runtime = resolved.pack;
  const idl = await loadProtocolIdl(options.protocolId);
  const operation = resolved.materialized;
  const hydratedInput = hydrateAndValidateRuntimeInputs({
    input: options.input,
    materialized: operation,
    context: `${options.protocolId}/${options.operationId}`,
  });
  const scope: JsonRecord = {
    input: hydratedInput,
    protocol: {
      id: protocol.id,
      name: protocol.name,
      network: protocol.network,
      programId: protocol.programId,
    },
    runtime,
  };
  const derived: Record<string, unknown> = {};
  scope.derived = derived;
  const resolverCtx: ResolverContext = {
    protocol: scope.protocol as ResolverContext['protocol'],
    runtime,
    input: hydratedInput,
    idl,
    connection: options.connection,
    walletPublicKey: options.walletPublicKey,
    scope,
  };
  for (const step of operation.resolve as ResolveStep[]) {
    const value = await runResolver(step, resolverCtx);
    derived[step.name] = value;
    scope[step.name] = value;
    scope.derived = derived;
  }
  for (const step of operation.compute as ComputeStep[]) {
    const value = await runComputeStep(step, resolverCtx);
    derived[step.name] = value;
    scope[step.name] = value;
    scope.derived = derived;
  }

  const output = operation.readOutput?.source
    ? normalizeRuntimeValue(resolvePath(scope, operation.readOutput.source))
    : normalizeRuntimeValue(derived);

  return {
    protocolId: options.protocolId,
    operationId: options.operationId,
    derived,
    output,
    readOutput: normalizeReadOutputSpec(operation.readOutput, `${options.protocolId}/${options.operationId}`),
  };
}

export async function prepareRuntimeInstruction(options: {
  protocolId: string;
  operationId: string;
  input: Record<string, unknown>;
  connection: Connection;
  walletPublicKey: PublicKey;
}): Promise<PreparedMetaInstruction> {
  const prepared = await prepareRuntimeOperation(options);
  if (!prepared.instructionName) {
    throw new Error(`Operation ${options.operationId} has no instruction; use prepareRuntimeOperation for read-only flows.`);
  }
  if (Object.keys(prepared.accounts).length === 0) {
    throw new Error(`Operation ${options.operationId} has no accounts mapping for instruction execution.`);
  }
  return {
    protocolId: prepared.protocolId,
    instructionName: prepared.instructionName,
    args: prepared.args,
    accounts: prepared.accounts,
    remainingAccounts: prepared.remainingAccounts,
    derived: prepared.derived,
    preInstructions: prepared.preInstructions,
    postInstructions: prepared.postInstructions,
  };
}

export async function explainRuntimeOperationBridge(options: {
  protocolId: string;
  operationId: string;
}): Promise<RuntimeOperationExplain> {
  return explainRuntimeOperation(options);
}
