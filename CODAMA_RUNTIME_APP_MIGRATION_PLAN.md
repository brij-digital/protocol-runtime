## Goal

Standardize AppPack protocol packs around three declarative artifacts:

- `*.codama.json`: protocol source of truth
- `*.runtime.json`: indexing/runtime source of truth
- `*.app.json`: product/app flow source of truth

This replaces the older blurred model where `meta.json` / `meta.core.json` mixed protocol,
indexing, and product concerns.

## Ownership Model

Per protocol:

- `Codama`
  - owner: protocol description
  - contents:
    - program id
    - accounts
    - instructions
    - events
    - types
    - discriminators
    - account metas
    - PDA seeds and structural relations

- `Runtime`
  - owner: indexing/runtime
  - contents:
    - decoder artifacts
    - sources
    - match rules
    - extract / resolve / compute / emit
    - projections
    - targeted bootstrap configuration

- `App`
  - owner: product / UX / agent flow
  - contents:
    - apps
    - steps
    - actions
    - input bindings
    - navigation
    - simulate / send / view flows

## Explicit Rule

`compute` belongs in `runtime`, not in `Codama` and not in `app`.

Reason:

- `Codama` describes what the protocol is.
- `runtime` describes how AppPack transforms protocol records into indexed data.
- `app` describes how users/agents interact with the protocol through the product.

## Transitional Status

`*.meta.json` and `*.meta.core.json` are now legacy transitional artifacts.

They may still exist while migration is in progress, but they are no longer the target
architecture for new work.

Rules during migration:

- do not add new protocol structure to `meta` or `meta.core`
- do not add new indexing/runtime logic to `meta` or `meta.core`
- new protocol structure goes to `Codama`
- new indexing logic goes to `runtime`
- new UX/app flow goes to `app`

## Migration Plan

### Phase 1: Freeze The New Model

- document `Codama + runtime + app` as the official target
- add CI/checks that validate pack topology
- mark `meta` / `meta.core` as legacy in docs

### Phase 2: Stop Growing Legacy Artifacts

- no new runtime logic in `meta.core`
- no new protocol structure in `meta`
- no new product flow in `meta`

### Phase 3: Migrate Protocol By Protocol

Recommended order:

1. `pump_amm`
2. `pump_core`
3. `orca_whirlpool`
4. `kamino_klend`

Per protocol:

- keep protocol truth in `*.codama.json`
- keep indexing/runtime in `*.runtime.json`
- keep UX/app flow in `*.app.json`
- reduce `*.meta.json` / `*.meta.core.json` until removable

### Phase 4: Remove Legacy Meta Artifacts

When all active protocols are migrated:

- remove `*.meta.core.json`
- remove or archive `*.meta.json`
- remove the runtime dependence on `meta_idl.core`
- re-evaluate whether `meta_idl.schema.v0.6.json` is still needed at all

## Definition Of Done

For a migrated protocol:

- protocol truth lives in `Codama`
- indexing truth lives in `runtime`
- UX truth lives in `app`
- no active ingest/index/read path depends on `meta` or `meta.core` as the primary source of truth

At the platform level:

- adding a new protocol means supplying:
  - `*.codama.json`
  - `*.runtime.json`
  - `*.app.json`
- without adding new protocol-specific product logic to the shared runtime code
