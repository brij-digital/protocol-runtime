import BN from 'bn.js';
import {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackAccount,
  unpackMint,
} from '@solana/spl-token';
import type { Connection } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import {
  getProtocolById,
  loadProtocolAgentRuntime,
  loadProtocolCodamaDocument,
  type ProtocolManifest,
} from './protocolLoader.js';
import { previewIdlInstruction } from './codamaFacade.js';
import {
  findCodamaInstructionByName,
  type CodamaDocument as Idl,
  type CodamaInstructionAccountDef,
  type CodamaInstructionArgDef,
  type CodamaTypeRef,
} from './codamaIdl.js';
import { DirectAccountsCoder } from './directAccountsCoder.js';
import { runRegisteredComputeStep } from './metaComputeRegistry.js';

type JsonRecord = Record<string, unknown>;

type RuntimeInputSpec = {
  type: string;
  example?: unknown;
  ui_example?: unknown;
};

type RuntimeInputDecl = string | RuntimeInputSpec;

type ReadOutputSpec = {
  type: 'array' | 'object' | 'scalar';
  source: string;
  object_schema?: OutputObjectSchemaSpec;
  item_schema?: OutputObjectSchemaSpec;
  scalar_type?: string;
};

type OutputFieldSpec = {
  type: string;
  description?: string;
};

type OutputObjectSchemaSpec = {
  entity_type?: string;
  identity_fields?: string[];
  fields: Record<string, OutputFieldSpec>;
};

type ArgBindingValue = string | number | boolean | null;

type RemainingAccountMeta = {
  pubkey: string;
  isSigner?: boolean;
  isWritable?: boolean;
};

type RuntimeLoadStepSpec = Record<string, unknown> & {
  name: string;
  kind: string;
};

type RuntimeTransformStepSpec = {
  kind: 'transform';
  transform: string;
};

type RuntimeOperationStepSpec = RuntimeLoadStepSpec | RuntimeTransformStepSpec;

type AgentViewSpec = {
  load_instruction?: string;
  load_instruction_bindings?: {
    args?: Record<string, ArgBindingValue>;
    accounts?: Record<string, string>;
  };
  inputs?: Record<string, RuntimeInputDecl>;
  steps?: RuntimeOperationStepSpec[];
  pre?: unknown[];
  post?: unknown[];
  output: ReadOutputSpec;
};

type AgentWriteSpec = {
  instruction: string;
  inputs?: Record<string, RuntimeInputSpec>;
  steps?: RuntimeOperationStepSpec[];
  args?: Record<string, ArgBindingValue>;
  accounts?: Record<string, string>;
  remaining_accounts?: string | RemainingAccountMeta[];
  pre?: unknown[];
  post?: unknown[];
};

export type RuntimePack = {
  schema: 'solana-agent-runtime.v1';
  protocolId: string;
  programId: string;
  codamaPath: string;
  label?: string;
  views?: Record<string, AgentViewSpec>;
  writes?: Record<string, AgentWriteSpec>;
  transforms?: Record<string, unknown[]>;
};

type OperationKind = 'view' | 'write';

type RawOperationSpec = AgentViewSpec | AgentWriteSpec;

export type ResolvedRuntimeOperation = {
  pack: RuntimePack;
  kind: OperationKind;
  spec: RawOperationSpec;
  materialized: MaterializedRuntimeOperation;
};

export type MaterializedRuntimeOperation = {
  kind: OperationKind;
  instruction: string | null;
  loadInstruction: string | null;
  inputs: Record<string, RuntimeInputSpec>;
  steps: MaterializedOperationStep[];
  args: Record<string, unknown>;
  accounts: Record<string, unknown>;
  loadInstructionArgs: Record<string, unknown>;
  loadInstructionAccounts: Record<string, unknown>;
  remainingAccounts: unknown;
  output?: ReadOutputSpec;
  pre?: unknown[];
  post?: unknown[];
};

export type RuntimeOperationInputSummary = {
  type: string;
};

export type RuntimeOperationSummary = {
  operationId: string;
  operationKind: OperationKind;
  instruction?: string;
  loadInstruction?: string;
  executionKind: 'view' | 'write';
  inputs: Record<string, RuntimeOperationInputSummary>;
  output?: {
    type: 'array' | 'object' | 'scalar';
    source: string;
    objectSchema?: OutputObjectSchemaSpec;
    itemSchema?: OutputObjectSchemaSpec;
    scalarType?: string;
  };
};

export type RuntimeOperationExplain = {
  protocolId: string;
  operationId: string;
  operationKind: OperationKind;
  instruction?: string;
  loadInstruction?: string;
  inputs: Record<string, RuntimeInputSpec>;
  steps: MaterializedOperationStep[];
  args: Record<string, unknown>;
  accounts: Record<string, unknown>;
  loadInstructionArgs: Record<string, unknown>;
  loadInstructionAccounts: Record<string, unknown>;
  remainingAccounts: unknown;
  output?: {
    type: 'array' | 'object' | 'scalar';
    source: string;
    objectSchema?: OutputObjectSchemaSpec;
    itemSchema?: OutputObjectSchemaSpec;
    scalarType?: string;
  };
  pre: unknown[];
  post: unknown[];
};

export type MaterializedOperationStep =
  | {
      phase: 'load';
      step: RuntimeLoadStepSpec;
    }
  | {
      phase: 'transform';
      step: Record<string, unknown>;
      fragment: string;
    };

type LoadStep = {
  name: string;
  kind: string;
  [key: string]: unknown;
};

type TransformStep = {
  name: string;
  kind: string;
  [key: string]: unknown;
};

type ScopedTransformStep = TransformStep & {
  steps?: unknown;
  output?: unknown;
  item_as?: unknown;
  index_as?: unknown;
  acc_as?: unknown;
  transform?: unknown;
  bindings?: unknown;
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
  output?: {
    type: 'array' | 'object' | 'scalar';
    source: string;
    objectSchema?: {
      entity_type?: string;
      identity_fields?: string[];
      fields: Record<string, { type: string; description?: string }>;
    };
    itemSchema?: {
      entity_type?: string;
      identity_fields?: string[];
      fields: Record<string, { type: string; description?: string }>;
    };
    scalarType?: string;
  };
  preInstructions: PreparedPreInstruction[];
  postInstructions: PreparedPostInstruction[];
};

export type PreparedMetaView = {
  protocolId: string;
  operationId: string;
  derived: Record<string, unknown>;
  output: unknown;
  loadInstructionArgs: Record<string, unknown>;
  loadInstructionAccounts: Record<string, string>;
  preInstructions: PreparedPreInstruction[];
  postInstructions: PreparedPostInstruction[];
  outputSpec?: {
    type: 'array' | 'object' | 'scalar';
    source: string;
    objectSchema?: {
      entity_type?: string;
      identity_fields?: string[];
      fields: Record<string, { type: string; description?: string }>;
    };
    itemSchema?: {
      entity_type?: string;
      identity_fields?: string[];
      fields: Record<string, { type: string; description?: string }>;
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

type ParsedTokenAccountRow = {
  pubkey: string;
  tokenProgram: string;
  mint: string;
  owner: string;
  amount: string;
  decimals: number | null;
  uiAmountString: string | null;
  state: string | null;
  isNative: boolean | null;
};

const runtimePackCache = new Map<string, RuntimePack>();
const idlCache = new Map<string, Idl>();

const DEFAULT_SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const DEFAULT_ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

function isTransformStepSpec(step: RuntimeOperationStepSpec): step is RuntimeTransformStepSpec {
  return step.kind === 'transform';
}

function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .replace(/__+/g, '_')
    .toLowerCase();
}

function cloneJsonLike<T>(value: T): T {
  if (value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
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
    throw new Error(`Cannot resolve path ${path}.`);
  }
  return resolved;
}

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

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
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

function asTransformSteps(value: unknown, label: string): TransformStep[] {
  return asArray(value, label).map((entry, index) => {
    const record = asRecord(entry, `${label}[${index}]`);
    const name = asString(record.name, `${label}[${index}].name`);
    const kind = asString(record.kind, `${label}[${index}].kind`);
    return { ...record, name, kind };
  });
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

function resolveScopedOutput(output: unknown, scope: JsonRecord, label: string): unknown {
  if (typeof output !== 'string' || !output.startsWith('$')) {
    throw new Error(`${label} must be a $-prefixed path.`);
  }
  return resolveTemplateValue(output, scope);
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
  spec: MaterializedRuntimeOperation['output'] | undefined,
  context: string,
): PreparedMetaOperation['output'] | undefined {
  if (!spec) {
    return undefined;
  }
  if (!spec.source || typeof spec.source !== 'string' || spec.source.trim().length === 0) {
    throw new Error(`${context}: output.source is required.`);
  }
  const normalized: NonNullable<PreparedMetaOperation['output']> = { type: spec.type, source: spec.source };
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
  const parsed = await loadProtocolCodamaDocument(protocolId);
  idlCache.set(protocolId, parsed);
  return parsed;
}

function evaluateCondition(condition: MetaCondition, scope: JsonRecord): boolean {
  if ('equals' in condition) {
    const [left, right] = condition.equals;
    return valuesEqual(
      normalizeRuntimeValue(resolveTemplateValue(left, scope)),
      normalizeRuntimeValue(resolveTemplateValue(right, scope)),
    );
  }
  if ('all' in condition) {
    return condition.all.every((entry) => evaluateCondition(entry, scope));
  }
  if ('any' in condition) {
    return condition.any.some((entry) => evaluateCondition(entry, scope));
  }
  return !evaluateCondition(condition.not, scope);
}

function resolvePostInstructions(
  post: PostInstructionSpec[] | undefined,
  scope: JsonRecord,
): PreparedPostInstruction[] {
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

function resolvePreInstructions(
  pre: PreInstructionSpec[] | undefined,
  scope: JsonRecord,
): PreparedPreInstruction[] {
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

async function runResolver(step: LoadStep, ctx: ResolverContext): Promise<unknown> {
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
    if (accountType === 'Mint') {
      const programId = info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
      const decoded = unpackMint(address, info, programId);
      return normalizeRuntimeValue({
        address: decoded.address,
        mintAuthority: decoded.mintAuthority,
        supply: decoded.supply,
        decimals: decoded.decimals,
        isInitialized: decoded.isInitialized,
        freezeAuthority: decoded.freezeAuthority,
      });
    }
    if (accountType === 'TokenAccount') {
      const programId = info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
      const decoded = unpackAccount(address, info, programId);
      return normalizeRuntimeValue({
        address: decoded.address,
        mint: decoded.mint,
        owner: decoded.owner,
        amount: decoded.amount,
        delegate: decoded.delegate,
        delegatedAmount: decoded.delegatedAmount,
        isInitialized: decoded.isInitialized,
        isFrozen: decoded.isFrozen,
        isNative: decoded.isNative,
        rentExemptReserve: decoded.rentExemptReserve,
        closeAuthority: decoded.closeAuthority,
      });
    }
    const coder = new DirectAccountsCoder(ctx.idl);
    return normalizeRuntimeValue(coder.decode(accountType, info.data));
  }
  if (step.kind === 'decode_accounts') {
    const rawAddresses = resolveTemplateValue(step.addresses, ctx.scope);
    if (!Array.isArray(rawAddresses)) {
      throw new Error(`decode_accounts:${step.name}:addresses must resolve to an array.`);
    }
    const accountType = asString(step.account_type, `decode_accounts:${step.name}:account_type`);
    const coder = new DirectAccountsCoder(ctx.idl);
    const decoded = [];
    for (let index = 0; index < rawAddresses.length; index += 1) {
      const address = asPubkey(rawAddresses[index], `decode_accounts:${step.name}:addresses[${index}]`);
      const info = await ctx.connection.getAccountInfo(address, 'confirmed');
      if (!info) {
        throw new Error(`Account not found for decode_accounts ${step.name}[${index}]: ${address.toBase58()}`);
      }
      let value: unknown;
      if (accountType === 'Mint') {
        const programId = info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
        const mint = unpackMint(address, info, programId);
        value = {
          address: mint.address,
          mintAuthority: mint.mintAuthority,
          supply: mint.supply,
          decimals: mint.decimals,
          isInitialized: mint.isInitialized,
          freezeAuthority: mint.freezeAuthority,
        };
      } else if (accountType === 'TokenAccount') {
        const programId = info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
        const token = unpackAccount(address, info, programId);
        value = {
          address: token.address,
          mint: token.mint,
          owner: token.owner,
          amount: token.amount,
          delegate: token.delegate,
          delegatedAmount: token.delegatedAmount,
          isInitialized: token.isInitialized,
          isFrozen: token.isFrozen,
          isNative: token.isNative,
          rentExemptReserve: token.rentExemptReserve,
          closeAuthority: token.closeAuthority,
        };
      } else {
        const decodedValue = normalizeRuntimeValue(coder.decode(accountType, info.data));
        value =
          decodedValue && typeof decodedValue === 'object' && !Array.isArray(decodedValue)
            ? { address: address.toBase58(), ...(decodedValue as JsonRecord) }
            : { address: address.toBase58(), value: decodedValue };
      }
      decoded.push(normalizeRuntimeValue(value));
    }
    return decoded;
  }
  if (step.kind === 'account_owner') {
    const address = asPubkey(resolveTemplateValue(step.address, ctx.scope), `account_owner:${step.name}:address`);
    const info = await ctx.connection.getAccountInfo(address, 'confirmed');
    if (!info) {
      throw new Error(`Account not found for account_owner ${step.name}: ${address.toBase58()}`);
    }
    return info.owner.toBase58();
  }
  if (step.kind === 'token_accounts_by_owner') {
    const owner = asPubkey(
      resolveTemplateValue(step.owner, ctx.scope),
      `token_accounts_by_owner:${step.name}:owner`,
    );
    const mint =
      step.mint === undefined
        ? undefined
        : asPubkey(
            resolveTemplateValue(step.mint, ctx.scope),
            `token_accounts_by_owner:${step.name}:mint`,
          );
    const tokenProgram =
      step.token_program === undefined
        ? undefined
        : asPubkey(
            resolveTemplateValue(step.token_program, ctx.scope),
            `token_accounts_by_owner:${step.name}:token_program`,
          );

    const filters =
      mint !== undefined
        ? [{ mint }]
        : tokenProgram !== undefined
          ? [{ programId: tokenProgram }]
          : [{ programId: TOKEN_PROGRAM_ID }, { programId: TOKEN_2022_PROGRAM_ID }];

    const accounts = new Map<string, ParsedTokenAccountRow>();
    for (const filter of filters) {
      const response = await ctx.connection.getParsedTokenAccountsByOwner(owner, filter, 'confirmed');
      for (const entry of response.value) {
        const account = asRecord(
          entry.account as unknown as JsonRecord,
          `token_accounts_by_owner:${step.name}:account`,
        );
        const ownerProgram = asString(
          account.owner,
          `token_accounts_by_owner:${step.name}:account.owner`,
        );
        if (tokenProgram && ownerProgram !== tokenProgram.toBase58()) {
          continue;
        }
        const data = asRecord(
          account.data,
          `token_accounts_by_owner:${step.name}:account.data`,
        );
        const parsed = asRecord(
          data.parsed,
          `token_accounts_by_owner:${step.name}:account.data.parsed`,
        );
        const info = asRecord(
          parsed.info,
          `token_accounts_by_owner:${step.name}:account.data.parsed.info`,
        );
        const tokenAmount = asRecord(
          info.tokenAmount,
          `token_accounts_by_owner:${step.name}:account.data.parsed.info.tokenAmount`,
        );
        const mintAddress = asString(
          info.mint,
          `token_accounts_by_owner:${step.name}:account.data.parsed.info.mint`,
        );
        if (mint && mintAddress !== mint.toBase58()) {
          continue;
        }
        accounts.set(entry.pubkey.toBase58(), {
          pubkey: entry.pubkey.toBase58(),
          tokenProgram: ownerProgram,
          mint: mintAddress,
          owner: asString(
            info.owner,
            `token_accounts_by_owner:${step.name}:account.data.parsed.info.owner`,
          ),
          amount: asString(
            tokenAmount.amount,
            `token_accounts_by_owner:${step.name}:account.data.parsed.info.tokenAmount.amount`,
          ),
          decimals:
            tokenAmount.decimals === undefined || tokenAmount.decimals === null
              ? null
              : Number(tokenAmount.decimals),
          uiAmountString:
            tokenAmount.uiAmountString === undefined || tokenAmount.uiAmountString === null
              ? null
              : String(tokenAmount.uiAmountString),
          state:
            info.state === undefined || info.state === null ? null : String(info.state),
          isNative:
            info.isNative === undefined || info.isNative === null ? null : Boolean(info.isNative),
        });
      }
    }

    return normalizeRuntimeValue(
      [...accounts.values()].sort((left, right) => left.pubkey.localeCompare(right.pubkey)),
    );
  }
  if (step.kind === 'ata') {
    const owner = asPubkey(resolveTemplateValue(step.owner, ctx.scope), `ata:${step.name}:owner`);
    const mint = asPubkey(resolveTemplateValue(step.mint, ctx.scope), `ata:${step.name}:mint`);
    const tokenProgram =
      step.token_program === undefined
        ? undefined
        : asPubkey(resolveTemplateValue(step.token_program, ctx.scope), `ata:${step.name}:token_program`);
    const allowOwnerOffCurve =
      step.allow_owner_off_curve === undefined
        ? false
        : Boolean(resolveTemplateValue(step.allow_owner_off_curve, ctx.scope));
    return getAssociatedTokenAddressSync(mint, owner, allowOwnerOffCurve, tokenProgram).toBase58();
  }
  if (step.kind === 'pda') {
    const programId = asPubkey(resolveTemplateValue(step.program_id, ctx.scope), `pda:${step.name}:program_id`);
    const seeds = Array.isArray(step.seeds)
      ? step.seeds.map((seed, index) => {
          if (typeof seed === 'string' && seed.startsWith('utf8:')) {
            return new TextEncoder().encode(seed.slice('utf8:'.length));
          }
          return asPubkey(resolveTemplateValue(seed, ctx.scope), `pda:${step.name}:seed[${index}]`).toBuffer();
        })
      : [];
    return PublicKey.findProgramAddressSync(seeds, programId)[0].toBase58();
  }
  throw new Error(`Unsupported resolver: ${step.kind}`);
}

function isScopedComputeKind(kind: string): boolean {
  return kind === 'list.map' || kind === 'list.flat_map' || kind === 'list.reduce';
}

async function runNamedTransformStep(step: TransformStep, ctx: ResolverContext): Promise<unknown> {
  const transformName = asString(step.transform, `compute:${step.name}:transform`);
  const transformSteps = ctx.runtime.transforms?.[transformName];
  if (!Array.isArray(transformSteps)) {
    throw new Error(`Transform ${transformName} not found in runtime pack.`);
  }
  const output = step.output;
  if (output === undefined) {
    throw new Error(`compute:${step.name}:output must be provided for transform step.`);
  }
  const bindingsRaw =
    step.bindings === undefined ? {} : asRecord(step.bindings, `compute:${step.name}:bindings`);
  const bindings = Object.fromEntries(
    Object.entries(bindingsRaw).map(([key, value]) => [
      key,
      normalizeRuntimeValue(resolveTemplateValue(value, ctx.scope)),
    ]),
  );
  const localScope: JsonRecord = {
    ...ctx.scope,
    ...bindings,
  };
  await runNestedTransformSteps(
    asTransformSteps(transformSteps, `runtime.transforms.${transformName}`),
    ctx,
    localScope,
  );
  return normalizeRuntimeValue(resolveScopedOutput(output, localScope, `compute:${step.name}:output`));
}

async function runNestedTransformSteps(
  steps: TransformStep[],
  ctx: ResolverContext,
  scope: JsonRecord,
): Promise<void> {
  const derived: Record<string, unknown> = {};
  scope.derived = derived;
  const nestedCtx: ResolverContext = {
    ...ctx,
    scope,
  };
  for (const step of steps) {
    const value = await runComputeStep(step, nestedCtx);
    derived[step.name] = value;
    scope[step.name] = value;
    scope.derived = derived;
  }
}

async function runListMapStep(step: ScopedTransformStep, ctx: ResolverContext): Promise<unknown[]> {
  const items = asArray(resolveTemplateValue(step.items, ctx.scope), `compute:${step.name}:items`);
  const steps = step.steps === undefined ? [] : asTransformSteps(step.steps, `compute:${step.name}:steps`);
  const output = step.output;
  const itemAs = step.item_as === undefined ? 'item' : asString(step.item_as, `compute:${step.name}:item_as`);
  const indexAs = step.index_as === undefined ? 'index' : asString(step.index_as, `compute:${step.name}:index_as`);
  const results: unknown[] = [];

  for (const [index, item] of items.entries()) {
    const localScope: JsonRecord = {
      ...ctx.scope,
      [itemAs]: normalizeRuntimeValue(item),
      [indexAs]: index,
    };
    await runNestedTransformSteps(steps, ctx, localScope);
    results.push(normalizeRuntimeValue(resolveScopedOutput(output, localScope, `compute:${step.name}:output`)));
  }

  return results;
}

async function runListFlatMapStep(step: ScopedTransformStep, ctx: ResolverContext): Promise<unknown[]> {
  const nested = await runListMapStep(step, ctx);
  const out: unknown[] = [];
  nested.forEach((entry, index) => {
    const arrayEntry = asArray(entry, `compute:${step.name}:mapped[${index}]`);
    out.push(...arrayEntry.map((item) => normalizeRuntimeValue(item)));
  });
  return out;
}

async function runListReduceStep(step: ScopedTransformStep, ctx: ResolverContext): Promise<unknown> {
  const items = asArray(resolveTemplateValue(step.items, ctx.scope), `compute:${step.name}:items`);
  const steps = step.steps === undefined ? [] : asTransformSteps(step.steps, `compute:${step.name}:steps`);
  const output = step.output;
  const initial = normalizeRuntimeValue(resolveTemplateValue(step.initial, ctx.scope));
  const itemAs = step.item_as === undefined ? 'item' : asString(step.item_as, `compute:${step.name}:item_as`);
  const indexAs = step.index_as === undefined ? 'index' : asString(step.index_as, `compute:${step.name}:index_as`);
  const accAs = step.acc_as === undefined ? 'acc' : asString(step.acc_as, `compute:${step.name}:acc_as`);

  let accumulator = initial;
  for (const [index, item] of items.entries()) {
    const localScope: JsonRecord = {
      ...ctx.scope,
      [itemAs]: normalizeRuntimeValue(item),
      [indexAs]: index,
      [accAs]: accumulator,
    };
    await runNestedTransformSteps(steps, ctx, localScope);
    accumulator = normalizeRuntimeValue(resolveScopedOutput(output, localScope, `compute:${step.name}:output`));
  }

  return accumulator;
}

async function runComputeStep(step: TransformStep, ctx: ResolverContext): Promise<unknown> {
  if (isScopedComputeKind(step.kind)) {
    if (step.kind === 'list.map') {
      return runListMapStep(step as ScopedTransformStep, ctx);
    }
    if (step.kind === 'list.flat_map') {
      return runListFlatMapStep(step as ScopedTransformStep, ctx);
    }
    return runListReduceStep(step as ScopedTransformStep, ctx);
  }
  if (step.kind === 'transform') {
    return runNamedTransformStep(step, ctx);
  }
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

async function runOperationSteps(
  steps: MaterializedOperationStep[],
  ctx: ResolverContext,
  scope: JsonRecord,
  derived: Record<string, unknown>,
): Promise<void> {
  for (const entry of steps) {
    if (entry.phase === 'load') {
      const step = entry.step as LoadStep;
      const value = await runResolver(step, ctx);
      derived[step.name] = value;
      scope[step.name] = value;
      scope.derived = derived;
      continue;
    }
    const step = entry.step as TransformStep;
    const value = await runComputeStep(step, ctx);
    derived[step.name] = value;
    scope[step.name] = value;
    scope.derived = derived;
  }
}

function buildMaterializedOperationSteps(options: {
  protocolId: string;
  operationId: string;
  catalog: Record<string, unknown[]>;
  steps: RuntimeOperationStepSpec[] | undefined;
}): MaterializedOperationStep[] {
  const out: MaterializedOperationStep[] = [];
  for (const [index, rawStep] of (options.steps ?? []).entries()) {
    if (isTransformStepSpec(rawStep)) {
      const fragment = options.catalog[rawStep.transform];
      if (!Array.isArray(fragment)) {
        throw new Error(
          `Unknown transform fragment ${rawStep.transform} in ${options.protocolId}/${options.operationId} at steps[${index}].`,
        );
      }
      for (const transformed of cloneJsonLike(fragment)) {
        out.push({
          phase: 'transform',
          step: transformed as Record<string, unknown>,
          fragment: rawStep.transform,
        });
      }
      continue;
    }
    out.push({
      phase: 'load',
      step: cloneJsonLike(rawStep as RuntimeLoadStepSpec),
    });
  }
  return out;
}

function normalizeInputDeclMap(
  inputMap: Record<string, RuntimeInputDecl>,
): Record<string, RuntimeInputSpec> {
  return Object.fromEntries(
    Object.entries(inputMap).map(([key, value]) => [
      key,
      typeof value === 'string'
        ? { type: value }
        : cloneJsonLike(value),
    ]),
  );
}

function collectInputReferences(value: unknown, refs: Set<string>): void {
  if (typeof value === 'string') {
    if (value.startsWith('$input.')) {
      const name = value.slice('$input.'.length).split('.').filter(Boolean)[0];
      if (name) {
        refs.add(name);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectInputReferences(entry, refs);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value as JsonRecord)) {
      collectInputReferences(entry, refs);
    }
  }
}

function collectStepInputReferences(steps: RuntimeOperationStepSpec[] | undefined, catalog: Record<string, unknown[]>, refs: Set<string>): void {
  for (const [index, step] of (steps ?? []).entries()) {
    if (isTransformStepSpec(step)) {
      const fragment = catalog[step.transform];
      if (!Array.isArray(fragment)) {
        throw new Error(`Unknown transform fragment ${step.transform} at steps[${index}].`);
      }
      collectInputReferences(fragment, refs);
      continue;
    }
    collectInputReferences(step, refs);
  }
}

function collectWriteInputReferences(spec: AgentWriteSpec, catalog: Record<string, unknown[]>): Set<string> {
  const refs = new Set<string>();
  collectStepInputReferences(spec.steps, catalog, refs);
  collectInputReferences(spec.args, refs);
  collectInputReferences(spec.accounts, refs);
  collectInputReferences(spec.remaining_accounts, refs);
  collectInputReferences(spec.pre, refs);
  collectInputReferences(spec.post, refs);
  return refs;
}

function codamaTypeToRuntimeType(type: CodamaTypeRef | unknown): string {
  if (typeof type === 'string') {
    if (type === 'pubkey' || type === 'publicKey') {
      return 'pubkey';
    }
    if (type === 'bool') {
      return 'bool';
    }
    return type;
  }
  if (type && typeof type === 'object') {
    if ('option' in type) {
      return codamaTypeToRuntimeType((type as { option: CodamaTypeRef }).option);
    }
    if ('defined' in type) {
      return 'json';
    }
    if ('vec' in type || 'array' in type) {
      return 'json';
    }
  }
  return 'json';
}

function buildWriteInputSpecFromCodamaRef(options: {
  protocolId: string;
  operationId: string;
  inputName: string;
  instructionName: string;
  args: CodamaInstructionArgDef[];
  accounts: CodamaInstructionAccountDef[];
}): RuntimeInputSpec {
  const arg = options.args.find((candidate) => toSnakeCase(candidate.name) === options.inputName);
  if (arg && toSnakeCase(arg.name) !== 'discriminator') {
    return {
      type: codamaTypeToRuntimeType(arg.type),
    };
  }

  const account = options.accounts.find((candidate) => toSnakeCase(candidate.name) === options.inputName);
  if (account) {
    return {
      type: 'pubkey',
    };
  }

  throw new Error(
    `Write ${options.protocolId}/${options.operationId} references non-Codama input ${options.inputName} for instruction ${options.instructionName}.`,
  );
}

async function hydrateWriteSpecsFromCodama(options: {
  protocolId: string;
  writes: Record<string, AgentWriteSpec>;
  transforms: Record<string, unknown[]>;
}): Promise<Record<string, AgentWriteSpec>> {
  const codama = await loadProtocolCodamaDocument(options.protocolId);
  const nextWrites: Record<string, AgentWriteSpec> = {};

  for (const [operationId, writeSpec] of Object.entries(options.writes)) {
    if (writeSpec.inputs !== undefined) {
      throw new Error(
        `Write ${options.protocolId}/${operationId} must not declare inputs explicitly; write inputs are sourced from Codama.`,
      );
    }

    const instruction = findCodamaInstructionByName(codama, writeSpec.instruction);
    if (!instruction) {
      throw new Error(`Write ${options.protocolId}/${operationId} references unknown Codama instruction ${writeSpec.instruction}.`);
    }

    const refs = [...collectWriteInputReferences(writeSpec, options.transforms)].sort();
    const inputs = Object.fromEntries(
      refs.map((inputName) => [
        inputName,
        buildWriteInputSpecFromCodamaRef({
          protocolId: options.protocolId,
          operationId,
          inputName,
          instructionName: instruction.name,
          args: instruction.args,
          accounts: instruction.accounts,
        }),
      ]),
    );

    nextWrites[operationId] = {
      ...cloneJsonLike(writeSpec),
      inputs,
    };
  }

  return nextWrites;
}

export async function loadRuntimePack(protocolId: string): Promise<RuntimePack> {
  const cached = runtimePackCache.get(protocolId);
  if (cached) {
    return cached;
  }
  const manifest = await getProtocolById(protocolId);
  const runtime = await loadProtocolAgentRuntime(protocolId);
  if (!runtime) {
    throw new Error(`Protocol ${protocolId} has no agentRuntimePath.`);
  }
  if (!manifest.codamaIdlPath) {
    throw new Error(`Protocol ${protocolId} has no codamaIdlPath in registry.`);
  }
  const parsed = runtime as unknown as {
    schema: 'solana-agent-runtime.v1';
    protocol_id: string;
    program_id: string;
    codama_path: string;
    label?: string;
    views?: Record<string, AgentViewSpec>;
    writes?: Record<string, AgentWriteSpec>;
    transforms?: Record<string, unknown[]>;
  };
  if (parsed.protocol_id !== protocolId) {
    throw new Error(`Protocol ${protocolId} runtime protocol_id mismatch: ${parsed.protocol_id}.`);
  }
  if (parsed.program_id !== manifest.programId) {
    throw new Error(`Protocol ${protocolId} runtime program_id mismatch: ${parsed.program_id}.`);
  }
  if (parsed.codama_path !== manifest.codamaIdlPath) {
    throw new Error(`Protocol ${protocolId} runtime codama_path mismatch: ${parsed.codama_path}.`);
  }
  const transforms = cloneJsonLike(parsed.transforms ?? {});
  const writes = await hydrateWriteSpecsFromCodama({
    protocolId,
    writes: cloneJsonLike(parsed.writes ?? {}),
    transforms,
  });
  const views = cloneJsonLike((parsed as { views?: Record<string, AgentViewSpec> }).views ?? {});
  for (const [operationId, viewSpec] of Object.entries(views)) {
    if (!viewSpec.output) {
      throw new Error(`View ${protocolId}/${operationId} must declare output.`);
    }
  }
  const pack: RuntimePack = {
    schema: 'solana-agent-runtime.v1',
    protocolId,
    programId: manifest.programId,
    codamaPath: manifest.codamaIdlPath,
    ...(parsed.label ? { label: parsed.label } : {}),
    views,
    writes,
    transforms,
  };
  runtimePackCache.set(protocolId, pack);
  return pack;
}

function getRawOperationSpec(
  pack: RuntimePack,
  operationId: string,
): { kind: OperationKind; spec: RawOperationSpec } | null {
  const view = pack.views?.[operationId];
  if (view) {
    return { kind: 'view', spec: view };
  }
  const write = pack.writes?.[operationId];
  if (write) {
    return { kind: 'write', spec: write };
  }
  return null;
}

export function materializeRuntimeOperation(
  operationId: string,
  operation: RawOperationSpec,
  pack: RuntimePack,
  kind: OperationKind,
): MaterializedRuntimeOperation {
  const materialized: MaterializedRuntimeOperation = {
    kind,
    instruction: null,
    loadInstruction: null,
    inputs: {},
    steps: [],
    args: {},
    accounts: {},
    loadInstructionArgs: {},
    loadInstructionAccounts: {},
    remainingAccounts: [],
    pre: [],
    post: [],
  };

  const cloned = cloneJsonLike(operation as Partial<AgentViewSpec & AgentWriteSpec>);
  if ('load_instruction' in cloned && cloned.load_instruction) {
    materialized.loadInstruction = cloned.load_instruction;
  }
  if ('load_instruction_bindings' in cloned && cloned.load_instruction_bindings) {
    if (cloned.load_instruction_bindings.args) {
      materialized.loadInstructionArgs = cloneJsonLike(cloned.load_instruction_bindings.args);
    }
    if (cloned.load_instruction_bindings.accounts) {
      materialized.loadInstructionAccounts = cloneJsonLike(cloned.load_instruction_bindings.accounts);
    }
  }
  if ('instruction' in cloned && cloned.instruction) {
    materialized.instruction = cloned.instruction;
  }
  if (cloned.inputs) {
    materialized.inputs = normalizeInputDeclMap(cloned.inputs);
  }
  if (cloned.args) {
    materialized.args = cloneJsonLike(cloned.args);
  }
  if (cloned.accounts) {
    materialized.accounts = cloneJsonLike(cloned.accounts);
  }
  if (cloned.remaining_accounts !== undefined) {
    materialized.remainingAccounts = cloneJsonLike(cloned.remaining_accounts);
  }
  if ('output' in cloned && cloned.output) {
    materialized.output = cloneJsonLike(cloned.output);
  }
  if (cloned.pre && cloned.pre.length > 0) {
    materialized.pre = cloneJsonLike(cloned.pre);
  }
  if (cloned.post && cloned.post.length > 0) {
    materialized.post = cloneJsonLike(cloned.post);
  }
  materialized.steps = buildMaterializedOperationSteps({
    protocolId: pack.protocolId,
    operationId,
    catalog: cloneJsonLike(pack.transforms ?? {}),
    steps: cloned.steps,
  });

  return materialized;
}

function normalizeOutputSpec(
  spec: ReadOutputSpec | undefined,
  context: string,
):
  | {
      type: 'array' | 'object' | 'scalar';
      source: string;
      objectSchema?: OutputObjectSchemaSpec;
      itemSchema?: OutputObjectSchemaSpec;
      scalarType?: string;
    }
  | undefined {
  if (!spec) {
    return undefined;
  }
  if (!spec.source || typeof spec.source !== 'string' || spec.source.trim().length === 0) {
    throw new Error(`${context}: output.source is required.`);
  }
  return {
    type: spec.type,
    source: spec.source,
    ...(spec.object_schema ? { objectSchema: cloneJsonLike(spec.object_schema) } : {}),
    ...(spec.item_schema ? { itemSchema: cloneJsonLike(spec.item_schema) } : {}),
    ...(typeof spec.scalar_type === 'string' && spec.scalar_type.length > 0 ? { scalarType: spec.scalar_type } : {}),
  };
}

function parseBigIntLike(value: unknown, label: string, signed: boolean): bigint {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new Error(`${label} must be an integer.`);
    }
    return BigInt(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const pattern = signed ? /^-?\d+$/ : /^\d+$/;
    if (!pattern.test(trimmed)) {
      throw new Error(`${label} must be an integer string.`);
    }
    return BigInt(trimmed);
  }
  throw new Error(`${label} must be an integer-compatible value.`);
}

function validateRuntimeInputValue(inputName: string, inputSpec: RuntimeInputSpec, rawValue: unknown, context: string): unknown {
  const label = `${context}.${inputName}`;
  switch (inputSpec.type) {
    case 'string': {
      if (typeof rawValue !== 'string') {
        throw new Error(`${label} must be a string.`);
      }
      return rawValue;
    }
    case 'bool': {
      if (typeof rawValue === 'boolean') {
        return rawValue;
      }
      if (typeof rawValue === 'string') {
        const normalized = rawValue.trim().toLowerCase();
        if (normalized === 'true') {
          return true;
        }
        if (normalized === 'false') {
          return false;
        }
      }
      throw new Error(`${label} must be a boolean.`);
    }
    case 'pubkey':
    case 'token_mint': {
      if (typeof rawValue !== 'string') {
        throw new Error(`${label} must be a base58 public key string.`);
      }
      try {
        return new PublicKey(rawValue).toBase58();
      } catch {
        throw new Error(`${label} must be a valid ${inputSpec.type} base58 public key.`);
      }
    }
    case 'u16':
    case 'u32':
    case 'u64':
    case 'i32': {
      const signed = inputSpec.type === 'i32';
      const parsed = parseBigIntLike(rawValue, label, signed);
      if (!signed && parsed < 0n) {
        throw new Error(`${label} must be non-negative.`);
      }
      if (inputSpec.type === 'u16' && (parsed < 0n || parsed > 65535n)) {
        throw new Error(`${label} must fit in u16.`);
      }
      if (inputSpec.type === 'u32' && (parsed < 0n || parsed > 4294967295n)) {
        throw new Error(`${label} must fit in u32.`);
      }
      if (inputSpec.type === 'i32' && (parsed < -2147483648n || parsed > 2147483647n)) {
        throw new Error(`${label} must fit in i32.`);
      }
      return parsed.toString();
    }
    default:
      return rawValue;
  }
}

export function hydrateAndValidateInputShape(options: {
  input: Record<string, unknown>;
  inputs: Record<string, RuntimeInputSpec>;
  context: string;
}): Record<string, unknown> {
  const hydratedInput: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(options.inputs)) {
    const rawValue = options.input[key];
    if (rawValue === undefined) {
      continue;
    }
    hydratedInput[key] = validateRuntimeInputValue(key, spec, rawValue, options.context);
  }
  return hydratedInput;
}

export function hydrateAndValidateRuntimeInputs(options: {
  input: Record<string, unknown>;
  materialized: MaterializedRuntimeOperation;
  context: string;
}): Record<string, unknown> {
  return hydrateAndValidateInputShape({
    input: options.input,
    inputs: options.materialized.inputs,
    context: options.context,
  });
}

export async function resolveRuntimeOperation(options: {
  protocolId: string;
  operationId: string;
}): Promise<ResolvedRuntimeOperation> {
  const pack = await loadRuntimePack(options.protocolId);
  return resolveRuntimeOperationFromPack({
    pack,
    protocolId: options.protocolId,
    operationId: options.operationId,
  });
}

export function resolveRuntimeOperationFromPack(options: {
  pack: RuntimePack;
  protocolId: string;
  operationId: string;
}): ResolvedRuntimeOperation {
  const pack = options.pack;
  const resolved = getRawOperationSpec(pack, options.operationId);
  if (!resolved) {
    throw new Error(`Operation ${options.operationId} not found in agent runtime pack for ${options.protocolId}.`);
  }
  return {
    pack,
    kind: resolved.kind,
    spec: resolved.spec,
    materialized: materializeRuntimeOperation(options.operationId, resolved.spec, pack, resolved.kind),
  };
}

export async function listRuntimeOperations(options: {
  protocolId: string;
}): Promise<{
  protocolId: string;
  operations: RuntimeOperationSummary[];
}> {
  const pack = await loadRuntimePack(options.protocolId);
  const operations: RuntimeOperationSummary[] = [];
  const pushSummary = (operationId: string, kind: OperationKind, _spec: RawOperationSpec, materialized: MaterializedRuntimeOperation) => {
    const inputs = Object.fromEntries(
      Object.entries(materialized.inputs).map(([inputName, inputSpec]) => [
        inputName,
        {
          type: inputSpec.type,
        },
      ]),
    );
    operations.push({
      operationId,
      operationKind: kind,
      ...(kind === 'write' && materialized.instruction ? { instruction: materialized.instruction } : {}),
      ...(kind === 'view' && materialized.loadInstruction ? { loadInstruction: materialized.loadInstruction } : {}),
      executionKind: kind,
      inputs,
      ...(normalizeOutputSpec(materialized.output, `${options.protocolId}/${operationId}`) ? {
        output: normalizeOutputSpec(materialized.output, `${options.protocolId}/${operationId}`),
      } : {}),
    });
  };

  for (const [operationId, spec] of Object.entries(pack.views ?? {})) {
    pushSummary(operationId, 'view', spec, materializeRuntimeOperation(operationId, spec, pack, 'view'));
  }
  for (const [operationId, spec] of Object.entries(pack.writes ?? {})) {
    pushSummary(operationId, 'write', spec, materializeRuntimeOperation(operationId, spec, pack, 'write'));
  }

  operations.sort((a, b) => a.operationId.localeCompare(b.operationId));
  return {
    protocolId: options.protocolId,
    operations,
  };
}

export async function explainRuntimeOperation(options: {
  protocolId: string;
  operationId: string;
}): Promise<RuntimeOperationExplain> {
  const pack = await loadRuntimePack(options.protocolId);
  const resolved = getRawOperationSpec(pack, options.operationId);
  if (!resolved) {
    throw new Error(`Operation ${options.operationId} not found in agent runtime pack for ${options.protocolId}.`);
  }
  const materialized = materializeRuntimeOperation(options.operationId, resolved.spec, pack, resolved.kind);
  return {
    protocolId: options.protocolId,
    operationId: options.operationId,
    operationKind: resolved.kind,
    ...(resolved.kind === 'write' && materialized.instruction ? { instruction: materialized.instruction } : {}),
    ...(resolved.kind === 'view' && materialized.loadInstruction ? { loadInstruction: materialized.loadInstruction } : {}),
    inputs: cloneJsonLike(materialized.inputs),
    steps: cloneJsonLike(materialized.steps),
    args: cloneJsonLike(materialized.args),
    accounts: cloneJsonLike(materialized.accounts),
    loadInstructionArgs: cloneJsonLike(materialized.loadInstructionArgs),
    loadInstructionAccounts: cloneJsonLike(materialized.loadInstructionAccounts),
    remainingAccounts: cloneJsonLike(materialized.remainingAccounts),
    ...(normalizeOutputSpec(materialized.output, `${options.protocolId}/${options.operationId}`) ? {
      output: normalizeOutputSpec(materialized.output, `${options.protocolId}/${options.operationId}`),
    } : {}),
    pre: cloneJsonLike(materialized.pre ?? []),
    post: cloneJsonLike(materialized.post ?? []),
  };
}

export async function resolveProtocolForPacks(protocolId: string): Promise<ProtocolManifest> {
  return getProtocolById(protocolId);
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
  if (resolved.kind !== 'write') {
    throw new Error(`Operation ${options.operationId} is not a write.`);
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
  await runOperationSteps(operation.steps, resolverCtx, scope, derived);
  const resolvedArgs = normalizeRuntimeValue(resolveTemplateValue(operation.args ?? {}, scope));
  const resolvedAccounts = normalizeRuntimeValue(resolveTemplateValue(operation.accounts ?? {}, scope));
  const resolvedRemainingAccounts = normalizeRuntimeValue(
    resolveTemplateValue(operation.remainingAccounts ?? [], scope),
  );
  const explicitAccounts = assertStringRecord(resolvedAccounts, 'accounts');
  const finalAccounts = operation.instruction
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
    output: normalizeReadOutputSpec(operation.output, `${options.protocolId}/${options.operationId}`),
    preInstructions: resolvePreInstructions(operation.pre as PreInstructionSpec[] | undefined, scope),
    postInstructions: resolvePostInstructions(operation.post as PostInstructionSpec[] | undefined, scope),
  };
}

export async function runRuntimeView(options: {
  protocolId: string;
  operationId: string;
  input: Record<string, unknown>;
  connection: Connection;
  walletPublicKey: PublicKey;
}): Promise<PreparedMetaView> {
  const protocol = await getProtocolById(options.protocolId);
  const resolved = await resolveRuntimeOperation({
    protocolId: options.protocolId,
    operationId: options.operationId,
  });
  if (resolved.kind !== 'view') {
    throw new Error(`Operation ${options.operationId} is not a view capability.`);
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
  await runOperationSteps(operation.steps, resolverCtx, scope, derived);

  const resolvedLoadInstructionArgs = normalizeRuntimeValue(
    resolveTemplateValue(operation.loadInstructionArgs ?? {}, scope),
  );
  const resolvedLoadInstructionAccounts = normalizeRuntimeValue(
    resolveTemplateValue(operation.loadInstructionAccounts ?? {}, scope),
  );
  const explicitAccounts = assertStringRecord(
    resolvedLoadInstructionAccounts,
    'load_instruction_bindings.accounts',
  );
  const finalAccounts = operation.loadInstruction
    ? (
        await previewIdlInstruction({
          protocolId: options.protocolId,
          instructionName: operation.loadInstruction,
          args: resolvedLoadInstructionArgs as Record<string, unknown>,
          accounts: explicitAccounts,
          walletPublicKey: options.walletPublicKey,
        })
      ).resolvedAccounts
    : explicitAccounts;
  scope.instruction_accounts = finalAccounts;

  if (!operation.output?.source) {
    throw new Error(`View ${options.protocolId}/${options.operationId} has no output.`);
  }
  const output = normalizeRuntimeValue(resolvePath(scope, operation.output.source));

  return {
    protocolId: options.protocolId,
    operationId: options.operationId,
    derived,
    output,
    loadInstructionArgs: resolvedLoadInstructionArgs as Record<string, unknown>,
    loadInstructionAccounts: finalAccounts,
    preInstructions: resolvePreInstructions(operation.pre as PreInstructionSpec[] | undefined, scope),
    postInstructions: resolvePostInstructions(operation.post as PostInstructionSpec[] | undefined, scope),
    outputSpec: normalizeReadOutputSpec(operation.output, `${options.protocolId}/${options.operationId}`),
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
    throw new Error(
      `Operation ${options.operationId} has no instruction; use prepareRuntimeOperation for read-only flows.`,
    );
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
