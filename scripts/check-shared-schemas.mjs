import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const SCHEMA_DIR = path.join(ROOT, 'schemas');
const EXPECTED_FILES = [
  'declarative_decoder_runtime.schema.v1.json',
  'solana_agent_runtime.schema.v1.json',
];

function fail(message) {
  throw new Error(message);
}

async function main() {
  const entries = await fs.readdir(SCHEMA_DIR, { withFileTypes: true }).catch(() => null);
  if (!entries) {
    fail(`Shared schema directory is missing: ${SCHEMA_DIR}`);
  }

  const actualFiles = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  const expectedFiles = [...EXPECTED_FILES].sort();

  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    fail(`Shared schema set mismatch.\nExpected: ${expectedFiles.join(', ')}\nActual: ${actualFiles.join(', ')}`);
  }

  for (const fileName of EXPECTED_FILES) {
    const fullPath = path.join(SCHEMA_DIR, fileName);
    const parsed = JSON.parse(await fs.readFile(fullPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fail(`${fileName} must decode to a JSON object.`);
    }
    if (typeof parsed.$schema !== 'string' || parsed.$schema.length === 0) {
      fail(`${fileName} is missing a top-level $schema string.`);
    }
    if (typeof parsed.$id !== 'string' || parsed.$id.length === 0) {
      fail(`${fileName} is missing a top-level $id string.`);
    }
    if (typeof parsed.title !== 'string' || parsed.title.length === 0) {
      fail(`${fileName} is missing a top-level title string.`);
    }
  }

  console.log(`Shared schemas are valid in ${SCHEMA_DIR}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
