# @brij-digital/apppack-runtime

Shared runtime package for AppPack protocol execution.

Used by:
- `protocol-ui` (browser app repo)
- `protocol-indexing` (node read/index service repo)

## Shared Schemas

`schemas/` is the source of truth for shared AppPack schema files:
- `declarative_decoder_runtime.schema.v1.json`
- `solana_agent_runtime.schema.v1.json`
- `solana_action_runner.schema.v1.json`

Downstream repos should sync these files from runtime and treat local copies as generated artifacts.
Because these files are JSON, downstream copies cannot carry inline comment headers.
The ownership marker is instead:
- this README
- the downstream directory README
- the sync/check scripts
- CI drift checks

If you need to change a shared schema:
- edit only [`schemas/`](/home/ubuntu/src/apppack-runtime/schemas)
- run `npm run schemas:check`
- then sync downstream repos instead of editing their copies

## Repo Relationship

These are the three main AppPack repositories:
- `protocol-runtime`: shared runtime package repo published via GitHub Packages
- `protocol-ui`: browser app repo consuming the published runtime package
- `protocol-indexing`: node API/worker repo consuming the published runtime package

Downstream apps should install the runtime from GitHub Packages under the `@brij-digital` scope.

## Package Naming

Use `@brij-digital/apppack-runtime` directly in manifests and imports.
Do not reintroduce the legacy `@agentform/apppack-runtime` alias.

## Scope

This package provides generic, protocol-agnostic runtime logic for:
- Codama-backed instruction preparation
- runtime compute execution
- runtime write preparation
- runtime action-runner execution
- shared loading/validation of protocol packs

Protocol-specific behavior belongs in pack data, not in runtime code.

The current pack split is:
- `Codama IDL`: instruction-level protocol source of truth
- `indexing specs`: ingest sources plus materialized entity definitions
- `runtime spec`: deterministic compute and write preparation

The runtime package owns only the third layer plus the shared loading logic around all three.

For a concrete description of the runtime layer, see:
- [docs/runtime-spec.md](docs/runtime-spec.md)
- [docs/indexing-spec.md](docs/indexing-spec.md)

## Exports

- `@brij-digital/apppack-runtime`
- `@brij-digital/apppack-runtime/idlDeclarativeRuntime`
- `@brij-digital/apppack-runtime/runtimeOperationRuntime`
- `@brij-digital/apppack-runtime/idlRegistry`

## Scripts

```bash
npm run build
npm run check
npm run schemas:check
npm run test
```

- `build`: TypeScript build to `dist/`
- `check`: type-check only
- `schemas:check`: validate the runtime-owned schema set and required top-level fields
- `test`: build + node test suite

## Package Layout

- `src/operationPackRuntime.ts`
- `src/operationExecutionRuntime.ts`
- `src/runtimeOperationRuntime.ts`
- `src/idlDeclarativeRuntime.ts`
- `src/metaComputeRegistry.ts`
- `src/actionRunner.ts`
- `src/codamaIdl.ts`
- `src/idlRegistry.ts`

## Versioning Notes

This package is published to GitHub Packages.
When changing runtime behavior, release a new semver version, update downstream consumers, and run their CI.

See [RELEASING.md](RELEASING.md) for the exact release flow.

## Product Direction

AppPack should be treated primarily as an agent-native execution platform with:
- `protocol-runtime` as the shared protocol execution repo
- `protocol-indexing` as the indexed read/search repo
- `protocol-ui` as the reference client and pack-authoring repo
