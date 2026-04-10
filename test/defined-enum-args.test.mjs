import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PublicKey } from '@solana/web3.js';
import { previewInstructionWithRegistry } from './helpers/preview-with-registry.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('previewIdlInstruction normalizes defined enum args from SDK-style __kind shape', async () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apppack-runtime-defined-enum-'));
  const registryPath = path.join(fixtureDir, 'registry.json');
  const codamaPath = path.join(fixtureDir, 'idl', 'test-enum.codama.json');
  fs.mkdirSync(path.dirname(codamaPath), { recursive: true });

  fs.writeFileSync(
    registryPath,
    JSON.stringify({
      version: 'test',
      protocols: [
        {
          id: 'test-enum-mainnet',
          name: 'Test Enum Protocol',
          network: 'mainnet',
          programId: '11111111111111111111111111111111',
          codamaIdlPath: '/idl/test-enum.codama.json',
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
      kind: 'rootNode',
      standard: 'codama',
      version: '1.5.1',
      program: {
        kind: 'programNode',
        name: 'testEnum',
        publicKey: '11111111111111111111111111111111',
        version: '0.1.0',
        origin: 'anchor',
        docs: [],
        accounts: [],
        instructions: [
          {
            kind: 'instructionNode',
            name: 'encodeEnumArg',
            docs: [],
            optionalAccountStrategy: 'programId',
            accounts: [],
            arguments: [
              {
                kind: 'instructionArgumentNode',
                name: 'discriminator',
                defaultValueStrategy: 'omitted',
                docs: [],
                type: {
                  kind: 'fixedSizeTypeNode',
                  size: 8,
                  type: {
                    kind: 'bytesTypeNode',
                  },
                },
                defaultValue: {
                  kind: 'bytesValueNode',
                  data: 'effb097cd2c6352b',
                  encoding: 'base16',
                },
              },
              {
                kind: 'instructionArgumentNode',
                name: 'method',
                docs: [],
                type: {
                  kind: 'definedTypeLinkNode',
                  name: 'testMethod',
                },
              },
            ],
            discriminators: [
              {
                kind: 'fieldDiscriminatorNode',
                name: 'discriminator',
                offset: 0,
              },
            ],
          },
        ],
        definedTypes: [
          {
            kind: 'definedTypeNode',
            name: 'testMethod',
            docs: [],
            type: {
              kind: 'enumTypeNode',
              variants: [
                {
                  kind: 'enumStructVariantTypeNode',
                  name: 'byTokenAmounts',
                  struct: {
                    kind: 'structTypeNode',
                    fields: [
                      {
                        kind: 'structFieldTypeNode',
                        name: 'tokenMaxA',
                        docs: [],
                        type: {
                          kind: 'numberTypeNode',
                          format: 'u64',
                          endian: 'le',
                        },
                      },
                      {
                        kind: 'structFieldTypeNode',
                        name: 'tokenMaxB',
                        docs: [],
                        type: {
                          kind: 'numberTypeNode',
                          format: 'u64',
                          endian: 'le',
                        },
                      },
                      {
                        kind: 'structFieldTypeNode',
                        name: 'minSqrtPrice',
                        docs: [],
                        type: {
                          kind: 'numberTypeNode',
                          format: 'u128',
                          endian: 'le',
                        },
                      },
                      {
                        kind: 'structFieldTypeNode',
                        name: 'maxSqrtPrice',
                        docs: [],
                        type: {
                          kind: 'numberTypeNode',
                          format: 'u128',
                          endian: 'le',
                        },
                      },
                    ],
                  },
                },
              ],
              size: {
                kind: 'numberTypeNode',
                format: 'u8',
                endian: 'le',
              },
            },
          },
        ],
        pdas: [],
      },
    }),
  );

  const preview = previewInstructionWithRegistry({
    registryPath,
    request: {
      protocolId: 'test-enum-mainnet',
      instructionName: 'encode_enum_arg',
      args: {
        method: {
          __kind: 'ByTokenAmounts',
          tokenMaxA: '10',
          tokenMaxB: '12',
          minSqrtPrice: '1',
          maxSqrtPrice: '2',
        },
      },
      accounts: {},
      walletPublicKey: PublicKey.default.toBase58(),
    },
  });

  assert.equal(preview.protocolId, 'test-enum-mainnet');
  assert.equal(preview.instructionName, 'encode_enum_arg');
  assert.deepEqual(preview.keys, []);
  assert.deepEqual(preview.resolvedAccounts, {});

  const expectedHex =
    'effb097cd2c6352b000a000000000000000c000000000000000100000000000000000000000000000002000000000000000000000000000000';
  assert.equal(Buffer.from(preview.dataBase64, 'base64').toString('hex'), expectedHex);
});
