import test from 'node:test';
import assert from 'node:assert/strict';
import { runActionRunner } from '../dist/actionRunner.js';

test('runActionRunner resolves step outputs through a linear pipeline', async () => {
  const executedSteps = [];
  const result = await runActionRunner({
    spec: {
      schema: 'solana-action-runner.v1',
      actionId: 'quote_swap',
      title: 'Quote Swap',
      inputs: {
        token_in: { type: 'string' },
        token_out: { type: 'string' },
      },
      steps: [
        {
          id: 'token_in',
          kind: 'read',
          protocolId: 'demo-index',
          operationId: 'tokens_get',
          input: {
            symbol: '$input.token_in',
          },
        },
        {
          id: 'pair',
          kind: 'read',
          protocolId: 'demo',
          operationId: 'pair_up',
          input: {
            left: '$token_in.output.symbol',
            right: '$input.token_out',
          },
        },
      ],
      output: {
        summary: '$pair.output.summary',
      },
    },
    input: {
      token_in: 'USDC',
      token_out: 'SOL',
    },
    executeStep: async (step) => {
      executedSteps.push(step);
      if (step.id === 'token_in') {
        return { output: { symbol: 'USDC', mint: 'mint-usdc' } };
      }
      return { output: { summary: `${String(step.input.left)}->${String(step.input.right)}` } };
    },
  });

  assert.equal(executedSteps.length, 2);
  assert.deepEqual(executedSteps[0].input, { symbol: 'USDC' });
  assert.deepEqual(executedSteps[1].input, { left: 'USDC', right: 'SOL' });
  assert.deepEqual(result.output, { summary: 'USDC->SOL' });
});
