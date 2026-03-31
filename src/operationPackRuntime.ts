import {
  getProtocolById,
  loadProtocolAgentRuntime,
  type ProtocolManifest,
} from './idlRegistry.js';
import { PublicKey } from '@solana/web3.js';

type JsonRecord = Record<string, unknown>;

type RuntimeInputSpec = {
  type: string;
  required?: boolean;
  default?: unknown;
  validate?: {
    required?: boolean;
    min?: string | number;
    max?: string | number;
    pattern?: string;
    message?: string;
  };
  example?: unknown;
  ui_example?: unknown;
};

type ReadOutputSpec = {
  type: 'array' | 'object' | 'scalar' | 'list';
  source: string;
  object_schema?: OutputObjectSchemaSpec;
  item_schema?: OutputObjectSchemaSpec;
  scalar_type?: string;
};

type OutputFieldSpec = {
  type: string;
  required?: boolean;
  description?: string;
};

type OutputObjectSchemaSpec = {
  entity_type?: string;
  identity_fields?: string[];
  fields: Record<string, OutputFieldSpec>;
};

type AgentIndexViewSpec = {
  inputs?: Record<string, RuntimeInputSpec>;
  validate?: {
    cross?: Array<{
      kind?: string;
      left?: string;
      right?: string;
      message?: string;
    }>;
  };
  read_output?: ReadOutputSpec;
  read: Record<string, unknown>;
};

type AgentComputeSpec = {
  instruction?: string;
  inputs?: Record<string, RuntimeInputSpec>;
  derive?: unknown[];
  compute?: unknown[];
  read_output?: ReadOutputSpec;
  validate?: {
    cross?: Array<{
      kind?: string;
      left?: string;
      right?: string;
      message?: string;
    }>;
  };
};

type AgentExecutionSpec = {
  instruction?: string;
  inputs?: Record<string, RuntimeInputSpec>;
  derive?: unknown[];
  compute?: unknown[];
  args?: Record<string, unknown>;
  accounts?: Record<string, unknown>;
  remaining_accounts?: unknown;
  pre?: unknown[];
  post?: unknown[];
  read_output?: ReadOutputSpec;
  validate?: {
    cross?: Array<{
      kind?: string;
      left?: string;
      right?: string;
      message?: string;
    }>;
  };
};

type RuntimeValidationSpec = {
  cross?: Array<{
    kind?: string;
    left?: string;
    right?: string;
    message?: string;
  }>;
};

export type RuntimePack = {
  schema: 'solana-agent-runtime.v1';
  protocol: {
    protocolId: string;
    programId: string;
    codamaPath: string;
  };
  index_views?: Record<string, AgentIndexViewSpec>;
  computes?: Record<string, AgentComputeSpec>;
  contract_writes?: Record<string, AgentExecutionSpec>;
};

type OperationKind = 'index_view' | 'compute' | 'contract_write';

type RawOperationSpec = AgentIndexViewSpec | AgentComputeSpec | AgentExecutionSpec;

export type ResolvedRuntimeOperation = {
  pack: RuntimePack;
  kind: OperationKind;
  spec: RawOperationSpec;
  materialized: MaterializedRuntimeOperation;
};

export type MaterializedRuntimeOperation = {
  kind: OperationKind;
  instruction: string;
  inputs: Record<string, RuntimeInputSpec>;
  derive: unknown[];
  compute: unknown[];
  args: Record<string, unknown>;
  accounts: Record<string, unknown>;
  remainingAccounts: unknown;
  readSpec?: Record<string, unknown>;
  readOutput?: ReadOutputSpec;
  pre?: unknown[];
  post?: unknown[];
};

export type RuntimeOperationInputSummary = {
  type: string;
  required: boolean;
  default?: unknown;
  validate?: {
    required?: boolean;
    min?: string | number;
    max?: string | number;
    pattern?: string;
    message?: string;
  };
};

export type RuntimeOperationSummary = {
  operationId: string;
  operationKind: OperationKind;
  readKind?: string;
  purpose?: string;
  instruction: string;
  executionKind: 'read' | 'compute' | 'write';
  inputs: Record<string, RuntimeOperationInputSummary>;
  crossValidation?: Array<{
    kind: 'not_equal';
    left: string;
    right: string;
    message?: string;
  }>;
  readOutput?: {
    type: 'array' | 'object' | 'scalar' | 'list';
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
  instruction: string;
  inputs: Record<string, RuntimeInputSpec>;
  derive: unknown[];
  compute: unknown[];
  args: Record<string, unknown>;
  accounts: Record<string, unknown>;
  remainingAccounts: unknown;
  readSpec?: Record<string, unknown>;
  readOutput?: {
    type: 'array' | 'object' | 'scalar' | 'list';
    source: string;
    objectSchema?: OutputObjectSchemaSpec;
    itemSchema?: OutputObjectSchemaSpec;
    scalarType?: string;
  };
  pre: unknown[];
  post: unknown[];
};

const runtimePackCache = new Map<string, RuntimePack>();

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

function mergeMaterializedFragment(
  target: MaterializedRuntimeOperation,
  fragment: Partial<AgentComputeSpec & AgentExecutionSpec>,
): void {
  if (fragment.instruction) {
    target.instruction = fragment.instruction;
  }
  if (fragment.inputs) {
    target.inputs = { ...target.inputs, ...cloneJsonLike(fragment.inputs) };
  }
  if (fragment.derive) {
    target.derive.push(...cloneJsonLike(fragment.derive));
  }
  if (fragment.compute) {
    target.compute.push(...cloneJsonLike(fragment.compute));
  }
  if (fragment.args) {
    target.args = { ...target.args, ...cloneJsonLike(fragment.args) };
  }
  if (fragment.accounts) {
    target.accounts = { ...target.accounts, ...cloneJsonLike(fragment.accounts) };
  }
  if (fragment.remaining_accounts !== undefined) {
    const cloned = cloneJsonLike(fragment.remaining_accounts);
    if (Array.isArray(cloned) && Array.isArray(target.remainingAccounts)) {
      target.remainingAccounts.push(...cloned);
    } else {
      target.remainingAccounts = cloned;
    }
  }
  if (fragment.read_output) {
    target.readOutput = cloneJsonLike(fragment.read_output);
  }
  if (fragment.pre && fragment.pre.length > 0) {
    target.pre = [...(target.pre ?? []), ...cloneJsonLike(fragment.pre)];
  }
  if (fragment.post && fragment.post.length > 0) {
    target.post = [...(target.post ?? []), ...cloneJsonLike(fragment.post)];
  }
}

export async function loadRuntimePack(protocolId: string): Promise<RuntimePack> {
  const cached = runtimePackCache.get(protocolId);
  if (cached) {
    return cached;
  }
  const runtime = await loadProtocolAgentRuntime(protocolId);
  if (!runtime) {
    throw new Error(`Protocol ${protocolId} has no agentRuntimePath.`);
  }
  const parsed = runtime as unknown as RuntimePack;
  runtimePackCache.set(protocolId, parsed);
  return parsed;
}

function getRawOperationSpec(
  pack: RuntimePack,
  operationId: string,
): { kind: OperationKind; spec: RawOperationSpec } | null {
  const indexView = pack.index_views?.[operationId];
  if (indexView) {
    return { kind: 'index_view', spec: indexView };
  }
  const compute = pack.computes?.[operationId];
  if (compute) {
    return { kind: 'compute', spec: compute };
  }
  const execution = pack.contract_writes?.[operationId];
  if (execution) {
    return { kind: 'contract_write', spec: execution };
  }
  return null;
}

export function materializeRuntimeOperation(
  operationId: string,
  operation: RawOperationSpec,
  pack: RuntimePack,
  kind: OperationKind,
): MaterializedRuntimeOperation {
  if (kind === 'index_view') {
    const readSpec = cloneJsonLike((operation as AgentIndexViewSpec).read);
    return {
      kind,
      instruction: '',
      inputs: cloneJsonLike((operation as AgentIndexViewSpec).inputs ?? {}),
      derive: [],
      compute: [],
      args: {},
      accounts: {},
      remainingAccounts: [],
      readSpec,
      readOutput: cloneJsonLike((operation as AgentIndexViewSpec).read_output),
      pre: [],
      post: [],
    };
  }

  const materialized: MaterializedRuntimeOperation = {
    kind,
    instruction: '',
    inputs: {},
    derive: [],
    compute: [],
    args: {},
    accounts: {},
    remainingAccounts: [],
    pre: [],
    post: [],
  };

  mergeMaterializedFragment(materialized, cloneJsonLike(operation as Partial<AgentComputeSpec & AgentExecutionSpec>));

  return materialized;
}

function normalizeReadOutputSpec(
  spec: ReadOutputSpec | undefined,
  context: string,
):
  | {
      type: 'array' | 'object' | 'scalar' | 'list';
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
    throw new Error(`${context}: read_output.source is required.`);
  }
  return {
    type: spec.type,
    source: spec.source,
    ...(spec.object_schema ? { objectSchema: cloneJsonLike(spec.object_schema) } : {}),
    ...(spec.item_schema ? { itemSchema: cloneJsonLike(spec.item_schema) } : {}),
    ...(typeof spec.scalar_type === 'string' && spec.scalar_type.length > 0 ? { scalarType: spec.scalar_type } : {}),
  };
}

function normalizeCrossValidation(
  validate: RuntimeValidationSpec | undefined,
): RuntimeOperationSummary['crossValidation'] {
  const rules = Array.isArray(validate?.cross) ? validate.cross : [];
  const normalized = rules
    .map((rule) => {
      if (!rule || rule.kind !== 'not_equal' || typeof rule.left !== 'string' || typeof rule.right !== 'string') {
        return null;
      }
      return {
        kind: 'not_equal' as const,
        left: rule.left.trim(),
        right: rule.right.trim(),
        ...(typeof rule.message === 'string' && rule.message.trim().length > 0 ? { message: rule.message.trim() } : {}),
      };
    })
    .filter((rule): rule is { kind: 'not_equal'; left: string; right: string; message?: string } => Boolean(rule && rule.left && rule.right));
  return normalized.length > 0 ? normalized : undefined;
}

function isIntegerType(type: string): boolean {
  return type === 'u16' || type === 'u32' || type === 'u64' || type === 'i32';
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
      if (inputSpec.validate?.pattern) {
        const pattern = new RegExp(inputSpec.validate.pattern);
        if (!pattern.test(rawValue)) {
          throw new Error(inputSpec.validate.message ?? `${label} must match ${inputSpec.validate.pattern}.`);
        }
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
      if (inputSpec.validate?.min !== undefined) {
        const min = parseBigIntLike(inputSpec.validate.min, `${label}.min`, signed);
        if (parsed < min) {
          throw new Error(inputSpec.validate.message ?? `${label} must be >= ${min.toString()}.`);
        }
      }
      if (inputSpec.validate?.max !== undefined) {
        const max = parseBigIntLike(inputSpec.validate.max, `${label}.max`, signed);
        if (parsed > max) {
          throw new Error(inputSpec.validate.message ?? `${label} must be <= ${max.toString()}.`);
        }
      }
      return parsed.toString();
    }
    default:
      return rawValue;
  }
}

function validateCrossRules(
  input: Record<string, unknown>,
  validate: RuntimeValidationSpec | undefined,
  context: string,
): void {
  const rules = normalizeCrossValidation(validate);
  if (!rules) {
    return;
  }
  for (const rule of rules) {
    const left = readPathFromValue({ input }, rule.left);
    const right = readPathFromValue({ input }, rule.right);
    if (rule.kind === 'not_equal' && JSON.stringify(left) === JSON.stringify(right)) {
      throw new Error(rule.message ?? `${context}: ${rule.left} must not equal ${rule.right}.`);
    }
  }
}

export function hydrateAndValidateRuntimeInputs(options: {
  input: Record<string, unknown>;
  materialized: MaterializedRuntimeOperation;
  validate?: RuntimeValidationSpec;
  context: string;
}): Record<string, unknown> {
  const hydratedInput: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(options.materialized.inputs)) {
    const rawValue = options.input[key] !== undefined ? options.input[key] : spec.default;
    if (rawValue === undefined) {
      if (spec.required !== false) {
        throw new Error(`Missing required runtime input: ${key}`);
      }
      continue;
    }
    hydratedInput[key] = validateRuntimeInputValue(key, spec, rawValue, options.context);
  }
  validateCrossRules(hydratedInput, options.validate, options.context);
  return hydratedInput;
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
  const pushSummary = (operationId: string, kind: OperationKind, spec: RawOperationSpec, materialized: MaterializedRuntimeOperation) => {
    const inputs = Object.fromEntries(
      Object.entries(materialized.inputs).map(([inputName, inputSpec]) => [
        inputName,
        {
          type: inputSpec.type,
          required: inputSpec.required !== false,
          ...(inputSpec.default !== undefined ? { default: cloneJsonLike(inputSpec.default) } : {}),
          ...(inputSpec.validate ? { validate: cloneJsonLike(inputSpec.validate) } : {}),
        },
      ]),
    );
    operations.push({
      operationId,
      operationKind: kind,
      ...(typeof materialized.readSpec?.kind === 'string' ? { readKind: materialized.readSpec.kind } : {}),
      ...(typeof materialized.readSpec?.description === 'string'
        ? { purpose: materialized.readSpec.description }
        : typeof materialized.readSpec?.title === 'string'
          ? { purpose: materialized.readSpec.title }
          : {}),
      instruction: materialized.instruction,
      executionKind: kind === 'contract_write' ? 'write' : kind === 'compute' ? 'compute' : 'read',
      inputs,
      ...(normalizeCrossValidation((spec as AgentIndexViewSpec | AgentComputeSpec | AgentExecutionSpec).validate) ? {
        crossValidation: normalizeCrossValidation((spec as AgentIndexViewSpec | AgentComputeSpec | AgentExecutionSpec).validate),
      } : {}),
      ...(normalizeReadOutputSpec(materialized.readOutput, `${options.protocolId}/${operationId}`) ? {
        readOutput: normalizeReadOutputSpec(materialized.readOutput, `${options.protocolId}/${operationId}`),
      } : {}),
    });
  };

  for (const [operationId, spec] of Object.entries(pack.index_views ?? {})) {
    pushSummary(operationId, 'index_view', spec, materializeRuntimeOperation(operationId, spec, pack, 'index_view'));
  }
  for (const [operationId, spec] of Object.entries(pack.computes ?? {})) {
    pushSummary(operationId, 'compute', spec, materializeRuntimeOperation(operationId, spec, pack, 'compute'));
  }
  for (const [operationId, spec] of Object.entries(pack.contract_writes ?? {})) {
    pushSummary(operationId, 'contract_write', spec, materializeRuntimeOperation(operationId, spec, pack, 'contract_write'));
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
    instruction: materialized.instruction,
    inputs: cloneJsonLike(materialized.inputs),
    derive: cloneJsonLike(materialized.derive),
    compute: cloneJsonLike(materialized.compute),
    args: cloneJsonLike(materialized.args),
    accounts: cloneJsonLike(materialized.accounts),
    remainingAccounts: cloneJsonLike(materialized.remainingAccounts),
    ...(materialized.readSpec ? { readSpec: cloneJsonLike(materialized.readSpec) } : {}),
    ...(normalizeReadOutputSpec(materialized.readOutput, `${options.protocolId}/${options.operationId}`) ? {
      readOutput: normalizeReadOutputSpec(materialized.readOutput, `${options.protocolId}/${options.operationId}`),
    } : {}),
    pre: cloneJsonLike(materialized.pre ?? []),
    post: cloneJsonLike(materialized.post ?? []),
  };
}

export async function resolveProtocolForPacks(protocolId: string): Promise<ProtocolManifest> {
  return getProtocolById(protocolId);
}
