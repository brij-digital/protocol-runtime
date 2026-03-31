import test from 'node:test';
import assert from 'node:assert/strict';
import { hydrateAndValidateRuntimeInputs } from '../dist/runtimeOperationRuntime.js';

test('hydrateAndValidateRuntimeInputs rejects symbol-like token_mint values', () => {
  assert.throws(
    () =>
      hydrateAndValidateRuntimeInputs({
        input: {
          token_in_mint: 'USDC',
          token_out_mint: 'So11111111111111111111111111111111111111112',
        },
        materialized: {
          kind: 'index_view',
          instruction: '',
          inputs: {
            token_in_mint: { type: 'token_mint' },
            token_out_mint: { type: 'token_mint' },
          },
          derive: [],
          compute: [],
          args: {},
          accounts: {},
          remainingAccounts: [],
          pre: [],
          post: [],
        },
        context: 'orca-whirlpool-mainnet/pools_index',
      }),
    /token_in_mint must be a valid token_mint base58 public key/i,
  );
});

test('hydrateAndValidateRuntimeInputs normalizes valid pubkey-like inputs', () => {
  const normalized = hydrateAndValidateRuntimeInputs({
    input: {
      token_in_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      token_out_mint: 'So11111111111111111111111111111111111111112',
      slippage_bps: 100,
    },
    materialized: {
      kind: 'compute',
      instruction: '',
      inputs: {
        token_in_mint: { type: 'token_mint' },
        token_out_mint: { type: 'token_mint' },
        slippage_bps: { type: 'u16' },
      },
      derive: [],
      compute: [],
      args: {},
      accounts: {},
      remainingAccounts: [],
      pre: [],
      post: [],
    },
    context: 'orca-whirlpool-mainnet/quote_exact_in',
  });

  assert.deepEqual(normalized, {
    token_in_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    token_out_mint: 'So11111111111111111111111111111111111111112',
    slippage_bps: '100',
  });
});
