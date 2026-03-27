# Spec Source-Of-Truth Migration Plan

## Goal

Move from the current multi-repo spec drift to a single, explicit source of truth for:

- shared schemas
- protocol pack formats
- protocol pack validation
- generated runtime-facing artifacts

The target is:

- one owner for schemas
- one owner for protocol-pack source files
- read-only consumption in downstream repos
- no silent divergence between wallet, view-service, and runtime

## Velocity Constraint

This migration must not turn into heavy process or release bureaucracy.

The goal is:

- maximum clarity
- minimum ceremony

So the near-term version of this plan should be deliberately lightweight:

- one schema owner
- one protocol-pack source owner
- one sync path
- one drift check

It should **not** begin with:

- a new dedicated repo
- a new package publish pipeline
- multi-step manual release overhead
- broad repo restructuring before the ownership model is stable

## Why This Plan Exists

Today the architecture is directionally coherent, but spec ownership is not.

Current problems:

- `ec-ai-wallet` and `apppack-view-service` both carry copies of shared schema files
- some copied schema files have diverged
- some protocol packs have diverged between repos
- `apppack-runtime` is the logical place for shared contracts, but it is not yet the formal owner

This is making the system harder to trust than it should be.

## Source-Of-Truth Decision

### 1. Shared schemas

`apppack-runtime` becomes the owner of:

- `meta_idl.schema.v0.6.json`
- `meta_idl.core.schema.v0.6.json`
- `meta_view.schema.v0.2.json`
- `meta_view.schema.v0.3.json`
- `meta_app.schema.v0.1.json`
- future declarative ingest/runtime schemas

Reason:

- these are shared contracts
- they should not be owned by a product repo
- runtime is already the package most naturally aligned with contract ownership

### 2. Protocol pack source

Pick one owner repo for protocol pack source.

Recommended owner:

- `ec-ai-wallet`

Reason:

- it already has the authoring pipeline:
  - `aidl/*.aidl.json`
  - `aidl/*.compute.json`
  - `scripts/compile-aidl.mjs`
  - `scripts/split-meta-packs.mjs`
- it already behaves like the current pack authoring workspace

This means:

- `ec-ai-wallet` owns authoring
- `apppack-runtime` owns schemas
- `apppack-view-service` consumes generated outputs only

### 3. Downstream consumption

`apppack-view-service` should stop acting as a second owner of the same packs.

It should consume:

- generated protocol packs
- shared schemas

It should not be the authoritative place where pack copies evolve independently.

## Target Ownership Model

### `apppack-runtime`

Owns:

- shared schema definitions
- shared validation utilities
- shared runtime types
- future generic declarative ingest schema

Does not own:

- protocol-specific business packs
- product-specific generated copies

### `ec-ai-wallet`

Owns:

- protocol pack source authoring
- compile/split pipeline
- generated pack artifacts for UI consumption

Does not own:

- shared schema truth

### `apppack-view-service`

Owns:

- server runtime
- indexing/query engine
- canonical ingest/projection/read logic

Consumes:

- schemas from runtime
- generated protocol packs from the chosen pack source owner

Does not own:

- independent schema copies
- independent divergent pack copies

## Migration Strategy

Use additive migration first, then cutover, then cleanup.

Do not try to rewrite ownership in one destructive step.

Prefer the minimum viable governance that stops drift without slowing everyday iteration.

## Minimum Viable Rollout

This is the recommended first implementation of the plan.

### Do now

1. make `apppack-runtime` the owner of shared schemas
2. make `ec-ai-wallet` the temporary owner of protocol-pack source files
3. sync generated schema/pack copies into downstream repos with simple scripts
4. add one CI drift check

### Do later

1. package protocol packs as a shared package
2. move protocol packs into a dedicated repo
3. introduce stricter versioned release flow for schema changes

### Explicit principle

If a step adds process without immediately reducing drift, defer it.

## Phase 1. Freeze the current drift and document it

### Goal

Make drift visible and stop accidental further divergence.

### Actions

1. Record which files currently differ across repos.
2. Add a note in each repo README or bootstrap doc explaining:
   - shared schemas are transitioning to runtime ownership
   - protocol packs are transitioning to single-source ownership
3. Do not introduce new schema-only changes independently in both wallet and view-service during the migration.

### Exit Criteria

- drift list is explicit
- no one is guessing where truth lives

## Phase 2. Move shared schemas into `apppack-runtime`

### Goal

Make runtime the formal contract owner.

### Actions

1. Add a dedicated folder in `apppack-runtime`, for example:
   - `schemas/`
2. Move or copy into it:
   - `meta_idl.schema.v0.6.json`
   - `meta_idl.core.schema.v0.6.json`
   - `meta_view.schema.v0.2.json`
   - `meta_view.schema.v0.3.json`
   - `meta_app.schema.v0.1.json`
   - `declarative_decoder_runtime.schema.v1.json` if adopted
3. Export or document those paths as the official source of truth.
4. Add validation tests in `apppack-runtime` against these schemas.

### Exit Criteria

- there is one official schema home
- runtime can validate against that home

## Phase 3. Make wallet and view-service consume runtime-owned schemas

### Goal

Stop maintaining schema copies by hand.

### Actions

1. Add a sync script in both downstream repos or in runtime.
2. Replace hand-edited schema files in:
   - `ec-ai-wallet/public/idl/`
   - `apppack-view-service/idl/`
   with synced copies generated from runtime-owned schemas
3. Mark those copies as generated or synced artifacts.
4. Add a CI check that fails if local copies drift from runtime.

### Exit Criteria

- schema updates happen in runtime only
- downstream repos sync, not edit

## Phase 4. Formalize protocol pack ownership

### Goal

Choose one owner for source protocol packs and end split ownership.

### Recommended owner

- `ec-ai-wallet`

### Actions

1. Declare that the source pack inputs live only in:
   - `ec-ai-wallet/aidl/`
2. Keep generated wallet outputs in:
   - `ec-ai-wallet/public/idl/`
3. Add a sync/export step that publishes generated protocol pack outputs for server consumption.
4. Stop editing parallel copies of:
   - `pump_amm.meta*.json`
   - `pump_core.meta*.json`
   - `orca_whirlpool.meta*.json`
   directly inside `apppack-view-service`

### Exit Criteria

- protocol pack source has one owner
- generated outputs are consumed by both UI and server

## Phase 5. Define the transport format from pack owner to consumers

### Goal

Make pack sharing boring and deterministic.

### Options

#### Option A. Sync folder copy

The owner repo exports generated packs, and downstream repos sync them in.

Pros:

- simple
- fast to adopt

Cons:

- still copies files into multiple repos

#### Option B. Package the generated packs

Publish generated packs as a package, for example:

- `@brij-digital/apppack-protocol-packs`

Pros:

- best contract hygiene
- explicit versioning
- no hand-copied artifacts

Cons:

- slightly more release overhead

#### Option C. Dedicated protocol-pack repo

Move source packs into a dedicated repo later.

Pros:

- clean long-term ownership

Cons:

- too much churn for now

### Recommendation

Use:

1. Option A immediately
2. Option B once the pack shape stabilizes

For the current stage, Option A is preferred specifically because it preserves dev speed.

### Exit Criteria

- there is one deterministic path from source packs to consumers

## Phase 6. Add compatibility checks across all three repos

### Goal

Catch drift automatically.

### Actions

1. Add schema compatibility checks:
   - wallet vs runtime
   - view-service vs runtime
2. Add protocol-pack compatibility checks:
   - generated outputs in wallet vs consumed outputs in view-service
3. Add at least one cross-repo smoke path:
   - runtime validates pack
   - view-service loads pack
   - wallet renders pack metadata

### Exit Criteria

- drift becomes a CI failure, not a surprise

## Phase 7. Introduce the declarative ingest/runtime schema officially

### Goal

Fold the new indexing/decode direction into the shared contract model.

### Actions

1. If the new declarative decoder/runtime model is accepted, move:
   - `idl/declarative_decoder_runtime.schema.v1.json`
   into `apppack-runtime`
2. Treat it as experimental first if needed:
   - `v1-alpha`
3. Add runtime-owned validation for it.
4. Make `apppack-view-service` consume it from runtime ownership, not as a private backend-only schema copy.

### Exit Criteria

- the declarative ingest contract is either officially shared or explicitly experimental

## Phase 8. Remove duplicate ownership from `apppack-view-service`

### Goal

Turn the backend into a clean consumer of shared contracts.

### Actions

1. Remove hand-maintained divergent schema copies.
2. Remove hand-maintained divergent pack copies.
3. Keep only synced/generated inputs required by the backend runtime.
4. Update server docs to explain where specs come from.

### Exit Criteria

- `apppack-view-service` is no longer a second schema owner

## Phase 9. Stabilize release discipline

### Goal

Make changes to shared contracts predictable.

### Actions

1. Update `RELEASING.md` in runtime to include schema release expectations.
2. Define the order for changes:
   - update schema in runtime
   - update pack generator in wallet if needed
   - regenerate outputs
   - sync downstream
   - update backend/runtime code
3. Require version bumps when shared contract changes are breaking.

### Exit Criteria

- schema and pack changes follow one repeatable release process

## Recommended Immediate Sequence

If we execute this now, the best order is:

1. move shared schemas into `apppack-runtime`
2. sync wallet and view-service from runtime-owned schema files
3. declare `ec-ai-wallet` the temporary protocol-pack source owner
4. stop editing pack copies directly in `apppack-view-service`
5. add drift-check CI
6. decide whether to formalize the declarative decoder/runtime schema in runtime

This sequence is intentionally the lowest-friction version that still fixes the ownership problem.

## Definition Of Done

We can say the system has a single source of truth when:

1. shared schemas are owned by `apppack-runtime`
2. protocol pack source is owned by exactly one repo
3. wallet and view-service consume synced/generated artifacts
4. drift is CI-enforced
5. backend and frontend no longer evolve shared contracts independently

## Final Recommendation

Do not try to make both:

- `ec-ai-wallet`
- `apppack-view-service`

co-own the same schemas or protocol packs.

That is the current failure mode.

The cleanest near-term model is:

- `apppack-runtime` owns schemas
- `ec-ai-wallet` owns protocol pack authoring
- `apppack-view-service` consumes both

Once that is stable, a dedicated protocol-pack package or repo can come later if needed.
