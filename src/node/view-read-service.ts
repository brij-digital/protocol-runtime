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
  allowRpcFallback?: boolean;
};

type ReadResult = {
  items: Record<string, unknown>[];
  source: 'cache' | 'db' | 'rpc';
  slot: number;
  generatedAtMs: number;
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
  programId: PublicKey;
  accountType: string;
  accountSize: number;
  discriminatorFilter: GetProgramAccountsFilter | null;
  paramMap: Record<string, string>;
  operationInputDefs: Record<string, OperationInputDef>;
};

type RpcV2AccountEntry = {
  pubkey: string;
  account: {
    data: string | [string, string];
  };
};

type RpcV2GetProgramAccountsResult = {
  accounts: RpcV2AccountEntry[];
  paginationKey?: string | null;
  count?: number;
};

const LEGACY_ORCA_POOLS_TABLE = 'orca_pools';
const LEGACY_ORCA_HISTORY_TABLE = 'orca_pool_history';

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

function pickFieldBySelectValue(select: Record<string, unknown>, valueRef: string): string | null {
  for (const [fieldName, expression] of Object.entries(select)) {
    if (expression === valueRef) {
      return fieldName;
    }
  }
  return null;
}

function inferPairParams(step: DiscoverQueryStep): [string | null, string | null] {
  const params = new Set<string>();
  const groups = step.or_filters ?? [];
  for (const group of groups) {
    for (const condition of group) {
      const ref = condition.memcmp.bytesFrom;
      if (!ref.startsWith('$param.')) {
        continue;
      }
      params.add(ref.slice('$param.'.length));
    }
  }
  const values = Array.from(params);
  if (values.length >= 2) {
    return [values[0] ?? null, values[1] ?? null];
  }
  return [null, null];
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
  const tokenMintFieldA = pickFieldBySelectValue(discoverStep.select, '$decoded.token_mint_a');
  const tokenMintFieldB = pickFieldBySelectValue(discoverStep.select, '$decoded.token_mint_b');
  const liquidityField = pickFieldBySelectValue(discoverStep.select, '$decoded.liquidity');
  const [pairParamA, pairParamB] = inferPairParams(discoverStep);

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
    operationInputDefs: operation.inputs ?? {},
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
    this.pool = options.databaseUrl
      ? new Pool({
          connectionString: options.databaseUrl,
          max: 4,
        })
      : null;

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

  async runRead(options: ListPoolsOptions): Promise<ReadResult> {
    const resolvedInput = this.resolveOperationInput(options.input);
    const effectiveLimit = Math.max(1, Math.min(options.limit, this.compiled.outputMaxItems));
    const allowRpcFallback = options.allowRpcFallback ?? true;
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
      const dbValue = await this.fetchFromDatabase(resolvedInput, effectiveLimit);
      if (dbValue) {
        this.cache.set(cacheKey, {
          expiresAtMs: dbValue.generatedAtMs + this.cacheTtlMs,
          value: dbValue,
        });
        return dbValue;
      }
    }

    if (!allowRpcFallback) {
      if (!this.pool) {
        throw new Error(
          `No indexed data available for ${this.compiled.namespace}: DATABASE_URL is not configured and RPC fallback is disabled.`,
        );
      }
      throw new Error(`No indexed data available for ${this.compiled.namespace} and RPC fallback is disabled.`);
    }

    const rpcValue = await this.fetchFromRpc(resolvedInput, effectiveLimit);
    this.cache.set(cacheKey, {
      expiresAtMs: rpcValue.generatedAtMs + this.cacheTtlMs,
      value: rpcValue,
    });
    return rpcValue;
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

  private resolveParamsFromInput(input: Record<string, unknown>): Record<string, unknown> {
    const params: Record<string, unknown> = {};
    const context = { input };
    for (const [paramName, expression] of Object.entries(this.compiled.paramMap)) {
      params[paramName] = resolveReference(expression, context);
    }
    // If template mapping omits some params, fallback from input by same name.
    for (const inputName of Object.keys(input)) {
      if (!(inputName in params)) {
        params[inputName] = input[inputName];
      }
    }
    return params;
  }

  private async fetchFromDatabase(input: Record<string, unknown>, limit: number): Promise<ReadResult | null> {
    if (!this.pool) {
      return null;
    }
    if (!this.compiled.tokenMintFieldA || !this.compiled.tokenMintFieldB || !this.compiled.liquidityField) {
      return null;
    }
    if (!this.compiled.pairParamA || !this.compiled.pairParamB) {
      return null;
    }
    const tokenIn = input[this.compiled.pairParamA];
    const tokenOut = input[this.compiled.pairParamB];
    if (typeof tokenIn !== 'string' || typeof tokenOut !== 'string') {
      return null;
    }

    const query = `
      SELECT entity_id, slot::text AS slot, payload
      FROM view_entities
      WHERE namespace = $1
        AND (
          ((payload->>$2) = $3 AND (payload->>$4) = $5)
          OR
          ((payload->>$2) = $5 AND (payload->>$4) = $3)
        )
      ORDER BY COALESCE(NULLIF(payload->>$6, '')::numeric, 0) DESC, entity_id ASC
      LIMIT $7
    `;
    const result = await this.pool.query<{ entity_id: string; slot: string; payload: unknown }>(query, [
      this.compiled.namespace,
      this.compiled.tokenMintFieldA,
      tokenIn,
      this.compiled.tokenMintFieldB,
      tokenOut,
      this.compiled.liquidityField,
      limit,
    ]);
    if (result.rows.length === 0) {
      return null;
    }

    const items: Record<string, unknown>[] = [];
    let maxSlot = 0;
    for (const row of result.rows) {
      if (!isObjectRecord(row.payload)) {
        continue;
      }
      items.push(row.payload);
      const slot = Number.parseInt(row.slot, 10);
      if (Number.isFinite(slot) && slot > maxSlot) {
        maxSlot = slot;
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

  private async fetchFromRpc(input: Record<string, unknown>, limit: number): Promise<ReadResult> {
    const params = this.resolveParamsFromInput(input);
    const step = this.compiled.discoverStep;
    const filtersByGroup = this.buildOrFilters(step, params);
    const accountsByPubkey = new Map<string, Buffer>();

    for (const groupFilters of filtersByGroup) {
      const filters: GetProgramAccountsFilter[] = [
        { dataSize: this.compiled.accountSize },
        ...(this.compiled.discriminatorFilter ? [this.compiled.discriminatorFilter] : []),
        ...groupFilters,
      ];
      const accounts = await this.getProgramAccountsViaV2(filters, step.commitment ?? 'confirmed');
      for (const account of accounts) {
        accountsByPubkey.set(account.pubkey, account.data);
      }
    }

    const decodedRows: DecodedAccountContext[] = [];
    for (const [pubkey, data] of accountsByPubkey.entries()) {
      let decoded: Record<string, unknown>;
      try {
        decoded = this.coder.decode(this.compiled.accountType, data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const row: DecodedAccountContext = {
        account: { pubkey },
        decoded,
        param: params,
        protocol: {
          programId: this.compiled.programId.toBase58(),
        },
      };
      if (!this.matchesWhere(step.where ?? [], row)) {
        continue;
      }
      decodedRows.push(row);
    }

    this.sortRows(decodedRows, step.sort ?? []);

    const mapped = decodedRows.map((row) => this.mapSelect(step.select, row));
    const appliedLimit = Math.max(1, Math.min(limit, step.limit ?? limit, this.compiled.outputMaxItems));
    const items = mapped.slice(0, appliedLimit);
    const slot = await this.connection.getSlot(step.commitment ?? 'confirmed');

    return {
      items,
      source: 'rpc',
      slot,
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
    if (!this.matchesWhere(this.compiled.discoverStep.where ?? [], row)) {
      return null;
    }
    return this.mapSelect(this.compiled.discoverStep.select, row);
  }

  private buildOrFilters(step: DiscoverQueryStep, params: Record<string, unknown>): GetProgramAccountsFilter[][] {
    const groups = step.or_filters ?? [];
    if (groups.length === 0) {
      return [[]];
    }

    const out: GetProgramAccountsFilter[][] = [];
    for (const group of groups) {
      const filters: GetProgramAccountsFilter[] = [];
      for (const condition of group) {
        const offset = condition.memcmp.offset;
        const bytes = resolveReference(condition.memcmp.bytesFrom, { param: params });
        if (typeof bytes !== 'string') {
          throw new Error(`Invalid memcmp bytesFrom resolution for offset ${offset}.`);
        }
        filters.push({
          memcmp: {
            offset,
            bytes: parsePublicKey(bytes, 'memcmp.bytesFrom').toBase58(),
          },
        });
      }
      out.push(filters);
    }
    return out;
  }

  private async rpcRequest<T>(method: string, params: unknown[]): Promise<T> {
    const response = await fetch(this.connection.rpcEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `${method}-${Date.now()}`,
        method,
        params,
      }),
    });

    let payload: { result?: T; error?: { code?: number; message?: string; data?: unknown } };
    try {
      payload = (await response.json()) as { result?: T; error?: { code?: number; message?: string; data?: unknown } };
    } catch {
      throw new Error(`${method} failed: RPC response is not valid JSON.`);
    }

    if (!response.ok) {
      const details = payload?.error?.message ?? response.statusText;
      throw new Error(`${method} failed (${response.status}): ${details}`);
    }
    if (payload.error) {
      const code = payload.error.code ?? 'unknown';
      const message = payload.error.message ?? 'Unknown RPC error.';
      throw new Error(`${method} RPC error (${code}): ${message}`);
    }
    if (payload.result === undefined) {
      throw new Error(`${method} failed: missing result in RPC response.`);
    }
    return payload.result;
  }

  private decodeBase64AccountData(value: string | [string, string]): Buffer {
    if (Array.isArray(value)) {
      const [encoded, encoding] = value;
      if (encoding !== 'base64') {
        throw new Error(`Unsupported account data encoding from getProgramAccountsV2: ${encoding}`);
      }
      return Buffer.from(encoded, 'base64');
    }
    return Buffer.from(value, 'base64');
  }

  private async getProgramAccountsViaV2(
    filters: GetProgramAccountsFilter[],
    commitment: Commitment,
  ): Promise<Array<{ pubkey: string; data: Buffer }>> {
    const pageSize = 1_000;
    const maxPages = 10_000;
    let pages = 0;
    let paginationKey: string | null = null;
    const seenPaginationKeys = new Set<string>();
    const out = new Map<string, Buffer>();

    // No fallback path by design: this service expects getProgramAccountsV2 support.
    for (;;) {
      pages += 1;
      if (pages > maxPages) {
        throw new Error(`getProgramAccountsV2 exceeded max pages (${maxPages}) for ${this.compiled.namespace}.`);
      }
      const config: Record<string, unknown> = {
        commitment,
        encoding: 'base64',
        withContext: false,
        filters,
        limit: pageSize,
      };
      if (paginationKey) {
        config.paginationKey = paginationKey;
      }

      const result = await this.rpcRequest<RpcV2GetProgramAccountsResult>('getProgramAccountsV2', [
        this.compiled.programId.toBase58(),
        config,
      ]);
      const pageAccounts = Array.isArray(result.accounts) ? result.accounts : [];
      if (pageAccounts.length === 0) {
        break;
      }
      for (const account of pageAccounts) {
        if (!account || typeof account.pubkey !== 'string' || !account.account || account.account.data === undefined) {
          continue;
        }
        try {
          out.set(account.pubkey, this.decodeBase64AccountData(account.account.data));
        } catch {
          continue;
        }
      }

      const nextKey = typeof result.paginationKey === 'string' && result.paginationKey.length > 0 ? result.paginationKey : null;
      if (!nextKey) {
        break;
      }
      if (seenPaginationKeys.has(nextKey)) {
        break;
      }
      seenPaginationKeys.add(nextKey);
      paginationKey = nextKey;
    }

    return Array.from(out.entries()).map(([pubkey, data]) => ({ pubkey, data }));
  }

  private matchesWhere(whereClauses: DiscoverWhereClause[], row: DecodedAccountContext): boolean {
    for (const clause of whereClauses) {
      const left = readByPath(row, clause.path);
      if (!compareValues(left, clause.value, clause.op)) {
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
        await client.query(sql, [this.compiled.namespace, record.entityId, slot, JSON.stringify(record.payload)]);
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
