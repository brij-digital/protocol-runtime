import {
  getProtocolById,
  loadProtocolRuntimeSpec,
  type ProtocolManifest,
} from './idlRegistry.js';
import { resolveAppUrl } from './appUrl.js';

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
  read_from?: string;
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

type RuntimeOperationSpec = {
  instruction?: string;
  inputs?: Record<string, RuntimeInputSpec>;
  discover?: unknown[];
  derive?: unknown[];
  compute?: unknown[];
  args?: Record<string, unknown>;
  accounts?: Record<string, unknown>;
  remaining_accounts?: unknown;
  view?: Record<string, unknown>;
  read_output?: {
    type: 'array' | 'object' | 'scalar';
    source: string;
    title?: string;
    empty_text?: string;
    max_items?: number;
    item_label_fields?: string[];
  };
  pre?: unknown[];
  post?: unknown[];
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

export type RuntimePack = {
  schema: 'declarative-decoder-runtime.v1';
  version: string;
  protocolId: string;
  label?: string;
  sources?: Record<string, unknown>;
  templates?: Record<string, TemplateSpec>;
  operations?: Record<string, RuntimeOperationSpec>;
};


export type MaterializedRuntimeOperation = {
  instruction: string;
  inputs: Record<string, RuntimeInputSpec>;
  discover: unknown[];
  derive: unknown[];
  compute: unknown[];
  args: Record<string, unknown>;
  accounts: Record<string, unknown>;
  remainingAccounts: unknown;
  view?: Record<string, unknown>;
  readOutput?: RuntimeOperationSpec['read_output'];
  pre?: unknown[];
  post?: unknown[];
};

export type RuntimeOperationInputSummary = {
  type: string;
  required: boolean;
  default?: unknown;
  bind_from?: string;
  read_stage?: 'discover' | 'derive' | 'compute' | 'input' | 'unknown';
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
  instruction: string;
  executionKind: 'read' | 'write';
  inputs: Record<string, RuntimeOperationInputSummary>;
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

export type RuntimeOperationExplain = {
  protocolId: string;
  operationId: string;
  schema: string | null;
  version: string;
  instruction: string;
  templateUse: unknown[];
  inputs: Record<string, RuntimeInputSpec>;
  discover: unknown[];
  derive: unknown[];
  compute: unknown[];
  args: Record<string, unknown>;
  accounts: Record<string, unknown>;
  remainingAccounts: unknown;
  view?: Record<string, unknown>;
  readOutput?: {
    type: 'array' | 'object' | 'scalar';
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

function asRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonRecord;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function cloneJsonLike<T>(value: T): T {
  if (value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

async function loadJsonByPath<T>(filePath: string): Promise<T> {
  const response = await fetch(resolveAppUrl(filePath));
  if (!response.ok) {
    throw new Error(`Failed to load JSON from ${filePath}.`);
  }
  return (await response.json()) as T;
}

export async function loadRuntimePack(protocolId: string): Promise<RuntimePack> {
  const cached = runtimePackCache.get(protocolId);
  if (cached) {
    return cached;
  }

  const runtimeSpec = await loadProtocolRuntimeSpec(protocolId);
  if (!runtimeSpec) {
    throw new Error(`Protocol ${protocolId} has no runtimeSpecPath.`);
  }

  const parsed = (runtimeSpec as unknown as RuntimePack);
  runtimePackCache.set(protocolId, parsed);
  return parsed;
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

function mergeOperationFragment(
  target: MaterializedRuntimeOperation,
  fragment: Omit<RuntimeOperationSpec, 'use'>,
  label: string,
): void {
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
  if (fragment.discover) {
    target.discover.push(...cloneJsonLike(fragment.discover));
  }
  if (fragment.derive) {
    target.derive.push(...cloneJsonLike(fragment.derive));
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

export function materializeRuntimeOperation(
  operationId: string,
  operation: RuntimeOperationSpec,
  pack: RuntimePack,
): MaterializedRuntimeOperation {
  const materialized: MaterializedRuntimeOperation = {
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
    const template = pack.templates?.[templateName];
    if (!template) {
      throw new Error(`Operation ${operationId} references unknown template ${templateName}.`);
    }
    const params = resolveTemplateParams(templateName, template, use);
    const expanded = resolveTemplateExpansionValue(cloneJsonLike(template.expand), {
      param: params,
    }) as Omit<RuntimeOperationSpec, 'use'>;
    mergeOperationFragment(materialized, expanded, `template ${templateName}`);
  }

  mergeOperationFragment(
    materialized,
    cloneJsonLike({
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
    }),
    `operation ${operationId}`,
  );

  for (const [inputName, inputSpec] of Object.entries(materialized.inputs)) {
    const bindFrom =
      typeof inputSpec.bind_from === 'string' && inputSpec.bind_from.trim().length > 0
        ? inputSpec.bind_from.trim()
        : typeof inputSpec.read_from === 'string' && inputSpec.read_from.trim().length > 0
          ? inputSpec.read_from.trim()
          : undefined;
    if (bindFrom) {
      inputSpec.bind_from = bindFrom;
    }
    delete inputSpec.read_from;
    if (inputSpec.bind_from !== undefined && inputSpec.bind_from.length === 0) {
      throw new Error(`Operation ${operationId} input ${inputName}: bind_from must be a non-empty string.`);
    }
  }

  return materialized;
}

function normalizeReadOutputSpec(
  spec: RuntimeOperationSpec['read_output'] | undefined,
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
  if (Array.isArray(spec.item_label_fields) && spec.item_label_fields.length > 0) {
    normalized.itemLabelFields = spec.item_label_fields.filter(
      (entry): entry is string => typeof entry === 'string' && entry.length > 0,
    );
  }
  return normalized;
}

function resolveDiscoverStage(
  path: string,
  operation: MaterializedRuntimeOperation,
): 'discover' | 'derive' | 'compute' | 'input' | 'unknown' {
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
  if (operation.discover.some((step) => isNamedStep(step, candidate))) {
    return 'discover';
  }
  if (operation.derive.some((step) => isNamedStep(step, candidate))) {
    return 'derive';
  }
  if (operation.compute.some((step) => isNamedStep(step, candidate))) {
    return 'compute';
  }
  return 'unknown';
}

function isNamedStep(value: unknown, name: string): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && (value as JsonRecord).name === name);
}

function normalizeCrossValidation(
  validate: RuntimeOperationSpec['validate'] | undefined,
): RuntimeOperationSummary['crossValidation'] {
  const rules = Array.isArray(validate?.cross) ? validate!.cross : [];
  const normalized = rules
    .map((rule) => {
      if (
        !rule ||
        typeof rule !== 'object' ||
        rule.kind !== 'not_equal' ||
        typeof rule.left !== 'string' ||
        typeof rule.right !== 'string'
      ) {
        return null;
      }
      return {
        kind: 'not_equal' as const,
        left: rule.left.trim(),
        right: rule.right.trim(),
        ...(typeof rule.message === 'string' && rule.message.trim().length > 0
          ? { message: rule.message.trim() }
          : {}),
      };
    })
    .filter(
      (rule): rule is {
        kind: 'not_equal';
        left: string;
        right: string;
        message?: string;
      } => rule !== null && rule.left.length > 0 && rule.right.length > 0,
    );
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
  const operations = pack.operations ?? {};
  const summaries = Object.entries(operations)
    .map(([operationId, operationSpec]) => {
      const materialized = materializeRuntimeOperation(operationId, operationSpec, pack);
      const inputs = Object.fromEntries(
        Object.entries(materialized.inputs).map(([inputName, spec]) => [
          inputName,
          {
            type: spec.type,
            required: spec.required !== false,
            ...(spec.default !== undefined ? { default: cloneJsonLike(spec.default) } : {}),
            ...(typeof spec.bind_from === 'string' ? { bind_from: spec.bind_from } : {}),
            ...(typeof spec.bind_from === 'string'
              ? { read_stage: resolveDiscoverStage(spec.bind_from, materialized) }
              : {}),
            ...(spec.validate ? { validate: cloneJsonLike(spec.validate) } : {}),
          },
        ]),
      );

      return {
        operationId,
        instruction: materialized.instruction,
        executionKind: materialized.instruction ? 'write' : 'read',
        inputs,
        ...(normalizeCrossValidation(operationSpec.validate)
          ? { crossValidation: normalizeCrossValidation(operationSpec.validate) }
          : {}),
        ...(normalizeReadOutputSpec(materialized.readOutput, `${options.protocolId}/${operationId}`)
          ? { readOutput: normalizeReadOutputSpec(materialized.readOutput, `${options.protocolId}/${operationId}`) }
          : {}),
      } satisfies RuntimeOperationSummary;
    })
    .sort((a, b) => a.operationId.localeCompare(b.operationId));

  return {
    protocolId: options.protocolId,
    schema: pack.schema,
    version: pack.version,
    operations: summaries,
  };
}

export async function explainRuntimeOperation(options: {
  protocolId: string;
  operationId: string;
}): Promise<RuntimeOperationExplain> {
  const pack = await loadRuntimePack(options.protocolId);
  const operationSpec = pack.operations?.[options.operationId];
  if (!operationSpec) {
    throw new Error(`Operation ${options.operationId} not found in runtime pack for ${options.protocolId}.`);
  }
  const materialized = materializeRuntimeOperation(options.operationId, operationSpec, pack);
  return {
    protocolId: options.protocolId,
    operationId: options.operationId,
    schema: pack.schema,
    version: pack.version,
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
    ...(normalizeReadOutputSpec(materialized.readOutput, `${options.protocolId}/${options.operationId}`)
      ? { readOutput: normalizeReadOutputSpec(materialized.readOutput, `${options.protocolId}/${options.operationId}`) }
      : {}),
    pre: cloneJsonLike(materialized.pre ?? []),
    post: cloneJsonLike(materialized.post ?? []),
  };
}


function isPlainObject(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export async function resolveProtocolForPacks(protocolId: string): Promise<ProtocolManifest> {
  return getProtocolById(protocolId);
}
