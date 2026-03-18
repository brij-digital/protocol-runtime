import { BN, BorshAccountsCoder } from '@coral-xyz/anchor';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey, type Connection } from '@solana/web3.js';
import type { Idl } from '@coral-xyz/anchor';
import { getProtocolById } from './idlRegistry';
import { previewIdlInstruction } from './idlDeclarativeRuntime';
import { runRegisteredComputeStep } from './metaComputeRegistry';
import { runRegisteredDiscoverStep } from './metaDiscoverRegistry';
import { normalizeIdlForAnchorCoder } from './normalizeIdl';
import { resolveAppUrl } from './appUrl';

const META_IDL_SCHEMA = 'meta-idl.v0.6';
const META_IDL_CORE_SCHEMA = 'meta-idl.core.v0.6';
const META_APP_SCHEMA = 'meta-app.v0.1';
const DEFAULT_SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const DEFAULT_ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

type BuiltinResolverName =
  | 'wallet_pubkey'
  | 'decode_account'
  | 'account_owner'
  | 'token_account_balance'
  | 'token_supply'
  | 'ata'
  | 'pda'
  | 'lookup'
  | 'unix_timestamp';
type ResolverName = BuiltinResolverName;

type LookupMode = 'first' | 'all';
type ComputeKind = string;

type ResolverStepFallback = {
  resolver: ResolverName;
  address?: unknown;
  account_type?: string;
  owner?: unknown;
  mint?: unknown;
  token_program?: unknown;
  allow_owner_off_curve?: unknown;
  program_id?: unknown;
  seeds?: unknown[];
  source?: string;
  where?: unknown;
  select?: unknown;
  mode?: LookupMode;
  [key: string]: unknown;
};

type DeriveStep = ResolverStepFallback & {
  name: string;
  [key: string]: unknown;
};

type ComputeStep = {
  name: string;
  compute: ComputeKind;
  [key: string]: unknown;
};

type DiscoverStep = {
  name: string;
  discover: string;
  [key: string]: unknown;
};

type ActionInputSpec = {
  type: string;
  required?: boolean;
  default?: unknown;
  read_from?: string;
  ui_editable?: boolean;
  label?: string;
  placeholder?: string;
  help?: string;
  group?: string;
  display_order?: number;
  example?: unknown;
  ui_example?: unknown;
  validate?: {
    required?: boolean;
    min?: string | number;
    max?: string | number;
    pattern?: string;
    message?: string;
  };
};

type ReadOutputSpec = {
  type: 'array' | 'object' | 'scalar';
  source: string;
  title?: string;
  empty_text?: string;
  max_items?: number;
  item_label_fields?: string[];
};

type ViewSpec = {
  bootstrap: Record<string, unknown>;
  stream?: Record<string, unknown>;
  mapping: Record<string, unknown>;
  entity_keys: string[];
};

type ActionSpec = {
  label?: string;
  instruction?: string;
  inputs?: Record<string, ActionInputSpec>;
  discover?: DiscoverStep[];
  derive?: DeriveStep[];
  compute?: ComputeStep[];
  args?: Record<string, unknown>;
  accounts?: Record<string, unknown>;
  remaining_accounts?: Array<Record<string, unknown>>;
  view?: ViewSpec;
  read_output?: ReadOutputSpec;
  pre?: PreInstructionSpec[];
  post?: PostInstructionSpec[];
  use?: TemplateUseSpec[];
  validate?: {
    cross?: Array<{
      kind?: string;
      left?: string;
      right?: string;
      message?: string;
    }>;
  };
};

type UserAppActionSpec = {
  id: string;
  kind: 'run' | 'back' | 'reset';
  label: string;
  mode?: 'view' | 'simulate' | 'send';
  variant: 'primary' | 'secondary' | 'ghost';
};

type UserAppStatusTextSpec = {
  idle?: string;
  running: string;
  success: string;
  error: string;
};

type UserAppStepSpec = {
  id: string;
  label?: string;
  operation: string;
  title: string;
  description?: string;
  next_on_success?: string;
  status_text: UserAppStatusTextSpec;
  input_from?: Record<string, unknown>;
  requires_paths?: string[];
  actions: UserAppActionSpec[];
  ui?: {
    kind: 'select_from_derived';
    source: string;
    bind_to: string;
    value_path: string;
    label_fields?: string[];
    require_selection: boolean;
    auto_advance: boolean;
    title?: string;
    description?: string;
  };
};

type UserAppSpec = {
  label?: string;
  title: string;
  description?: string;
  entry_step: string;
  steps: UserAppStepSpec[];
};

type MaterializedActionSpec = {
  instruction: string;
  inputs: Record<string, ActionInputSpec>;
  discover: DiscoverStep[];
  derive: DeriveStep[];
  compute: ComputeStep[];
  args: Record<string, unknown>;
  accounts: Record<string, unknown>;
  remainingAccounts: unknown;
  view?: ViewSpec;
  readOutput?: ReadOutputSpec;
  pre?: PreInstructionSpec[];
  post?: PostInstructionSpec[];
};

type TemplateParamSpec =
  | string
  | {
      type?: string;
      required?: boolean;
      default?: unknown;
    };

type TemplateSpec = {
  params?: Record<string, TemplateParamSpec>;
  expand: Omit<ActionSpec, 'use'>;
};

type TemplateUseSpec = {
  template: string;
  with?: Record<string, unknown>;
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

type LookupSourceSpec =
  | { kind: 'inline'; items: unknown[] }
  | { kind: 'http_json'; url: string; items_path?: string; ttl_ms?: number };

type MetaCoreSpec = {
  schema: string;
  version: string;
  protocolId: string;
  label?: string;
  sources?: Record<string, LookupSourceSpec>;
  templates?: Record<string, TemplateSpec>;
  operations?: Record<string, ActionSpec>;
  apps?: Record<string, UserAppSpec>;
};

type MetaAppSpec = {
  schema: string;
  version: string;
  protocolId: string;
  label?: string;
  apps: Record<string, UserAppSpec>;
};

type MetaIdlSpec = {
  schema: string;
  version: string;
  protocolId: string;
  label?: string;
  sources?: Record<string, LookupSourceSpec>;
  templates?: Record<string, TemplateSpec>;
  operations?: Record<string, ActionSpec>;
  apps: Record<string, UserAppSpec>;
};

type ResolverContext = {
  protocol: {
    id: string;
    name: string;
    network: string;
    programId: string;
    idlPath: string;
    metaPath?: string;
    metaCorePath?: string;
    appPath?: string;
  };
  meta: MetaIdlSpec;
  input: Record<string, unknown>;
  idl: Idl;
  connection: Connection;
  walletPublicKey: PublicKey;
  scope: Record<string, unknown>;
};

type PreparedMetaInstruction = {
  protocolId: string;
  instructionName: string;
  args: Record<string, unknown>;
  accounts: Record<string, string>;
  remainingAccounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  derived: Record<string, unknown>;
  preInstructions: PreparedPreInstruction[];
  postInstructions: PreparedPostInstruction[];
};

type PreparedMetaOperation = {
  protocolId: string;
  operationId: string;
  instructionName: string | null;
  args: Record<string, unknown>;
  accounts: Record<string, string>;
  remainingAccounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  derived: Record<string, unknown>;
  readOutput?: {
    type: 'array' | 'object' | 'scalar';
    source: string;
    title?: string;
    emptyText?: string;
    maxItems?: number;
    itemLabelFields?: string[];
  };
  preInstructions: PreparedPreInstruction[];
  postInstructions: PreparedPostInstruction[];
};

type PreparedPreInstruction =
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

type PreparedPostInstruction = {
  kind: 'spl_token_close_account';
  account: string;
  destination: string;
  owner: string;
  tokenProgram: string;
};

export type MetaOperationExplain = {
  protocolId: string;
  operationId: string;
  schema: string | null;
  version: string;
  instruction: string;
  templateUse: Array<Record<string, unknown>>;
  inputs: Record<string, Record<string, unknown>>;
  discover: Array<Record<string, unknown>>;
  derive: Array<Record<string, unknown>>;
  compute: Array<Record<string, unknown>>;
  args: Record<string, unknown>;
  accounts: Record<string, unknown>;
  remainingAccounts: unknown;
  view?: Record<string, unknown>;
  readOutput?: Record<string, unknown>;
  pre: Array<Record<string, unknown>>;
  post: Array<Record<string, unknown>>;
};

export type MetaOperationSummary = {
  operationId: string;
  label?: string;
  instruction: string;
  executionKind: 'read' | 'write';
  inputs: Record<
    string,
    {
      type: string;
      required: boolean;
      default?: unknown;
      read_from?: string;
      read_stage?: 'discover' | 'derive' | 'compute' | 'input' | 'unknown';
      ui_editable?: boolean;
      label?: string;
      placeholder?: string;
      help?: string;
      group?: string;
      display_order?: number;
      example?: unknown;
      ui_example?: unknown;
      validate?: {
        required?: boolean;
        min?: string | number;
        max?: string | number;
        pattern?: string;
        message?: string;
      };
    }
  >;
  crossValidation?: Array<{
    kind: 'not_equal';
    left: string;
    right: string;
    message?: string;
  }>;
  readOutput?: {
    type: 'array' | 'object' | 'scalar';
    source: string;
    title?: string;
    emptyText?: string;
    maxItems?: number;
    itemLabelFields?: string[];
  };
};

export type MetaAppStepSummary = {
  stepId: string;
  label: string;
  operationId: string;
  title: string;
  description?: string;
  nextOnSuccess?: string;
  statusText: {
    idle?: string;
    running: string;
    success: string;
    error: string;
  };
  actions: Array<{
    actionId: string;
    kind: 'run' | 'back' | 'reset';
    label: string;
    mode?: 'view' | 'simulate' | 'send';
    variant: 'primary' | 'secondary' | 'ghost';
  }>;
  inputFrom: Record<string, unknown>;
  requiresPaths: string[];
  ui?: {
    kind: 'select_from_derived';
    source: string;
    bindTo: string;
    valuePath: string;
    labelFields: string[];
    requireSelection: boolean;
    autoAdvance: boolean;
    title?: string;
    description?: string;
  };
};

export type MetaAppSummary = {
  appId: string;
  label: string;
  title: string;
  description?: string;
  entryStepId: string;
  steps: MetaAppStepSummary[];
};

function resolveDiscoverStage(path: string, operation: MaterializedActionSpec): 'discover' | 'derive' | 'compute' | 'input' | 'unknown' {
  const cleaned = path.startsWith('$') ? path.slice(1) : path;
  const parts = cleaned.split('.').filter(Boolean);
  const [root] = parts;
  if (!root) {
    return 'unknown';
  }
  const candidate = root === 'derived' && parts.length > 1 ? parts[1] : root;
  if (root === 'input') {
    return 'input';
  }
  if ((operation.discover ?? []).some((step) => step.name === candidate)) {
    return 'discover';
  }
  if ((operation.derive ?? []).some((step) => step.name === candidate)) {
    return 'derive';
  }
  if ((operation.compute ?? []).some((step) => step.name === candidate)) {
    return 'compute';
  }
  return 'unknown';
}

function normalizeReadOutputSpec(
  spec: ReadOutputSpec | undefined,
  context: string,
):
  | {
      type: 'array' | 'object' | 'scalar';
      source: string;
      title?: string;
      emptyText?: string;
      maxItems?: number;
      itemLabelFields?: string[];
    }
  | undefined {
  if (!spec) {
    return undefined;
  }

  if (!spec.source || typeof spec.source !== 'string' || spec.source.trim().length === 0) {
    throw new Error(`${context}: read_output.source is required.`);
  }

  const normalized: {
    type: 'array' | 'object' | 'scalar';
    source: string;
    title?: string;
    emptyText?: string;
    maxItems?: number;
    itemLabelFields?: string[];
  } = {
    type: spec.type,
    source: spec.source,
  };

  if (typeof spec.title === 'string' && spec.title.length > 0) {
    normalized.title = spec.title;
  }
  if (typeof spec.empty_text === 'string' && spec.empty_text.length > 0) {
    normalized.emptyText = spec.empty_text;
  }
  if (typeof spec.max_items === 'number' && Number.isInteger(spec.max_items) && spec.max_items > 0) {
    normalized.maxItems = spec.max_items;
  }
  if (Array.isArray(spec.item_label_fields)) {
    const fields = spec.item_label_fields.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
    if (fields.length > 0) {
      normalized.itemLabelFields = fields;
    }
  }

  return normalized;
}

const metaCache = new Map<string, MetaIdlSpec>();
const idlCache = new Map<string, Idl>();
const lookupSourceCache = new Map<string, { expiresAt: number; items: unknown[] }>();

function normalizeRuntimeValue(value: unknown): unknown {
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

function readPathFromValue(value: unknown, path: string): unknown {
  const cleaned = path.startsWith('$') ? path.slice(1) : path;
  const parts = cleaned.split('.').filter(Boolean);
  let current: unknown = value;

  for (const part of parts) {
    if (!current || typeof current !== 'object') {
      return undefined;
    }

    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

function resolvePath(scope: Record<string, unknown>, path: string): unknown {
  const resolved = readPathFromValue(scope, path);
  if (resolved === undefined) {
    throw new Error(`Cannot resolve path ${path}`);
  }

  return resolved;
}

function resolveTemplateValue(value: unknown, scope: Record<string, unknown>): unknown {
  if (typeof value === 'string' && value.startsWith('$')) {
    return resolvePath(scope, value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplateValue(item, scope));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        resolveTemplateValue(nested, scope),
      ]),
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
    const entries = Object.entries(normalized as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => [key, normalizeComparable(nested)] as const);
    return Object.fromEntries(entries);
  }

  return normalized;
}

function comparableHash(value: unknown): string {
  return JSON.stringify(normalizeComparable(value));
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return comparableHash(left) === comparableHash(right);
}

function asString(value: unknown, label: string): string {
  if (typeof value === 'string') {
    return value;
  }

  throw new Error(`${label} must be a string.`);
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

  const mapped = Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
    const normalized = normalizeRuntimeValue(entry);
    if (typeof normalized !== 'string') {
      throw new Error(`${label}.${key} must resolve to string.`);
    }

    return [key, normalized] as const;
  });

  return Object.fromEntries(mapped);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must resolve to an object.`);
  }

  return value as Record<string, unknown>;
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

    return {
      pubkey,
      isSigner: Boolean(item.isSigner),
      isWritable: Boolean(item.isWritable),
    };
  });
}

function resolveWhereFilter(where: unknown, scope: Record<string, unknown>, label: string): Record<string, unknown> {
  if (where === undefined) {
    return {};
  }

  return asRecord(resolveTemplateValue(where, scope), label);
}

function itemMatchesWhere(item: unknown, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([path, expected]) => {
    const actual = readPathFromValue(item, path);
    return valuesEqual(actual, expected);
  });
}

function applySelectTemplate(select: unknown, item: unknown, scope: Record<string, unknown>): unknown {
  if (select === undefined) {
    return item;
  }

  return resolveTemplateValue(select, {
    ...scope,
    item,
  });
}

function resolveCollectionMode(mode: LookupMode | undefined): LookupMode {
  if (!mode) {
    return 'first';
  }

  if (mode === 'first' || mode === 'all') {
    return mode;
  }

  throw new Error(`Unsupported collection mode: ${String(mode)}`);
}

function resolveCollectionCandidates(step: DeriveStep, items: unknown[], scope: Record<string, unknown>): unknown[] {
  const where = resolveWhereFilter(step.where, scope, `${step.resolver}:${step.name}:where`);
  return items
    .filter((item) => itemMatchesWhere(item, where))
    .map((item) => applySelectTemplate(step.select, item, scope));
}

function readItemsByPath(value: unknown, path?: string): unknown[] {
  if (path) {
    const resolved = readPathFromValue(value, path);
    if (!Array.isArray(resolved)) {
      throw new Error(`items_path ${path} did not resolve to an array.`);
    }
    return resolved;
  }

  if (Array.isArray(value)) {
    return value;
  }

  if (value && typeof value === 'object') {
    const maybeItems = (value as Record<string, unknown>).items;
    if (Array.isArray(maybeItems)) {
      return maybeItems;
    }
  }

  throw new Error('Lookup source response must be an array or expose an array in "items".');
}

function assertMetaSpec(meta: MetaIdlSpec, protocolId: string): MetaIdlSpec {
  if (meta.schema !== META_IDL_SCHEMA) {
    throw new Error(
      `Unsupported meta IDL schema for ${protocolId}: ${meta.schema}. Required: ${META_IDL_SCHEMA}.`,
    );
  }

  if (meta.protocolId !== protocolId) {
    throw new Error(`Meta protocolId mismatch: expected ${protocolId}, got ${meta.protocolId}.`);
  }

  const hasOperations = !!meta.operations && typeof meta.operations === 'object';
  if (!hasOperations) {
    throw new Error(`Meta IDL for ${protocolId} is missing operations.`);
  }

  const hasApps = !!meta.apps && typeof meta.apps === 'object' && !Array.isArray(meta.apps);
  if (!hasApps) {
    throw new Error(`Meta IDL for ${protocolId} is missing apps (required in app-first schema).`);
  }

  return meta;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toMetaCoreSpec(value: unknown, protocolId: string, sourcePath: string): MetaCoreSpec {
  if (!isObject(value)) {
    throw new Error(`Invalid meta core for ${protocolId}: ${sourcePath} must be an object.`);
  }
  const schema = asString(value.schema, `${protocolId}:${sourcePath}.schema`);
  if (schema !== META_IDL_CORE_SCHEMA && schema !== META_IDL_SCHEMA) {
    throw new Error(
      `Unsupported meta core schema for ${protocolId}: ${schema}. Required: ${META_IDL_CORE_SCHEMA} or ${META_IDL_SCHEMA}.`,
    );
  }
  const protocolInFile = asString(value.protocolId, `${protocolId}:${sourcePath}.protocolId`);
  if (protocolInFile !== protocolId) {
    throw new Error(
      `Meta core protocolId mismatch in ${sourcePath}: expected ${protocolId}, got ${protocolInFile}.`,
    );
  }
  return value as MetaCoreSpec;
}

function toMetaAppSpec(value: unknown, protocolId: string, sourcePath: string): MetaAppSpec {
  if (!isObject(value)) {
    throw new Error(`Invalid meta app for ${protocolId}: ${sourcePath} must be an object.`);
  }
  const schema = asString(value.schema, `${protocolId}:${sourcePath}.schema`);
  if (schema !== META_APP_SCHEMA) {
    throw new Error(
      `Unsupported meta app schema for ${protocolId}: ${schema}. Required: ${META_APP_SCHEMA}.`,
    );
  }
  const protocolInFile = asString(value.protocolId, `${protocolId}:${sourcePath}.protocolId`);
  if (protocolInFile !== protocolId) {
    throw new Error(
      `Meta app protocolId mismatch in ${sourcePath}: expected ${protocolId}, got ${protocolInFile}.`,
    );
  }
  if (!isObject(value.apps)) {
    throw new Error(`Meta app for ${protocolId} is missing apps object (${sourcePath}).`);
  }
  return value as MetaAppSpec;
}

function resolveOperationSpec(meta: MetaIdlSpec, protocolId: string, operationId: string): ActionSpec {
  const operationSpec = meta.operations?.[operationId];
  if (!operationSpec) {
    throw new Error(`Operation ${operationId} not found in meta IDL for ${protocolId}.`);
  }

  return operationSpec;
}

function cloneJsonLike<T>(value: T): T {
  if (value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function resolveTemplateExpansionValue(value: unknown, paramScope: Record<string, unknown>): unknown {
  if (typeof value === 'string' && value.startsWith('$param.')) {
    return resolvePath(paramScope, value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplateExpansionValue(item, paramScope));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        resolveTemplateExpansionValue(nested, paramScope),
      ]),
    );
  }

  return value;
}

function resolveTemplateParams(templateName: string, template: TemplateSpec, use: TemplateUseSpec): Record<string, unknown> {
  const provided = use.with ?? {};
  if (template.params && typeof template.params !== 'object') {
    throw new Error(`Template ${templateName} params must be an object.`);
  }

  const resolved: Record<string, unknown> = {};
  if (template.params) {
    for (const [name, rawSpec] of Object.entries(template.params)) {
      const spec = typeof rawSpec === 'string' ? { type: rawSpec } : rawSpec;
      if (provided[name] !== undefined) {
        resolved[name] = provided[name];
        continue;
      }
      if (spec.default !== undefined) {
        resolved[name] = spec.default;
        continue;
      }
      if (spec.required !== false) {
        throw new Error(`Template ${templateName} missing required param ${name}.`);
      }
    }

    for (const key of Object.keys(provided)) {
      if (!(key in template.params)) {
        throw new Error(`Template ${templateName} received unknown param ${key}.`);
      }
    }
  } else {
    Object.assign(resolved, provided);
  }

  return resolved;
}

function mergeActionFragment(target: MaterializedActionSpec, fragment: Omit<ActionSpec, 'use'>, label: string): void {
  if (fragment.instruction) {
    if (target.instruction && target.instruction !== fragment.instruction) {
      throw new Error(
        `Conflicting instruction while materializing operation (${label}): ${target.instruction} vs ${fragment.instruction}.`,
      );
    }
    target.instruction = fragment.instruction;
  }

  if (fragment.inputs) {
    target.inputs = {
      ...target.inputs,
      ...cloneJsonLike(fragment.inputs),
    };
  }

  if (fragment.derive) {
    target.derive.push(...cloneJsonLike(fragment.derive));
  }

  if (fragment.discover) {
    target.discover.push(...cloneJsonLike(fragment.discover));
  }

  if (fragment.compute) {
    target.compute.push(...cloneJsonLike(fragment.compute));
  }

  if (fragment.args) {
    target.args = {
      ...target.args,
      ...cloneJsonLike(fragment.args),
    };
  }

  if (fragment.accounts) {
    target.accounts = {
      ...target.accounts,
      ...cloneJsonLike(fragment.accounts),
    };
  }

  if (fragment.remaining_accounts !== undefined) {
    const cloned = cloneJsonLike(fragment.remaining_accounts);
    if (Array.isArray(cloned) && Array.isArray(target.remainingAccounts)) {
      target.remainingAccounts.push(...cloned);
    } else {
      target.remainingAccounts = cloned;
    }
  }

  if (fragment.view !== undefined) {
    target.view = cloneJsonLike(fragment.view);
  }

  if (fragment.read_output !== undefined) {
    target.readOutput = cloneJsonLike(fragment.read_output);
  }

  if (fragment.pre && fragment.pre.length > 0) {
    target.pre = [...(target.pre ?? []), ...cloneJsonLike(fragment.pre)];
  }

  if (fragment.post && fragment.post.length > 0) {
    target.post = [...(target.post ?? []), ...cloneJsonLike(fragment.post)];
  }
}

function materializeOperation(operationId: string, operation: ActionSpec, meta: MetaIdlSpec): MaterializedActionSpec {
  const materialized: MaterializedActionSpec = {
    instruction: '',
    inputs: {},
    discover: [],
    derive: [],
    compute: [],
    args: {},
    accounts: {},
    remainingAccounts: [],
    pre: [],
    post: [],
  };

  for (const use of operation.use ?? []) {
    const templateName = use.template;
    if (!templateName) {
      throw new Error(`Operation ${operationId} contains use item without template name.`);
    }

    const template = meta.templates?.[templateName];
    if (!template) {
      throw new Error(`Operation ${operationId} references unknown template ${templateName}.`);
    }

    const params = resolveTemplateParams(templateName, template, use);
    const expanded = resolveTemplateExpansionValue(cloneJsonLike(template.expand), {
      param: params,
    }) as Omit<ActionSpec, 'use'>;
    mergeActionFragment(materialized, expanded, `template ${templateName}`);
  }

  const actionDirectFragment = cloneJsonLike({
    instruction: operation.instruction,
    inputs: operation.inputs,
    discover: operation.discover,
    derive: operation.derive,
    compute: operation.compute,
    args: operation.args,
    accounts: operation.accounts,
    remaining_accounts: operation.remaining_accounts,
    view: operation.view,
    read_output: operation.read_output,
    pre: operation.pre,
    post: operation.post,
  });
  mergeActionFragment(materialized, actionDirectFragment, `operation ${operationId}`);

  for (const [inputName, inputSpec] of Object.entries(materialized.inputs ?? {})) {
    if (inputSpec.ui_editable === false) {
      if (typeof inputSpec.read_from !== 'string' || inputSpec.read_from.trim().length === 0) {
        throw new Error(
          `Operation ${operationId} input ${inputName}: ui_editable=false requires non-empty read_from.`,
        );
      }
    }
  }

  return materialized;
}

function evaluateCondition(condition: MetaCondition, scope: Record<string, unknown>): boolean {
  if ('equals' in condition) {
    const [left, right] = condition.equals;
    const resolvedLeft = normalizeRuntimeValue(resolveTemplateValue(left, scope));
    const resolvedRight = normalizeRuntimeValue(resolveTemplateValue(right, scope));
    return valuesEqual(resolvedLeft, resolvedRight);
  }

  if ('all' in condition) {
    return condition.all.every((entry) => evaluateCondition(entry, scope));
  }

  if ('any' in condition) {
    return condition.any.some((entry) => evaluateCondition(entry, scope));
  }

  if ('not' in condition) {
    return !evaluateCondition(condition.not, scope);
  }

  throw new Error('Unsupported meta condition.');
}

function resolvePostInstructions(
  post: PostInstructionSpec[] | undefined,
  scope: Record<string, unknown>,
): PreparedPostInstruction[] {
  if (!post || post.length === 0) {
    return [];
  }

  return post
    .filter((spec) => (spec.when ? evaluateCondition(spec.when, scope) : true))
    .map((spec) => {
      if (spec.kind !== 'spl_token_close_account') {
        throw new Error(`Unsupported post instruction kind: ${spec.kind}`);
      }

      const account = asString(resolveTemplateValue(spec.account, scope), 'post.account');
      const destination = asString(resolveTemplateValue(spec.destination, scope), 'post.destination');
      const owner = asString(resolveTemplateValue(spec.owner, scope), 'post.owner');
      const tokenProgram = spec.token_program
        ? asString(resolveTemplateValue(spec.token_program, scope), 'post.token_program')
        : DEFAULT_SPL_TOKEN_PROGRAM;

      return {
        kind: 'spl_token_close_account',
        account,
        destination,
        owner,
        tokenProgram,
      };
    });
}

function resolvePreInstructions(
  pre: PreInstructionSpec[] | undefined,
  scope: Record<string, unknown>,
): PreparedPreInstruction[] {
  if (!pre || pre.length === 0) {
    return [];
  }

  return pre
    .filter((spec) => (spec.when ? evaluateCondition(spec.when, scope) : true))
    .map((spec) => {
      if (spec.kind === 'spl_ata_create_idempotent') {
        const payer = asString(resolveTemplateValue(spec.payer, scope), 'pre.payer');
        const ata = asString(resolveTemplateValue(spec.ata, scope), 'pre.ata');
        const owner = asString(resolveTemplateValue(spec.owner, scope), 'pre.owner');
        const mint = asString(resolveTemplateValue(spec.mint, scope), 'pre.mint');
        const tokenProgram = spec.token_program
          ? asString(resolveTemplateValue(spec.token_program, scope), 'pre.token_program')
          : DEFAULT_SPL_TOKEN_PROGRAM;
        const associatedTokenProgram = spec.associated_token_program
          ? asString(resolveTemplateValue(spec.associated_token_program, scope), 'pre.associated_token_program')
          : DEFAULT_ASSOCIATED_TOKEN_PROGRAM;
        return {
          kind: 'spl_ata_create_idempotent',
          payer,
          ata,
          owner,
          mint,
          tokenProgram,
          associatedTokenProgram,
        };
      }

      if (spec.kind === 'system_transfer') {
        const from = asString(resolveTemplateValue(spec.from, scope), 'pre.from');
        const to = asString(resolveTemplateValue(spec.to, scope), 'pre.to');
        const lamports = asU64String(resolveTemplateValue(spec.lamports, scope), 'pre.lamports');
        return {
          kind: 'system_transfer',
          from,
          to,
          lamports,
        };
      }

      if (spec.kind === 'spl_token_sync_native') {
        const account = asString(resolveTemplateValue(spec.account, scope), 'pre.account');
        const tokenProgram = spec.token_program
          ? asString(resolveTemplateValue(spec.token_program, scope), 'pre.token_program')
          : DEFAULT_SPL_TOKEN_PROGRAM;
        return {
          kind: 'spl_token_sync_native',
          account,
          tokenProgram,
        };
      }

      throw new Error(`Unsupported pre instruction kind: ${(spec as { kind?: unknown }).kind}`);
    });
}

async function loadMetaSpec(protocolId: string): Promise<MetaIdlSpec> {
  if (metaCache.has(protocolId)) {
    return metaCache.get(protocolId)!;
  }

  const protocol = await getProtocolById(protocolId);
  const corePath = protocol.metaCorePath ?? protocol.metaPath;
  if (!corePath) {
    throw new Error(
      `Protocol ${protocolId} does not define metaCorePath or metaPath in registry.`,
    );
  }

  const loadJsonByPath = async (filePath: string): Promise<unknown> => {
    const response = await fetch(resolveAppUrl(filePath));
    if (!response.ok) {
      throw new Error(`Failed to load JSON from ${filePath}.`);
    }
    return response.json();
  };

  const coreSpec = toMetaCoreSpec(await loadJsonByPath(corePath), protocolId, corePath);
  const isLegacyCombined = coreSpec.schema === META_IDL_SCHEMA;

  const appPath = isLegacyCombined
    ? null
    : (() => {
        if (!protocol.appPath) {
          throw new Error(`Protocol ${protocolId} is missing appPath for ${META_APP_SCHEMA}.`);
        }
        return protocol.appPath;
      })();

  const resolvedApps = isLegacyCombined
    ? (coreSpec.apps ?? {})
    : toMetaAppSpec(await loadJsonByPath(appPath!), protocolId, appPath!).apps;

  const merged: MetaIdlSpec = {
    schema: META_IDL_SCHEMA,
    version: coreSpec.version,
    protocolId: coreSpec.protocolId,
    ...(typeof coreSpec.label === 'string' ? { label: coreSpec.label } : {}),
    ...(coreSpec.sources ? { sources: coreSpec.sources } : {}),
    ...(coreSpec.templates ? { templates: coreSpec.templates } : {}),
    ...(coreSpec.operations ? { operations: coreSpec.operations } : {}),
    apps: resolvedApps,
  };

  const asserted = assertMetaSpec(merged, protocolId);
  metaCache.set(protocolId, asserted);
  return asserted;
}

async function loadProtocolIdl(protocolId: string): Promise<Idl> {
  if (idlCache.has(protocolId)) {
    return idlCache.get(protocolId)!;
  }

  const protocol = await getProtocolById(protocolId);
  const response = await fetch(resolveAppUrl(protocol.idlPath));
  if (!response.ok) {
    throw new Error(`Failed to load IDL from ${protocol.idlPath}`);
  }

  const parsed = normalizeIdlForAnchorCoder((await response.json()) as Idl);
  idlCache.set(protocolId, parsed);
  return parsed;
}

async function loadLookupItems(step: DeriveStep, ctx: ResolverContext): Promise<unknown[]> {
  if (!step.source) {
    throw new Error(`Resolver lookup for ${step.name} missing source.`);
  }

  const source = ctx.meta.sources?.[step.source];
  if (!source) {
    throw new Error(`Lookup source ${step.source} not found in meta IDL.`);
  }

  if (source.kind === 'inline') {
    return source.items;
  }

  const resolvedUrl = asString(resolveTemplateValue(source.url, ctx.scope), `lookup:${step.name}:source.url`);
  const cacheKey = `${ctx.protocol.id}:${step.source}:${resolvedUrl}`;
  const now = Date.now();
  const ttlMs = source.ttl_ms ?? 0;
  const cached = lookupSourceCache.get(cacheKey);
  if (cached && cached.expiresAt >= now) {
    return cached.items;
  }

  const response = await fetch(resolveAppUrl(resolvedUrl));
  if (!response.ok) {
    throw new Error(`Lookup source ${step.source} fetch failed: ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as unknown;
  const items = readItemsByPath(body, source.items_path);

  if (ttlMs > 0) {
    lookupSourceCache.set(cacheKey, {
      expiresAt: now + ttlMs,
      items,
    });
  }

  return items;
}

async function runResolver(step: DeriveStep, ctx: ResolverContext): Promise<unknown> {
  if (step.resolver === 'wallet_pubkey') {
    return ctx.walletPublicKey.toBase58();
  }

  if (step.resolver === 'decode_account') {
    if (!step.address || !step.account_type) {
      throw new Error(`Resolver decode_account for ${step.name} missing address/account_type.`);
    }

    const address = asPubkey(resolveTemplateValue(step.address, ctx.scope), `decode_account:${step.name}:address`);
    const info = await ctx.connection.getAccountInfo(address, 'confirmed');
    if (!info) {
      throw new Error(`Account not found for decode_account ${step.name}: ${address.toBase58()}`);
    }

    const coder = new BorshAccountsCoder(ctx.idl);
    const decoded = coder.decode(step.account_type, info.data);
    return normalizeRuntimeValue(decoded);
  }

  if (step.resolver === 'account_owner') {
    if (!step.address) {
      throw new Error(`Resolver account_owner for ${step.name} missing address.`);
    }
    const address = asPubkey(resolveTemplateValue(step.address, ctx.scope), `account_owner:${step.name}:address`);
    const info = await ctx.connection.getAccountInfo(address, 'confirmed');
    if (!info) {
      throw new Error(`Account not found for account_owner ${step.name}: ${address.toBase58()}`);
    }
    return info.owner.toBase58();
  }

  if (step.resolver === 'token_account_balance') {
    if (!step.address) {
      throw new Error(`Resolver token_account_balance for ${step.name} missing address.`);
    }
    const address = asPubkey(
      resolveTemplateValue(step.address, ctx.scope),
      `token_account_balance:${step.name}:address`,
    );
    try {
      const balance = await ctx.connection.getTokenAccountBalance(address, 'confirmed');
      return balance.value.amount;
    } catch (error) {
      const allowMissing =
        step.allow_missing === undefined
          ? false
          : Boolean(resolveTemplateValue(step.allow_missing, ctx.scope));
      if (!allowMissing) {
        throw error;
      }
      const defaultValue =
        step.default === undefined ? '0' : normalizeRuntimeValue(resolveTemplateValue(step.default, ctx.scope));
      if (
        typeof defaultValue !== 'string' &&
        typeof defaultValue !== 'number' &&
        typeof defaultValue !== 'bigint'
      ) {
        throw new Error(`Resolver token_account_balance default for ${step.name} must be integer-like.`);
      }
      return String(defaultValue);
    }
  }

  if (step.resolver === 'token_supply') {
    if (!step.mint) {
      throw new Error(`Resolver token_supply for ${step.name} missing mint.`);
    }
    const mint = asPubkey(resolveTemplateValue(step.mint, ctx.scope), `token_supply:${step.name}:mint`);
    const supply = await ctx.connection.getTokenSupply(mint, 'confirmed');
    return supply.value.amount;
  }

  if (step.resolver === 'ata') {
    if (!step.owner || !step.mint) {
      throw new Error(`Resolver ata for ${step.name} missing owner/mint.`);
    }

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

  if (step.resolver === 'pda') {
    if (!step.program_id || !step.seeds) {
      throw new Error(`Resolver pda for ${step.name} missing program_id/seeds.`);
    }

    const programId = asPubkey(resolveTemplateValue(step.program_id, ctx.scope), `pda:${step.name}:program_id`);

    const seeds = step.seeds.map((seed, index) => {
      if (typeof seed === 'string' && seed.startsWith('utf8:')) {
        return new TextEncoder().encode(seed.slice('utf8:'.length));
      }

      const resolved = resolveTemplateValue(seed, ctx.scope);
      const asKey = asPubkey(resolved, `pda:${step.name}:seed[${index}]`);
      return asKey.toBuffer();
    });

    return PublicKey.findProgramAddressSync(seeds, programId)[0].toBase58();
  }

  if (step.resolver === 'lookup') {
    const mode = resolveCollectionMode(step.mode);
    const items = await loadLookupItems(step, ctx);
    const candidates = resolveCollectionCandidates(step, items, ctx.scope);
    if (candidates.length === 0) {
      throw new Error(`lookup resolver returned no candidate for step ${step.name}.`);
    }

    if (mode === 'all') {
      return normalizeRuntimeValue(candidates);
    }

    return normalizeRuntimeValue(candidates[0]);
  }

  if (step.resolver === 'unix_timestamp') {
    return Math.floor(Date.now() / 1000);
  }

  throw new Error(`Unsupported resolver: ${step.resolver}`);
}

async function runComputeStep(step: ComputeStep, ctx: ResolverContext): Promise<unknown> {
  const resolvedStep = asRecord(normalizeRuntimeValue(resolveTemplateValue(step, ctx.scope)), `compute:${step.name}`);
  const compute = asString(resolvedStep.compute, `compute:${step.name}:compute`);
  return runRegisteredComputeStep(
    {
      ...resolvedStep,
      name: step.name,
      compute,
    },
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

        return {
          programId: preview.programId,
          dataBase64: preview.dataBase64,
          keys: preview.keys,
        };
      },
    },
  );
}

async function runDiscoverStep(step: DiscoverStep, ctx: ResolverContext): Promise<unknown> {
  const rawStep = asRecord(normalizeRuntimeValue(step), `discover:${step.name}`);
  const discover = asString(rawStep.discover, `discover:${step.name}:discover`);
  const resolvedStep =
    discover === 'discover.query' || discover === 'discover.pick_list_item_by_value'
      ? rawStep
      : asRecord(normalizeRuntimeValue(resolveTemplateValue(step, ctx.scope)), `discover:${step.name}`);
  return runRegisteredDiscoverStep(
    {
      ...resolvedStep,
      name: step.name,
      discover,
    },
    {
      protocolId: ctx.protocol.id,
      programId: ctx.protocol.programId,
      connection: ctx.connection,
      walletPublicKey: ctx.walletPublicKey,
      idl: ctx.idl,
      scope: ctx.scope,
    },
  );
}

async function prepareMetaOperationInternal(options: {
  protocolId: string;
  operationId: string;
  input: Record<string, unknown>;
  connection: Connection;
  walletPublicKey: PublicKey;
}): Promise<PreparedMetaOperation> {
  const protocol = await getProtocolById(options.protocolId);
  const meta = await loadMetaSpec(options.protocolId);
  const idl = await loadProtocolIdl(options.protocolId);

  const operationSpec = resolveOperationSpec(meta, options.protocolId, options.operationId);
  const operation = materializeOperation(options.operationId, operationSpec, meta);

  const hydratedInput: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(operation.inputs ?? {})) {
    if (options.input[key] !== undefined) {
      hydratedInput[key] = options.input[key];
      continue;
    }

    if (spec.default !== undefined) {
      hydratedInput[key] = spec.default;
      continue;
    }

    if (spec.required !== false) {
      throw new Error(`Missing required meta input: ${key}`);
    }
  }

  const scope: Record<string, unknown> = {
    input: hydratedInput,
    protocol: {
      id: protocol.id,
      name: protocol.name,
      network: protocol.network,
      programId: protocol.programId,
      idlPath: protocol.idlPath,
      ...(protocol.metaPath ? { metaPath: protocol.metaPath } : {}),
      ...(protocol.metaCorePath ? { metaCorePath: protocol.metaCorePath } : {}),
      ...(protocol.appPath ? { appPath: protocol.appPath } : {}),
    },
    meta,
  };

  const derived: Record<string, unknown> = {};
  scope.derived = derived;

  const resolverCtx: ResolverContext = {
    protocol: scope.protocol as ResolverContext['protocol'],
    meta,
    input: hydratedInput,
    idl,
    connection: options.connection,
    walletPublicKey: options.walletPublicKey,
    scope,
  };

  for (const step of operation.discover ?? []) {
    if (!step.name) {
      throw new Error(`Operation ${options.operationId} has discover step without name.`);
    }

    const value = await runDiscoverStep(step, resolverCtx);
    derived[step.name] = value;
    scope[step.name] = value;
    scope.derived = derived;
  }

  for (const step of operation.derive ?? []) {
    if (!step.name) {
      throw new Error(`Operation ${options.operationId} has derive step without name.`);
    }

    const value = await runResolver(step, resolverCtx);
    derived[step.name] = value;
    scope[step.name] = value;
    scope.derived = derived;
  }

  for (const step of operation.compute ?? []) {
    if (!step.name) {
      throw new Error(`Operation ${options.operationId} has compute step without name.`);
    }

    const value = await runComputeStep(step, resolverCtx);
    derived[step.name] = value;
    scope[step.name] = value;
    scope.derived = derived;
  }

  const resolvedArgs = normalizeRuntimeValue(resolveTemplateValue(operation.args ?? {}, scope));
  const resolvedAccounts = normalizeRuntimeValue(resolveTemplateValue(operation.accounts ?? {}, scope));
  const resolvedRemainingAccounts = normalizeRuntimeValue(
    resolveTemplateValue(operation.remainingAccounts ?? [], scope),
  );
  const preInstructions = resolvePreInstructions(operation.pre, scope);
  const postInstructions = resolvePostInstructions(operation.post, scope);

  return {
    protocolId: options.protocolId,
    operationId: options.operationId,
    instructionName: operation.instruction ? operation.instruction : null,
    args: resolvedArgs as Record<string, unknown>,
    accounts: assertStringRecord(resolvedAccounts, 'accounts'),
    remainingAccounts: assertRemainingAccounts(resolvedRemainingAccounts, 'remaining_accounts'),
    derived,
    readOutput: normalizeReadOutputSpec(
      operation.readOutput,
      `${options.protocolId}/${options.operationId}`,
    ),
    preInstructions,
    postInstructions,
  };
}

export async function prepareMetaOperation(options: {
  protocolId: string;
  operationId: string;
  input: Record<string, unknown>;
  connection: Connection;
  walletPublicKey: PublicKey;
}): Promise<PreparedMetaOperation> {
  return prepareMetaOperationInternal(options);
}

export async function prepareMetaInstruction(options: {
  protocolId: string;
  operationId: string;
  input: Record<string, unknown>;
  connection: Connection;
  walletPublicKey: PublicKey;
}): Promise<PreparedMetaInstruction> {
  const prepared = await prepareMetaOperationInternal(options);
  if (!prepared.instructionName) {
    throw new Error(`Operation ${options.operationId} has no instruction; use prepareMetaOperation for read-only flows.`);
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

export async function explainMetaOperation(options: {
  protocolId: string;
  operationId: string;
}): Promise<MetaOperationExplain> {
  const meta = await loadMetaSpec(options.protocolId);
  const operationSpec = resolveOperationSpec(meta, options.protocolId, options.operationId);
  const materialized = materializeOperation(options.operationId, operationSpec, meta);
  const readOutput = normalizeReadOutputSpec(materialized.readOutput, `${options.protocolId}/${options.operationId}`);

  return {
    protocolId: options.protocolId,
    operationId: options.operationId,
    schema: meta.schema ?? null,
    version: meta.version,
    instruction: materialized.instruction,
    templateUse: cloneJsonLike(operationSpec.use ?? []),
    inputs: cloneJsonLike(materialized.inputs),
    discover: cloneJsonLike(materialized.discover),
    derive: cloneJsonLike(materialized.derive),
    compute: cloneJsonLike(materialized.compute),
    args: cloneJsonLike(materialized.args),
    accounts: cloneJsonLike(materialized.accounts),
    remainingAccounts: cloneJsonLike(materialized.remainingAccounts),
    ...(materialized.view ? { view: cloneJsonLike(materialized.view) } : {}),
    ...(readOutput ? { readOutput } : {}),
    pre: cloneJsonLike(materialized.pre ?? []),
    post: cloneJsonLike(materialized.post ?? []),
  };
}

export async function listMetaOperations(options: {
  protocolId: string;
}): Promise<{
  protocolId: string;
  schema: string | null;
  version: string;
  operations: MetaOperationSummary[];
}> {
  const meta = await loadMetaSpec(options.protocolId);
  const operations = meta.operations ?? {};

  const summaries = Object.entries(operations)
    .map(([operationId, operationSpec]) => {
      const operation = materializeOperation(operationId, operationSpec, meta);
      const readOutput = normalizeReadOutputSpec(operation.readOutput, `${options.protocolId}/${operationId}`);
      const operationLabel =
        typeof operationSpec.label === 'string' && operationSpec.label.trim().length > 0
          ? operationSpec.label.trim()
          : undefined;
      const crossValidation = Array.isArray(operationSpec.validate?.cross)
        ? operationSpec.validate!.cross
            .map((rule) =>
              rule &&
              typeof rule === 'object' &&
              rule.kind === 'not_equal' &&
              typeof rule.left === 'string' &&
              rule.left.trim().length > 0 &&
              typeof rule.right === 'string' &&
              rule.right.trim().length > 0
                ? {
                    kind: 'not_equal' as const,
                    left: rule.left.trim(),
                    right: rule.right.trim(),
                    ...(typeof rule.message === 'string' && rule.message.trim().length > 0
                      ? { message: rule.message.trim() }
                      : {}),
                  }
                : null,
            )
            .filter(
              (rule): rule is {
                kind: 'not_equal';
                left: string;
                right: string;
                message?: string;
              } => rule !== null,
            )
        : [];
      const inputs = Object.fromEntries(
        Object.entries(operation.inputs).map(([name, spec]) => [
          name,
          {
            type: spec.type,
            required: spec.required !== false,
            ...(spec.default !== undefined ? { default: cloneJsonLike(spec.default) } : {}),
            ...(spec.read_from ? { read_from: spec.read_from } : {}),
            ...(spec.read_from ? { read_stage: resolveDiscoverStage(spec.read_from, operation) } : {}),
            ...(typeof spec.ui_editable === 'boolean' ? { ui_editable: spec.ui_editable } : {}),
            ...(typeof spec.label === 'string' && spec.label.trim().length > 0 ? { label: spec.label.trim() } : {}),
            ...(typeof spec.placeholder === 'string' && spec.placeholder.trim().length > 0
              ? { placeholder: spec.placeholder.trim() }
              : {}),
            ...(typeof spec.help === 'string' && spec.help.trim().length > 0 ? { help: spec.help.trim() } : {}),
            ...(typeof spec.group === 'string' && spec.group.trim().length > 0 ? { group: spec.group.trim() } : {}),
            ...(typeof spec.display_order === 'number' && Number.isFinite(spec.display_order)
              ? { display_order: spec.display_order }
              : {}),
            ...(spec.example !== undefined ? { example: cloneJsonLike(spec.example) } : {}),
            ...(spec.ui_example !== undefined ? { ui_example: cloneJsonLike(spec.ui_example) } : {}),
            ...(spec.validate && typeof spec.validate === 'object'
              ? {
                  validate: {
                    ...(typeof spec.validate.required === 'boolean'
                      ? { required: spec.validate.required }
                      : {}),
                    ...(typeof spec.validate.min === 'string' || typeof spec.validate.min === 'number'
                      ? { min: spec.validate.min }
                      : {}),
                    ...(typeof spec.validate.max === 'string' || typeof spec.validate.max === 'number'
                      ? { max: spec.validate.max }
                      : {}),
                    ...(typeof spec.validate.pattern === 'string' && spec.validate.pattern.trim().length > 0
                      ? { pattern: spec.validate.pattern.trim() }
                      : {}),
                    ...(typeof spec.validate.message === 'string' && spec.validate.message.trim().length > 0
                      ? { message: spec.validate.message.trim() }
                      : {}),
                  },
                }
              : {}),
          },
        ]),
      );

      return {
        operationId,
        ...(operationLabel ? { label: operationLabel } : {}),
        instruction: operation.instruction,
        executionKind: operation.instruction ? 'write' : 'read',
        inputs,
        ...(crossValidation.length > 0 ? { crossValidation } : {}),
        ...(readOutput ? { readOutput } : {}),
      } as MetaOperationSummary;
    })
    .sort((a, b) => a.operationId.localeCompare(b.operationId));

  return {
    protocolId: options.protocolId,
    schema: meta.schema ?? null,
    version: meta.version,
    operations: summaries,
  };
}

export async function listMetaApps(options: {
  protocolId: string;
}): Promise<{
  protocolId: string;
  schema: string | null;
  version: string;
  apps: MetaAppSummary[];
}> {
  const meta = await loadMetaSpec(options.protocolId);
  const operations = meta.operations ?? {};
  const appsSpec = asRecord(meta.apps, `${options.protocolId}.apps`);

  const apps = Object.entries(appsSpec)
    .map(([appId, appRaw]) => {
      const app = asRecord(appRaw, `${options.protocolId}.apps.${appId}`);
      const appLabel = asString(app.label, `${options.protocolId}.apps.${appId}.label`);
      const title = asString(app.title, `${options.protocolId}.apps.${appId}.title`);
      const entryStepId = asString(app.entry_step, `${options.protocolId}.apps.${appId}.entry_step`);
      if (!Array.isArray(app.steps) || app.steps.length === 0) {
        throw new Error(`${options.protocolId}.apps.${appId}.steps must be a non-empty array.`);
      }

      const steps = app.steps.map((stepRaw, index) => {
        const step = asRecord(stepRaw, `${options.protocolId}.apps.${appId}.steps[${index}]`);
        const stepId = asString(step.id, `${options.protocolId}.apps.${appId}.steps[${index}].id`);
        const operationId = asString(step.operation, `${options.protocolId}.apps.${appId}.steps[${index}].operation`);
        if (!operations[operationId]) {
          throw new Error(
            `${options.protocolId}.apps.${appId}.steps[${index}] references unknown operation ${operationId}.`,
          );
        }
        const stepLabel = asString(step.label, `${options.protocolId}.apps.${appId}.steps[${index}].label`);
        const stepTitle = asString(step.title, `${options.protocolId}.apps.${appId}.steps[${index}].title`);
        const nextOnSuccess =
          typeof step.next_on_success === 'string' && step.next_on_success.trim().length > 0
            ? step.next_on_success.trim()
            : undefined;
        const statusText = (() => {
          if (!step.status_text || typeof step.status_text !== 'object' || Array.isArray(step.status_text)) {
            throw new Error(`${options.protocolId}.apps.${appId}.steps[${index}].status_text must be an object.`);
          }
          const rawStatus = asRecord(
            step.status_text,
            `${options.protocolId}.apps.${appId}.steps[${index}].status_text`,
          );
          const running = asString(
            rawStatus.running,
            `${options.protocolId}.apps.${appId}.steps[${index}].status_text.running`,
          ).trim();
          const success = asString(
            rawStatus.success,
            `${options.protocolId}.apps.${appId}.steps[${index}].status_text.success`,
          ).trim();
          const error = asString(
            rawStatus.error,
            `${options.protocolId}.apps.${appId}.steps[${index}].status_text.error`,
          ).trim();
          if (!running || !success || !error) {
            throw new Error(
              `${options.protocolId}.apps.${appId}.steps[${index}].status_text running/success/error must be non-empty.`,
            );
          }
          return {
            ...(typeof rawStatus.idle === 'string' && rawStatus.idle.trim().length > 0
              ? { idle: rawStatus.idle.trim() }
              : {}),
            running,
            success,
            error,
          };
        })();
        const inputFrom =
          step.input_from && typeof step.input_from === 'object' && !Array.isArray(step.input_from)
            ? (cloneJsonLike(step.input_from) as Record<string, unknown>)
            : {};
        if (!Array.isArray(step.actions) || step.actions.length === 0) {
          throw new Error(`${options.protocolId}.apps.${appId}.steps[${index}].actions must be a non-empty array.`);
        }
        const actions = step.actions.map((actionRaw, actionIndex) => {
          const action = asRecord(
            actionRaw,
            `${options.protocolId}.apps.${appId}.steps[${index}].actions[${actionIndex}]`,
          );
          const kind = asString(
            action.kind,
            `${options.protocolId}.apps.${appId}.steps[${index}].actions[${actionIndex}].kind`,
          );
          if (kind !== 'run' && kind !== 'back' && kind !== 'reset') {
            throw new Error(
              `${options.protocolId}.apps.${appId}.steps[${index}].actions[${actionIndex}].kind must be run|back|reset.`,
            );
          }
          const variant = asString(
            action.variant,
            `${options.protocolId}.apps.${appId}.steps[${index}].actions[${actionIndex}].variant`,
          ).trim();
          if (variant !== 'primary' && variant !== 'secondary' && variant !== 'ghost') {
            throw new Error(
              `${options.protocolId}.apps.${appId}.steps[${index}].actions[${actionIndex}].variant must be primary|secondary|ghost.`,
            );
          }
          const mode =
            typeof action.mode === 'string' && action.mode.trim().length > 0
              ? action.mode.trim()
              : undefined;
          if (kind === 'run') {
            if (!mode) {
              throw new Error(
                `${options.protocolId}.apps.${appId}.steps[${index}].actions[${actionIndex}].mode is required for run actions.`,
              );
            }
            if (mode !== 'view' && mode !== 'simulate' && mode !== 'send') {
              throw new Error(
                `${options.protocolId}.apps.${appId}.steps[${index}].actions[${actionIndex}].mode must be view|simulate|send.`,
              );
            }
          } else if (mode) {
            throw new Error(
              `${options.protocolId}.apps.${appId}.steps[${index}].actions[${actionIndex}].mode is only allowed for run actions.`,
            );
          }
          return {
            actionId: asString(
              action.id,
              `${options.protocolId}.apps.${appId}.steps[${index}].actions[${actionIndex}].id`,
            ),
            kind,
            label: asString(
              action.label,
              `${options.protocolId}.apps.${appId}.steps[${index}].actions[${actionIndex}].label`,
            ),
            ...(mode ? { mode } : {}),
            variant,
          };
        });

        if (step.transitions !== undefined) {
          throw new Error(
            `${options.protocolId}.apps.${appId}.steps[${index}].transitions is not supported. Use next_on_success only.`,
          );
        }
        if (step.blocking !== undefined) {
          throw new Error(
            `${options.protocolId}.apps.${appId}.steps[${index}].blocking is not supported. Use requires_paths directly on the step.`,
          );
        }
        const requiresPathsRaw = Array.isArray(step.requires_paths) ? step.requires_paths : [];
        const requiresPaths = requiresPathsRaw.map((entry, pathIndex) =>
          asString(
            entry,
            `${options.protocolId}.apps.${appId}.steps[${index}].requires_paths[${pathIndex}]`,
          ),
        );

        const ui =
          step.ui && typeof step.ui === 'object' && !Array.isArray(step.ui)
            ? (() => {
                const uiRaw = asRecord(step.ui, `${options.protocolId}.apps.${appId}.steps[${index}].ui`);
                const kind = asString(uiRaw.kind, `${options.protocolId}.apps.${appId}.steps[${index}].ui.kind`);
                if (kind !== 'select_from_derived') {
                  throw new Error(`${options.protocolId}.apps.${appId}.steps[${index}].ui.kind unsupported: ${kind}`);
                }
                const source = asString(uiRaw.source, `${options.protocolId}.apps.${appId}.steps[${index}].ui.source`);
                const bindTo = asString(uiRaw.bind_to, `${options.protocolId}.apps.${appId}.steps[${index}].ui.bind_to`);
                const valuePath = asString(
                  uiRaw.value_path,
                  `${options.protocolId}.apps.${appId}.steps[${index}].ui.value_path`,
                );
                const requireSelection = Boolean(uiRaw.require_selection);
                const autoAdvance = Boolean(uiRaw.auto_advance);
                const labelFields = Array.isArray(uiRaw.label_fields)
                  ? uiRaw.label_fields
                      .map((entry, labelIndex) =>
                        asString(
                          entry,
                          `${options.protocolId}.apps.${appId}.steps[${index}].ui.label_fields[${labelIndex}]`,
                        ),
                      )
                  : [];
                return {
                  kind: 'select_from_derived' as const,
                  source,
                  bindTo,
                  valuePath,
                  requireSelection,
                  autoAdvance,
                  labelFields,
                  ...(typeof uiRaw.title === 'string' && uiRaw.title.length > 0 ? { title: uiRaw.title } : {}),
                  ...(typeof uiRaw.description === 'string' && uiRaw.description.length > 0
                    ? { description: uiRaw.description }
                    : {}),
                };
              })()
            : undefined;

        return {
          stepId,
          label: stepLabel,
          operationId,
          title: stepTitle,
          ...(typeof step.description === 'string' && step.description.length > 0 ? { description: step.description } : {}),
          ...(nextOnSuccess ? { nextOnSuccess } : {}),
          statusText,
          actions,
          inputFrom,
          requiresPaths,
          ...(ui ? { ui } : {}),
        } as MetaAppStepSummary;
      });

      const stepIdSet = new Set<string>();
      for (const step of steps) {
        if (stepIdSet.has(step.stepId)) {
          throw new Error(`${options.protocolId}.apps.${appId} has duplicate step id ${step.stepId}.`);
        }
        stepIdSet.add(step.stepId);
      }
      if (!stepIdSet.has(entryStepId)) {
        throw new Error(`${options.protocolId}.apps.${appId}.entry_step references unknown step id ${entryStepId}.`);
      }

      for (const step of steps) {
        if (step.nextOnSuccess && !stepIdSet.has(step.nextOnSuccess)) {
          throw new Error(
            `${options.protocolId}.apps.${appId}.steps.${step.stepId}.next_on_success references unknown step ${step.nextOnSuccess}.`,
          );
        }
      }

      return {
        appId,
        label: appLabel,
        title,
        ...(typeof app.description === 'string' && app.description.length > 0 ? { description: app.description } : {}),
        entryStepId,
        steps,
      } as MetaAppSummary;
    })
    .sort((a, b) => a.appId.localeCompare(b.appId));

  return {
    protocolId: options.protocolId,
    schema: meta.schema ?? null,
    version: meta.version,
    apps,
  };
}
