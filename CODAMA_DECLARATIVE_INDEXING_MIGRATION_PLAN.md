# Codama Declarative Indexing Migration Plan

## Goal

Move AppPack to a `Codama + runtime spec + app pack` model where, for migrated protocols:

- `Codama IDL` is the protocol source of truth
- `declarative runtime spec` is the ingest/decode/normalize source of truth
- `app pack` is the active action/read contract
- backend/runtime code acts as a generic execution engine
- legacy `idlPath` is no longer a structural dependency on active paths

This plan is intentionally incremental. The goal is to remove ambiguity without slowing active development more than necessary.

## Current Direction

The intended split is:

- `apppack-runtime`
  - owns shared schemas
  - defines runtime contract and execution boundaries
- `ec-ai-wallet`
  - owns active protocol pack artifacts
  - emits `codama + runtime + app` packs
- `apppack-view-service`
  - consumes those packs
  - compiles backend runtime plans
  - runs indexing/read execution against canonical storage

This migration is about finishing that split and making it true on the active code paths.

## Definition Of A Migrated Protocol

A protocol is considered `migrated` when all of the following are true:

1. `codamaIdlPath` is present in the active registry.
2. `runtimeSpecPath` is present in the active registry.
3. `appPath` is present in the active registry.
4. `metaPath` / `metaCorePath` are not used on active paths.
5. Active decode/bootstrap/read flows do not rely on legacy `idlPath` as their primary source of truth.

A protocol is considered `fully migrated` when:

1. it satisfies the migrated protocol rules above
2. `idlPath` is no longer required for active execution
3. no protocol-specific indexing logic is handwritten in backend/runtime code for that protocol

## Phase 1: Stabilize The Baseline

### Objective

Start from a clean, reproducible state before pushing the migration further.

### Tasks

1. Ensure all three repos are aligned on the published runtime version.
2. Fix local/runtime package resolution in downstream repos.
3. Re-run baseline checks:
   - `apppack-runtime`: `npm test`
   - `ec-ai-wallet`: `npm run aidl:check`
   - `apppack-view-service`: `npm run check`
4. Treat that green state as the migration baseline.

### Done

- All three repos are green from `main`.

## Phase 2: Lock The Contract For Migrated Packs

### Objective

Make the new pack model explicit instead of implicit.

### Tasks

1. Keep the active registry centered on:
   - `codamaIdlPath`
   - `runtimeSpecPath`
   - `appPath`
2. Keep drift checks that reject legacy `metaPath` / `metaCorePath` on active protocols.
3. Distinguish clearly in tooling:
   - legacy protocol
   - migrated protocol
   - fully migrated protocol
4. Document that new protocol truth must not be added to legacy meta files.

### Done

- The repo tooling can tell whether a protocol is legacy, migrated, or fully migrated.

## Phase 3: Make Codama The Effective Decode Source

### Objective

For migrated protocols, move decode truth from legacy IDL to `Codama + runtime spec`.

### Tasks

1. Keep backend runtime-plan generation sourced from:
   - `codamaIdlPath`
   - `runtimeSpecPath`
2. Reduce active runtime/backend dependence on legacy `idlPath`.
3. Treat legacy `idlPath` as transitional compatibility only.
4. For migrated protocols, do not add new decode logic against legacy IDL-first paths.

### Primary Targets

- `apppack-runtime/src/idlDeclarativeRuntime.ts`
- `apppack-runtime/src/metaIdlRuntime.ts`
- `apppack-runtime/src/node/view-read-service.ts`
- `apppack-view-service/generated/runtime-decoder-plan.json`

### Done

- For Pump and Orca, the effective decode contract comes from `Codama + runtime spec`, not from legacy IDL-first code paths.

## Phase 4: Remove Legacy Read-Path Dependence On Active Protocols

### Objective

Stop treating legacy read paths as the default on migrated protocols.

### Tasks

1. Make active view paths consume:
   - app pack
   - runtime spec
   - canonical backend storage
2. Remove legacy read fallback behavior from migrated protocols.
3. Keep legacy paths only for protocols that have not migrated yet.

### Primary Targets

- `apppack-view-service/src/view-routes.ts`
- `apppack-runtime/src/node/view-read-service.ts`

### Done

- Pump and Orca active paths are driven by app packs and canonical/runtime-backed reads.

## Phase 5: Remove Legacy IDL Dependence From Bootstrap And Search

### Objective

Finish the migration on search/bootstrap, not just on reads.

### Tasks

1. Replace legacy account discriminator lookup based on `idlPath`.
2. Derive discriminator/layout truth from:
   - Codama artifact
   - and/or generated runtime decoder artifacts
3. Make backend bootstrap/search use the generated runtime plan as its truth source.

### Primary Targets

- `apppack-view-service/src/view-sync.ts`
- `apppack-view-service/src/account-bootstrap-worker.ts`

### Done

- Bootstrap/search for migrated protocols no longer require legacy IDL as their primary source of truth.

## Phase 6: Make Runtime Specs The Real Ingest Contract

### Objective

Ensure runtime specs are not just published artifacts, but the actual execution contract.

### Tasks

1. Execute `matchRules`, `pipelines`, `decoderArtifacts`, and `sources` as the primary ingest contract.
2. Continue generating backend plan artifacts and Carbon decoder bindings from those specs.
3. Remove handwritten protocol-specific indexing branches where the runtime spec already expresses the same behavior.

### Primary Targets

- `apppack-view-service/scripts/compile-runtime-decoder-plan.mjs`
- `apppack-view-service/scripts/generate-carbon-decoders.mjs`
- generated Carbon bindings and backend runtime plans

### Done

- Adding a similar protocol is primarily a pack/spec task, not a backend handwritten indexing task.

## Phase 7: Prove The Model On Orca, Not Just Pump

### Objective

Validate that the architecture is genuinely generic.

### Tasks

1. Apply the same migrated path to Orca active views and indexing.
2. Verify:
   - feed
   - series
   - snapshot
   - bootstrap/search
3. Remove hidden Pump-shaped assumptions from runtime/backend code.

### Done

- Pump and Orca both run on the same active model.

## Phase 8: Clean Up The Registry Model

### Objective

Make the registry reflect the target architecture instead of the transitional one.

### Tasks

1. Keep `idlPath` only where compatibility still requires it.
2. Mark `idlPath` clearly as transitional for migrated protocols.
3. Remove `idlPath` entirely from fully migrated protocols when safe.

### Done

- The active registry visibly reflects the post-migration model.

## Phase 9: Battle-Test The Declarative Path

### Objective

Prove that the new model is not only cleaner, but operationally reliable.

### Tasks

1. Run Pump and Orca continuously on the migrated path.
2. Test restart/recovery behavior.
3. Validate bootstrap/search recovery.
4. Validate that changing a runtime spec changes behavior without bespoke backend edits.
5. Compare observed behavior with chain reality and expected canonical outputs.

### Done

- The declarative path is trusted operationally, not just architecturally.

## Recommended Order

1. Stabilize build/install baseline.
2. Lock the migrated-pack contract.
3. Make `Codama + runtime spec` the effective decode source.
4. Remove legacy read-path dependence on migrated protocols.
5. Remove legacy IDL dependence from bootstrap/search.
6. Make runtime specs the real ingest contract.
7. Prove the model on Orca.
8. Clean up registry transition fields.
9. Battle-test the result.

## What We Should Avoid

- Do not attempt a big-bang removal of all legacy `idlPath` usage at once.
- Do not reintroduce protocol-specific handwritten indexing logic if the runtime spec can express it.
- Do not leave dual paths in place indefinitely.
- Do not treat generated pack/runtime artifacts as optional if they are the active contract.

## Success Criteria

We can consider this migration successful when, for the priority migrated protocols:

1. `Codama + runtime spec + app pack` are sufficient to define active behavior.
2. Active backend/runtime execution does not structurally depend on legacy `idlPath`.
3. Search/bootstrap/read flows use the migrated model as their primary path.
4. Backend code behaves like a generic engine, not a collection of protocol-specific handlers.
5. Adding a similar protocol is mostly a pack/spec operation.
