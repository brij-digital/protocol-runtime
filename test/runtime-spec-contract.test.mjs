import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PROGRAM_ID = '11111111111111111111111111111111';
const TREASURY = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const VAULT = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const WALLET = '4x4K45kncfjpoPgWBaFU4x1iDMsfGBfPwrFNJzXUgGcR';
const SOURCE_MINT = 'So11111111111111111111111111111111111111112';
const TARGET = '9wFFmGphzaTWRmRmNE7pHBU8RLK2U71ha5vX4yxTXdwc';

function writeFixture(options = {}) {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apppack-runtime-spec-contract-'));
  const registryPath = path.join(fixtureDir, 'registry.json');
  const idlDir = path.join(fixtureDir, 'idl');
  const codamaPath = path.join(idlDir, 'spec.codama.json');
  const runtimePath = path.join(idlDir, 'spec.runtime.json');
  fs.mkdirSync(idlDir, { recursive: true });

  const codama =
    options.codama ??
    {
      program: {
        name: 'SpecRuntime',
        pdas: [],
        instructions: [
          {
            name: 'loadQuote',
            arguments: [
              {
                name: 'discriminator',
                type: { kind: 'bytesTypeNode' },
                defaultValue: {
                  encoding: 'base16',
                  data: '0102030405060708',
                },
              },
              {
                name: 'amount',
                type: {
                  kind: 'numberTypeNode',
                  format: 'u64',
                },
              },
            ],
            accounts: [
              {
                kind: 'instructionAccountNode',
                name: 'authority',
                isWritable: false,
                isSigner: true,
                isOptional: false,
              },
              {
                kind: 'instructionAccountNode',
                name: 'sourceMint',
                isWritable: false,
                isSigner: false,
                isOptional: false,
              },
              {
                kind: 'instructionAccountNode',
                name: 'destination',
                isWritable: true,
                isSigner: false,
                isOptional: false,
              },
              {
                kind: 'instructionAccountNode',
                name: 'treasury',
                isWritable: false,
                isSigner: false,
                isOptional: false,
                defaultValue: {
                  kind: 'publicKeyValueNode',
                  publicKey: TREASURY,
                },
              },
            ],
          },
          {
            name: 'executeSwap',
            arguments: [
              {
                name: 'discriminator',
                type: { kind: 'bytesTypeNode' },
                defaultValue: {
                  encoding: 'base16',
                  data: '090a0b0c0d0e0f10',
                },
              },
              {
                name: 'amount',
                type: {
                  kind: 'numberTypeNode',
                  format: 'u64',
                },
              },
            ],
            accounts: [
              {
                kind: 'instructionAccountNode',
                name: 'authority',
                isWritable: false,
                isSigner: true,
                isOptional: false,
              },
              {
                kind: 'instructionAccountNode',
                name: 'target',
                isWritable: true,
                isSigner: false,
                isOptional: false,
              },
              {
                kind: 'instructionAccountNode',
                name: 'vault',
                isWritable: false,
                isSigner: false,
                isOptional: false,
                defaultValue: {
                  kind: 'publicKeyValueNode',
                  publicKey: VAULT,
                },
              },
            ],
          },
        ],
        accounts: [],
        definedTypes: [],
      },
    };

  const runtime =
    options.runtime ??
    {
      schema: 'solana-agent-runtime.v1',
      protocol_id: 'spec-runtime-mainnet',
      program_id: PROGRAM_ID,
      codama_path: '/idl/spec.codama.json',
      views: {
        quote_view: {
          load_instruction: 'load_quote',
          load_instruction_bindings: {
            args: {
              amount: '$input.amount',
            },
            accounts: {
              source_mint: '$input.source_mint',
              destination: '$input.destination',
            },
          },
          inputs: {
            amount: 'u64',
            source_mint: 'token_mint',
            destination: 'pubkey',
          },
          output: {
            type: 'object',
            source: '$instruction_accounts',
            object_schema: {
              fields: {
                authority: { type: 'pubkey' },
                source_mint: { type: 'pubkey' },
                destination: { type: 'pubkey' },
                treasury: { type: 'pubkey' },
              },
            },
          },
        },
      },
      writes: {
        execute_swap: {
          instruction: 'execute_swap',
          args: {
            amount: '$input.amount',
          },
          accounts: {
            target: '$input.target',
          },
          remaining_accounts: [
            {
              pubkey: '$input.target',
              isSigner: false,
              isWritable: true,
            },
          ],
          pre: [
            {
              kind: 'system_transfer',
              from: '$instruction_accounts.authority',
              to: '$instruction_accounts.target',
              lamports: '$input.amount',
            },
          ],
          post: [
            {
              kind: 'spl_token_close_account',
              account: '$instruction_accounts.target',
              destination: '$instruction_accounts.authority',
              owner: '$instruction_accounts.authority',
            },
          ],
        },
      },
      transforms: {},
    };

  const registry =
    options.registry ??
    {
      version: 'test',
      protocols: [
        {
          id: 'spec-runtime-mainnet',
          name: 'Spec Runtime',
          network: 'mainnet',
          programId: PROGRAM_ID,
          codamaIdlPath: '/idl/spec.codama.json',
          agentRuntimePath: '/idl/spec.runtime.json',
          transport: 'solana-rpc',
          supportedCommands: [],
          status: 'active',
        },
      ],
    };

  fs.writeFileSync(registryPath, JSON.stringify(registry));
  fs.writeFileSync(codamaPath, JSON.stringify(codama));
  fs.writeFileSync(runtimePath, JSON.stringify(runtime));

  return { registryPath };
}

function runWithRegistry(registryPath, body) {
  const script = `
    process.env.APPPACK_RUNTIME_REGISTRY_PATH = ${JSON.stringify(registryPath)};
    ${body}
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `child process failed with code ${result.status}`);
  }

  return JSON.parse(result.stdout);
}

test('loadRuntimePack, listRuntimeOperations, and explainRuntimeOperation expose the runtime spec contract', () => {
  const { registryPath } = writeFixture();
  const output = runWithRegistry(
    registryPath,
    `
      const runtime = await import(${JSON.stringify(path.resolve('dist/runtimeOperationRuntime.js'))});
      const pack = await runtime.loadRuntimePack('spec-runtime-mainnet');
      const listed = await runtime.listRuntimeOperations({ protocolId: 'spec-runtime-mainnet' });
      const explained = await runtime.explainRuntimeOperation({
        protocolId: 'spec-runtime-mainnet',
        operationId: 'execute_swap',
      });
      console.log(JSON.stringify({ pack, listed, explained }));
    `,
  );

  assert.equal(output.pack.protocolId, 'spec-runtime-mainnet');
  assert.deepEqual(output.pack.writes.execute_swap.inputs, {
    amount: { type: 'u64' },
    target: { type: 'pubkey' },
  });

  assert.deepEqual(
    output.listed.operations.map((entry) => [entry.operationId, entry.operationKind]),
    [
      ['execute_swap', 'write'],
      ['quote_view', 'view'],
    ],
  );
  assert.deepEqual(output.listed.operations[0].inputs, {
    amount: { type: 'u64' },
    target: { type: 'pubkey' },
  });
  assert.equal(output.listed.operations[1].loadInstruction, 'load_quote');

  assert.equal(output.explained.instruction, 'execute_swap');
  assert.deepEqual(output.explained.args, { amount: '$input.amount' });
  assert.deepEqual(output.explained.accounts, { target: '$input.target' });
  assert.deepEqual(output.explained.remainingAccounts, [
    {
      pubkey: '$input.target',
      isSigner: false,
      isWritable: true,
    },
  ]);
  assert.deepEqual(output.explained.pre, [
    {
      kind: 'system_transfer',
      from: '$instruction_accounts.authority',
      to: '$instruction_accounts.target',
      lamports: '$input.amount',
    },
  ]);
  assert.deepEqual(output.explained.post, [
    {
      kind: 'spl_token_close_account',
      account: '$instruction_accounts.target',
      destination: '$instruction_accounts.authority',
      owner: '$instruction_accounts.authority',
    },
  ]);
});

test('runRuntimeView resolves load_instruction bindings through Codama account resolution', () => {
  const { registryPath } = writeFixture();
  const output = runWithRegistry(
    registryPath,
    `
      const { PublicKey } = await import('@solana/web3.js');
      const { runRuntimeView } = await import(${JSON.stringify(path.resolve('dist/runtimeOperationRuntime.js'))});
      const result = await runRuntimeView({
        protocolId: 'spec-runtime-mainnet',
        operationId: 'quote_view',
        input: {
          amount: '7',
          source_mint: ${JSON.stringify(SOURCE_MINT)},
          destination: ${JSON.stringify(TARGET)},
        },
        connection: {},
        walletPublicKey: new PublicKey(${JSON.stringify(WALLET)}),
      });
      console.log(JSON.stringify(result));
    `,
  );

  assert.deepEqual(output.output, {
    authority: WALLET,
    source_mint: SOURCE_MINT,
    destination: TARGET,
    treasury: TREASURY,
  });
  assert.deepEqual(output.preInstructions, []);
  assert.deepEqual(output.postInstructions, []);
  assert.equal(output.outputSpec.source, '$instruction_accounts');
});

test('prepareRuntimeInstruction resolves remaining_accounts and pre/post envelopes', () => {
  const { registryPath } = writeFixture();
  const output = runWithRegistry(
    registryPath,
    `
      const { PublicKey } = await import('@solana/web3.js');
      const { prepareRuntimeInstruction } = await import(${JSON.stringify(path.resolve('dist/index.js'))});
      const prepared = await prepareRuntimeInstruction({
        protocolId: 'spec-runtime-mainnet',
        operationId: 'execute_swap',
        input: {
          amount: 7,
          target: ${JSON.stringify(TARGET)},
        },
        connection: {},
        walletPublicKey: new PublicKey(${JSON.stringify(WALLET)}),
      });
      console.log(JSON.stringify(prepared));
    `,
  );

  assert.equal(output.instructionName, 'execute_swap');
  assert.deepEqual(output.args, { amount: '7' });
  assert.deepEqual(output.accounts, {
    authority: WALLET,
    target: TARGET,
    vault: VAULT,
  });
  assert.deepEqual(output.remainingAccounts, [
    {
      pubkey: TARGET,
      isSigner: false,
      isWritable: true,
    },
  ]);
  assert.deepEqual(output.preInstructions, [
    {
      kind: 'system_transfer',
      from: WALLET,
      to: TARGET,
      lamports: '7',
    },
  ]);
  assert.deepEqual(output.postInstructions, [
    {
      kind: 'spl_token_close_account',
      account: TARGET,
      destination: WALLET,
      owner: WALLET,
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    },
  ]);
});

test('loadRuntimePack rejects write inputs that are not sourced from Codama', () => {
  const { registryPath } = writeFixture({
    runtime: {
      schema: 'solana-agent-runtime.v1',
      protocol_id: 'spec-runtime-mainnet',
      program_id: PROGRAM_ID,
      codama_path: '/idl/spec.codama.json',
      views: {},
      writes: {
        invalid_write: {
          instruction: 'execute_swap',
          args: {
            amount: '$input.amount',
          },
          accounts: {
            target: '$input.target',
          },
          pre: [
            {
              kind: 'system_transfer',
              from: '$input.authority',
              to: '$input.target',
              lamports: '$input.non_codama_field',
            },
          ],
        },
      },
      transforms: {},
    },
  });

  const script = `
    process.env.APPPACK_RUNTIME_REGISTRY_PATH = ${JSON.stringify(registryPath)};
    const runtime = await import(${JSON.stringify(path.resolve('dist/runtimeOperationRuntime.js'))});
    try {
      await runtime.loadRuntimePack('spec-runtime-mainnet');
      console.log(JSON.stringify({ ok: true }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, message: error.message }));
    }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `child process failed with code ${result.status}`);
  }

  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.match(
    output.message,
    /references non-Codama input non_codama_field for instruction execute_swap/i,
  );
});
