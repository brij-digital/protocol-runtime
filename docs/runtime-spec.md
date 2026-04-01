# Runtime Spec V1 Reference

This document describes the current `solana-agent-runtime.v1` contract.

The goal of this spec is narrow:
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

Program-specific runtime logic lives in the protocol runtime file:

- `public/idl/<protocol>.runtime.json`

Examples:
- `orca_whirlpool.runtime.json`
- `pump_amm.runtime.json`
- `pump_core.runtime.json`

This file is authored by the protocol pack maintainer.

What the maintainer provides there:
- named `views`
- named `writes`
- named reusable `transforms`
- exact read input contracts
- extra runtime context that still needs to be loaded
- deterministic transform steps and reusable transform fragments
- mapping from loaded/transformed values into write args/accounts
- optional `pre` / `post` envelope instructions

What the maintainer does **not** need to restate there:
- raw instruction account schema
- signer metadata already declared in Codama
- fixed/default/PDA-backed accounts already declared in Codama

## Top-level file shape

Required top-level keys:

```json
{
  "$schema": "/idl/solana_agent_runtime.schema.v1.json",
  "schema": "solana-agent-runtime.v1",
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

Both `viewSpec` and `writeSpec` share the same preparation phase:

- `load`
  - optional
  - array of `loadStepSpec`
- `transform`
  - optional
  - array of:
    - string references to top-level `transforms`

This shared shape is intentional:
- both may need to load extra runtime state
- both may need deterministic derived values before they diverge

## `viewSpec`

A view operation has these attributes:

- `preview_instruction`
  - optional
  - Codama instruction name used only when the view needs preview account resolution
- `inputs`
  - optional
  - map of input name -> type string
- `output`
  - required
  - `outputSpec`

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
  - object schema for `type = array`
- `scalar_type`
  - optional
  - scalar type string for `type = scalar`

## `writeSpec`

A contract write operation has these attributes:

- `instruction`
  - required
  - target instruction name in Codama
- write inputs are not declared in the runtime file
  - the write input surface is sourced from Codama
  - only Codama args/accounts still referenced through `$input.*` remain visible as write inputs

- `args`
  - optional
  - map of arg name -> scalar binding
  - allowed binding values: `string`, `number`, `boolean`, `null`
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

## `transforms`

Top-level `transforms` is the only place where transform steps are declared.

Each entry is:
- a named array of `transformStepSpec`

Operations reference these entries from their local `transform` array by name.

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
      "load": [],
      "transform": ["swap_direction"]
    }
  },
  "writes": {
    "swap_exact_in": {
      "load": [],
      "transform": ["swap_direction"]
    }
  }
}
```

## Load reference

`load` brings in the extra runtime context still needed outside Codama.

### `wallet_pubkey`

Required attributes:
- `name`
- `kind = "wallet_pubkey"`

### `decode_account`

Required attributes:
- `name`
- `kind = "decode_account"`
- `address`
- `account_type`

Notes:
- Use protocol account types from the protocol Codama IDL.
- Standard account types such as `Mint` and `TokenAccount` are also supported directly.

### `account_owner`

Required attributes:
- `name`
- `kind = "account_owner"`
- `address`

### `ata`

Required attributes:
- `name`
- `kind = "ata"`
- `owner`
- `mint`

Optional attributes:
- `token_program`
- `allow_owner_off_curve`

### `pda`

Required attributes:
- `name`
- `kind = "pda"`
- `program_id`

Optional attributes:
- `seeds`

`seeds` is an array of:
- string
- any JSON value

## Transform reference

`transform` is the deterministic expression language used by named root transform fragments.

### Arithmetic kinds

`math.add`
- required: `name`, `kind`, `values`

`math.sum`
- required: `name`, `kind`, `values`

`math.mul`
- required: `name`, `kind`, `values`

`math.sub`
- required: `name`, `kind`, `values`

`math.floor_div`
- required: `name`, `kind`, `dividend`, `divisor`

### List kinds

`list.range_map`
- required: `name`, `kind`, `base`, `step`, `count`

`list.get`
- required: `name`, `kind`, `values`, `index`

`list.filter`
- required: `name`, `kind`, `items`
- optional: `where`

`list.first`
- required: `name`, `kind`, `items`
- optional: `allow_empty`

`list.min_by`
- required: `name`, `kind`, `items`, `path`
- optional: `allow_empty`

`list.max_by`
- required: `name`, `kind`, `items`, `path`
- optional: `allow_empty`

### Utility kinds

`coalesce`
- required: `name`, `kind`, `values`

`pda(seed_spec)`
- required: `name`, `kind`, `seeds`
- optional: `program_id`, `map_over`

Seed item kinds:
- `utf8`
- `pubkey`
- `i32_le`
- `item_i32_le`
- `item_utf8`

### Comparison kinds

`compare.equals`
- required: `name`, `kind`, `left`, `right`

`compare.not_equals`
- required: `name`, `kind`, `left`, `right`

`compare.gt`
- required: `name`, `kind`, `left`, `right`

`compare.gte`
- required: `name`, `kind`, `left`, `right`

`compare.lt`
- required: `name`, `kind`, `left`, `right`

`compare.lte`
- required: `name`, `kind`, `left`, `right`

### Logic kinds

`logic.if`
- required: `name`, `kind`, `condition`, `then`, `else`

### Assertion / curve kinds

`assert.not_null`
- required: `name`, `kind`, `value`
- optional: `message`

`curve.linear_interpolate_bps`
- required: `name`, `kind`, `points`, `x_bps`
- optional: `x_field`, `y_field`

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

In the Orca pack:

- `quote_exact_in`
  - previews Codama instruction `swap_v2`
  - decodes the `Whirlpool`
  - reuses a shared transform fragment
  - returns a typed quote object

- `swap_exact_in`
  - targets Codama instruction `swap_v2`
  - consumes raw Codama write inputs
  - materializes `args` and `accounts`

Minimal structural excerpt:

```json
{
  "transforms": {
    "quote_exact_in__transform": []
  },
  "views": {
    "quote_exact_in": {
      "preview_instruction": "swap_v2",
      "inputs": {
        "token_in_mint": "token_mint",
        "token_out_mint": "token_mint",
        "amount_in": "u64",
        "slippage_bps": "u16",
        "whirlpool": "pubkey",
        "unwrap_sol_output": "bool"
      },
      "load": [],
      "transform": [
        "quote_exact_in__transform"
      ],
      "output": {
        "type": "object",
        "source": "$derived"
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

This excerpt is intentionally structural. The real Orca pack uses larger transform fragments.

Real Orca transform fragment ids:

- `quote_exact_in__transform`
- `swap_exact_in__transform`

Useful references:

- runtime pack: `/idl/orca_whirlpool.runtime.json`
- Codama IDL: `/idl/orca_whirlpool.codama.json`
- live inspect UI: `/#compute`

For example, the real Orca flow derives values such as `a_to_b`, `sqrt_price_limit`, and `tick_arrays` before they are bound into the raw Codama-shaped write input surface:

```json
{
  "amount": "$input.amount_in",
  "other_amount_threshold": "$quote.output.minimum_out",
  "sqrt_price_limit": "$quote.output.sqrt_price_limit",
  "amount_specified_is_input": true,
  "a_to_b": "$quote.output.a_to_b",
  "whirlpool": "$input.whirlpool",
  "tick_array0": "$quote.output.tick_arrays.0",
  "tick_array1": "$quote.output.tick_arrays.1",
  "tick_array2": "$quote.output.tick_arrays.2"
}
```

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
- dynamic value materialization for a write
- small transaction-envelope logic around a write

Anything that requires:
- transaction A
- then read live state
- then transaction B

belongs in a higher-level runtime, not in this spec.
