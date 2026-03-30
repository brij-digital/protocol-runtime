import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Connection, PublicKey, type Commitment, type GetProgramAccountsFilter } from '@solana/web3.js';
import type { CodamaDocument } from '../codamaIdl.js';
import { DirectAccountsCoder } from '../directAccountsCoder.js';
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
    bytes?: string;
    bytesFrom?: string;
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

type ViewFilterCondition = {
  field: string;
  op: '>' | '>=' | '<' | '<=' | '=' | '!=' | 'in';
  value: unknown;
};

type ViewFilterGroup =
  | {
      all: Array<ViewFilterCondition | ViewFilterGroup>;
    }
  | {
      any: Array<ViewFilterCondition | ViewFilterGroup>;
    };

type SearchSortClause = {
  field: string;
  dir: SortDirection;
  mode?: 'indexed' | 'live' | 'indexed_then_live_refine';
  candidate_limit?: number;
};

type SearchHydrateSpec = {
  mode: 'none' | 'accounts';
  candidate_limit?: number;
  fields?: string[];
};

type SearchDecodeSpec = {
  account_type: string;
};

type SearchBootstrapSpec = {
  kind: 'scan_accounts';
  source: 'rpc.getProgramAccounts';
  program_id: string;
  account_type: string;
  filters?: DiscoverMemcmpClause[];
};

type SearchQuerySpec = {
  indexed_filters?: ViewFilterGroup;
  filters?: ViewFilterGroup;
  hydrate?: SearchHydrateSpec;
  decode?: SearchDecodeSpec;
  sort?: SearchSortClause[];
  limit?: number;
  select: Record<string, unknown>;
};

type SearchViewDef = {
  kind: 'search';
  source: 'rpc' | 'indexed' | 'hybrid';
  entity_type: string;
  bootstrap: SearchBootstrapSpec;
  refresh?: Record<string, unknown>;
  query: SearchQuerySpec;
  title?: string;
  description?: string;
};

type AccountViewDef = {
  kind: 'account';
  source: 'rpc' | 'indexed' | 'hybrid';
  entity_type?: string;
  target: {
    address: unknown;
    account_type: string;
  };
  refresh?: Record<string, unknown>;
  select: Record<string, unknown>;
  title?: string;
  description?: string;
};

type ViewDef = SearchViewDef | AccountViewDef;

type OperationDef = {
  inputs?: Record<string, OperationInputDef>;
  contract_view?: ViewDef;
  read_output?: ReadOutputDef;
};

type RuntimeDecoderArtifactDef = {
  codamaPath?: string;
};

type MetaPack = {
  protocolId: string;
  decoderArtifacts?: Record<string, RuntimeDecoderArtifactDef>;
  operations?: Record<string, OperationDef>;
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
  runtimePath: string;
  programId: string;
  protocolId: string;
  operationId: string;
};

type DecodedAccountContext = {
  account: {
    pubkey: string;
    slot?: number;
    firstSeenSlot?: number;
    lastSeenSlot?: number;
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
  mode: 'search' | 'account';
  defaultLimit: number;
  outputMaxItems: number;
  pairParamA: string | null;
  pairParamB: string | null;
  programId: PublicKey;
  accountType: string;
  accountSize: number;
  discriminatorFilter: GetProgramAccountsFilter | null;
  operationInputDefs: Record<string, OperationInputDef>;
  staticMemcmpFilters: DiscoverMemcmpClause[];
  indexedFilterGroups: DiscoverMemcmpClause[][];
  decodedFilterSpec: ViewFilterGroup | null;
  sortClauses: SearchSortClause[];
  select: Record<string, unknown>;
  targetAddress?: unknown;
};

const ACCOUNT_CACHE_TABLE = 'cached_program_accounts';

function sanitizeIndexName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50) || 'idx';
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseOperationPack(runtimePath: string): MetaPack {
  return JSON.parse(fs.readFileSync(runtimePath, 'utf8')) as MetaPack;
}

function parseRuntimeCodamaDocument(runtimePath: string, protocolId: string): CodamaDocument {
  const runtime = parseOperationPack(runtimePath);
  const artifactEntries = Object.entries(runtime.decoderArtifacts ?? {});
  if (artifactEntries.length === 0) {
    throw new Error(`runtime ${runtimePath} declares no decoder artifacts for ${protocolId}.`);
  }
  if (artifactEntries.length > 1) {
    throw new Error(`runtime ${runtimePath} declares multiple decoder artifacts for ${protocolId}; view-read-service requires a single codec artifact.`);
  }
  const artifact = artifactEntries[0]?.[1] as RuntimeDecoderArtifactDef | undefined;
  const codamaPath = typeof artifact?.codamaPath === 'string' ? artifact.codamaPath : null;
  if (!codamaPath || !codamaPath.startsWith('/idl/')) {
    throw new Error(`runtime ${runtimePath} is missing a valid decoderArtifacts codamaPath for ${protocolId}.`);
  }
  const codamaFilePath = path.join(path.dirname(runtimePath), codamaPath.slice('/idl/'.length));
  return JSON.parse(fs.readFileSync(codamaFilePath, 'utf8')) as CodamaDocument;
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

function resolveStaticReference(expression: unknown, context: Record<string, unknown>): unknown {
  if (Array.isArray(expression)) {
    return expression.map((item) => resolveStaticReference(item, context));
  }
  if (isObjectRecord(expression)) {
    return Object.fromEntries(
      Object.entries(expression).map(([key, value]) => [key, resolveStaticReference(value, context)]),
    );
  }
  return resolveReference(expression, context);
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

function inferPairParamsFromInputs(operationInputDefs: Record<string, OperationInputDef>): [string | null, string | null] {
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

  return [null, null];
}

function inferPairParamsFromView(
  operationInputDefs: Record<string, OperationInputDef>,
  filterSpec: ViewFilterGroup | null | undefined,
): [string | null, string | null] {
  const direct = inferPairParamsFromInputs(operationInputDefs);
  if (direct[0] && direct[1]) {
    return direct;
  }

  const params = new Set<string>();
  const visit = (node: ViewFilterGroup | ViewFilterCondition | undefined | null) => {
    if (!node || typeof node !== 'object') {
      return;
    }
    if ('field' in node) {
      if (typeof node.value === 'string' && node.value.startsWith('$input.')) {
        const inputName = node.value.slice('$input.'.length);
        if (operationInputDefs[inputName]?.type === 'pubkey') {
          params.add(inputName);
        }
      }
      return;
    }
    if ('all' in node) {
      for (const item of node.all) visit(item);
      return;
    }
    if ('any' in node) {
      for (const item of node.any) visit(item);
    }
  };
  visit(filterSpec ?? null);
  const values = Array.from(params);
  if (values.length >= 2) {
    return [values[0] ?? null, values[1] ?? null];
  }
  return [null, null];
}

function isSearchViewDef(view: ViewDef | undefined): view is SearchViewDef {
  return !!view && typeof view === 'object' && 'kind' in view && view.kind === 'search';
}

function isAccountViewDef(view: ViewDef | undefined): view is AccountViewDef {
  return !!view && typeof view === 'object' && 'kind' in view && view.kind === 'account';
}

function normalizeIndexedFilterGroups(spec: ViewFilterGroup | undefined | null): DiscoverMemcmpClause[][] {
  if (!spec) {
    return [];
  }

  const toClause = (value: ViewFilterCondition | ViewFilterGroup): DiscoverMemcmpClause | null => {
    if (!value || typeof value !== 'object' || !('field' in value)) {
      return null;
    }
    if (!value.field.startsWith('memcmp.')) {
      return null;
    }
    if (value.op !== '=') {
      return null;
    }
    const offset = Number.parseInt(value.field.slice('memcmp.'.length), 10);
    if (!Number.isFinite(offset) || offset < 0) {
      return null;
    }
    if (typeof value.value === 'string') {
      return { memcmp: { offset, bytesFrom: value.value } };
    }
    return null;
  };

  if ('all' in spec) {
    const clauses = spec.all.map(toClause).filter((item): item is DiscoverMemcmpClause => !!item);
    return clauses.length > 0 ? [clauses] : [];
  }

  const groups: DiscoverMemcmpClause[][] = [];
  for (const item of spec.any) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    if ('all' in item) {
      const clauses = item.all.map(toClause).filter((entry): entry is DiscoverMemcmpClause => !!entry);
      if (clauses.length > 0) {
        groups.push(clauses);
      }
      continue;
    }
    const clause = toClause(item);
    if (clause) {
      groups.push([clause]);
    }
  }
  return groups;
}

function compileOperation(meta: MetaPack, coder: DirectAccountsCoder, options: AppPackViewReadServiceOptions): CompiledOperation {
  const operation = meta.operations?.[options.operationId];
  if (!operation) {
    throw new Error(`Operation ${options.operationId} not found in the runtime pack.`);
  }
  const operationInputDefs = operation.inputs ?? {};

  if (isSearchViewDef(operation.contract_view)) {
    const view = operation.contract_view;
    if (view.bootstrap.kind !== 'scan_accounts' || view.bootstrap.source !== 'rpc.getProgramAccounts') {
      throw new Error(`Operation ${options.operationId} requires unsupported search bootstrap source.`);
    }
    const staticContext = {
      protocol: {
        programId: options.programId,
      },
    };
    const accountType = view.query.decode?.account_type ?? view.bootstrap.account_type;
    const [pairParamA, pairParamB] = inferPairParamsFromView(operationInputDefs, view.query.filters);
    return {
      protocolId: meta.protocolId,
      namespace: `${meta.protocolId}.${options.operationId}`,
      mode: 'search',
      defaultLimit: view.query.limit ?? operation.read_output?.max_items ?? 20,
      outputMaxItems: operation.read_output?.max_items ?? view.query.limit ?? 20,
      pairParamA,
      pairParamB,
      programId: parsePublicKey(
        String(resolveStaticReference(view.bootstrap.program_id, staticContext)),
        'bootstrap.program_id',
      ),
      accountType,
      accountSize: coder.size(accountType),
      discriminatorFilter: {
        memcmp: coder.memcmp(accountType),
      },
      operationInputDefs,
      staticMemcmpFilters: view.bootstrap.filters ?? [],
      indexedFilterGroups: normalizeIndexedFilterGroups(view.query.indexed_filters),
      decodedFilterSpec: view.query.filters ?? null,
      sortClauses: view.query.sort ?? [],
      select: view.query.select,
    };
  }

  if (isAccountViewDef(operation.contract_view)) {
    const view = operation.contract_view;
    const accountType = view.target.account_type;
    return {
      protocolId: meta.protocolId,
      namespace: `${meta.protocolId}.${options.operationId}`,
      mode: 'account',
      defaultLimit: 1,
      outputMaxItems: 1,
      pairParamA: null,
      pairParamB: null,
      programId: parsePublicKey(options.programId, 'programId'),
      accountType,
      accountSize: coder.size(accountType),
      discriminatorFilter: {
        memcmp: coder.memcmp(accountType),
      },
      operationInputDefs,
      staticMemcmpFilters: [],
      indexedFilterGroups: [],
      decodedFilterSpec: null,
      sortClauses: [],
      select: view.select,
      targetAddress: view.target.address,
    };
  }
  throw new Error(`Operation ${options.operationId} must declare a contract_view of kind search or account.`);
}

export class AppPackViewReadService {
  private readonly connection: Connection;
  private readonly cacheTtlMs: number;
  private readonly pool: Pool | null;
  private readonly coder: DirectAccountsCoder;
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

    const runtimePath = options.runtimePath;
    const meta = parseOperationPack(path.resolve(runtimePath));
    const codama = parseRuntimeCodamaDocument(path.resolve(runtimePath), options.protocolId);
    this.coder = new DirectAccountsCoder(codama);
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
      CREATE TABLE IF NOT EXISTS ${ACCOUNT_CACHE_TABLE} (
        pubkey TEXT PRIMARY KEY,
        owner_program_id TEXT NOT NULL,
        slot BIGINT NOT NULL,
        lamports BIGINT NOT NULL,
        rent_epoch TEXT NOT NULL,
        executable BOOLEAN NOT NULL,
        data_bytes BYTEA NOT NULL,
        data_hash BYTEA NOT NULL,
        data_len INTEGER NOT NULL,
        source TEXT NOT NULL,
        first_seen_slot BIGINT NOT NULL DEFAULT 0,
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_slot BIGINT NOT NULL DEFAULT 0,
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await this.pool.query(`
      ALTER TABLE ${ACCOUNT_CACHE_TABLE}
      ADD COLUMN IF NOT EXISTS first_seen_slot BIGINT NOT NULL DEFAULT 0;
    `);

    await this.pool.query(`
      ALTER TABLE ${ACCOUNT_CACHE_TABLE}
      ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    `);

    await this.pool.query(`
      ALTER TABLE ${ACCOUNT_CACHE_TABLE}
      ADD COLUMN IF NOT EXISTS last_seen_slot BIGINT NOT NULL DEFAULT 0;
    `);

    await this.pool.query(`
      ALTER TABLE ${ACCOUNT_CACHE_TABLE}
      ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_cached_program_accounts_owner_slot_pubkey
      ON ${ACCOUNT_CACHE_TABLE} (owner_program_id, slot DESC, pubkey);
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_cached_program_accounts_owner_len
      ON ${ACCOUNT_CACHE_TABLE} (owner_program_id, data_len);
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_cached_program_accounts_owner_disc8
      ON ${ACCOUNT_CACHE_TABLE} (owner_program_id, substring(data_bytes from 1 for 8));
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_cached_program_accounts_owner_first_seen_pubkey
      ON ${ACCOUNT_CACHE_TABLE} (owner_program_id, first_seen_slot DESC, pubkey);
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_cached_program_accounts_owner_last_seen_pubkey
      ON ${ACCOUNT_CACHE_TABLE} (owner_program_id, last_seen_slot DESC, pubkey);
    `);
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
    if (this.compiled.mode === 'account') {
      return this.runAccountRead(resolvedInput);
    }
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
      const dbValue = await this.fetchFromAccountCache(resolvedInput, effectiveLimit);
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
    if (this.compiled.mode !== 'search') {
      return null;
    }

    const filters: GetProgramAccountsFilter[] = [{ dataSize: this.compiled.accountSize }];
    if (this.compiled.discriminatorFilter && 'memcmp' in this.compiled.discriminatorFilter) {
      filters.push(this.compiled.discriminatorFilter);
    }
    for (const clause of this.compiled.staticMemcmpFilters) {
      const cmp = clause?.memcmp;
      if (!cmp) {
        continue;
      }
      filters.push({
        memcmp: {
          offset: cmp.offset,
          bytes: this.resolveMemcmpBytes(clause, {}).toString('base64'),
          encoding: 'base64',
        },
      });
    }

    const accounts = await this.connection.getProgramAccounts(this.compiled.programId, {
      commitment: 'confirmed',
      filters,
    });
    const slot = await this.connection.getSlot('confirmed');

    const upserted = await this.upsertAccountCacheRecords(
      accounts.map((account) => ({
        pubkey: account.pubkey.toBase58(),
        ownerProgramId: this.compiled.programId.toBase58(),
        slot,
        lamports: account.account.lamports,
        rentEpoch: account.account.rentEpoch ?? 0,
        executable: account.account.executable,
        data: Buffer.from(account.account.data),
        source: `bootstrap:${this.compiled.namespace}`,
      })),
    );
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
    if (this.compiled.mode !== 'search') {
      return {
        inputAccounts: addresses.length,
        fetchedAccounts: 0,
        decodedAccounts: 0,
        upserted: 0,
        slot,
      };
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

    let fetchedAccounts = 0;
    const cacheRecords: Array<{
      pubkey: string;
      ownerProgramId: string;
      slot: number;
      lamports: bigint | number;
      rentEpoch: bigint | number;
      executable: boolean;
      data: Buffer;
      source: string;
    }> = [];

    for (const group of chunk(list, 100)) {
      const pubkeys = group.map((value) => new PublicKey(value));
      const infos = await this.connection.getMultipleAccountsInfo(pubkeys, 'confirmed');
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
        cacheRecords.push({
          pubkey,
          ownerProgramId: info.owner.toBase58(),
          slot,
          lamports: info.lamports,
          rentEpoch: info.rentEpoch ?? 0,
          executable: info.executable,
          data: Buffer.from(info.data),
          source: `refresh:${this.compiled.namespace}`,
        });
      }
    }

    const upserted = await this.upsertAccountCacheRecords(cacheRecords);
    if (upserted > 0) {
      this.clearCache();
    }

    return {
      inputAccounts: list.length,
      fetchedAccounts,
      decodedAccounts: cacheRecords.length,
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

  private async runAccountRead(params: Record<string, unknown>): Promise<ReadResult> {
    const targetAddress = resolveReference(this.compiled.targetAddress, { input: params, param: params });
    if (typeof targetAddress !== 'string' || targetAddress.length === 0) {
      throw new Error(`Target address could not be resolved for ${this.compiled.namespace}.`);
    }
    const pubkey = parsePublicKey(targetAddress, 'target.address').toBase58();

    if (this.pool) {
      const dbResult = await this.fetchAccountByPubkey(pubkey, params);
      if (dbResult) {
        return dbResult;
      }
    }

    const info = await this.connection.getAccountInfo(new PublicKey(pubkey), 'confirmed');
    if (!info) {
      return {
        items: [],
        source: 'db',
        slot: 0,
        generatedAtMs: Date.now(),
      };
    }
    const selected = this.decodeAndSelect(pubkey, Buffer.from(info.data), params);
    return {
      items: selected ? [selected] : [],
      source: 'db',
      slot: 0,
      generatedAtMs: Date.now(),
    };
  }

  private resolveMemcmpBytes(clause: DiscoverMemcmpClause, params: Record<string, unknown>): Buffer {
    const bytesFrom = clause.memcmp.bytesFrom;
    if (typeof clause.memcmp.bytes === 'string' && clause.memcmp.bytes.length > 0) {
      const literal = clause.memcmp.bytes;
      if (/^[0-9a-fA-F]+$/.test(literal) && literal.length % 2 === 0) {
        return Buffer.from(literal, 'hex');
      }
      if (/^[1-9A-HJ-NP-Za-km-z]+$/.test(literal)) {
        return decodeBase58(literal);
      }
      return Buffer.from(literal, 'utf8');
    }
    if (typeof bytesFrom !== 'string' || bytesFrom.length === 0) {
      throw new Error('memcmp clause must include bytes or bytesFrom');
    }
    const resolved = resolveReference(bytesFrom, { param: params, input: params });
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

  private buildMemcmpAndSql(
    clauses: DiscoverMemcmpClause[],
    params: Record<string, unknown>,
    paramStartIndex: number,
  ): { sql: string; values: unknown[] } {
    if (clauses.length === 0) {
      return { sql: '', values: [] };
    }

    const values: unknown[] = [];
    const andSql: string[] = [];
    for (const clause of clauses) {
      const cmp = clause?.memcmp;
      if (!cmp) {
        continue;
      }
      const bytes = this.resolveMemcmpBytes(clause, params);
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
    if (andSql.length === 0) {
      return { sql: '', values: [] };
    }
    return {
      sql: ` AND ${andSql.join(' AND ')}`,
      values,
    };
  }

  private buildMemcmpGroupSql(
    groups: DiscoverMemcmpClause[][],
    params: Record<string, unknown>,
    paramStartIndex: number,
  ): { sql: string; values: unknown[] } {
    if (groups.length === 0) {
      return { sql: '', values: [] };
    }

    const values: unknown[] = [];
    const groupSql: string[] = [];
    for (const group of groups) {
      if (!Array.isArray(group) || group.length === 0) {
        continue;
      }
      const built = this.buildMemcmpAndSql(group, params, paramStartIndex + values.length);
      if (!built.sql) {
        continue;
      }
      values.push(...built.values);
      groupSql.push(`(${built.sql.trim().replace(/^AND\s+/u, '')})`);
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
      SELECT
        pubkey,
        slot::text AS slot,
        first_seen_slot::text AS first_seen_slot,
        last_seen_slot::text AS last_seen_slot,
        data_bytes
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

    const staticFilters = this.buildMemcmpAndSql(this.compiled.staticMemcmpFilters, params, queryParams.length);
    sql += staticFilters.sql;
    queryParams.push(...staticFilters.values);

    const indexedFilters = this.buildMemcmpGroupSql(this.compiled.indexedFilterGroups, params, queryParams.length);
    sql += indexedFilters.sql;
    queryParams.push(...indexedFilters.values);
    sql += '\nORDER BY slot DESC, pubkey ASC';

    const result = await this.pool.query<{
      pubkey: string;
      slot: string;
      first_seen_slot: string;
      last_seen_slot: string;
      data_bytes: unknown;
    }>(sql, queryParams);
    if (result.rows.length === 0) {
      return null;
    }

    const rows: DecodedAccountContext[] = [];
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
        account: {
          pubkey: record.pubkey,
          slot: Number.parseInt(record.slot, 10) || 0,
          firstSeenSlot: Number.parseInt(record.first_seen_slot, 10) || 0,
          lastSeenSlot: Number.parseInt(record.last_seen_slot, 10) || 0,
        },
        decoded,
        param: params,
        protocol: {
          programId: this.compiled.programId.toBase58(),
        },
      };
      if (!this.matchesFilterSpec(this.compiled.decodedFilterSpec, row, params)) {
        continue;
      }
      rows.push(row);
    }

    if (rows.length === 0) {
      return null;
    }

    this.sortRows(rows, this.compiled.sortClauses);
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
      items.push(this.mapSelect(this.compiled.select, row));
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

  private async fetchAccountByPubkey(pubkey: string, params: Record<string, unknown>): Promise<ReadResult | null> {
    if (!this.pool) {
      return null;
    }
    const result = await this.pool.query<{
      pubkey: string;
      slot: string;
      first_seen_slot: string;
      last_seen_slot: string;
      data_bytes: unknown;
    }>(
      `
        SELECT
          pubkey,
          slot::text AS slot,
          first_seen_slot::text AS first_seen_slot,
          last_seen_slot::text AS last_seen_slot,
          data_bytes
        FROM ${ACCOUNT_CACHE_TABLE}
        WHERE owner_program_id = $1
          AND pubkey = $2
          AND data_len = $3
        LIMIT 1
      `,
      [this.compiled.programId.toBase58(), pubkey, this.compiled.accountSize],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    const accountData = toBufferSafe(row.data_bytes);
    if (!accountData) {
      return null;
    }
    const selected = this.decodeAndSelect(pubkey, accountData, params, {
      slot: Number.parseInt(row.slot, 10) || 0,
      firstSeenSlot: Number.parseInt(row.first_seen_slot, 10) || 0,
      lastSeenSlot: Number.parseInt(row.last_seen_slot, 10) || 0,
    });
    if (!selected) {
      return null;
    }
    return {
      items: [selected],
      source: 'db',
      slot: Number.parseInt(row.slot, 10) || 0,
      generatedAtMs: Date.now(),
    };
  }

  private decodeAndSelect(
    pubkey: string,
    accountData: Buffer,
    params: Record<string, unknown>,
    accountMeta?: { slot?: number; firstSeenSlot?: number; lastSeenSlot?: number },
  ): Record<string, unknown> | null {
    let decoded: Record<string, unknown>;
    try {
      decoded = this.coder.decode(this.compiled.accountType, accountData) as Record<string, unknown>;
    } catch {
      return null;
    }
    const row: DecodedAccountContext = {
      account: {
        pubkey,
        slot: accountMeta?.slot ?? 0,
        firstSeenSlot: accountMeta?.firstSeenSlot ?? 0,
        lastSeenSlot: accountMeta?.lastSeenSlot ?? 0,
      },
      decoded,
      param: params,
      protocol: {
        programId: this.compiled.programId.toBase58(),
      },
    };
    if (!this.matchesFilterSpec(this.compiled.decodedFilterSpec, row, params)) {
      return null;
    }
    return this.mapSelect(this.compiled.select, row);
  }

  private matchesFilterSpec(spec: ViewFilterGroup | null, row: DecodedAccountContext, params: Record<string, unknown>): boolean {
    if (!spec) {
      return true;
    }
    const matchesNode = (node: ViewFilterGroup | ViewFilterCondition): boolean => {
      if ('field' in node) {
        const left = readByPath(row, node.field);
        const right = resolveReference(node.value, { param: params, input: params });
        if (node.op === 'in' && Array.isArray(right)) {
          return right.some((candidate) => compareValues(left, candidate, '='));
        }
        return compareValues(left, right, node.op === 'in' ? '=' : node.op);
      }
      if ('all' in node) {
        return node.all.every((item) => matchesNode(item));
      }
      return node.any.some((item) => matchesNode(item));
    };
    return matchesNode(spec);
  }

  private sortRows(rows: DecodedAccountContext[], sortClauses: Array<{ field: string; dir: SortDirection }>): void {
    if (sortClauses.length === 0) {
      return;
    }
    rows.sort((left, right) => {
      for (const clause of sortClauses) {
        const a = readByPath(left, clause.field);
        const b = readByPath(right, clause.field);
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

  private async upsertAccountCacheRecords(
    records: Array<{
      pubkey: string;
      ownerProgramId: string;
      slot: number;
      lamports: bigint | number;
      rentEpoch: bigint | number;
      executable: boolean;
      data: Buffer;
      source: string;
    }>,
  ): Promise<number> {
    if (!this.pool || records.length === 0) {
      return 0;
    }

    let upserted = 0;
    for (const record of records) {
      const hash = createHash('sha256').update(record.data).digest();
      const result = await this.pool.query(
        `
          INSERT INTO ${ACCOUNT_CACHE_TABLE}
            (
              pubkey,
              owner_program_id,
              slot,
              lamports,
              rent_epoch,
              executable,
              data_bytes,
              data_hash,
              data_len,
              source,
              first_seen_slot,
              first_seen_at,
              last_seen_slot,
              last_seen_at,
              updated_at
            )
          VALUES
            ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), $11, NOW(), NOW())
          ON CONFLICT (pubkey) DO UPDATE
            SET owner_program_id = EXCLUDED.owner_program_id,
                slot = EXCLUDED.slot,
                lamports = EXCLUDED.lamports,
                rent_epoch = EXCLUDED.rent_epoch,
                executable = EXCLUDED.executable,
                data_bytes = EXCLUDED.data_bytes,
                data_hash = EXCLUDED.data_hash,
                data_len = EXCLUDED.data_len,
                source = EXCLUDED.source,
                last_seen_slot = GREATEST(${ACCOUNT_CACHE_TABLE}.last_seen_slot, EXCLUDED.last_seen_slot),
                last_seen_at = NOW(),
                updated_at = NOW()
          WHERE ${ACCOUNT_CACHE_TABLE}.slot < EXCLUDED.slot
             OR ${ACCOUNT_CACHE_TABLE}.data_hash <> EXCLUDED.data_hash
             OR ${ACCOUNT_CACHE_TABLE}.last_seen_slot < EXCLUDED.last_seen_slot
          RETURNING pubkey
        `,
        [
          record.pubkey,
          record.ownerProgramId,
          record.slot,
          String(record.lamports),
          String(record.rentEpoch),
          record.executable,
          record.data,
          hash,
          record.data.length,
          record.source,
          record.slot,
        ],
      );
      upserted += result.rowCount ?? 0;
    }
    return upserted;
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
}
