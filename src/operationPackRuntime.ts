import {
  getProtocolById,
  loadProtocolAgentRuntime,
  type ProtocolManifest,
} from './idlRegistry.js';

type JsonRecord = Record<string, unknown>;

type TemplateParamSpec =
  | string
  | {
      type?: string;
      required?: boolean;
      default?: unknown;
    };

type TemplateSpec = {
  params?: Record<string, TemplateParamSpec>;
  expand: JsonRecord;
};

type TemplateUseSpec = {
  template: string;
  with?: Record<string, unknown>;
};

type RuntimeInputSpec = {
  type: string;
  required?: boolean;
  default?: unknown;
  bind_from?: string;
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
  title?: string;
  empty_text?: string;
  emptyText?: string;
  max_items?: number;
  maxItems?: number;
  item_label_fields?: string[];
  itemLabelFields?: string[];
};

type AgentIndexReadSpec = {
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
  inputs?: Record<string, RuntimeInputSpec>;
  derive?: unknown[];
  compute?: unknown[];
  use?: TemplateUseSpec[];
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
  use?: TemplateUseSpec[];
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

export type RuntimePack = {
  schema: 'solana-agent-runtime.v1';
  version: string;
  protocol: {
    protocolId: string;
    label?: string;
    programId: string;
    codamaPath: string;
  };
  navigation?: Record<string, unknown>;
  sources?: Record<string, unknown>;
  reads?: {
    index?: Record<string, AgentIndexReadSpec>;
  };
  computes?: Record<string, AgentComputeSpec>;
  executions?: Record<string, AgentExecutionSpec>;
  templates?: Record<string, TemplateSpec>;
};

type OperationKind = 'index_read' | 'compute' | 'execution';

type RawOperationSpec = AgentIndexReadSpec | AgentComputeSpec | AgentExecutionSpec;

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
  bind_from?: string;
  read_stage?: 'derive' | 'compute' | 'input' | 'unknown';
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
    title?: string;
    emptyText?: string;
    maxItems?: number;
    itemLabelFields?: string[];
  };
};

export type RuntimeOperationExplain = {
  protocolId: string;
  operationId: string;
  operationKind: OperationKind;
  schema: string | null;
  version: string;
  instruction: string;
  templateUse: unknown[];
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
    title?: string;
    emptyText?: string;
    maxItems?: number;
    itemLabelFields?: string[];
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

function resolveTemplateExpansionValue(value: unknown, paramScope: JsonRecord): unknown {
  if (typeof value === 'string' && value.startsWith('$param.')) {
    return resolvePath(paramScope, value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplateExpansionValue(item, paramScope));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as JsonRecord).map(([key, nested]) => [
        key,
        resolveTemplateExpansionValue(nested, paramScope),
      ]),
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
    throw new Error(`Cannot resolve path ${path}.`);
  }
  return resolved;
}

function resolveTemplateParams(
  templateName: string,
  template: TemplateSpec,
  use: TemplateUseSpec,
): JsonRecord {
  const provided = use.with ?? {};
  const resolved: JsonRecord = {};

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
    return resolved;
  }

  return { ...provided };
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
  const indexRead = pack.reads?.index?.[operationId];
  if (indexRead) {
    return { kind: 'index_read', spec: indexRead };
  }
  const compute = pack.computes?.[operationId];
  if (compute) {
    return { kind: 'compute', spec: compute };
  }
  const execution = pack.executions?.[operationId];
  if (execution) {
    return { kind: 'execution', spec: execution };
  }
  return null;
}

export function materializeRuntimeOperation(
  operationId: string,
  operation: RawOperationSpec,
  pack: RuntimePack,
  kind: OperationKind,
): MaterializedRuntimeOperation {
  if (kind === 'index_read') {
    const readSpec = cloneJsonLike((operation as AgentIndexReadSpec).read);
    return {
      kind,
      instruction: '',
      inputs: cloneJsonLike((operation as AgentIndexReadSpec).inputs ?? {}),
      derive: [],
      compute: [],
      args: {},
      accounts: {},
      remainingAccounts: [],
      readSpec,
      readOutput: cloneJsonLike((operation as AgentIndexReadSpec).read_output),
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

  for (const use of (operation as AgentComputeSpec | AgentExecutionSpec).use ?? []) {
    const templateName = use.template;
    if (!templateName) {
      throw new Error(`Operation ${operationId} contains use item without template name.`);
    }
    const template = pack.templates?.[templateName];
    if (!template) {
      throw new Error(`Operation ${operationId} references unknown template ${templateName}.`);
    }
    const params = resolveTemplateParams(templateName, template, use);
    const expanded = resolveTemplateExpansionValue(cloneJsonLike(template.expand), {
      param: params,
    }) as Partial<AgentComputeSpec & AgentExecutionSpec>;
    mergeMaterializedFragment(materialized, expanded);
  }

  mergeMaterializedFragment(materialized, cloneJsonLike(operation as Partial<AgentComputeSpec & AgentExecutionSpec>));

  for (const [inputName, inputSpec] of Object.entries(materialized.inputs)) {
    if (typeof inputSpec.bind_from === 'string' && inputSpec.bind_from.trim().length > 0) {
      inputSpec.bind_from = inputSpec.bind_from.trim();
    } else {
      delete inputSpec.bind_from;
    }
    if (inputSpec.bind_from === `$input.${inputName}`) {
      delete inputSpec.bind_from;
    }
  }

  return materialized;
}

function normalizeReadOutputSpec(
  spec: ReadOutputSpec | undefined,
  context: string,
):
  | {
      type: 'array' | 'object' | 'scalar' | 'list';
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
  return {
    type: spec.type,
    source: spec.source,
    ...(typeof spec.title === 'string' && spec.title.length > 0 ? { title: spec.title } : {}),
    ...(typeof (spec.empty_text ?? spec.emptyText) === 'string' && String(spec.empty_text ?? spec.emptyText).length > 0
      ? { emptyText: String(spec.empty_text ?? spec.emptyText) }
      : {}),
    ...(typeof (spec.max_items ?? spec.maxItems) === 'number' && Number.isInteger(spec.max_items ?? spec.maxItems) && Number(spec.max_items ?? spec.maxItems) > 0
      ? { maxItems: Number(spec.max_items ?? spec.maxItems) }
      : {}),
    ...(Array.isArray(spec.item_label_fields ?? spec.itemLabelFields)
      ? {
          itemLabelFields: (spec.item_label_fields ?? spec.itemLabelFields)?.filter(
            (entry): entry is string => typeof entry === 'string' && entry.length > 0,
          ),
        }
      : {}),
  };
}

function isNamedStep(value: unknown, name: string): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && (value as JsonRecord).name === name);
}

function resolveReadStage(
  path: string,
  operation: MaterializedRuntimeOperation,
): 'derive' | 'compute' | 'input' | 'unknown' {
  const cleaned = path.startsWith('$') ? path.slice(1) : path;
  const parts = cleaned.split('.').filter(Boolean);
  const [root] = parts;
  if (!root) {
    return 'unknown';
  }
  const candidate = root === 'derived' && parts.length > 1 ? parts[1] : root;
  if (root === 'input' || root === 'args') {
    return 'input';
  }
  if (operation.derive.some((step) => isNamedStep(step, candidate))) {
    return 'derive';
  }
  if (operation.compute.some((step) => isNamedStep(step, candidate))) {
    return 'compute';
  }
  return 'unknown';
}

function normalizeCrossValidation(
  validate: { cross?: Array<{ kind?: string; left?: string; right?: string; message?: string }> } | undefined,
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

export async function listRuntimeOperations(options: {
  protocolId: string;
}): Promise<{
  protocolId: string;
  schema: string | null;
  version: string;
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
          ...(typeof inputSpec.bind_from === 'string' ? { bind_from: inputSpec.bind_from, read_stage: resolveReadStage(inputSpec.bind_from, materialized) } : {}),
          ...(inputSpec.validate ? { validate: cloneJsonLike(inputSpec.validate) } : {}),
        },
      ]),
    );
    operations.push({
      operationId,
      operationKind: kind,
      instruction: materialized.instruction,
      executionKind: kind === 'execution' ? 'write' : kind === 'compute' ? 'compute' : 'read',
      inputs,
      ...(normalizeCrossValidation((spec as AgentIndexReadSpec | AgentComputeSpec | AgentExecutionSpec).validate) ? {
        crossValidation: normalizeCrossValidation((spec as AgentIndexReadSpec | AgentComputeSpec | AgentExecutionSpec).validate),
      } : {}),
      ...(normalizeReadOutputSpec(materialized.readOutput, `${options.protocolId}/${operationId}`) ? {
        readOutput: normalizeReadOutputSpec(materialized.readOutput, `${options.protocolId}/${operationId}`),
      } : {}),
    });
  };

  for (const [operationId, spec] of Object.entries(pack.reads?.index ?? {})) {
    pushSummary(operationId, 'index_read', spec, materializeRuntimeOperation(operationId, spec, pack, 'index_read'));
  }
  for (const [operationId, spec] of Object.entries(pack.computes ?? {})) {
    pushSummary(operationId, 'compute', spec, materializeRuntimeOperation(operationId, spec, pack, 'compute'));
  }
  for (const [operationId, spec] of Object.entries(pack.executions ?? {})) {
    pushSummary(operationId, 'execution', spec, materializeRuntimeOperation(operationId, spec, pack, 'execution'));
  }

  operations.sort((a, b) => a.operationId.localeCompare(b.operationId));
  return {
    protocolId: options.protocolId,
    schema: pack.schema,
    version: pack.version,
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
    schema: pack.schema,
    version: pack.version,
    instruction: materialized.instruction,
    templateUse: cloneJsonLike((resolved.spec as AgentComputeSpec | AgentExecutionSpec).use ?? []),
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
