import { PublicKey, type Connection } from '@solana/web3.js';
import type { CodamaDocument as Idl } from './codamaIdl.js';

export type ComputeStepResolved = {
  name: string;
  compute: string;
  [key: string]: unknown;
};

export type ComputeInstructionPreview = {
  programId: string;
  dataBase64: string;
  keys: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
};

export type ComputeRuntimeContext = {
  protocolId: string;
  programId: string;
  connection: Connection;
  walletPublicKey: PublicKey;
  idl: Idl;
  scope: Record<string, unknown>;
  previewInstruction: (options: {
    instructionName: string;
    args: Record<string, unknown>;
    accounts: Record<string, string>;
  }) => Promise<ComputeInstructionPreview>;
};

export type ComputeExecutor = (step: ComputeStepResolved, ctx: ComputeRuntimeContext) => Promise<unknown>;

type PdaSeedSpec =
  | { kind: 'utf8'; value: string }
  | { kind: 'pubkey'; value: unknown }
  | { kind: 'i32_le'; value: unknown }
  | { kind: 'item_i32_le' }
  | { kind: 'item_utf8' };

type ListWhereOp = '=' | '==' | '!=' | '>' | '>=' | '<' | '<=';
type ListWhereClause = {
  path: string;
  op?: ListWhereOp;
  value: unknown;
};

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  return value;
}

function asBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${label} must be a boolean.`);
  }
  return value;
}

function asBigInt(value: unknown, label: string): bigint {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) {
    return BigInt(value);
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    return BigInt(value);
  }
  if (typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value)) {
    return BigInt(value);
  }
  if (typeof value === 'string' && /^[0-9a-fA-F]+$/.test(value) && /[a-fA-F]/.test(value)) {
    return BigInt(`0x${value}`);
  }
  throw new Error(`${label} must be bigint-compatible integer.`);
}

function asSafeInteger(value: unknown, label: string): number {
  const big = asBigInt(value, label);
  if (big < BigInt(Number.MIN_SAFE_INTEGER) || big > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} must fit in JS safe integer range.`);
  }
  return Number(big);
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

function normalizeComparable(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map(normalizeComparable);
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => [key, normalizeComparable(nested)] as const);
    return Object.fromEntries(entries);
  }

  return value;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizeComparable(left)) === JSON.stringify(normalizeComparable(right));
}

function toComparableBigint(value: unknown): bigint | null {
  try {
    return asBigInt(value, 'compare');
  } catch {
    return null;
  }
}

function compareOrdered(left: unknown, right: unknown): number {
  const leftBigint = toComparableBigint(left);
  const rightBigint = toComparableBigint(right);
  if (leftBigint !== null && rightBigint !== null) {
    if (leftBigint === rightBigint) {
      return 0;
    }
    return leftBigint > rightBigint ? 1 : -1;
  }

  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    if (leftNumber === rightNumber) {
      return 0;
    }
    return leftNumber > rightNumber ? 1 : -1;
  }

  return String(left).localeCompare(String(right));
}

function floorDivBigInt(dividend: bigint, divisor: bigint): bigint {
  if (divisor === 0n) {
    throw new Error('divisor must not be zero.');
  }
  const quotient = dividend / divisor;
  const remainder = dividend % divisor;
  if (remainder === 0n) {
    return quotient;
  }
  const signsDiffer = (dividend < 0n) !== (divisor < 0n);
  return signsDiffer ? quotient - 1n : quotient;
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

function toStringInteger(value: bigint): string {
  return value.toString();
}

async function runMathAdd(step: ComputeStepResolved): Promise<string> {
  const values = asArray(step.values, `compute:${step.name}:values`);
  if (values.length < 2) {
    throw new Error(`compute:${step.name}:values must contain at least 2 elements.`);
  }
  let total = 0n;
  values.forEach((value, index) => {
    total += asBigInt(value, `compute:${step.name}:values[${index}]`);
  });
  return toStringInteger(total);
}

async function runMathSum(step: ComputeStepResolved): Promise<string> {
  const values = asArray(step.values, `compute:${step.name}:values`);
  if (values.length < 1) {
    throw new Error(`compute:${step.name}:values must contain at least 1 element.`);
  }
  let total = 0n;
  values.forEach((value, index) => {
    total += asBigInt(value, `compute:${step.name}:values[${index}]`);
  });
  return toStringInteger(total);
}

async function runMathMul(step: ComputeStepResolved): Promise<string> {
  const values = asArray(step.values, `compute:${step.name}:values`);
  if (values.length < 2) {
    throw new Error(`compute:${step.name}:values must contain at least 2 elements.`);
  }
  let product = 1n;
  values.forEach((value, index) => {
    product *= asBigInt(value, `compute:${step.name}:values[${index}]`);
  });
  return toStringInteger(product);
}

async function runMathSub(step: ComputeStepResolved): Promise<string> {
  const values = asArray(step.values, `compute:${step.name}:values`);
  if (values.length < 2) {
    throw new Error(`compute:${step.name}:values must contain at least 2 elements.`);
  }
  let result = asBigInt(values[0], `compute:${step.name}:values[0]`);
  for (let index = 1; index < values.length; index += 1) {
    result -= asBigInt(values[index], `compute:${step.name}:values[${index}]`);
  }
  return toStringInteger(result);
}

async function runMathFloorDiv(step: ComputeStepResolved): Promise<string> {
  const dividend = asBigInt(step.dividend, `compute:${step.name}:dividend`);
  const divisor = asBigInt(step.divisor, `compute:${step.name}:divisor`);
  return toStringInteger(floorDivBigInt(dividend, divisor));
}

async function runListRangeMap(step: ComputeStepResolved): Promise<number[]> {
  const base = asSafeInteger(step.base, `compute:${step.name}:base`);
  const stepSize = asSafeInteger(step.step, `compute:${step.name}:step`);
  const count = asSafeInteger(step.count, `compute:${step.name}:count`);
  if (count <= 0 || count > 16) {
    throw new Error(`compute:${step.name}:count must be between 1 and 16.`);
  }
  return Array.from({ length: count }, (_, index) => base + index * stepSize);
}

async function runListGet(step: ComputeStepResolved): Promise<unknown> {
  const values = asArray(step.values, `compute:${step.name}:values`);
  if (values.length === 0) {
    throw new Error(`compute:${step.name}:values must not be empty.`);
  }
  const index = asSafeInteger(step.index, `compute:${step.name}:index`);
  if (index < 0 || index >= values.length) {
    throw new Error(`compute:${step.name}:index ${index} is out of bounds for ${values.length} item(s).`);
  }
  return values[index];
}

function parseListWhereClause(raw: unknown, label: string): ListWhereClause {
  const clause = asRecord(raw, label);
  const opRaw = clause.op === undefined ? '==' : clause.op;
  const op = String(opRaw) as ListWhereOp;
  if (!['=', '==', '!=', '>', '>=', '<', '<='].includes(op)) {
    throw new Error(`${label}.op must be one of =, ==, !=, >, >=, <, <=.`);
  }
  return {
    path: String(clause.path),
    op,
    value: clause.value,
  };
}

function matchesWhere(item: unknown, clauses: ListWhereClause[]): boolean {
  return clauses.every((clause) => {
    const actual = readPathFromValue(item, clause.path);
    const op = clause.op ?? '==';
    if (op === '=' || op === '==') {
      return valuesEqual(actual, clause.value);
    }
    if (op === '!=') {
      return !valuesEqual(actual, clause.value);
    }
    const ordered = compareOrdered(actual, clause.value);
    if (op === '>') {
      return ordered > 0;
    }
    if (op === '>=') {
      return ordered >= 0;
    }
    if (op === '<') {
      return ordered < 0;
    }
    if (op === '<=') {
      return ordered <= 0;
    }
    throw new Error(`Unsupported op ${String(op)}.`);
  });
}

async function runListFilter(step: ComputeStepResolved): Promise<unknown[]> {
  const items = asArray(step.items, `compute:${step.name}:items`);
  if (step.where === undefined) {
    return items;
  }
  const whereArray = Array.isArray(step.where) ? step.where : [step.where];
  const clauses = whereArray.map((entry, index) =>
    parseListWhereClause(entry, `compute:${step.name}:where[${index}]`),
  );
  return items.filter((item) => matchesWhere(item, clauses));
}

async function runListFirst(step: ComputeStepResolved): Promise<unknown> {
  const items = asArray(step.items, `compute:${step.name}:items`);
  if (items.length === 0) {
    if (step.allow_empty === true) {
      return null;
    }
    throw new Error(`compute:${step.name}:items must not be empty.`);
  }
  return items[0];
}

function pickByPath(items: unknown[], path: string, mode: 'min' | 'max', label: string): unknown {
  if (items.length === 0) {
    throw new Error(`${label}:items must not be empty.`);
  }

  let bestItem = items[0];
  let bestValue = readPathFromValue(items[0], path);
  for (let index = 1; index < items.length; index += 1) {
    const candidate = items[index];
    const candidateValue = readPathFromValue(candidate, path);
    const cmp = compareOrdered(candidateValue, bestValue);
    if ((mode === 'min' && cmp < 0) || (mode === 'max' && cmp > 0)) {
      bestItem = candidate;
      bestValue = candidateValue;
    }
  }
  return bestItem;
}

async function runListMinBy(step: ComputeStepResolved): Promise<unknown> {
  const items = asArray(step.items, `compute:${step.name}:items`);
  const path = String(step.path ?? '');
  if (!path) {
    throw new Error(`compute:${step.name}:path must be provided.`);
  }
  if (items.length === 0) {
    if (step.allow_empty === true) {
      return null;
    }
    throw new Error(`compute:${step.name}:items must not be empty.`);
  }
  return pickByPath(items, path, 'min', `compute:${step.name}`);
}

async function runListMaxBy(step: ComputeStepResolved): Promise<unknown> {
  const items = asArray(step.items, `compute:${step.name}:items`);
  const path = String(step.path ?? '');
  if (!path) {
    throw new Error(`compute:${step.name}:path must be provided.`);
  }
  if (items.length === 0) {
    if (step.allow_empty === true) {
      return null;
    }
    throw new Error(`compute:${step.name}:items must not be empty.`);
  }
  return pickByPath(items, path, 'max', `compute:${step.name}`);
}

async function runCoalesce(step: ComputeStepResolved): Promise<unknown> {
  const values = asArray(step.values, `compute:${step.name}:values`);
  for (const value of values) {
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return null;
}

function encodePdaSeed(seed: PdaSeedSpec, item: unknown, label: string): Uint8Array {
  if (seed.kind === 'utf8') {
    return new TextEncoder().encode(seed.value);
  }
  if (seed.kind === 'pubkey') {
    return asPubkey(seed.value, `${label}:value`).toBuffer();
  }
  if (seed.kind === 'i32_le') {
    const intValue = asSafeInteger(seed.value, `${label}:value`);
    if (intValue < -2147483648 || intValue > 2147483647) {
      throw new Error(`${label}:value must fit in i32.`);
    }
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setInt32(0, intValue, true);
    return bytes;
  }
  if (seed.kind === 'item_utf8') {
    if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'bigint') {
      throw new Error(`${label}:item must be string/number/bigint for item_utf8.`);
    }
    return new TextEncoder().encode(String(item));
  }

  const intValue = asSafeInteger(item, `${label}:item`);
  if (intValue < -2147483648 || intValue > 2147483647) {
    throw new Error(`${label}:item must fit in i32.`);
  }
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setInt32(0, intValue, true);
  return bytes;
}

function parseSeedSpec(raw: unknown, label: string): PdaSeedSpec {
  const seed = asRecord(raw, label);
  const kind = String(seed.kind);
  if (kind === 'utf8') {
    if (typeof seed.value !== 'string') {
      throw new Error(`${label}: utf8 seed requires string value.`);
    }
    return { kind: 'utf8', value: seed.value };
  }
  if (kind === 'pubkey') {
    return { kind: 'pubkey', value: seed.value };
  }
  if (kind === 'i32_le') {
    return { kind: 'i32_le', value: seed.value };
  }
  if (kind === 'item_i32_le') {
    return { kind: 'item_i32_le' };
  }
  if (kind === 'item_utf8') {
    return { kind: 'item_utf8' };
  }
  throw new Error(`${label}: unsupported seed kind ${String(kind)}.`);
}

async function runPdaSeedSpec(step: ComputeStepResolved, ctx: ComputeRuntimeContext): Promise<string | string[]> {
  const programId = asPubkey(step.program_id ?? ctx.programId, `compute:${step.name}:program_id`);
  const seeds = asArray(step.seeds, `compute:${step.name}:seeds`).map((entry, index) =>
    parseSeedSpec(entry, `compute:${step.name}:seeds[${index}]`),
  );

  const mapOver = step.map_over === undefined ? null : asArray(step.map_over, `compute:${step.name}:map_over`);
  if (!mapOver) {
    const encodedSeeds = seeds.map((seed, index) =>
      encodePdaSeed(seed, undefined, `compute:${step.name}:seeds[${index}]`),
    );
    return PublicKey.findProgramAddressSync(encodedSeeds, programId)[0].toBase58();
  }

  return mapOver.map((item, itemIndex) => {
    const encodedSeeds = seeds.map((seed, seedIndex) =>
      encodePdaSeed(seed, item, `compute:${step.name}:map_over[${itemIndex}].seeds[${seedIndex}]`),
    );
    return PublicKey.findProgramAddressSync(encodedSeeds, programId)[0].toBase58();
  });
}

async function runCompareEquals(step: ComputeStepResolved): Promise<boolean> {
  return valuesEqual(step.left, step.right);
}

async function runCompareNotEquals(step: ComputeStepResolved): Promise<boolean> {
  return !valuesEqual(step.left, step.right);
}

async function runCompareGt(step: ComputeStepResolved): Promise<boolean> {
  return compareOrdered(step.left, step.right) > 0;
}

async function runCompareGte(step: ComputeStepResolved): Promise<boolean> {
  return compareOrdered(step.left, step.right) >= 0;
}

async function runCompareLt(step: ComputeStepResolved): Promise<boolean> {
  return compareOrdered(step.left, step.right) < 0;
}

async function runCompareLte(step: ComputeStepResolved): Promise<boolean> {
  return compareOrdered(step.left, step.right) <= 0;
}

async function runLogicIf(step: ComputeStepResolved): Promise<unknown> {
  const condition = asBoolean(step.condition, `compute:${step.name}:condition`);
  return condition ? step.then : step.else;
}

async function runAssertNotNull(step: ComputeStepResolved): Promise<unknown> {
  const value = step.value;
  if (value === null || value === undefined) {
    const message =
      step.message === undefined
        ? `compute:${step.name}:value must not be null or undefined.`
        : String(step.message);
    throw new Error(message);
  }
  return value;
}

async function runCurveLinearInterpolateBps(step: ComputeStepResolved): Promise<string> {
  const pointsRaw = asArray(step.points, `compute:${step.name}:points`);
  if (pointsRaw.length === 0) {
    throw new Error(`compute:${step.name}:points must not be empty.`);
  }

  const xField = step.x_field === undefined ? 'utilizationRateBps' : String(step.x_field);
  const yField = step.y_field === undefined ? 'borrowRateBps' : String(step.y_field);
  const xBps = asBigInt(step.x_bps, `compute:${step.name}:x_bps`);

  const points = pointsRaw
    .map((entry, index) => {
      const row = asRecord(entry, `compute:${step.name}:points[${index}]`);
      return {
        x: asBigInt(row[xField], `compute:${step.name}:points[${index}].${xField}`),
        y: asBigInt(row[yField], `compute:${step.name}:points[${index}].${yField}`),
      };
    })
    .sort((left, right) => (left.x === right.x ? 0 : left.x > right.x ? 1 : -1));

  if (xBps <= points[0].x) {
    return points[0].y.toString();
  }

  for (let index = 1; index < points.length; index += 1) {
    const left = points[index - 1];
    const right = points[index];
    if (xBps <= right.x) {
      if (right.x === left.x) {
        return right.y.toString();
      }
      const xDelta = xBps - left.x;
      const span = right.x - left.x;
      const yDelta = right.y - left.y;
      const yOffset = floorDivBigInt(xDelta * yDelta, span);
      return (left.y + yOffset).toString();
    }
  }

  return points[points.length - 1].y.toString();
}

const COMPUTE_EXECUTORS: Record<string, ComputeExecutor> = {
  'math.add': runMathAdd,
  'math.sum': runMathSum,
  'math.mul': runMathMul,
  'math.sub': runMathSub,
  'math.floor_div': runMathFloorDiv,
  'list.range_map': runListRangeMap,
  'list.get': runListGet,
  'list.filter': runListFilter,
  'list.first': runListFirst,
  'list.min_by': runListMinBy,
  'list.max_by': runListMaxBy,
  coalesce: runCoalesce,
  'pda(seed_spec)': runPdaSeedSpec,
  'compare.equals': runCompareEquals,
  'compare.not_equals': runCompareNotEquals,
  'compare.gt': runCompareGt,
  'compare.gte': runCompareGte,
  'compare.lt': runCompareLt,
  'compare.lte': runCompareLte,
  'logic.if': runLogicIf,
  'assert.not_null': runAssertNotNull,
  'curve.linear_interpolate_bps': runCurveLinearInterpolateBps,
};

export async function runRegisteredComputeStep(step: ComputeStepResolved, ctx: ComputeRuntimeContext): Promise<unknown> {
  const executor = COMPUTE_EXECUTORS[step.compute];
  if (!executor) {
    throw new Error(`Unsupported compute step: ${step.compute}`);
  }

  return executor(step, ctx);
}
