import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SCHEMA_DIR = path.join(ROOT, 'schemas');
const EXPECTED_FILES = [
  'meta_view.schema.v0.2.json',
  'meta_view.schema.v0.3.json',
  'declarative_decoder_runtime.schema.v1.json',
];

for (const fileName of EXPECTED_FILES) {
  test(`shared schema ${fileName} exists and parses`, () => {
    const fullPath = path.join(SCHEMA_DIR, fileName);
    assert.equal(fs.existsSync(fullPath), true, `${fileName} should exist in schemas/`);
    const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    assert.equal(typeof parsed, 'object');
    assert.equal(Array.isArray(parsed), false);
    assert.equal(typeof parsed.$schema, 'string');
    assert.equal(typeof parsed.$id, 'string');
    assert.equal(typeof parsed.title, 'string');
  });
}
