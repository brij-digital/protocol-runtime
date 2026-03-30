import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import BN from 'bn.js';
import { Connection, PublicKey } from '@solana/web3.js';
import { AppPackViewReadService } from '../dist/node/view-read-service.js';
import { DirectAccountsCoder } from '../dist/index.js';

const PROGRAM_ID = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const MINT_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MINT_SOL = 'So11111111111111111111111111111111111111112';

const CODAMA = {
  kind: 'rootNode',
  standard: 'codama',
  version: '1.0.0',
  program: {
    publicKey: PROGRAM_ID,
    name: 'orca_whirlpool_test',
    version: '0.0.0',
    accounts: [
      {
        name: 'Whirlpool',
        data: {
          kind: 'structTypeNode',
          fields: [
            {
              name: 'discriminator',
              defaultValue: { encoding: 'base16', data: '3f95d10ce1806309' },
            },
            { name: 'token_mint_a', type: { kind: 'publicKeyTypeNode' } },
            { name: 'token_mint_b', type: { kind: 'publicKeyTypeNode' } },
            { name: 'tick_spacing', type: { kind: 'numberTypeNode', format: 'u16' } },
            { name: 'liquidity', type: { kind: 'numberTypeNode', format: 'u128' } },
          ],
        },
      },
    ],
    instructions: [],
    definedTypes: [],
  },
};

const RUNTIME = {
  schema: 'declarative-decoder-runtime.v1',
  protocolId: 'orca-whirlpool-mainnet',
  decoderArtifacts: {
    default: {
      kind: 'generated_idl_decoder',
      family: 'codama',
      artifact: 'default',
      codamaPath: '/idl/orca_whirlpool.codama.json',
    },
  },
  operations: {
    list_pools: {
      inputs: {
        token_in_mint: { type: 'pubkey', required: true },
        token_out_mint: { type: 'pubkey', required: true },
        min_last_seen_slot: { type: 'u64', required: false, default: '0' },
      },
      read_output: {
        type: 'array',
        source: '$derived.items',
        max_items: 20,
      },
      index_view: {
        kind: 'search',
        source_kind: 'account_changes',
        entity_type: 'whirlpool_pool',
        bootstrap: {
          kind: 'scan_accounts',
          source: 'rpc.getProgramAccounts',
          program_id: '$protocol.programId',
          account_type: 'Whirlpool',
          filters: [],
        },
        query: {
          indexed_filters: {
            any: [
              {
                all: [
                  { field: 'memcmp.8', op: '=', value: '$input.token_in_mint' },
                  { field: 'memcmp.40', op: '=', value: '$input.token_out_mint' },
                ],
              },
              {
                all: [
                  { field: 'memcmp.8', op: '=', value: '$input.token_out_mint' },
                  { field: 'memcmp.40', op: '=', value: '$input.token_in_mint' },
                ],
              },
            ],
          },
          filters: {
            all: [
              { field: 'account.lastSeenSlot', op: '>=', value: '$input.min_last_seen_slot' },
              { field: 'decoded.liquidity', op: '>', value: '0' },
            ],
          },
          decode: {
            account_type: 'Whirlpool',
          },
          sort: [{ field: 'decoded.liquidity', dir: 'desc', mode: 'indexed_then_live_refine', candidate_limit: 20 }],
          limit: 20,
          select: {
            whirlpool: '$account.pubkey',
            tokenMintA: '$decoded.token_mint_a',
            tokenMintB: '$decoded.token_mint_b',
            tickSpacing: '$decoded.tick_spacing',
            liquidity: '$decoded.liquidity',
          },
        },
      },
    },
  },
};

async function writeTempJson(prefix, value) {
  const dir = path.join(os.tmpdir(), `apppack-runtime-test-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${prefix}.json`);
  await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
  return file;
}

async function writeTempRuntimeWithCodama(prefix, runtimeValue, codamaValue) {
  const dir = path.join(os.tmpdir(), `apppack-runtime-test-${randomUUID()}`);
  const idlDir = path.join(dir, 'idl');
  await fs.mkdir(idlDir, { recursive: true });
  const runtimePath = path.join(idlDir, `${prefix}.runtime.json`);
  const codamaPath = path.join(idlDir, 'orca_whirlpool.codama.json');
  await fs.writeFile(runtimePath, JSON.stringify(runtimeValue, null, 2), 'utf8');
  await fs.writeFile(codamaPath, JSON.stringify(codamaValue, null, 2), 'utf8');
  return runtimePath;
}

test('runRead queries cached_program_accounts via runtime search view and returns sorted selected rows', async () => {
  const metaPath = await writeTempRuntimeWithCodama('runtime', RUNTIME, CODAMA);
  const coder = new DirectAccountsCoder(CODAMA);

  const dataA = await coder.encode('Whirlpool', {
    token_mint_a: new PublicKey(MINT_USDC),
    token_mint_b: new PublicKey(MINT_SOL),
    tick_spacing: 4,
    liquidity: new BN('1000000'),
  });
  const dataB = await coder.encode('Whirlpool', {
    token_mint_a: new PublicKey(MINT_SOL),
    token_mint_b: new PublicKey(MINT_USDC),
    tick_spacing: 16,
    liquidity: new BN('2000000'),
  });

  const capturedQueries = [];
  const pool = {
    async query(sql, params) {
      capturedQueries.push({ sql: String(sql), params: params ?? [] });
      if (String(sql).includes('FROM cached_program_accounts')) {
        return {
          rows: [
            {
              pubkey: 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE',
              slot: '202532154',
              data_bytes: Buffer.from(dataA),
            },
            {
              pubkey: '2sZ7dw8Nfqn8mQ9QGp2PzFpvx9TLtCrzkx5hDfSE9iJY',
              slot: '202532160',
              data_bytes: Buffer.from(dataB),
            },
          ],
          rowCount: 2,
        };
      }
      return { rows: [], rowCount: 0 };
    },
    async end() {},
  };

  const service = new AppPackViewReadService({
    connection: new Connection('http://127.0.0.1:8899', 'confirmed'),
    databaseUrl: null,
    poolOverride: pool,
    cacheTtlMs: 1000,
    protocolId: 'orca-whirlpool-mainnet',
    runtimePath: metaPath,
    programId: PROGRAM_ID,
    operationId: 'list_pools',
  });

  const result = await service.runRead({
    input: {
      token_in_mint: MINT_USDC,
      token_out_mint: MINT_SOL,
      min_last_seen_slot: '0',
    },
    limit: 20,
  });

  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].liquidity, '2000000');
  assert.equal(result.items[1].liquidity, '1000000');
  assert.equal(result.items[0].whirlpool, '2sZ7dw8Nfqn8mQ9QGp2PzFpvx9TLtCrzkx5hDfSE9iJY');

  const memcmpQuery = capturedQueries.find((entry) => entry.sql.includes('FROM cached_program_accounts'));
  assert.ok(memcmpQuery, 'expected memcmp query against cached_program_accounts');
  assert.ok(memcmpQuery.sql.includes('substring(data_bytes from'));
  assert.ok(memcmpQuery.sql.includes("decode($"));
  assert.ok(memcmpQuery.sql.includes(' OR '));

  const tokenInHex = new PublicKey(MINT_USDC).toBuffer().toString('hex');
  const tokenOutHex = new PublicKey(MINT_SOL).toBuffer().toString('hex');
  const serializedParams = JSON.stringify(memcmpQuery.params);
  assert.ok(serializedParams.includes(tokenInHex));
  assert.ok(serializedParams.includes(tokenOutHex));

  await service.close();
});

test('syncFullToDatabase bootstraps cached_program_accounts for runtime search views', async () => {
  const metaPath = await writeTempRuntimeWithCodama('runtime-bootstrap', RUNTIME, CODAMA);
  const coder = new DirectAccountsCoder(CODAMA);
  const data = await coder.encode('Whirlpool', {
    token_mint_a: new PublicKey(MINT_USDC),
    token_mint_b: new PublicKey(MINT_SOL),
    tick_spacing: 16,
    liquidity: new BN('123456'),
  });

  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params: params ?? [] });
      return { rows: [{ pubkey: 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE' }], rowCount: 1 };
    },
    async end() {},
  };

  const connection = {
    async getProgramAccounts() {
      return [
        {
          pubkey: new PublicKey('Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE'),
          account: {
            data: Buffer.from(data),
            executable: false,
            lamports: 5000,
            owner: new PublicKey(PROGRAM_ID),
            rentEpoch: BigInt(0),
          },
        },
      ];
    },
    async getSlot() {
      return 202532154;
    },
  };

  const service = new AppPackViewReadService({
    connection,
    databaseUrl: null,
    poolOverride: pool,
    cacheTtlMs: 1000,
    protocolId: 'orca-whirlpool-mainnet',
    runtimePath: metaPath,
    programId: PROGRAM_ID,
    operationId: 'list_pools',
  });

  const result = await service.syncFullToDatabase();
  assert.equal(result?.totalAccounts, 1);
  assert.equal(result?.upserted, 1);
  assert.equal(result?.slot, 202532154);

  const insertQuery = queries.find((entry) => entry.sql.includes('INSERT INTO cached_program_accounts'));
  assert.ok(insertQuery, 'expected bootstrap insert into cached_program_accounts');

  await service.close();
});
