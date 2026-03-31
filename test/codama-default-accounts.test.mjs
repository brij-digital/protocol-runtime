import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { getInstructionTemplate, previewIdlInstruction } from '../dist/index.js';

const PROGRAM_ID = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const WHIRLPOOL = 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE';
const WALLET = '4x4K45kncfjpoPgWBaFU4x1iDMsfGBfPwrFNJzXUgGcR';

const REGISTRY = {
  version: 'test',
  protocols: [
    {
      id: 'codama-defaults-test',
      name: 'Codama Defaults Test',
      network: 'mainnet',
      programId: PROGRAM_ID,
      codamaIdlPath: '/idl/codama-defaults-test.codama.json',
      transport: 'solana-rpc',
      supportedCommands: [],
      status: 'active',
    },
  ],
};

const CODAMA = {
  program: {
    pdas: [
      {
        name: 'oracle',
        seeds: [
          {
            kind: 'constantPdaSeedNode',
            value: {
              encoding: 'base16',
              data: '6f7261636c65',
            },
          },
          {
            kind: 'variablePdaSeedNode',
            name: 'whirlpool',
          },
        ],
      },
    ],
    instructions: [
      {
        name: 'swapV2',
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
            name: 'whirlpool',
            isWritable: true,
            isSigner: false,
            isOptional: false,
          },
          {
            kind: 'instructionAccountNode',
            name: 'oracle',
            isWritable: true,
            isSigner: false,
            isOptional: false,
            defaultValue: {
              kind: 'pdaValueNode',
              pda: {
                kind: 'pdaLinkNode',
                name: 'oracle',
              },
              seeds: [
                {
                  kind: 'pdaSeedValueNode',
                  name: 'whirlpool',
                  value: {
                    kind: 'accountValueNode',
                    name: 'whirlpool',
                  },
                },
              ],
            },
          },
          {
            kind: 'instructionAccountNode',
            name: 'memoProgram',
            isWritable: false,
            isSigner: false,
            isOptional: false,
            defaultValue: {
              kind: 'publicKeyValueNode',
              publicKey: MEMO_PROGRAM_ID,
            },
          },
        ],
      },
    ],
    accounts: [],
    definedTypes: [],
  },
};

test('Codama default accounts drive templates and preview account metas', async () => {
  const originalFetch = globalThis.fetch;
  const originalBase = process.env.APPPACK_RUNTIME_BASE_URL;
  process.env.APPPACK_RUNTIME_BASE_URL = 'http://runner.test';

  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('/idl/registry.json')) {
      return new Response(JSON.stringify(REGISTRY), { status: 200 });
    }
    if (target.includes('/idl/codama-defaults-test.codama.json')) {
      return new Response(JSON.stringify(CODAMA), { status: 200 });
    }
    throw new Error(`Unexpected fetch ${target}`);
  };

  try {
    const template = await getInstructionTemplate({
      protocolId: 'codama-defaults-test',
      instructionName: 'swap_v2',
    });

    assert.equal(template.accounts.authority, '$WALLET');
    assert.equal(template.accounts.whirlpool, '<PUBKEY>');
    assert.equal(template.accounts.memo_program, MEMO_PROGRAM_ID);
    assert.equal(template.accounts.oracle, '<AUTO_PDA:oracle>');

    const preview = await previewIdlInstruction({
      protocolId: 'codama-defaults-test',
      instructionName: 'swap_v2',
      args: {
        amount: '1',
      },
      accounts: {
        whirlpool: WHIRLPOOL,
      },
      walletPublicKey: new PublicKey(WALLET),
    });

    const expectedOracle = PublicKey.findProgramAddressSync(
      [Buffer.from('oracle'), new PublicKey(WHIRLPOOL).toBuffer()],
      new PublicKey(PROGRAM_ID),
    )[0].toBase58();

    assert.equal(preview.keys[0].pubkey, WALLET);
    assert.equal(preview.keys[1].pubkey, WHIRLPOOL);
    assert.equal(preview.keys[2].pubkey, expectedOracle);
    assert.equal(preview.keys[3].pubkey, MEMO_PROGRAM_ID);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBase === undefined) {
      delete process.env.APPPACK_RUNTIME_BASE_URL;
    } else {
      process.env.APPPACK_RUNTIME_BASE_URL = originalBase;
    }
  }
});
