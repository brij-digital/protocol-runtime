type JsonRecord = Record<string, unknown>;

export type ActionRunnerInputSpec = {
  type: string;
  required?: boolean;
  default?: unknown;
  description?: string;
  example?: unknown;
};

export type ActionRunnerStepSpec = {
  id: string;
  kind: 'read' | 'write';
  protocolId: string;
  operationId: string;
  input?: Record<string, unknown>;
  limit?: number;
};

export type ActionRunnerSpec = {
  schema: 'solana-action-runner.v1';
  actionId: string;
  title: string;
  description?: string;
  inputs: Record<string, ActionRunnerInputSpec>;
  steps: ActionRunnerStepSpec[];
  output: Record<string, unknown>;
};

export type ActionRunnerStepResult = {
  id: string;
  kind: ActionRunnerStepSpec['kind'];
  protocolId: string;
  operationId: string;
  input: Record<string, unknown>;
  output: unknown;
  meta?: Record<string, unknown>;
};

export type ActionRunnerResult = {
  actionId: string;
  title: string;
  output: Record<string, unknown>;
  steps: ActionRunnerStepResult[];
};

export type ActionRunnerExecutor = (step: {
  id: string;
  kind: ActionRunnerStepSpec['kind'];
  protocolId: string;
  operationId: string;
  input: Record<string, unknown>;
  limit?: number;
}) => Promise<{
  output: unknown;
  meta?: Record<string, unknown>;
}>;

function asRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonRecord;
}

function readPath(value: unknown, path: string): unknown {
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

function resolveReference(value: string, scope: JsonRecord): unknown {
  if (!value.startsWith('$')) {
    return value;
  }
  const resolved = readPath(scope, value);
  if (resolved === undefined) {
    throw new Error(`Cannot resolve runner reference ${value}.`);
  }
  return resolved;
}

function resolveValue(value: unknown, scope: JsonRecord): unknown {
  if (typeof value === 'string') {
    return resolveReference(value, scope);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => resolveValue(entry, scope));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as JsonRecord).map(([key, entry]) => [key, resolveValue(entry, scope)]),
    );
  }
  return value;
}

function hydrateRunnerInput(spec: ActionRunnerSpec, input: Record<string, unknown>): Record<string, unknown> {
  const hydrated: Record<string, unknown> = {};
  for (const [inputName, inputSpec] of Object.entries(spec.inputs)) {
    const rawValue = input[inputName] !== undefined ? input[inputName] : inputSpec.default;
    if (rawValue === undefined) {
      if (inputSpec.required !== false) {
        throw new Error(`Missing required runner input: ${inputName}`);
      }
      continue;
    }
    hydrated[inputName] = rawValue;
  }
  return hydrated;
}

export async function runActionRunner(options: {
  spec: ActionRunnerSpec;
  input: Record<string, unknown>;
  executeStep: ActionRunnerExecutor;
}): Promise<ActionRunnerResult> {
  const hydratedInput = hydrateRunnerInput(options.spec, options.input);
  const scope: JsonRecord = {
    input: hydratedInput,
  };
  const steps: ActionRunnerStepResult[] = [];

  for (const step of options.spec.steps) {
    const resolvedInput = step.input
      ? asRecord(resolveValue(step.input, scope), `${options.spec.actionId}.${step.id}.input`)
      : {};
    const executed = await options.executeStep({
      id: step.id,
      kind: step.kind,
      protocolId: step.protocolId,
      operationId: step.operationId,
      input: resolvedInput,
      limit: step.limit,
    });
    const entry: ActionRunnerStepResult = {
      id: step.id,
      kind: step.kind,
      protocolId: step.protocolId,
      operationId: step.operationId,
      input: resolvedInput,
      output: executed.output,
      ...(executed.meta ? { meta: executed.meta } : {}),
    };
    steps.push(entry);
    scope[step.id] = {
      output: entry.output,
      ...(entry.meta ? { meta: entry.meta } : {}),
    };
  }

  return {
    actionId: options.spec.actionId,
    title: options.spec.title,
    output: asRecord(resolveValue(options.spec.output, scope), `${options.spec.actionId}.output`),
    steps,
  };
}
