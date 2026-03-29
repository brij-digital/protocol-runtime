# @brij-digital/apppack-runtime

Shared runtime package for AppPack protocol execution.

Used by:
- `ec-ai-wallet` (browser app)
- `apppack-view-service` (node read/index service)

## Shared Schemas

`schemas/` is the source of truth for shared AppPack schema files:
- `meta_idl.schema.v0.6.json`
- `meta_idl.core.schema.v0.6.json`
- `meta_view.schema.v0.2.json`
- `meta_view.schema.v0.3.json`
- `meta_app.schema.v0.1.json`
- `declarative_decoder_runtime.schema.v1.json`

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
- `apppack-runtime`: shared runtime package published via GitHub Packages
- `ec-ai-wallet`: browser app consuming the published runtime package
- `apppack-view-service`: node API/worker consuming the published runtime package

Downstream apps should install the runtime from GitHub Packages under the `@brij-digital` scope.

## Package Naming

Use `@brij-digital/apppack-runtime` directly in manifests and imports.
Do not reintroduce the legacy `@agentform/apppack-runtime` alias.

## Scope

This package provides generic, protocol-agnostic runtime logic for:
- IDL instruction preparation/simulate/send
- MetaIDL operation materialization and execution
- discover/derive/compute runtime primitives
- read runtime for indexed views (`node/view-read-service`)

For indexed search views, the node runtime expects the backing cache to provide:
- latest raw account bytes in `cached_program_accounts`
- temporal metadata such as `first_seen_slot` / `last_seen_slot`
- deterministic shortlist queries before decode/filter/select

Bootstrap-window concerns such as `bootstrap.lookback_seconds` are handled by the view-service sync worker, not by the runtime itself.
The runtime simply consumes whatever account universe has already been cached locally.

The current runtime path reads directly from cached accounts.
It no longer depends on a separate `view_entities` table or legacy materialized-entity flow.

The intended split is:
- `search` views: cache/index-first, because they need discovery over an account universe
- `account` views: direct known-account reads, which may be served from cache or straight from RPC depending on the caller and deployment model

In other words, `account` does not mean "stale cached forever".
It means the view starts from a known address instead of a discovery scan.

Protocol-specific behavior belongs in pack data (`idl + meta + app`), not in runtime code.
For indexing/runtime ownership, the intended split is:
- `Codama IDL`: declarative protocol description and protocol source of truth
- `declarative runtime spec`: declarative indexing contract
- `app spec`: declarative product / agent flow

`meta_idl` and `meta_idl.core` are now legacy transitional schemas.
Do not add new protocol truth or new indexing logic there.
New work should go into:
- `Codama` for protocol structure
- `runtime` for indexing / compute / projections
- `app` for UX / agent flow

## Exports

- `@brij-digital/apppack-runtime`
- `@brij-digital/apppack-runtime/idlDeclarativeRuntime`
- `@brij-digital/apppack-runtime/metaIdlRuntime`
- `@brij-digital/apppack-runtime/idlRegistry`
- `@brij-digital/apppack-runtime/node/view-read-service`

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

- `src/idlDeclarativeRuntime.ts`
- `src/metaIdlRuntime.ts`
- `src/metaDiscoverRegistry.ts`
- `src/metaComputeRegistry.ts`
- `src/node/view-read-service.ts`

## Versioning Notes

This package is published to GitHub Packages.
When changing runtime behavior, release a new semver version, update downstream consumers, and run their CI.

See [RELEASING.md](RELEASING.md) for the exact release flow.

## Product Direction

AppPack should be treated primarily as an agent-native execution platform with:
- `apppack-runtime` as the shared protocol execution core
- `apppack-view-service` as the indexed read/search backend
- `ec-ai-wallet` as the reference client and pack-authoring surface
