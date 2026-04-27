import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PROGRAM_ID = '11111111111111111111111111111111';
const OWNER = '4x4K45kncfjpoPgWBaFU4x1iDMsfGBfPwrFNJzXUgGcR';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const MINT_A = 'So11111111111111111111111111111111111111112';
const MINT_B = 'Es9vMFrzaCERmJfrF4H2FYD4N6qWw2X2VNfzQExgkt1h';
const TOKEN_ACCOUNT_A = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const TOKEN_ACCOUNT_B = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

function writeFixture() {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apppack-runtime-token-owner-'));
  const registryPath = path.join(fixtureDir, 'registry.json');
  const idlDir = path.join(fixtureDir, 'idl');
  const codamaPath = path.join(idlDir, 'spec.codama.json');
  const runtimePath = path.join(idlDir, 'spec.runtime.json');
  fs.mkdirSync(idlDir, { recursive: true });

  fs.writeFileSync(
    registryPath,
    JSON.stringify({
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
    }),
  );
  fs.writeFileSync(
    codamaPath,
    JSON.stringify({
      program: {
        name: 'SpecRuntime',
        pdas: [],
        instructions: [],
        accounts: [],
        definedTypes: [],
      },
    }),
  );
  fs.writeFileSync(
    runtimePath,
    JSON.stringify({
      schema: 'solana-agent-runtime.v1',
      protocol_id: 'spec-runtime-mainnet',
      program_id: PROGRAM_ID,
      codama_path: '/idl/spec.codama.json',
      views: {
        wallet_tokens: {
          inputs: {
            owner: 'pubkey',
          },
          steps: [
            {
              name: 'token_accounts',
              kind: 'token_accounts_by_owner',
              owner: '$input.owner',
            },
          ],
          output: {
            type: 'array',
            source: '$token_accounts',
          },
        },
        wallet_tokens_for_mint: {
          inputs: {
            owner: 'pubkey',
            mint: 'token_mint',
          },
          steps: [
            {
              name: 'token_accounts',
              kind: 'token_accounts_by_owner',
              owner: '$input.owner',
              mint: '$input.mint',
            },
          ],
          output: {
            type: 'array',
            source: '$token_accounts',
          },
        },
      },
      writes: {},
      transforms: {},
    }),
  );

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

test('token_accounts_by_owner view queries both token programs and supports mint filtering', () => {
  const { registryPath } = writeFixture();
  const output = runWithRegistry(
    registryPath,
    `
      const { PublicKey } = await import('@solana/web3.js');
      const runtime = await import(${JSON.stringify(path.resolve('dist/runtimeOperationRuntime.js'))});

      const calls = [];
      const buildEntry = ({ pubkey, tokenProgram, mint, owner, amount }) => ({
        pubkey: new PublicKey(pubkey),
        account: {
          owner: tokenProgram,
          data: {
            parsed: {
              info: {
                mint,
                owner,
                tokenAmount: {
                  amount,
                  decimals: 0,
                  uiAmountString: amount
                },
                state: 'initialized',
                isNative: false
              }
            }
          }
        }
      });

      const connection = {
        async getParsedTokenAccountsByOwner(owner, filter) {
          calls.push({
            owner: owner.toBase58(),
            filter: 'mint' in filter
              ? { mint: filter.mint.toBase58() }
              : { programId: filter.programId.toBase58() }
          });
          if ('mint' in filter) {
            return {
              context: { slot: 1 },
              value: [
                buildEntry({
                  pubkey: ${JSON.stringify(TOKEN_ACCOUNT_A)},
                  tokenProgram: ${JSON.stringify(TOKEN_PROGRAM)},
                  mint: filter.mint.toBase58(),
                  owner: ${JSON.stringify(OWNER)},
                  amount: '1'
                })
              ]
            };
          }
          if (filter.programId.toBase58() === ${JSON.stringify(TOKEN_PROGRAM)}) {
            return {
              context: { slot: 1 },
              value: [
                buildEntry({
                  pubkey: ${JSON.stringify(TOKEN_ACCOUNT_A)},
                  tokenProgram: ${JSON.stringify(TOKEN_PROGRAM)},
                  mint: ${JSON.stringify(MINT_A)},
                  owner: ${JSON.stringify(OWNER)},
                  amount: '1'
                })
              ]
            };
          }
          return {
            context: { slot: 1 },
            value: [
              buildEntry({
                pubkey: ${JSON.stringify(TOKEN_ACCOUNT_B)},
                tokenProgram: ${JSON.stringify(TOKEN_2022_PROGRAM)},
                mint: ${JSON.stringify(MINT_B)},
                owner: ${JSON.stringify(OWNER)},
                amount: '7'
              })
            ]
          };
        }
      };

      const ownerOnly = await runtime.runRuntimeView({
        protocolId: 'spec-runtime-mainnet',
        operationId: 'wallet_tokens',
        input: { owner: ${JSON.stringify(OWNER)} },
        connection,
        walletPublicKey: new PublicKey(${JSON.stringify(OWNER)})
      });

      const ownerAndMint = await runtime.runRuntimeView({
        protocolId: 'spec-runtime-mainnet',
        operationId: 'wallet_tokens_for_mint',
        input: { owner: ${JSON.stringify(OWNER)}, mint: ${JSON.stringify(MINT_A)} },
        connection,
        walletPublicKey: new PublicKey(${JSON.stringify(OWNER)})
      });

      console.log(JSON.stringify({
        calls,
        ownerOnly: ownerOnly.output,
        ownerAndMint: ownerAndMint.output
      }));
    `,
  );

  assert.equal(output.calls.length, 3);
  assert.deepEqual(output.calls[0], {
    owner: OWNER,
    filter: { programId: TOKEN_PROGRAM },
  });
  assert.deepEqual(output.calls[1], {
    owner: OWNER,
    filter: { programId: TOKEN_2022_PROGRAM },
  });
  assert.deepEqual(output.calls[2], {
    owner: OWNER,
    filter: { mint: MINT_A },
  });

  assert.equal(output.ownerOnly.length, 2);
  assert.deepEqual(output.ownerOnly[0], {
    pubkey: TOKEN_ACCOUNT_A,
    tokenProgram: TOKEN_PROGRAM,
    mint: MINT_A,
    owner: OWNER,
    amount: '1',
    decimals: 0,
    uiAmountString: '1',
    state: 'initialized',
    isNative: false,
  });
  assert.deepEqual(output.ownerOnly[1], {
    pubkey: TOKEN_ACCOUNT_B,
    tokenProgram: TOKEN_2022_PROGRAM,
    mint: MINT_B,
    owner: OWNER,
    amount: '7',
    decimals: 0,
    uiAmountString: '7',
    state: 'initialized',
    isNative: false,
  });

  assert.equal(output.ownerAndMint.length, 1);
  assert.deepEqual(output.ownerAndMint[0].mint, MINT_A);
  assert.deepEqual(output.ownerAndMint[0].tokenProgram, TOKEN_PROGRAM);
});
