import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function previewInstructionWithRegistry({ registryPath, request }) {
  const script = `
    process.env.APPPACK_RUNTIME_REGISTRY_PATH = ${JSON.stringify(registryPath)};
    const { PublicKey } = await import('@solana/web3.js');
    const { previewIdlInstruction } = await import(${JSON.stringify(path.resolve('dist/index.js'))});
    const request = ${JSON.stringify(request)};
    request.walletPublicKey = new PublicKey(request.walletPublicKey);
    const preview = await previewIdlInstruction(request);
    console.log(JSON.stringify(preview));
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
