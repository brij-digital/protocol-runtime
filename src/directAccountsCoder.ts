import * as borsh from '@coral-xyz/borsh';
import bs58 from 'bs58';
import { Buffer } from 'node:buffer';
import { listCodamaAccounts, listCodamaTypeDefs } from './codamaIdl.js';
import type {
  CodamaAccountDef,
  CodamaDocument,
  CodamaTypeRef,
  CodamaTypeDef,
} from './codamaIdl.js';

type JsonRecord = Record<string, unknown>;

type CodecField = {
  name?: string;
  type: CodamaTypeRef;
};

type CodecVariant = {
  name: string;
  fields?: CodecField[] | CodamaTypeRef[];
};

type CodecTypeDef = {
  name: string;
  type:
    | { kind: 'struct'; fields?: CodecField[] | CodamaTypeRef[] }
    | { kind: 'enum'; variants: CodecVariant[] }
    | { kind: 'type'; alias: CodamaTypeRef };
};
type CodecAccountDef = CodamaAccountDef;

type LayoutLike = {
  encode(src: unknown, buffer: Buffer, offset?: number): number;
  decode(buffer: Buffer, offset?: number): unknown;
  span: number;
  replicate?(property: string): LayoutLike;
};

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  return value;
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonRecord;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a string.`);
  }
  return value;
}

function handleDefinedFields<T>(
  fields: CodecField[] | CodamaTypeRef[] | undefined,
  unitCb: () => T,
  namedCb: (fields: CodecField[]) => T,
  tupleCb: (fields: CodamaTypeRef[]) => T,
): T {
  if (!fields || fields.length === 0) {
    return unitCb();
  }
  const first = fields[0] as CodecField | CodamaTypeRef;
  if (typeof first === 'object' && first && 'name' in first) {
    return namedCb(fields as CodecField[]);
  }
  return tupleCb(fields as CodamaTypeRef[]);
}

function resolveDefinedName(type: string | { name: string }): string {
  return typeof type === 'string' ? type : type.name;
}

function typeDefLayout(typeDef: CodecTypeDef, types: CodecTypeDef[], name?: string): LayoutLike {
  switch (typeDef.type.kind) {
    case 'struct': {
      const fieldLayouts = handleDefinedFields(
        typeDef.type.fields,
        () => [],
        (fields) => fields.map((field) => fieldLayout(field, types)),
        (fields) => fields.map((field, index) => fieldLayout({ name: String(index), type: field }, types)),
      );
      return borsh.struct(fieldLayouts, name) as LayoutLike;
    }
    case 'enum': {
      const variants = typeDef.type.variants.map((variant) => {
        const variantLayouts = handleDefinedFields(
          variant.fields,
          () => [],
          (fields) => fields.map((field) => fieldLayout(field, types)),
          (fields) => fields.map((field, index) => fieldLayout({ name: String(index), type: field }, types)),
        );
        return borsh.struct(variantLayouts, variant.name);
      });
      const layout = borsh.rustEnum(variants);
      return name ? (layout.replicate(name) as LayoutLike) : (layout as LayoutLike);
    }
    case 'type':
      return fieldLayout({ name, type: typeDef.type.alias }, types);
    default:
      throw new Error(`Unsupported type kind ${(typeDef as { type?: { kind?: string } }).type?.kind ?? 'unknown'}.`);
  }
}

function fieldLayout(field: { name?: string; type: CodamaTypeRef }, types: CodecTypeDef[]): LayoutLike {
  const fieldName = field.name;
  switch (field.type) {
    case 'bool':
      return borsh.bool(fieldName) as LayoutLike;
    case 'u8':
      return borsh.u8(fieldName) as LayoutLike;
    case 'i8':
      return borsh.i8(fieldName) as LayoutLike;
    case 'u16':
      return borsh.u16(fieldName) as LayoutLike;
    case 'i16':
      return borsh.i16(fieldName) as LayoutLike;
    case 'u32':
      return borsh.u32(fieldName) as LayoutLike;
    case 'i32':
      return borsh.i32(fieldName) as LayoutLike;
    case 'f32':
      return borsh.f32(fieldName) as LayoutLike;
    case 'f64':
      return borsh.f64(fieldName) as LayoutLike;
    case 'u64':
      return borsh.u64(fieldName) as LayoutLike;
    case 'i64':
      return borsh.i64(fieldName) as LayoutLike;
    case 'u128':
      return borsh.u128(fieldName) as LayoutLike;
    case 'i128':
      return borsh.i128(fieldName) as LayoutLike;
    case 'u256':
      return borsh.u256(fieldName) as LayoutLike;
    case 'i256':
      return borsh.i256(fieldName) as LayoutLike;
    case 'bytes':
      return borsh.vecU8(fieldName) as LayoutLike;
    case 'string':
      return borsh.str(fieldName) as LayoutLike;
    case 'pubkey':
    case 'publicKey':
      return borsh.publicKey(fieldName) as LayoutLike;
    default: {
      if (typeof field.type === 'object' && field.type) {
        if ('option' in field.type) {
          return borsh.option(fieldLayout({ type: field.type.option }, types) as never, fieldName) as unknown as LayoutLike;
        }
        if ('vec' in field.type) {
          return borsh.vec(fieldLayout({ type: field.type.vec }, types) as never, fieldName) as unknown as LayoutLike;
        }
        if ('array' in field.type) {
          const [innerType, length] = field.type.array;
          return borsh.array(fieldLayout({ type: innerType }, types) as never, length, fieldName) as unknown as LayoutLike;
        }
        if ('defined' in field.type) {
          const definedName = resolveDefinedName(field.type.defined);
          const typeDef = types.find((entry) => entry.name === definedName);
          if (!typeDef) {
            throw new Error(`Type not found: ${definedName}`);
          }
          return typeDefLayout(typeDef, types, fieldName);
        }
      }
      throw new Error(`Unsupported field type ${JSON.stringify(field.type)}`);
    }
  }
}

function typeSize(type: CodamaTypeRef, accounts: CodecAccountDef[], types: CodecTypeDef[]): number {
  switch (type) {
    case 'bool':
    case 'u8':
    case 'i8':
      return 1;
    case 'u16':
    case 'i16':
      return 2;
    case 'u32':
    case 'i32':
    case 'f32':
      return 4;
    case 'u64':
    case 'i64':
    case 'f64':
      return 8;
    case 'u128':
    case 'i128':
      return 16;
    case 'u256':
    case 'i256':
      return 32;
    case 'pubkey':
    case 'publicKey':
      return 32;
    case 'bytes':
    case 'string':
      return 1;
    default: {
      if (typeof type === 'object' && type) {
        if ('option' in type) {
          return 1 + typeSize(type.option, accounts, types);
        }
        if ('vec' in type) {
          return 1;
        }
        if ('array' in type) {
          const [innerType, length] = type.array;
          return typeSize(innerType, accounts, types) * length;
        }
        if ('defined' in type) {
          const definedName = resolveDefinedName(type.defined);
          const typeDef = types.find((entry) => entry.name === definedName);
          if (!typeDef) {
            throw new Error(`Type not found: ${definedName}`);
          }
          switch (typeDef.type.kind) {
            case 'struct':
              return handleDefinedFields(
                typeDef.type.fields,
                () => 0,
                (fields) => fields.reduce((sum, field) => sum + typeSize(field.type, accounts, types), 0),
                (fields) => fields.reduce((sum, field) => sum + typeSize(field, accounts, types), 0),
              );
            case 'enum': {
              const variantSizes = typeDef.type.variants.map((variant) =>
                handleDefinedFields(
                  variant.fields,
                  () => 0,
                  (fields) => fields.reduce((sum, field) => sum + typeSize(field.type, accounts, types), 0),
                  (fields) => fields.reduce((sum, field) => sum + typeSize(field, accounts, types), 0),
                ),
              );
              return 1 + Math.max(0, ...variantSizes);
            }
            case 'type':
              return typeSize(typeDef.type.alias, accounts, types);
            default:
              throw new Error('Unsupported type kind.');
          }
        }
      }
      throw new Error(`Unsupported type size for ${JSON.stringify(type)}`);
    }
  }
}

export class DirectAccountsCoder {
  private readonly accounts: CodecAccountDef[];
  private readonly types: CodecTypeDef[];
  private readonly accountLayouts: Map<string, { discriminator: number[]; layout: LayoutLike }>;

  constructor(codama: CodamaDocument) {
    this.accounts = listCodamaAccounts(codama) as CodecAccountDef[];
    this.types = listCodamaTypeDefs(codama) as CodecTypeDef[];
    const accounts = this.accounts;
    const types = this.types;
    const layouts = accounts.map((account) => {
      const typeDef = types.find((entry) => entry.name === account.name);
      if (!typeDef) {
        throw new Error(`Account type not found: ${account.name}`);
      }
      return [
        account.name,
        {
          discriminator: account.discriminator,
          layout: typeDefLayout(typeDef, types),
        },
      ] as const;
    });
    this.accountLayouts = new Map(layouts);
  }

  accountDiscriminator(name: string): Buffer {
    const layout = this.accountLayouts.get(name);
    if (!layout) {
      throw new Error(`Account not found: ${name}`);
    }
    return Buffer.from(layout.discriminator);
  }

  async encode(accountName: string, account: unknown): Promise<Buffer> {
    const layout = this.accountLayouts.get(accountName);
    if (!layout) {
      throw new Error(`Unknown account: ${accountName}`);
    }
    const buffer = Buffer.alloc(4096);
    const len = layout.layout.encode(account, buffer);
    const accountData = buffer.slice(0, len);
    return Buffer.concat([this.accountDiscriminator(accountName), accountData]);
  }

  decode(accountName: string, data: Buffer | Uint8Array): unknown {
    const discriminator = this.accountDiscriminator(accountName);
    const bytes = Buffer.from(data);
    if (discriminator.compare(bytes.subarray(0, discriminator.length)) !== 0) {
      throw new Error('Invalid account discriminator');
    }
    return this.decodeUnchecked(accountName, bytes);
  }

  decodeUnchecked(accountName: string, data: Buffer | Uint8Array): unknown {
    const layout = this.accountLayouts.get(accountName);
    if (!layout) {
      throw new Error(`Unknown account: ${accountName}`);
    }
    const discriminator = this.accountDiscriminator(accountName);
    return layout.layout.decode(Buffer.from(data).subarray(discriminator.length));
  }

  decodeAny(data: Buffer | Uint8Array): unknown {
    const bytes = Buffer.from(data);
    for (const [accountName, layout] of this.accountLayouts.entries()) {
      const discriminator = Buffer.from(layout.discriminator);
      if (bytes.subarray(0, discriminator.length).equals(discriminator)) {
        return this.decodeUnchecked(accountName, bytes);
      }
    }
    throw new Error('Account not found');
  }

  memcmp(accountName: string, appendData?: Buffer): { offset: number; bytes: string } {
    const discriminator = this.accountDiscriminator(accountName);
    return {
      offset: 0,
      bytes: bs58.encode(appendData ? Buffer.concat([discriminator, appendData]) : discriminator),
    };
  }

  size(accountName: string): number {
    const account = this.accounts.find((entry) => entry.name === accountName);
    if (!account) {
      throw new Error(`Account not found: ${accountName}`);
    }
    return Buffer.from(account.discriminator).length + typeSize({ defined: { name: accountName } }, this.accounts, this.types);
  }
}
