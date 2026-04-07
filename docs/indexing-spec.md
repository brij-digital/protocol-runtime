# Declarative Indexing Specs

AppPack indexing is now split into two explicit spec families:

1. `*.ingest.json`
- source-of-truth for canonical raw ingest
- decoded updates -> `extract -> compute -> emit`
- writes only raw canonical records and state

2. `*.entities.json`
- source-of-truth for materialized layer-2 read tables
- projector reads canonical raw, executes the entity transform DSL, and writes entity tables

The old `*.indexed-reads.json` compatibility shape is removed.

## Registry Model

`registry.json` now uses:

- `protocols[]` for protocol metadata, Codama, and runtime packs
- `indexings[]` for indexing jobs
- `indexings[].sources[]` for ingest source declarations
- `indexings[].entitySchemaPath` for entity specs

## Ingest Spec (`*.ingest.json`)

Top-level shape:

```json
{
  "schema": "declarative-decoder-runtime.v1",
  "sourceProtocolIds": ["pump-amm-mainnet"],
  "programId": "$protocol.programId",
  "decoderArtifacts": {},
  "sources": {},
  "matchRules": [],
  "pipelines": {}
}
```

Supported model:

- `decoderArtifacts`
- `sources`
- `matchRules`
- `pipelines`

The ingest DSL is for canonical raw emission only. It does not define query surfaces.

## Entity Specs (`*.entities.json`)

Entity specs live in `protocol-registry/indexing/entities/` and are consumed by `protocol-indexing`.

Each entity spec owns exactly one materialized table and uses a declarative transform pipeline:

- `source`
- `transform.extract`
- `transform.compute`
- `transform.groupBy`
- `transform.reduce`
- `emit`

That layer is no longer represented as `operations.index_view`.

## Design Rule

- ingest owns raw completeness
- entities own materialized read tables
- runtime owns deterministic read/write execution

No backward-compatibility path should reintroduce:

- `indexedReadsPath`
- `*.indexed-reads.json`
- `index_view`
