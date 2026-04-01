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
- named `reads`
- named `writes`
- named reusable `transforms`
- exact input contracts
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
  "reads": {},
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
- `reads`
  - required
  - object map from operation id to `readSpec`
- `writes`
  - required
  - object map from operation id to `writeSpec`
- `transforms`
  - required
  - object map from transform id to `transformSpec`

No other top-level attributes are allowed.

## Shared attribute types

### `inputSpec`

Used inside `inputs`.

Attributes:
- `type`
  - required
  - string
- `required`
  - optional
  - boolean
- `default`
  - optional
  - any JSON value

### `outputFieldSpec`

Used inside `read_output.object_schema.fields`.

Attributes:
- `type`
  - required
  - string
- `required`
  - optional
  - boolean
- `description`
  - optional
  - string

### `readOutputSpec`

Typed output contract for a compute or write operation.

Attributes:
- `type`
  - required
  - one of: `array`, `object`, `scalar`, `list`
- `source`
  - required
  - runtime expression string
- `object_schema`
  - optional
  - object schema for `type = object`
- `item_schema`
  - optional
  - object schema for `type = array` or `list`
- `scalar_type`
  - optional
  - scalar type string for `type = scalar`

## Shared operation core

Both `readSpec` and `writeSpec` share the same preparation phase:

- `instruction`
  - optional
  - string
  - instruction name for contextual alignment with Codama
- `inputs`
  - optional
  - map of input name -> `inputSpec`
- `load`
  - optional
  - array of `loadStepSpec`
- `transform`
  - optional
  - array of:
    - inline `transformStepSpec`, or
    - string references to top-level `transforms`

This shared shape is intentional:
- reads and writes often need the same input contract
- both may need to load extra runtime state
- both may need deterministic derived values before they diverge

## `readSpec`

A read operation has these attributes:

- `read_output`
  - optional
  - `readOutputSpec`

## `writeSpec`

A contract write operation has these attributes:

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
- `read_output`
  - optional
  - `readOutputSpec`

## `transformSpec`

Top-level `transforms` is a reusable catalog.

Each entry is:
- a named array of `transformStepSpec`

Operations can reference these entries from their local `transform` array by name.

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
  "reads": {
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

### `account_owner`

Required attributes:
- `name`
- `kind = "account_owner"`
- `address`

### `token_account_balance`

Required attributes:
- `name`
- `kind = "token_account_balance"`
- `address`

Optional attributes:
- `allow_missing`
- `default`

### `token_supply`

Required attributes:
- `name`
- `kind = "token_supply"`
- `mint`

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

`transform` is the deterministic expression language used inside a read or write operation.

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
  - decodes the `Whirlpool`
  - derives direction, tick arrays, `estimated_out`, `minimum_out`
  - returns a typed quote object

- `swap_exact_in`
  - targets Codama instruction `swap_v2`
  - reuses deterministic logic
  - fills `args`
  - materializes dynamic accounts
  - adds `pre` / `post` instructions for ATA and WSOL handling

Minimal excerpt:

```json
{
  "instruction": "swap_v2",
  "load": [
    {
      "name": "wallet",
      "kind": "wallet_pubkey"
    },
    {
      "name": "whirlpool_data",
      "kind": "decode_account",
      "address": "$input.whirlpool",
      "account_type": "Whirlpool"
    }
  ],
  "transform": [
    {
      "name": "a_to_b",
      "kind": "compare.equals",
      "left": "$whirlpool_data.token_mint_a",
      "right": "$input.token_in_mint"
    },
    {
      "name": "minimum_out",
      "kind": "coalesce",
      "values": ["$other_amount_threshold"]
    }
  ],
  "args": {
    "amount": "$input.amount_in",
    "other_amount_threshold": "$other_amount_threshold"
  }
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
- reusable deterministic transform fragments shared by reads and writes
- dynamic value materialization for a write
- small transaction-envelope logic around a write

Anything that requires:
- transaction A
- then read live state
- then transaction B

belongs in a higher-level runtime, not in this spec.
