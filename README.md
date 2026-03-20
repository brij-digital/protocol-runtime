# @agentform/apppack-runtime

Shared runtime package for AppPack protocol execution.

Used by:
- `ec-ai-wallet` (browser app)
- `apppack-view-service` (node read/index service)

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

Protocol-specific behavior belongs in pack data (`idl + meta + app`), not in runtime code.

## Exports

- `@agentform/apppack-runtime`
- `@agentform/apppack-runtime/idlDeclarativeRuntime`
- `@agentform/apppack-runtime/metaIdlRuntime`
- `@agentform/apppack-runtime/idlRegistry`
- `@agentform/apppack-runtime/node/view-read-service`

## Scripts

```bash
npm run build
npm run check
npm run test
```

- `build`: TypeScript build to `dist/`
- `check`: type-check only
- `test`: build + node test suite

## Package Layout

- `src/idlDeclarativeRuntime.ts`
- `src/metaIdlRuntime.ts`
- `src/metaDiscoverRegistry.ts`
- `src/metaComputeRegistry.ts`
- `src/node/view-read-service.ts`

## Versioning Notes

This package is consumed from GitHub refs in downstream repos.
When changing runtime behavior, update consumers to the new commit and run their CI.
