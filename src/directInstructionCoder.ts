import * as borsh from '@coral-xyz/borsh';
import { Buffer } from 'node:buffer';
import type {
  CompiledCodecInstruction,
  CompiledCodecTypeRef,
} from './codamaIdl.js';

type CodecField = {
  name?: string;
  type: CompiledCodecTypeRef;
};

type CodecVariant = {
  name: string;
  fields?: CodecField[] | CompiledCodecTypeRef[];
};

type CodecTypeDef = {
  name: string;
  type:
    | { kind: 'struct'; fields?: CodecField[] | CompiledCodecTypeRef[] }
    | { kind: 'enum'; variants: CodecVariant[] }
    | { kind: 'type'; alias: CompiledCodecTypeRef };
};
type CodecInstructionDef = Omit<CompiledCodecInstruction, 'args'> & {
  args?: Array<{ name: string; type: CompiledCodecTypeRef }>;
};
export type DirectInstructionCodec = {
  instructions?: CodecInstructionDef[];
  types?: CodecTypeDef[];
};

type LayoutLike = {
  encode(src: unknown, buffer: Buffer, offset?: number): number;
  span: number;
  replicate?(property: string): LayoutLike;
};

function handleDefinedFields<T>(
  fields: CodecField[] | CompiledCodecTypeRef[] | undefined,
  unitCb: () => T,
  namedCb: (fields: CodecField[]) => T,
  tupleCb: (fields: CompiledCodecTypeRef[]) => T,
): T {
  if (!fields || fields.length === 0) {
    return unitCb();
  }
  const first = fields[0] as CodecField | CompiledCodecTypeRef;
  if (typeof first === 'object' && first && 'name' in first) {
    return namedCb(fields as CodecField[]);
  }
  return tupleCb(fields as CompiledCodecTypeRef[]);
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

function fieldLayout(field: { name?: string; type: CompiledCodecTypeRef }, types: CodecTypeDef[]): LayoutLike {
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

export class DirectInstructionCoder {
  private readonly instructionLayouts: Map<string, { discriminator: number[]; layout: LayoutLike }>;

  constructor(codec: DirectInstructionCodec) {
    const instructions = codec.instructions ?? [];
    const types = codec.types ?? [];
    const layouts = instructions.map((instruction) => [
      instruction.name,
      {
        discriminator: instruction.discriminator,
        layout: borsh.struct(
          (instruction.args ?? []).map((arg) => fieldLayout({ name: arg.name, type: arg.type }, types)),
        ) as LayoutLike,
      },
    ] as const);
    this.instructionLayouts = new Map(layouts);
  }

  instructionDiscriminator(name: string): Buffer {
    const layout = this.instructionLayouts.get(name);
    if (!layout) {
      throw new Error(`Instruction not found: ${name}`);
    }
    return Buffer.from(layout.discriminator);
  }

  encode(ixName: string, args: Record<string, unknown>): Buffer {
    const layout = this.instructionLayouts.get(ixName);
    if (!layout) {
      throw new Error(`Unknown instruction: ${ixName}`);
    }
    const buffer = Buffer.alloc(4096);
    const len = layout.layout.encode(args, buffer);
    return Buffer.concat([this.instructionDiscriminator(ixName), buffer.subarray(0, len)]);
  }
}
