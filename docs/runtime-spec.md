# Runtime Spec V1 Reference

This document describes the current `solana-agent-runtime.v1` contract.

The scope of this spec is narrow:
- it does **not** restate raw instruction structure
- it does **not** try to be a full workflow language

It only describes the deterministic runtime layer that sits on top of Codama.

## Scope boundary

This document only covers:
- `*.runtime.json`

It assumes Codama already exists for the same protocol and already owns:
- instruction structure
- named accounts
- signer metadata
- fixed/default accounts
- PDA-backed defaults when declared in Codama

## Where program-specific logic lives

Program-specific runtime logic lives in:

- `public/idl/<protocol>.runtime.json`

Examples:
- `orca_whirlpool.runtime.json`
- `pump_amm.runtime.json`
- `pump_core.runtime.json`

What the runtime pack adds on top of Codama:
- named `views`
- named `writes`
- named reusable `transforms`
- exact view input contracts
- deterministic ordered runtime steps
- optional `pre` / `post` envelope instructions
- mapping from derived values into Codama-shaped write args/accounts

What it does **not** restate:
- raw instruction account schema
- signer metadata already declared in Codama
- fixed/default/PDA-backed accounts already declared in Codama

## Top-level file shape

Required top-level keys:

```json
{
  "$schema": "/idl/solana_agent_runtime.schema.v1.json",
  "schema": "solana-agent-runtime.v1",
  "protocol_id": "orca-whirlpool-mainnet",
  "program_id": "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  "codama_path": "/idl/orca_whirlpool.codama.json",
  "label": "Orca Whirlpools",
  "views": {},
  "writes": {},
  "transforms": {}
}
```

Top-level attributes:
- `$schema`
  - optional schema path string
- `schema`
  - required
  - must be `solana-agent-runtime.v1`
- `protocol_id`
  - required
  - logical protocol identifier for the runtime pack
- `program_id`
  - required
  - Solana program id this runtime pack targets
- `codama_path`
  - required
  - `/idl/*` path to the Codama IDL used by this runtime pack
- `label`
  - optional
  - human-friendly protocol label
- `views`
  - required
  - object map from operation id to `viewSpec`
- `writes`
  - required
  - object map from operation id to `writeSpec`
- `transforms`
  - required
  - object map from transform id to an array of `transformStepSpec`

No other top-level attributes are allowed.

## Shared operation core

Both `viewSpec` and `writeSpec` share the same ordered preparation phase:

- `steps`
  - optional
  - array of `operationStepSpec`

Each operation step is either:
- a direct runtime step like `wallet_pubkey`, `decode_account`, `decode_accounts`, `ata`, `pda`, etc.
- or a transform fragment invocation:

```json
{ "kind": "transform", "transform": "quote_exact_in__quote_math" }
```

This is intentional:
- operations can interleave loading and transform execution in a fixed order
- both views and writes can reuse the same named root transforms
- the runtime no longer splits per-operation prep into separate `load` and `transform` arrays

## `viewSpec`

A view operation has these attributes:

- `load_instruction`
  - optional
  - Codama instruction name whose account context should be loaded for the view
- `load_instruction_bindings`
  - optional
  - explicit bindings used to populate that instruction context
  - supports:
    - `args`
    - `accounts`
- `inputs`
  - optional
  - map of input name -> type string
- `steps`
  - optional
  - ordered array of `operationStepSpec`
- `pre`
  - optional
  - array of `preInstructionSpec`
- `post`
  - optional
  - array of `postInstructionSpec`
- `output`
  - required
  - typed output contract for the view

`pre` / `post` on a view are useful when the view is not only computing a quote, but also previewing the transaction envelope implied by a Codama instruction context.

## Read Output Types

These types are used only by `views[*].output`.

### `outputFieldSpec`

Used inside `output.object_schema.fields`.

Attributes:
- `type`
  - required
  - string
- `description`
  - optional
  - string

### `views[*].output`

Typed output contract for a view operation.

Attributes:
- `type`
  - required
  - one of: `array`, `object`, `scalar`
- `source`
  - required
  - runtime expression string
- `object_schema`
  - optional
  - object schema for `type = object`
- `item_schema`
  - optional
  - schema for array items when `type = array`
- `scalar_type`
  - optional
  - scalar type string for `type = scalar`

## `writeSpec`

A contract write operation has these attributes:

- `instruction`
  - required
  - target instruction name in Codama
- `steps`
  - optional
  - ordered array of `operationStepSpec`
- `args`
  - optional
  - map of arg name -> scalar binding
- `accounts`
  - optional
  - map of account name -> string binding
- `remaining_accounts`
  - optional
  - either:
    - string reference, or
    - array of `{ pubkey, isSigner?, isWritable? }`
- `pre`
  - optional
  - array of `preInstructionSpec`
- `post`
  - optional
  - array of `postInstructionSpec`

Write inputs are not declared explicitly in the runtime file.

Instead, the visible write input surface is sourced from Codama and narrowed to the Codama args/accounts still referenced through `$input.*` inside the write.

## `transforms`

Top-level `transforms` is the only place where reusable transform fragments are declared.

Each entry is:
- a named array of `transformStepSpec`

Operations reference these entries from ordered `steps` by name.

Example:

```json
{
  "transforms": {
    "swap_direction": [
      {
        "name": "a_to_b",
        "kind": "compare.equals",
        "left": "$whirlpool_data.token_mint_a",
        "right": "$input.token_in_mint"
      }
    ]
  },
  "views": {
    "quote_exact_in": {
      "steps": [
        { "kind": "transform", "transform": "swap_direction" }
      ]
    }
  },
  "writes": {
    "swap_exact_in": {
      "steps": [
        { "kind": "transform", "transform": "swap_direction" }
      ]
    }
  }
}
```

## Step families

The current runtime supports these important step families:

- load / resolution:
  - `wallet_pubkey`
  - `decode_account`
  - `decode_accounts`
  - `account_owner`
  - `ata`
  - `pda`
- arithmetic:
  - `math.add`
  - `math.sum`
  - `math.mul`
  - `math.sub`
  - `math.min`
  - `math.max`
  - `math.div_round_up`
  - `math.mod`
  - `math.mul_div_floor`
  - `math.mul_div_ceil`
  - `math.shift_left`
  - `math.shift_right`
  - `math.bit_and`
- list / collection:
  - `list.range_map`
  - `list.map`
  - `list.flat_map`
  - `list.reduce`
  - `list.filter`
  - `list.find_first`
  - `list.sort_by`
  - `list.concat`
  - `list.first`
  - `list.get`
- object:
  - `object.create`
  - `object.merge`
- comparison / control:
  - `compare.equals`
  - `compare.not_equals`
  - `compare.gt`
  - `compare.gte`
  - `compare.lt`
  - `compare.lte`
  - `logic.if`
  - `coalesce`
  - `assert.not_null`
- nested transform invocation inside a transform fragment:
  - `transform`

The JSON schema is the source of truth for the full step catalog and exact attributes for each kind.

## Scoped collection transforms

`list.map`, `list.flat_map`, and `list.reduce` can execute nested steps inside the collection scope.

Example:

```json
{
  "name": "flattened",
  "kind": "list.flat_map",
  "items": "$groups",
  "item_as": "group",
  "output": "$group.values"
}
```

These scoped collection steps can also invoke another named transform with explicit bindings:

```json
{
  "name": "quote_row",
  "kind": "transform",
  "transform": "quote_tick",
  "bindings": {
    "tick": "$item",
    "direction": "$a_to_b"
  },
  "output": "$payload"
}
```

This is one of the main runtime improvements that the Orca harness ended up exercising heavily.

## Condition reference

`when` conditions in `pre` and `post` use `metaConditionSpec`.

Allowed forms:

`equals`

```json
{ "equals": ["$a", "$b"] }
```

`all`

```json
{ "all": [ { "equals": ["$a", true] }, { "equals": ["$b", false] } ] }
```

`any`

```json
{ "any": [ ... ] }
```

`not`

```json
{ "not": { "equals": ["$a", "$b"] } }
```

## Pre-instruction reference

### `spl_ata_create_idempotent`

Required attributes:
- `name`
- `kind = "spl_ata_create_idempotent"`
- `payer`
- `ata`
- `owner`
- `mint`

Optional attributes:
- `token_program`
- `associated_token_program`
- `when`

### `system_transfer`

Required attributes:
- `name`
- `kind = "system_transfer"`
- `from`
- `to`
- `lamports`

Optional attributes:
- `when`

### `spl_token_sync_native`

Required attributes:
- `name`
- `kind = "spl_token_sync_native"`
- `account`

Optional attributes:
- `token_program`
- `when`

## Post-instruction reference

### `spl_token_close_account`

Required attributes:
- `name`
- `kind = "spl_token_close_account"`
- `account`
- `destination`
- `owner`

Optional attributes:
- `token_program`
- `when`

## Orca example

The Orca runtime pack is now a good boundary test for this spec.

It exercises:
- exact-input quotes
- exact-output quotes
- ordered operation steps
- scoped collection transforms
- Codama-backed write preparation
- preview envelope instructions around a quote

In the current Orca pack:

- `quote_exact_in`
  - loads Codama instruction context for `swap_v2`
  - decodes the `Whirlpool`
  - derives tick arrays
  - decodes those tick arrays
  - runs quote math
  - previews `pre` / `post`
  - returns a typed quote object

- `swap_exact_in`
  - targets Codama instruction `swap_v2`
  - consumes raw Codama-shaped write inputs
  - materializes final args/accounts

Minimal structural excerpt:

```json
{
  "protocol_id": "orca-whirlpool-mainnet",
  "program_id": "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  "codama_path": "/idl/orca_whirlpool.codama.json",
  "transforms": {
    "quote_exact_in__derive_tick_arrays": [],
    "quote_exact_in__quote_math": []
  },
  "views": {
    "quote_exact_in": {
      "load_instruction": "swap_v2",
      "inputs": {
        "token_in_mint": "token_mint",
        "token_out_mint": "token_mint",
        "amount_in": "u64",
        "slippage_bps": "u16",
        "whirlpool": "pubkey",
        "unwrap_sol_output": "bool"
      },
      "load_instruction_bindings": {
        "args": {
          "amount": "$input.amount_in"
        },
        "accounts": {
          "whirlpool": "$input.whirlpool"
        }
      },
      "steps": [
        { "name": "wallet", "kind": "wallet_pubkey" },
        {
          "name": "whirlpool_data",
          "kind": "decode_account",
          "address": "$input.whirlpool",
          "account_type": "Whirlpool"
        },
        { "kind": "transform", "transform": "quote_exact_in__derive_tick_arrays" },
        {
          "name": "tick_arrays_data",
          "kind": "decode_accounts",
          "addresses": "$tick_arrays",
          "account_type": "TickArray"
        },
        { "kind": "transform", "transform": "quote_exact_in__quote_math" }
      ],
      "pre": [
        {
          "kind": "spl_ata_create_idempotent",
          "payer": "$wallet",
          "ata": "$instruction_accounts.token_owner_account_a",
          "owner": "$wallet",
          "mint": "$whirlpool_data.token_mint_a"
        }
      ],
      "output": {
        "type": "object",
        "source": "$derived",
        "object_schema": {
          "entity_type": "orca_quote_exact_in",
          "identity_fields": ["whirlpool"],
          "fields": {
            "whirlpool": { "type": "pubkey" },
            "token_in_mint": { "type": "pubkey" },
            "token_out_mint": { "type": "pubkey" },
            "amount_in": { "type": "u64" },
            "slippage_bps": { "type": "u16" },
            "estimated_out": { "type": "u64" },
            "minimum_out": { "type": "u64" },
            "a_to_b": { "type": "bool" },
            "pool_fee_bps": { "type": "number" }
          }
        }
      }
    }
  },
  "writes": {
    "swap_exact_in": {
      "instruction": "swap_v2",
      "args": {
        "amount": "$input.amount",
        "other_amount_threshold": "$input.other_amount_threshold",
        "sqrt_price_limit": "$input.sqrt_price_limit",
        "amount_specified_is_input": "$input.amount_specified_is_input",
        "a_to_b": "$input.a_to_b",
        "remaining_accounts_info": null
      },
      "accounts": {
        "whirlpool": "$input.whirlpool",
        "tick_array0": "$input.tick_array0",
        "tick_array1": "$input.tick_array1",
        "tick_array2": "$input.tick_array2"
      }
    }
  }
}
```

This excerpt is intentionally structural. The real Orca pack is larger and currently includes:
- `quote_exact_in`
- `quote_exact_out`
- swap writes
- liquidity parity / decrease / collect writes

Real Orca fragment ids used by the current quote flows include:
- `quote_exact_in__derive_tick_arrays`
- `quote_exact_in__quote_math`
- `quote_exact_out__derive_tick_arrays`
- `quote_exact_out__quote_math`

Useful references:
- runtime pack: `/idl/orca_whirlpool.runtime.json`
- Codama IDL: `/idl/orca_whirlpool.codama.json`
- live inspect UI: `/#compute`

## Authoring rule of thumb

Put logic in Codama when it is:
- instruction structure
- account metadata
- signer metadata
- fixed/default account resolution
- PDA-backed defaults

Put logic in the runtime spec when it is:
- deterministic protocol-specific transform
- reusable deterministic transform fragments shared by views and writes
- dynamic value materialization around a Codama write
- small transaction-envelope logic around a write or quote preview

Anything that requires:
- transaction A
- then read live state
- then transaction B

belongs in a higher-level runtime, not in this spec.
