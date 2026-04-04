# Declarative Decoder Runtime V1

`declarative-decoder-runtime.v1` covers two related document shapes:

1. **Ingest spec** (`*.ingest.json`) — how raw chain events become canonical records and state
2. **Indexed reads spec** (`*.indexed-reads.json`) — how stored facts are queried and projected

Both files share the same `schema: "declarative-decoder-runtime.v1"` header but serve different purposes.

## Architecture

```
Chain events → [Ingest spec] → Raw canonical facts → Postgres
                                                        ↓
Client request → [Indexed reads spec] → Filter/Sort/Aggregate → Response
```

### Design rules

**Ingest pipelines** store only raw canonical facts:
- ✅ Direct values from event/account payload
- ✅ Small pure normalization (unit conversion, rename, booleans)
- 🚫 No joins (`state.lookup`)
- 🚫 No external calls (`rpc.token_supply`)
- 🚫 No derived business metrics (market cap, liquidity, price)

**Indexed reads** expose stored facts:
- ✅ Filter, sort, aggregate, reshape
- 🚫 No enrichment at query time

**Enrichment** (price, market cap, liquidity) belongs in the runtime view layer, computed at read time, not baked into indexed data.

## Registry fields

Each protocol declares both paths in `registry.json`:

```json
{
  "id": "pump-amm-mainnet",
  "ingestSpecPath": "/idl/pump_amm.ingest.json",
  "indexedReadsPath": "/idl/pump_amm.indexed-reads.json"
}
```

- `ingestSpecPath` — used by the Carbon plan compiler. `null` for protocols with no ingest (e.g. manual token index).
- `indexedReadsPath` — used by the canonical view runner and query layer.

---

## Ingest Spec (`*.ingest.json`)

### Top-level shape

```json
{
  "schema": "declarative-decoder-runtime.v1",
  "protocolId": "pump-amm-mainnet",
  "programId": "$protocol.programId",
  "decoderArtifacts": {},
  "sources": {},
  "matchRules": [],
  "pipelines": {}
}
```

### `decoderArtifacts`

Declare how program data gets decoded.

```json
{
  "pump_swap": {
    "kind": "generated_idl_decoder",
    "family": "codama",
    "codamaPath": "/idl/pump_amm.codama.json",
    "artifact": "pump_swap"
  }
}
```

### `sources`

Declare where updates come from.

```json
{
  "pump_swap_crawler": {
    "kind": "rpc_transaction_crawler",
    "programId": "$protocol.programId",
    "commitment": "confirmed",
    "decoderRef": "pump_swap",
    "decodeTargets": ["instruction", "log_event"]
  }
}
```

### `matchRules`

Route decoded updates into named pipelines.

```json
[
  {
    "source": "pump_swap_crawler",
    "match": { "decodedType": "event", "name": "BuyEvent" },
    "pipeline": "trade_buy"
  }
]
```

### `pipelines`

Each pipeline has: `extract` → `compute` → `emit`.

**No `resolve` steps.** Ingest pipelines do not join external state or call RPC. If a pipeline needs data not present in the decoded event, that data should come from the event itself or be handled at read time.

```json
{
  "trade_buy": {
    "extract": {
      "pool": "$decoded.pool",
      "user": "$decoded.user",
      "side": "buy",
      "baseAmountAtomic": "$decoded.base_amount_out",
      "quoteAmountAtomic": "$decoded.quote_amount_in"
    },
    "compute": [
      {
        "name": "baseAmountUi",
        "compute": "math.amount_ui",
        "amount": "$ctx.baseAmountAtomic",
        "decimals": 9
      }
    ],
    "emit": {
      "record": {
        "recordName": "BuyEvent",
        "subjectId": "$ctx.pool",
        "payload": { "...": "raw facts only" }
      }
    }
  }
}
```

#### Allowed compute ops in ingest

Only pure normalization:
- `math.amount_ui` — atomic to UI unit conversion
- `math.add`, `math.sub`, `math.mul` — basic arithmetic on same-payload values
- `math.safe_div` — division with zero guard
- `compare.gt`, `compare.equals` — boolean checks
- `logic.if` — conditional selection
- `coalesce` — first non-null value

---

## Indexed Reads Spec (`*.indexed-reads.json`)

### Top-level shape

```json
{
  "schema": "declarative-decoder-runtime.v1",
  "protocolId": "pump-amm-mainnet",
  "programId": "$protocol.programId",
  "operations": {}
}
```

### `operations`

Each operation defines an indexed read surface.

```json
{
  "trade_feed": {
    "index_view": {
      "kind": "search",
      "canonical": {
        "source": "indexed_idl_records",
        "protocol_id": "pump-amm-mainnet",
        "record_kind": "event",
        "record_name": ["BuyEvent", "SellEvent"]
      },
      "projection": {
        "projection_kind": "feed",
        "sort_by": [{ "field": "eventTime", "dir": "desc" }]
      }
    }
  }
}
```

#### Projection kinds

| Kind | Description | Allowed ops |
|---|---|---|
| `feed` | Chronological event stream | sort, limit |
| `snapshot` | Latest state per subject | filter, sort |
| `series` | Time-bucketed aggregation (OHLCV) | aggregate, bucket |
| `ranking` | Scored/sorted items | filter, sort, score |
| `search` | Filterable state queries | filter, sort |

---

## Unsupported in V1 authoring

- `resolve` steps in ingest pipelines
- registry-level `indexingSpecPath`
- top-level `projectionSpecs`

These are outside the supported authoring model. Ingest is `extract -> compute -> emit`, and projection/query configuration lives in `*.indexed-reads.json`.
