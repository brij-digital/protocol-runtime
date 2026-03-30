import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();

function fail(message) {
  throw new Error(message);
}

function parseArgs() {
  const dirFlagIndex = process.argv.findIndex((arg) => arg === '--pack-dir');
  if (dirFlagIndex === -1 || !process.argv[dirFlagIndex + 1]) {
    fail('Usage: node scripts/check-pack-contracts.mjs --pack-dir <directory>');
  }
  return {
    packDir: path.resolve(ROOT, process.argv[dirFlagIndex + 1]),
  };
}

async function loadJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

function asObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be a JSON object.`);
  }
  return value;
}

async function assertFile(filePath) {
  await fs.access(filePath).catch(() => fail(`Missing required file: ${filePath}`));
}

async function main() {
  const { packDir } = parseArgs();
  const registryPath = path.join(packDir, 'registry.json');
  await assertFile(registryPath);

  const registry = await loadJson(registryPath);
  if (!registry || typeof registry !== 'object' || !Array.isArray(registry.protocols)) {
    fail(`Invalid registry shape: ${registryPath}`);
  }

  for (const protocol of registry.protocols) {
    if (!protocol || typeof protocol !== 'object') {
      fail('Registry contains a non-object protocol entry.');
    }
    if (typeof protocol.id !== 'string' || protocol.id.trim().length === 0) {
      fail('Registry protocol entry is missing id.');
    }
    const isActive = protocol.status !== 'inactive';
    if (protocol.idlPath != null) {
      fail(`Protocol ${protocol.id} still declares legacy idlPath.`);
    }

    for (const key of ['codamaIdlPath', 'runtimeSpecPath']) {
      const value = protocol[key];
      if (value == null) {
        continue;
      }
      if (typeof value !== 'string' || !value.startsWith('/idl/')) {
        fail(`Protocol ${protocol.id} has invalid ${key}.`);
      }
      const filePath = path.join(packDir, value.slice('/idl/'.length));
      await assertFile(filePath);
      const parsed = await loadJson(filePath);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        fail(`${filePath} did not parse as a JSON object.`);
      }
      if (key === 'runtimeSpecPath') {
        if (parsed.schema !== 'declarative-decoder-runtime.v1') {
          fail(`${filePath} has invalid declarative runtime schema marker.`);
        }
        const runtime = asObject(parsed, `${filePath}`);
        const decoderArtifacts = asObject(runtime.decoderArtifacts, `${filePath}.decoderArtifacts`);
        for (const [artifactName, artifactValue] of Object.entries(decoderArtifacts)) {
          const artifact = asObject(artifactValue, `${filePath}.decoderArtifacts.${artifactName}`);
          if (artifact.family === 'codama') {
            if (typeof artifact.codamaPath !== 'string' || !artifact.codamaPath.startsWith('/idl/')) {
              fail(`${filePath}.decoderArtifacts.${artifactName} requires codamaPath.`);
            }
            const codamaPath = path.join(packDir, artifact.codamaPath.slice('/idl/'.length));
            await assertFile(codamaPath);
            const codama = await loadJson(codamaPath);
            if (codama.standard !== 'codama') {
              fail(`${codamaPath} is not a Codama IDL.`);
            }
          }
          if (artifact.codecIdlPath != null) {
            fail(`${filePath}.decoderArtifacts.${artifactName} must not declare legacy codecIdlPath.`);
          }
          if (artifact.idlPath != null) {
            fail(`${filePath}.decoderArtifacts.${artifactName} must not declare legacy idlPath.`);
          }
        }
      }
      if (key === 'codamaIdlPath') {
        if (parsed.standard !== 'codama') {
          fail(`${filePath} is not a Codama IDL.`);
        }
      }
    }

    if (isActive && protocol.runtimeSpecPath == null) {
      fail(`Protocol ${protocol.id} is active but has no runtimeSpecPath; active pack contracts must be runtime-backed.`);
    }
    if (protocol.appPath != null) {
      fail(`Protocol ${protocol.id} still declares appPath; active pack contracts are codama/runtime only.`);
    }

    for (const legacyKey of ['metaPath', 'metaCorePath']) {
      if (protocol[legacyKey] != null) {
        fail(`Protocol ${protocol.id} still declares legacy ${legacyKey}; active pack contracts are codama/runtime only.`);
      }
    }
  }

  console.log(`Pack contract validation succeeded for ${registry.protocols.length} protocol(s) in ${packDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
