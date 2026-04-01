import {
  getProtocolById,
  loadProtocolIndexingSpec,
  loadProtocolAgentRuntime,
  type ProtocolManifest,
} from './idlRegistry.js';
import {
  findCodamaInstructionByName,
  loadProtocolCodamaFromRuntime,
  type CodamaInstructionAccountDef,
  type CodamaInstructionArgDef,
  type CodamaTypeRef,
} from './codamaIdl.js';
import { PublicKey } from '@solana/web3.js';

type JsonRecord = Record<string, unknown>;

type RuntimeInputSpec = {
  type: string;
  example?: unknown;
  ui_example?: unknown;
};

type RuntimeInputDecl = string | RuntimeInputSpec;

type ReadOutputSpec = {
  type: 'array' | 'object' | 'scalar' | 'list';
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

type IndexViewSpec = {
  inputs?: Record<string, RuntimeInputSpec>;
  read_output?: ReadOutputSpec;
};

type ArgBindingValue = string | number | boolean | null;

type RemainingAccountMeta = {
  pubkey: string;
  isSigner?: boolean;
  isWritable?: boolean;
};

type AgentReadSpec = {
  inputs?: Record<string, RuntimeInputDecl>;
  load?: unknown[];
  transform?: string[];
  output?: ReadOutputSpec;
};

type AgentWriteSpec = {
  instruction?: string;
  inputs?: Record<string, RuntimeInputSpec>;
  load?: unknown[];
  transform?: string[];
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
  reads?: Record<string, AgentReadSpec>;
  writes?: Record<string, AgentWriteSpec>;
  transforms?: Record<string, unknown[]>;
};

type OperationKind = 'read' | 'write';

type RawOperationSpec = AgentReadSpec | AgentWriteSpec;

export type ResolvedIndexViewContract = {
  protocolId: string;
  operationId: string;
  inputs: Record<string, RuntimeInputSpec>;
  readOutput?: ReadOutputSpec;
};

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
  load: unknown[];
  transform: unknown[];
  args: Record<string, unknown>;
  accounts: Record<string, unknown>;
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
  executionKind: 'read' | 'write';
  inputs: Record<string, RuntimeOperationInputSummary>;
  output?: {
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
  instruction?: string;
  inputs: Record<string, RuntimeInputSpec>;
  load: unknown[];
  transform: unknown[];
  args: Record<string, unknown>;
  accounts: Record<string, unknown>;
  remainingAccounts: unknown;
  output?: {
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

function mergeMaterializedFragment(
  target: MaterializedRuntimeOperation,
  fragment: Partial<AgentReadSpec & AgentWriteSpec>,
): void {
  if ('instruction' in fragment && fragment.instruction) {
    target.instruction = fragment.instruction;
  }
  if (fragment.inputs) {
    target.inputs = { ...target.inputs, ...normalizeInputDeclMap(fragment.inputs) };
  }
  if (fragment.load) {
    target.load.push(...cloneJsonLike(fragment.load));
  }
  if (fragment.transform) {
    target.transform.push(...cloneJsonLike(fragment.transform));
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
  if ('output' in fragment && fragment.output) {
    target.output = cloneJsonLike(fragment.output);
  }
  if (fragment.pre && fragment.pre.length > 0) {
    target.pre = [...(target.pre ?? []), ...cloneJsonLike(fragment.pre)];
  }
  if (fragment.post && fragment.post.length > 0) {
    target.post = [...(target.post ?? []), ...cloneJsonLike(fragment.post)];
  }
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

function expandReferencedTransformSteps(
  transformRefs: string[] | undefined,
  catalog: Record<string, unknown[]>,
): unknown[] {
  const expanded: unknown[] = [];
  for (const ref of transformRefs ?? []) {
    const fragment = catalog[ref];
    if (!Array.isArray(fragment)) {
      throw new Error(`Unknown transform fragment ${ref}.`);
    }
    expanded.push(...cloneJsonLike(fragment));
  }
  return expanded;
}

function collectWriteInputReferences(spec: AgentWriteSpec, catalog: Record<string, unknown[]>): Set<string> {
  const refs = new Set<string>();
  collectInputReferences(spec.load, refs);
  collectInputReferences(expandReferencedTransformSteps(spec.transform, catalog), refs);
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
    if (account.signer) {
      throw new Error(
        `Write ${options.protocolId}/${options.operationId} references signer input ${options.inputName}; wallet signer must not be user-provided.`,
      );
    }
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
  const codama = await loadProtocolCodamaFromRuntime(options.protocolId);
  const nextWrites: Record<string, AgentWriteSpec> = {};

  for (const [operationId, writeSpec] of Object.entries(options.writes)) {
    if (writeSpec.inputs !== undefined) {
      throw new Error(
        `Write ${options.protocolId}/${operationId} must not declare inputs explicitly; write inputs are sourced from Codama.`,
      );
    }
    if (!writeSpec.instruction) {
      nextWrites[operationId] = cloneJsonLike(writeSpec);
      continue;
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

function expandTransformPipeline(options: {
  protocolId: string;
  operationId: string;
  catalog: Record<string, unknown[]>;
  pipeline: string[];
}): unknown[] {
  const expanded: unknown[] = [];
  for (const [index, entry] of options.pipeline.entries()) {
    const fragment = options.catalog[entry];
    if (!Array.isArray(fragment)) {
      throw new Error(`Unknown transform fragment ${entry} in ${options.protocolId}/${options.operationId} at transform[${index}].`);
    }
    expanded.push(...cloneJsonLike(fragment));
  }
  return expanded;
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
  const parsed = runtime as unknown as Omit<RuntimePack, 'protocolId' | 'programId' | 'codamaPath'>;
  const transforms = cloneJsonLike(parsed.transforms ?? {});
  const writes = await hydrateWriteSpecsFromCodama({
    protocolId,
    writes: cloneJsonLike(parsed.writes ?? {}),
    transforms,
  });
  const pack: RuntimePack = {
    schema: 'solana-agent-runtime.v1',
    protocolId,
    programId: manifest.programId,
    codamaPath: manifest.codamaIdlPath,
    reads: cloneJsonLike(parsed.reads ?? {}),
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
  const read = pack.reads?.[operationId];
  if (read) {
    return { kind: 'read', spec: read };
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
    instruction: '',
    inputs: {},
    load: [],
    transform: [],
    args: {},
    accounts: {},
    remainingAccounts: [],
    pre: [],
    post: [],
  };

  mergeMaterializedFragment(materialized, cloneJsonLike(operation as Partial<AgentReadSpec & AgentWriteSpec>));
  const transformRefs = cloneJsonLike(materialized.transform) as string[];
  materialized.transform = expandTransformPipeline({
    protocolId: pack.protocolId,
    operationId,
    catalog: cloneJsonLike(pack.transforms ?? {}),
    pipeline: transformRefs,
  });

  return materialized;
}

export async function resolveIndexViewContract(options: {
  protocolId: string;
  operationId: string;
}): Promise<ResolvedIndexViewContract> {
  const indexing = await loadProtocolIndexingSpec(options.protocolId);
  const operation = indexing?.operations?.[options.operationId] as { index_view?: IndexViewSpec } | undefined;
  const indexView = operation?.index_view;
  if (!indexView) {
    throw new Error(`Index view ${options.protocolId}/${options.operationId} not found in indexing spec.`);
  }
  return {
    protocolId: options.protocolId,
    operationId: options.operationId,
    inputs: cloneJsonLike(indexView.inputs ?? {}),
    ...(indexView.read_output ? { readOutput: cloneJsonLike(indexView.read_output) } : {}),
  };
}

function normalizeOutputSpec(
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
  const pushSummary = (operationId: string, kind: OperationKind, spec: RawOperationSpec, materialized: MaterializedRuntimeOperation) => {
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
      ...(materialized.instruction ? { instruction: materialized.instruction } : {}),
      executionKind: kind,
      inputs,
      ...(normalizeOutputSpec(materialized.output, `${options.protocolId}/${operationId}`) ? {
        output: normalizeOutputSpec(materialized.output, `${options.protocolId}/${operationId}`),
      } : {}),
    });
  };

  for (const [operationId, spec] of Object.entries(pack.reads ?? {})) {
    pushSummary(operationId, 'read', spec, materializeRuntimeOperation(operationId, spec, pack, 'read'));
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
    ...(materialized.instruction ? { instruction: materialized.instruction } : {}),
    inputs: cloneJsonLike(materialized.inputs),
    load: cloneJsonLike(materialized.load),
    transform: cloneJsonLike(materialized.transform),
    args: cloneJsonLike(materialized.args),
    accounts: cloneJsonLike(materialized.accounts),
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
