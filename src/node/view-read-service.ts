import fs from 'node:fs';
import path from 'node:path';
import { BorshAccountsCoder, type Idl } from '@coral-xyz/anchor';
import { Connection, PublicKey, type Commitment, type GetProgramAccountsFilter } from '@solana/web3.js';
import { Pool } from 'pg';

type SortDirection = 'asc' | 'desc';

type DiscoverWhereClause = {
  path: string;
  op: '>' | '>=' | '<' | '<=' | '=' | '!=';
  value: string | number | boolean;
};

type DiscoverSortClause = {
  path: string;
  dir: SortDirection;
};

type DiscoverMemcmpClause = {
  memcmp: {
    offset: number;
    bytesFrom: string;
  };
};

type DiscoverQueryStep = {
  name: string;
  discover: 'discover.query';
  source: 'rpc.getProgramAccounts';
  program_id: string;
  account_type: string;
  discriminator_filter?: boolean;
  commitment?: Commitment;
  or_filters?: DiscoverMemcmpClause[][];
  where?: DiscoverWhereClause[];
  sort?: DiscoverSortClause[];
  limit?: number;
  select: Record<string, unknown>;
};

type TemplateUse = {
  template: string;
  with?: Record<string, string>;
};

type OperationInputDef = {
  type: string;
  required?: boolean;
  default?: unknown;
};

type ReadOutputDef = {
  type: string;
  source: string;
  max_items?: number;
};

type OperationDef = {
  inputs?: Record<string, OperationInputDef>;
  use?: TemplateUse[];
  view?: {
    entity_keys?: string[];
  };
  read_output?: ReadOutputDef;
};

type TemplateDef = {
  expand?: {
    discover?: DiscoverQueryStep[];
  };
};

type MetaPack = {
  protocolId: string;
  operations?: Record<string, OperationDef>;
  templates?: Record<string, TemplateDef>;
};

type ListPoolsOptions = {
  input: Record<string, unknown>;
  limit: number;
};

type ReadResult = {
  items: Record<string, unknown>[];
  source: 'cache' | 'db';
  slot: number;
  generatedAtMs: number;
};

type IndexedEntityRecord = {
  entityId: string;
  payload: Record<string, unknown>;
  slot: number;
};

type CacheEntry = {
  expiresAtMs: number;
  value: ReadResult;
};

type FullSyncResult = {
  totalAccounts: number;
  upserted: number;
  slot: number;
};

type IncrementalSyncResult = {
  inputAccounts: number;
  fetchedAccounts: number;
  decodedAccounts: number;
  upserted: number;
  slot: number;
};

type AppPackViewReadServiceOptions = {
  connection: Connection;
  databaseUrl: string | null;
  poolOverride?: Pool | null;
  cacheTtlMs: number;
  metaPath: string;
  idlPath: string;
  programId: string;
  operationId: string;
};

type DecodedAccountContext = {
  account: {
    pubkey: string;
  };
  decoded: Record<string, unknown>;
  param: Record<string, unknown>;
  protocol: {
    programId: string;
  };
};

type CompiledOperation = {
  protocolId: string;
  namespace: string;
  discoverStep: DiscoverQueryStep;
  defaultLimit: number;
  outputMaxItems: number;
  outputSource: string;
  entityKeys: string[];
  tokenMintFieldA: string | null;
  tokenMintFieldB: string | null;
  liquidityField: string | null;
  pairParamA: string | null;
  pairParamB: string | null;
  paramFieldMap: Record<string, string>;
  programId: PublicKey;
  accountType: string;
  accountSize: number;
  discriminatorFilter: GetProgramAccountsFilter | null;
  paramMap: Record<string, string>;
  operationInputDefs: Record<string, OperationInputDef>;
};

const LEGACY_ORCA_POOLS_TABLE = 'orca_pools';
const LEGACY_ORCA_HISTORY_TABLE = 'orca_pool_history';
const ACCOUNT_CACHE_TABLE = 'cached_program_accounts';

function sanitizeIndexName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50) || 'idx';
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseMetaPack(metaPath: string): MetaPack {
  return JSON.parse(fs.readFileSync(metaPath, 'utf8')) as MetaPack;
}

function parseIdl(idlPath: string): Idl {
  return JSON.parse(fs.readFileSync(idlPath, 'utf8')) as Idl;
}

function parsePublicKey(value: string, name: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`${name} must be a valid public key.`);
  }
}

function readByPath(root: unknown, dotPath: string): unknown {
  if (!dotPath) {
    return root;
  }
  const parts = dotPath.split('.');
  let current: unknown = root;
  for (const part of parts) {
    if (!part) {
      continue;
    }
    if (!isObjectRecord(current) && !Array.isArray(current)) {
      return undefined;
    }
    if (Array.isArray(current)) {
      const index = Number.parseInt(part, 10);
      if (!Number.isFinite(index)) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    current = current[part];
  }
  return current;
}

function resolveReference(expression: unknown, context: Record<string, unknown>): unknown {
  if (typeof expression !== 'string') {
    return expression;
  }
  if (!expression.startsWith('$')) {
    return expression;
  }
  const withoutDollar = expression.slice(1);
  const dotIndex = withoutDollar.indexOf('.');
  if (dotIndex === -1) {
    return context[withoutDollar];
  }
  const base = withoutDollar.slice(0, dotIndex);
  const path = withoutDollar.slice(dotIndex + 1);
  return readByPath(context[base], path);
}

function toBigIntSafe(value: unknown): bigint {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number') {
    return BigInt(value);
  }
  if (typeof value === 'string') {
    return BigInt(value);
  }
  if (value && typeof value === 'object' && 'toString' in value) {
    return BigInt(String(value));
  }
  throw new Error(`value is not bigint-compatible: ${String(value)}`);
}

function compareValues(left: unknown, right: unknown, operator: DiscoverWhereClause['op']): boolean {
  const attemptBigInt = () => {
    try {
      return [toBigIntSafe(left), toBigIntSafe(right)] as const;
    } catch {
      return null;
    }
  };

  const numeric = attemptBigInt();
  if (numeric) {
    const [a, b] = numeric;
    if (operator === '>') return a > b;
    if (operator === '>=') return a >= b;
    if (operator === '<') return a < b;
    if (operator === '<=') return a <= b;
    if (operator === '=') return a === b;
    return a !== b;
  }

  const a = String(left);
  const b = String(right);
  if (operator === '>') return a > b;
  if (operator === '>=') return a >= b;
  if (operator === '<') return a < b;
  if (operator === '<=') return a <= b;
  if (operator === '=') return a === b;
  return a !== b;
}

function normalizePair(a: string, b: string): string {
  return [a, b].sort((x, y) => x.localeCompare(y)).join('|');
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function decodeBase58(value: string): Buffer {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const bytes: number[] = [0];
  for (let i = 0; i < value.length; i += 1) {
    const index = alphabet.indexOf(value[i] ?? '');
    if (index < 0) {
      throw new Error(`invalid base58 value: ${value}`);
    }
    let carry = index;
    for (let j = 0; j < bytes.length; j += 1) {
      const x = bytes[j]! * 58 + carry;
      bytes[j] = x & 0xff;
      carry = x >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < value.length && value[i] === '1'; i += 1) {
    bytes.push(0);
  }
  return Buffer.from(bytes.reverse());
}

function toBufferSafe(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  if (typeof value === 'string' && value.startsWith('\\x')) {
    return Buffer.from(value.slice(2), 'hex');
  }
  return null;
}

function pickFieldBySelectValue(select: Record<string, unknown>, valueRef: string): string | null {
  for (const [fieldName, expression] of Object.entries(select)) {
    if (expression === valueRef) {
      return fieldName;
    }
  }
  return null;
}

function inferPairParams(
  step: DiscoverQueryStep,
  operationInputDefs: Record<string, OperationInputDef>,
): [string | null, string | null] {
  const preferredPairs: Array<[string, string]> = [
    ['token_in_mint', 'token_out_mint'],
    ['base_mint', 'quote_mint'],
    ['token_mint_a', 'token_mint_b'],
    ['mint_a', 'mint_b'],
  ];
  for (const [left, right] of preferredPairs) {
    if (operationInputDefs[left] && operationInputDefs[right]) {
      return [left, right];
    }
  }

  // Backward-compatible fallback for legacy specs that still use or_filters.
  const params = new Set<string>();
  const groups = step.or_filters ?? [];
  for (const group of groups) {
    for (const condition of group) {
      const ref = condition.memcmp.bytesFrom;
      if (ref.startsWith('$param.')) {
        params.add(ref.slice('$param.'.length));
      }
    }
  }
  const values = Array.from(params);
  if (values.length >= 2) {
    return [values[0] ?? null, values[1] ?? null];
  }

  return [null, null];
}

function inferParamFieldMap(step: DiscoverQueryStep): Record<string, string> {
  const map: Record<string, string> = {};
  const findSelectFieldForDecodedPath = (decodedPath: string): string | null => {
    const expression = `$decoded.${decodedPath}`;
    return pickFieldBySelectValue(step.select, expression);
  };

  for (const clause of step.where ?? []) {
    if (clause.op !== '=') {
      continue;
    }
    if (typeof clause.value !== 'string' || !clause.value.startsWith('$param.')) {
      continue;
    }
    if (!clause.path.startsWith('decoded.')) {
      continue;
    }
    const paramName = clause.value.slice('$param.'.length);
    const decodedPath = clause.path.slice('decoded.'.length);
    if (!paramName || !decodedPath) {
      continue;
    }
    const field = findSelectFieldForDecodedPath(decodedPath);
    if (!field) {
      continue;
    }
    map[paramName] = field;
  }

  return map;
}

function compileOperation(meta: MetaPack, coder: BorshAccountsCoder, options: AppPackViewReadServiceOptions): CompiledOperation {
  const operation = meta.operations?.[options.operationId];
  if (!operation) {
    throw new Error(`Operation ${options.operationId} not found in meta IDL.`);
  }
  const use = operation.use?.[0];
  if (!use) {
    throw new Error(`Operation ${options.operationId} has no template use.`);
  }
  const template = meta.templates?.[use.template];
  const discoverSteps = template?.expand?.discover;
  if (!discoverSteps || discoverSteps.length === 0) {
    throw new Error(`Template ${use.template} has no discover steps.`);
  }
  const discoverStep = discoverSteps[0];
  if (!discoverStep) {
    throw new Error(`Template ${use.template} has an invalid discover step.`);
  }
  if (discoverStep.discover !== 'discover.query' || discoverStep.source !== 'rpc.getProgramAccounts') {
    throw new Error(`Operation ${options.operationId} requires unsupported discover type/source.`);
  }

  const outputMaxItems = operation.read_output?.max_items ?? discoverStep.limit ?? 20;
  const outputSource = operation.read_output?.source ?? `$derived.${discoverStep.name}`;
  const entityKeys = operation.view?.entity_keys ?? ['whirlpool'];
  const operationInputDefs = operation.inputs ?? {};
  const tokenMintFieldA = pickFieldBySelectValue(discoverStep.select, '$decoded.token_mint_a');
  const tokenMintFieldB = pickFieldBySelectValue(discoverStep.select, '$decoded.token_mint_b');
  const liquidityField = pickFieldBySelectValue(discoverStep.select, '$decoded.liquidity');
  const [pairParamA, pairParamB] = inferPairParams(discoverStep, operationInputDefs);
  const paramFieldMap = inferParamFieldMap(discoverStep);

  return {
    protocolId: meta.protocolId,
    namespace: `${meta.protocolId}.${options.operationId}`,
    discoverStep,
    defaultLimit: discoverStep.limit ?? 20,
    outputMaxItems,
    outputSource,
    entityKeys,
    tokenMintFieldA,
    tokenMintFieldB,
    liquidityField,
    pairParamA,
    pairParamB,
    paramFieldMap,
    programId: parsePublicKey(options.programId, 'programId'),
    accountType: discoverStep.account_type,
    accountSize: coder.size(discoverStep.account_type),
    discriminatorFilter:
      discoverStep.discriminator_filter === false
        ? null
        : {
            memcmp: coder.memcmp(discoverStep.account_type),
          },
    paramMap: use.with ?? {},
    operationInputDefs,
  };
}

export class AppPackViewReadService {
  private readonly connection: Connection;
  private readonly cacheTtlMs: number;
  private readonly pool: Pool | null;
  private readonly coder: BorshAccountsCoder;
  private readonly compiled: CompiledOperation;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: AppPackViewReadServiceOptions) {
    this.connection = options.connection;
    this.cacheTtlMs = options.cacheTtlMs;
    if (options.poolOverride) {
      this.pool = options.poolOverride;
    } else {
      this.pool = options.databaseUrl
        ? new Pool({
            connectionString: options.databaseUrl,
            max: 4,
          })
        : null;
    }

    const meta = parseMetaPack(path.resolve(options.metaPath));
    const idl = parseIdl(path.resolve(options.idlPath));
    this.coder = new BorshAccountsCoder(idl);
    this.compiled = compileOperation(meta, this.coder, options);
  }

  hasDatabase(): boolean {
    return this.pool !== null;
  }

  async initialize(): Promise<void> {
    if (!this.pool) {
      return;
    }

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS view_entities (
        namespace TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        slot BIGINT NOT NULL,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (namespace, entity_id)
      );
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_view_entities_namespace_slot
      ON view_entities (namespace, slot DESC);
    `);

    const namespaceIndexName = sanitizeIndexName(`idx_${this.compiled.namespace}_namespace`);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${namespaceIndexName}
      ON view_entities (namespace)
      WHERE namespace = '${this.compiled.namespace}';
    `);

    if (this.compiled.tokenMintFieldA && this.compiled.tokenMintFieldB && this.compiled.liquidityField) {
      const pairIndexName = sanitizeIndexName(`idx_${this.compiled.namespace}_pair_liquidity`);
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS ${pairIndexName}
        ON view_entities (
          (payload->>'${this.compiled.tokenMintFieldA}'),
          (payload->>'${this.compiled.tokenMintFieldB}'),
          ((payload->>'${this.compiled.liquidityField}')::numeric) DESC
        )
        WHERE namespace = '${this.compiled.namespace}';
      `);
    }

    await this.migrateLegacyOrcaTablesIfNeeded();
  }

  clearCache(): void {
    this.cache.clear();
  }

  getCacheStats(): { entries: number } {
    return { entries: this.cache.size };
  }

  getNamespace(): string {
    return this.compiled.namespace;
  }

  async runRead(options: ListPoolsOptions): Promise<ReadResult> {
    const resolvedInput = this.resolveOperationInput(options.input);
    const resolvedParams = this.resolveTemplateParams(resolvedInput);
    const effectiveLimit = Math.max(1, Math.min(options.limit, this.compiled.outputMaxItems));
    const cacheKey = this.makeCacheKey(resolvedInput, effectiveLimit);
    const now = Date.now();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAtMs > now) {
      return {
        ...cached.value,
        source: 'cache',
      };
    }

    if (this.pool) {
      const dbValue = await this.fetchFromAccountCache(resolvedParams, effectiveLimit);
      if (dbValue) {
        this.cache.set(cacheKey, {
          expiresAtMs: dbValue.generatedAtMs + this.cacheTtlMs,
          value: dbValue,
        });
        return dbValue;
      }
    }

    if (!this.pool) {
      throw new Error(`No indexed data available for ${this.compiled.namespace}: DATABASE_URL is not configured.`);
    }
    throw new Error(
      `No indexed account-cache data available for ${this.compiled.namespace}. Hydrator may still be catching up.`,
    );
  }

  async syncFullToDatabase(): Promise<FullSyncResult | null> {
    if (!this.pool) {
      return null;
    }

    const accounts = await this.connection.getProgramAccounts(this.compiled.programId, {
      commitment: this.compiled.discoverStep.commitment ?? 'confirmed',
      filters: [{ dataSize: this.compiled.accountSize }],
    });
    const slot = await this.connection.getSlot(this.compiled.discoverStep.commitment ?? 'confirmed');

    const records: Array<{ entityId: string; payload: Record<string, unknown> }> = [];
    for (const account of accounts) {
      const selected = this.decodeAndSelect(account.pubkey.toBase58(), account.account.data, {});
      if (!selected) {
        continue;
      }
      const entityId = this.buildEntityId(selected, account.pubkey.toBase58());
      records.push({ entityId, payload: selected });
    }

    const upserted = await this.upsertRecords(records, slot);
    this.clearCache();
    return {
      totalAccounts: accounts.length,
      upserted,
      slot,
    };
  }

  async syncByAccountAddresses(addresses: string[], slot: number): Promise<IncrementalSyncResult | null> {
    if (!this.pool) {
      return null;
    }

    const uniqueAddresses = new Set<string>();
    for (const raw of addresses) {
      try {
        uniqueAddresses.add(new PublicKey(raw).toBase58());
      } catch {
        continue;
      }
    }
    const list = Array.from(uniqueAddresses);
    if (list.length === 0) {
      return {
        inputAccounts: 0,
        fetchedAccounts: 0,
        decodedAccounts: 0,
        upserted: 0,
        slot,
      };
    }

    const records: Array<{ entityId: string; payload: Record<string, unknown> }> = [];
    let fetchedAccounts = 0;

    for (const group of chunk(list, 100)) {
      const pubkeys = group.map((value) => new PublicKey(value));
      const infos = await this.connection.getMultipleAccountsInfo(pubkeys, this.compiled.discoverStep.commitment ?? 'confirmed');
      for (let i = 0; i < infos.length; i += 1) {
        const info = infos[i];
        if (!info) {
          continue;
        }
        fetchedAccounts += 1;
        if (!info.owner.equals(this.compiled.programId)) {
          continue;
        }
        if (info.data.length !== this.compiled.accountSize) {
          continue;
        }
        const pubkey = group[i];
        if (!pubkey) {
          continue;
        }
        const selected = this.decodeAndSelect(pubkey, info.data, {});
        if (!selected) {
          continue;
        }
        const entityId = this.buildEntityId(selected, pubkey);
        records.push({ entityId, payload: selected });
      }
    }

    const upserted = await this.upsertRecords(records, slot);
    if (upserted > 0) {
      this.clearCache();
    }

    return {
      inputAccounts: list.length,
      fetchedAccounts,
      decodedAccounts: records.length,
      upserted,
      slot,
    };
  }

  async close(): Promise<void> {
    if (!this.pool) {
      return;
    }
    await this.pool.end();
  }

  async upsertIndexedRecords(records: IndexedEntityRecord[]): Promise<{ upserted: number; maxSlot: number }> {
    if (!this.pool) {
      throw new Error(`Cannot upsert indexed records for ${this.compiled.namespace}: DATABASE_URL is not configured.`);
    }
    if (records.length === 0) {
      return { upserted: 0, maxSlot: 0 };
    }

    const normalized: IndexedEntityRecord[] = [];
    let maxSlot = 0;
    for (const record of records) {
      if (!record || typeof record !== 'object') {
        continue;
      }
      const entityId = String(record.entityId ?? '');
      if (entityId.length === 0) {
        continue;
      }
      if (!record.payload || typeof record.payload !== 'object' || Array.isArray(record.payload)) {
        continue;
      }
      const slot = Number.parseInt(String(record.slot), 10);
      if (!Number.isFinite(slot) || slot <= 0) {
        continue;
      }
      if (slot > maxSlot) {
        maxSlot = slot;
      }
      normalized.push({
        entityId,
        payload: record.payload,
        slot,
      });
    }

    if (normalized.length === 0) {
      return { upserted: 0, maxSlot };
    }

    const upserted = await this.upsertRecordsWithSlot(normalized);
    if (upserted > 0) {
      this.clearCache();
    }
    return { upserted, maxSlot };
  }

  private makeCacheKey(input: Record<string, unknown>, limit: number): string {
    const aKey = this.compiled.pairParamA ? String(input[this.compiled.pairParamA] ?? '') : '';
    const bKey = this.compiled.pairParamB ? String(input[this.compiled.pairParamB] ?? '') : '';
    const pair = aKey && bKey ? normalizePair(aKey, bKey) : JSON.stringify(input);
    return `${this.compiled.namespace}|${pair}|${limit}`;
  }

  private resolveOperationInput(rawInput: Record<string, unknown>): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};
    for (const [inputName, def] of Object.entries(this.compiled.operationInputDefs)) {
      const incoming = rawInput[inputName];
      if (incoming === undefined || incoming === null || incoming === '') {
        if (def.default !== undefined) {
          resolved[inputName] = def.default;
          continue;
        }
        if (def.required) {
          throw new Error(`Missing required input: ${inputName}`);
        }
        continue;
      }
      resolved[inputName] = incoming;
    }

    for (const [inputName, value] of Object.entries(rawInput)) {
      if (!(inputName in resolved)) {
        resolved[inputName] = value;
      }
    }

    // Normalize known pubkey pair inputs for deterministic cache keying.
    if (this.compiled.pairParamA && resolved[this.compiled.pairParamA] !== undefined) {
      resolved[this.compiled.pairParamA] = parsePublicKey(String(resolved[this.compiled.pairParamA]), this.compiled.pairParamA).toBase58();
    }
    if (this.compiled.pairParamB && resolved[this.compiled.pairParamB] !== undefined) {
      resolved[this.compiled.pairParamB] = parsePublicKey(String(resolved[this.compiled.pairParamB]), this.compiled.pairParamB).toBase58();
    }
    return resolved;
  }

  private resolveTemplateParams(input: Record<string, unknown>): Record<string, unknown> {
    const params: Record<string, unknown> = {};
    for (const [paramName, expression] of Object.entries(this.compiled.paramMap)) {
      const resolved = resolveReference(expression, { input });
      if (resolved !== undefined) {
        params[paramName] = resolved;
      }
    }
    for (const [key, value] of Object.entries(input)) {
      if (!(key in params)) {
        params[key] = value;
      }
    }
    return params;
  }

  private resolveMemcmpBytes(bytesFrom: string, params: Record<string, unknown>): Buffer {
    const resolved = resolveReference(bytesFrom, { param: params });
    if (typeof resolved !== 'string' || resolved.length === 0) {
      throw new Error(`Invalid memcmp bytesFrom value for ${bytesFrom}`);
    }

    try {
      return new PublicKey(resolved).toBuffer();
    } catch {
      if (/^[1-9A-HJ-NP-Za-km-z]+$/.test(resolved)) {
        return decodeBase58(resolved);
      }
      if (/^[0-9a-fA-F]+$/.test(resolved) && resolved.length % 2 === 0) {
        return Buffer.from(resolved, 'hex');
      }
      throw new Error(`Unable to resolve memcmp bytes for ${bytesFrom}`);
    }
  }

  private buildOrFiltersSql(params: Record<string, unknown>, paramStartIndex: number): { sql: string; values: unknown[] } {
    const groups = this.compiled.discoverStep.or_filters ?? [];
    if (groups.length === 0) {
      return { sql: '', values: [] };
    }

    const values: unknown[] = [];
    const groupSql: string[] = [];
    for (const group of groups) {
      if (!Array.isArray(group) || group.length === 0) {
        continue;
      }
      const andSql: string[] = [];
      for (const clause of group) {
        const cmp = clause?.memcmp;
        if (!cmp) {
          continue;
        }
        const bytes = this.resolveMemcmpBytes(cmp.bytesFrom, params);
        const offset = Number(cmp.offset);
        if (!Number.isFinite(offset) || offset < 0) {
          throw new Error(`Invalid memcmp offset: ${String(cmp.offset)}`);
        }
        const pOffset = paramStartIndex + values.length + 1;
        const pLen = paramStartIndex + values.length + 2;
        const pHex = paramStartIndex + values.length + 3;
        andSql.push(`substring(data_bytes from $${pOffset} for $${pLen}) = decode($${pHex}, 'hex')`);
        values.push(offset + 1, bytes.length, bytes.toString('hex'));
      }
      if (andSql.length > 0) {
        groupSql.push(`(${andSql.join(' AND ')})`);
      }
    }
    if (groupSql.length === 0) {
      return { sql: '', values: [] };
    }
    return {
      sql: ` AND (${groupSql.join(' OR ')})`,
      values,
    };
  }

  private async fetchFromAccountCache(params: Record<string, unknown>, limit: number): Promise<ReadResult | null> {
    if (!this.pool) {
      return null;
    }

    const queryParams: unknown[] = [this.compiled.programId.toBase58(), this.compiled.accountSize];
    let sql = `
      SELECT pubkey, slot::text AS slot, data_bytes
      FROM ${ACCOUNT_CACHE_TABLE}
      WHERE owner_program_id = $1
        AND data_len = $2
    `;

    const discriminatorFilter = this.compiled.discriminatorFilter;
    if (discriminatorFilter && 'memcmp' in discriminatorFilter) {
      const disc = discriminatorFilter.memcmp;
      const discBytes = decodeBase58(disc.bytes);
      const pOffset = queryParams.length + 1;
      const pLen = queryParams.length + 2;
      const pHex = queryParams.length + 3;
      sql += ` AND substring(data_bytes from $${pOffset} for $${pLen}) = decode($${pHex}, 'hex')`;
      queryParams.push((disc.offset ?? 0) + 1, discBytes.length, discBytes.toString('hex'));
    }

    const filters = this.buildOrFiltersSql(params, queryParams.length);
    sql += filters.sql;
    queryParams.push(...filters.values);
    sql += '\nORDER BY slot DESC, pubkey ASC';

    const result = await this.pool.query<{ pubkey: string; slot: string; data_bytes: unknown }>(sql, queryParams);
    if (result.rows.length === 0) {
      return null;
    }

    const rows: DecodedAccountContext[] = [];
    const whereClauses = this.compiled.discoverStep.where ?? [];
    for (const record of result.rows) {
      const accountData = toBufferSafe(record.data_bytes);
      if (!accountData) {
        continue;
      }
      let decoded: Record<string, unknown>;
      try {
        decoded = this.coder.decode(this.compiled.accountType, accountData) as Record<string, unknown>;
      } catch {
        continue;
      }
      const row: DecodedAccountContext = {
        account: { pubkey: record.pubkey },
        decoded,
        param: params,
        protocol: {
          programId: this.compiled.programId.toBase58(),
        },
      };
      if (!this.matchesWhere(whereClauses, row, params)) {
        continue;
      }
      rows.push(row);
    }

    if (rows.length === 0) {
      return null;
    }

    this.sortRows(rows, this.compiled.discoverStep.sort ?? []);
    const limitedRows = rows.slice(0, limit);

    const items: Record<string, unknown>[] = [];
    let maxSlot = 0;
    const slotByPubkey = new Map<string, number>();
    for (const record of result.rows) {
      const slot = Number.parseInt(record.slot, 10);
      if (!Number.isFinite(slot) || slot <= 0) {
        continue;
      }
      slotByPubkey.set(record.pubkey, slot);
      if (slot > maxSlot) {
        maxSlot = slot;
      }
    }
    for (const row of limitedRows) {
      items.push(this.mapSelect(this.compiled.discoverStep.select, row));
      const rowSlot = slotByPubkey.get(row.account.pubkey) ?? 0;
      if (rowSlot > maxSlot) {
        maxSlot = rowSlot;
      }
    }

    if (items.length === 0) {
      return null;
    }

    return {
      items,
      source: 'db',
      slot: maxSlot,
      generatedAtMs: Date.now(),
    };
  }

  private decodeAndSelect(
    pubkey: string,
    accountData: Buffer,
    params: Record<string, unknown>,
  ): Record<string, unknown> | null {
    let decoded: Record<string, unknown>;
    try {
      decoded = this.coder.decode(this.compiled.accountType, accountData) as Record<string, unknown>;
    } catch {
      return null;
    }
    const row: DecodedAccountContext = {
      account: { pubkey },
      decoded,
      param: params,
      protocol: {
        programId: this.compiled.programId.toBase58(),
      },
    };
    if (!this.matchesWhere(this.compiled.discoverStep.where ?? [], row, params)) {
      return null;
    }
    return this.mapSelect(this.compiled.discoverStep.select, row);
  }

  private matchesWhere(
    whereClauses: DiscoverWhereClause[],
    row: DecodedAccountContext,
    params: Record<string, unknown>,
  ): boolean {
    for (const clause of whereClauses) {
      const left = readByPath(row, clause.path);
      const right = resolveReference(clause.value, { param: params });
      if (!compareValues(left, right, clause.op)) {
        return false;
      }
    }
    return true;
  }

  private sortRows(rows: DecodedAccountContext[], sortClauses: DiscoverSortClause[]): void {
    if (sortClauses.length === 0) {
      return;
    }
    rows.sort((left, right) => {
      for (const clause of sortClauses) {
        const a = readByPath(left, clause.path);
        const b = readByPath(right, clause.path);
        if (a === b) {
          continue;
        }

        const bigintA = (() => {
          try {
            return toBigIntSafe(a);
          } catch {
            return null;
          }
        })();
        const bigintB = (() => {
          try {
            return toBigIntSafe(b);
          } catch {
            return null;
          }
        })();

        let cmp = 0;
        if (bigintA !== null && bigintB !== null) {
          cmp = bigintA === bigintB ? 0 : bigintA > bigintB ? 1 : -1;
        } else {
          const sa = String(a);
          const sb = String(b);
          cmp = sa === sb ? 0 : sa > sb ? 1 : -1;
        }

        if (cmp !== 0) {
          return clause.dir === 'desc' ? -cmp : cmp;
        }
      }
      return left.account.pubkey.localeCompare(right.account.pubkey);
    });
  }

  private mapSelect(select: Record<string, unknown>, row: DecodedAccountContext): Record<string, unknown> {
    const mapped: Record<string, unknown> = {};
    for (const [field, expression] of Object.entries(select)) {
      const value = resolveReference(expression, row as unknown as Record<string, unknown>);
      if (value === undefined) {
        continue;
      }
      if (typeof value === 'bigint') {
        mapped[field] = value.toString();
      } else if (typeof value === 'number') {
        mapped[field] = Number.isInteger(value) ? String(value) : value;
      } else if (isObjectRecord(value) && 'toBase58' in value && typeof value.toBase58 === 'function') {
        mapped[field] = value.toBase58();
      } else if (value && typeof value === 'object' && 'toString' in value && !Array.isArray(value)) {
        const text = String(value);
        mapped[field] = text;
      } else {
        mapped[field] = value;
      }
    }
    return mapped;
  }

  private buildEntityId(payload: Record<string, unknown>, fallbackPubkey: string): string {
    const parts: string[] = [];
    for (const key of this.compiled.entityKeys) {
      const value = payload[key];
      if (value === undefined || value === null) {
        continue;
      }
      parts.push(String(value));
    }
    return parts.length > 0 ? parts.join('|') : fallbackPubkey;
  }

  private async upsertRecords(records: Array<{ entityId: string; payload: Record<string, unknown> }>, slot: number): Promise<number> {
    return this.upsertRecordsWithSlot(records.map((record) => ({ ...record, slot })));
  }

  private async upsertRecordsWithSlot(records: IndexedEntityRecord[]): Promise<number> {
    if (!this.pool || records.length === 0) {
      return 0;
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const sql = `
        INSERT INTO view_entities (namespace, entity_id, slot, payload, updated_at)
        VALUES ($1, $2, $3, $4::jsonb, NOW())
        ON CONFLICT (namespace, entity_id) DO UPDATE SET
          slot = EXCLUDED.slot,
          payload = EXCLUDED.payload,
          updated_at = NOW()
      `;

      for (const record of records) {
        await client.query(sql, [
          this.compiled.namespace,
          record.entityId,
          record.slot,
          JSON.stringify(record.payload),
        ]);
      }

      await client.query('COMMIT');
      return records.length;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async tableExists(tableName: string): Promise<boolean> {
    if (!this.pool) {
      return false;
    }
    const result = await this.pool.query<{ exists: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = $1
        ) AS exists
      `,
      [tableName],
    );
    return result.rows[0]?.exists === true;
  }

  // Transitional one-time migration for previous MVP schema.
  private async migrateLegacyOrcaTablesIfNeeded(): Promise<void> {
    if (!this.pool) {
      return;
    }
    const hasLegacyPools = await this.tableExists(LEGACY_ORCA_POOLS_TABLE);
    const hasLegacyHistory = await this.tableExists(LEGACY_ORCA_HISTORY_TABLE);
    if (!hasLegacyPools && !hasLegacyHistory) {
      return;
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (hasLegacyPools) {
        await client.query(
          `
            INSERT INTO view_entities (namespace, entity_id, slot, payload, updated_at)
            SELECT
              $1 AS namespace,
              p.whirlpool AS entity_id,
              p.updated_slot AS slot,
              jsonb_build_object(
                'whirlpool', p.whirlpool,
                'tokenMintA', p.token_mint_a,
                'tokenMintB', p.token_mint_b,
                'tickSpacing', p.tick_spacing::text,
                'liquidity', p.liquidity::text
              ) AS payload,
              NOW() AS updated_at
            FROM orca_pools p
            ON CONFLICT (namespace, entity_id) DO UPDATE SET
              slot = EXCLUDED.slot,
              payload = EXCLUDED.payload,
              updated_at = NOW()
          `,
          [this.compiled.namespace],
        );
      }
      await client.query(`DROP TABLE IF EXISTS ${LEGACY_ORCA_HISTORY_TABLE}`);
      await client.query(`DROP TABLE IF EXISTS ${LEGACY_ORCA_POOLS_TABLE}`);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
