import { resolveAppUrl } from './appUrl.js';
import { loadProtocolRuntimeSpec } from './idlRegistry.js';

type JsonRecord = Record<string, unknown>;

type RuntimeDecoderArtifact = {
  codamaPath?: string;
};

export type CodamaDocument = JsonRecord;

export type CodamaTypeRef =
  | string
  | { option: CodamaTypeRef }
  | { vec: CodamaTypeRef }
  | { array: [CodamaTypeRef, number] }
  | { defined: { name: string } };

export type CodamaInstructionAccountDef = {
  name: string;
  writable?: boolean;
  signer?: boolean;
  optional?: boolean;
  address?: string;
};

export type CodamaInstructionArgDef = {
  name: string;
  type: CodamaTypeRef;
};

export type CodamaInstructionDef = {
  name: string;
  discriminator: number[];
  accounts: CodamaInstructionAccountDef[];
  args: CodamaInstructionArgDef[];
};

export type CodamaAccountDef = {
  name: string;
  discriminator: number[];
};

export type CodamaTypeDef = {
  name: string;
  type:
    | { kind: 'struct'; fields: Array<{ name: string; type: CodamaTypeRef | unknown }> }
    | { kind: 'enum'; variants: Array<{ name: string; fields?: Array<{ name: string; type: CodamaTypeRef | unknown }> | Array<CodamaTypeRef | unknown> }> }
    | CodamaTypeRef
    | unknown;
};

const codamaFetchCache = new Map<string, Promise<JsonRecord>>();
const protocolCodamaCache = new Map<string, Promise<CodamaDocument>>();
const instructionCache = new WeakMap<JsonRecord, CodamaInstructionDef[]>();
const accountCache = new WeakMap<JsonRecord, CodamaAccountDef[]>();
const typeDefCache = new WeakMap<JsonRecord, CodamaTypeDef[]>();

function asObject(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonRecord;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  return value;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .replace(/__+/g, '_')
    .toLowerCase();
}

function toPascalCase(value: string): string {
  return value
    .replace(/(^|[_-])([a-z0-9])/g, (_match, _sep, char) => char.toUpperCase())
    .replace(/[^A-Za-z0-9]/g, '');
}

function extractBytes(value: unknown, label: string): number[] {
  const node = asObject(value, label);
  const encoding = asString(node.encoding, `${label}.encoding`);
  if (encoding !== 'base16') {
    throw new Error(`${label}.encoding must be base16.`);
  }
  const data = asString(node.data, `${label}.data`);
  if (data.length % 2 !== 0) {
    throw new Error(`${label}.data must have even hex length.`);
  }
  const bytes: number[] = [];
  for (let index = 0; index < data.length; index += 2) {
    bytes.push(Number.parseInt(data.slice(index, index + 2), 16));
  }
  return bytes;
}

function extractDiscriminatorField(fields: unknown[], label: string): number[] {
  const discriminatorField = fields.find((field) => asObject(field, label).name === 'discriminator');
  if (!discriminatorField) {
    throw new Error(`${label} is missing discriminator field.`);
  }
  const defaultValue = asObject(discriminatorField, label).defaultValue;
  if (!defaultValue) {
    throw new Error(`${label}.discriminator defaultValue missing.`);
  }
  return extractBytes(defaultValue, `${label}.discriminator.defaultValue`);
}

function convertTypeNode(typeNode: unknown, context: string): CodamaTypeRef | unknown {
  const node = asObject(typeNode, context);
  switch (node.kind) {
    case 'publicKeyTypeNode':
      return 'pubkey';
    case 'stringTypeNode':
      return 'string';
    case 'bytesTypeNode':
      return 'bytes';
    case 'numberTypeNode':
      return asString(node.format, `${context}.format`);
    case 'booleanTypeNode':
      return 'bool';
    case 'definedTypeLinkNode':
      return { defined: { name: toPascalCase(asString(node.name, `${context}.name`)) } };
    case 'optionTypeNode':
      return { option: convertTypeNode(node.item ?? node.type, `${context}.item`) as CodamaTypeRef };
    case 'arrayTypeNode': {
      const item = convertTypeNode(node.item, `${context}.item`) as CodamaTypeRef;
      const count = asObject(node.count, `${context}.count`);
      if (count.kind === 'fixedCountNode') {
        return { array: [item, Number(count.value)] };
      }
      if (count.kind === 'prefixedCountNode') {
        return { vec: item };
      }
      throw new Error(`${context}.count kind ${String(count.kind)} is unsupported.`);
    }
    case 'fixedSizeTypeNode': {
      const size = Number(node.size);
      const inner = asObject(node.type, `${context}.type`);
      if (inner.kind === 'bytesTypeNode') {
        return { array: ['u8', size] };
      }
      throw new Error(`${context} fixedSizeTypeNode is unsupported unless wrapping bytes.`);
    }
    case 'sizePrefixTypeNode':
      return convertTypeNode(node.type, `${context}.type`);
    case 'tupleTypeNode': {
      const items = asArray(node.items, `${context}.items`).map((item, index) =>
        convertTypeNode(item, `${context}.items[${index}]`),
      );
      return { kind: 'struct', fields: items };
    }
    default:
      throw new Error(`${context} kind ${String(node.kind)} is unsupported in Codama access.`);
  }
}

function convertStructFields(fields: unknown, context: string) {
  return asArray(fields, `${context}.fields`)
    .filter((field) => asObject(field, context).name !== 'discriminator')
    .map((field, index) => {
      const entry = asObject(field, `${context}.fields[${index}]`);
      return {
        name: toSnakeCase(asString(entry.name, `${context}.fields[${index}].name`)),
        type: convertTypeNode(entry.type, `${context}.fields[${index}].type`),
      };
    });
}

function convertEnumVariant(variant: unknown, context: string): Record<string, unknown> {
  const entry = asObject(variant, context);
  const out: Record<string, unknown> = {
    name: toPascalCase(asString(entry.name, `${context}.name`)),
  };
  if (entry.kind === 'enumStructVariantTypeNode') {
    out.fields = convertStructFields(entry.struct ? asObject(entry.struct, `${context}.struct`).fields : entry.fields, `${context}.fields`);
    return out;
  }
  if (entry.kind === 'enumTupleVariantTypeNode') {
    const items = entry.tuple ? asObject(entry.tuple, `${context}.tuple`).items : entry.items;
    out.fields = asArray(items, `${context}.items`).map((item, index) =>
      convertTypeNode(item, `${context}.items[${index}]`),
    );
  }
  return out;
}

function convertDefinedType(definedType: unknown, context: string): CodamaTypeDef {
  const entry = asObject(definedType, context);
  const type = asObject(entry.type, `${context}.type`);
  const name = toPascalCase(asString(entry.name, `${context}.name`));
  if (type.kind === 'structTypeNode') {
    return {
      name,
      type: {
        kind: 'struct',
        fields: convertStructFields(type.fields, `${context}.type`),
      },
    };
  }
  if (type.kind === 'enumTypeNode') {
    return {
      name,
      type: {
        kind: 'enum',
        variants: asArray(type.variants, `${context}.type.variants`).map((variant, index) =>
          convertEnumVariant(variant, `${context}.type.variants[${index}]`) as {
            name: string;
            fields?: Array<{ name: string; type: CodamaTypeRef | unknown }> | Array<CodamaTypeRef | unknown>;
          },
        ),
      },
    };
  }
  if (type.kind === 'tupleTypeNode') {
    return {
      name,
      type: convertTypeNode(type, `${context}.type`),
    };
  }
  throw new Error(`${context}.type kind ${String(type.kind)} is unsupported.`);
}

function convertInstructionAccount(account: unknown, context: string): CodamaInstructionAccountDef {
  const entry = asObject(account, context);
  const output: CodamaInstructionAccountDef = {
    name: toSnakeCase(asString(entry.name, `${context}.name`)),
  };
  if (entry.isWritable === true) {
    output.writable = true;
  }
  if (entry.isSigner === true) {
    output.signer = true;
  }
  if (entry.isOptional === true) {
    output.optional = true;
  }
  const defaultValue = entry.defaultValue ? asObject(entry.defaultValue, `${context}.defaultValue`) : null;
  if (defaultValue?.kind === 'publicKeyValueNode') {
    output.address = asString(defaultValue.publicKey, `${context}.defaultValue.publicKey`);
  }
  return output;
}

function convertInstruction(instruction: unknown, context: string): CodamaInstructionDef {
  const entry = asObject(instruction, context);
  const argumentsNode = asArray(entry.arguments, `${context}.arguments`);
  const discriminatorArg = argumentsNode.find((argument) => asObject(argument, `${context}.arguments`).name === 'discriminator');
  if (!discriminatorArg) {
    throw new Error(`${context} is missing discriminator argument.`);
  }
  const discriminator = extractBytes(asObject(discriminatorArg, `${context}.arguments.discriminator`).defaultValue, `${context}.arguments.discriminator.defaultValue`);
  return {
    name: toSnakeCase(asString(entry.name, `${context}.name`)),
    discriminator,
    accounts: asArray(entry.accounts, `${context}.accounts`).map((account, index) =>
      convertInstructionAccount(account, `${context}.accounts[${index}]`),
    ),
    args: argumentsNode
      .filter((argument) => asObject(argument, `${context}.arguments`).name !== 'discriminator')
      .map((argument, index) => {
        const arg = asObject(argument, `${context}.arguments[${index}]`);
        return {
          name: toSnakeCase(asString(arg.name, `${context}.arguments[${index}].name`)),
          type: convertTypeNode(arg.type, `${context}.arguments[${index}].type`) as CodamaTypeRef,
        };
      }),
  };
}

function convertAccount(account: unknown, context: string): CodamaAccountDef {
  const entry = asObject(account, context);
  const data = asObject(entry.data, `${context}.data`);
  if (data.kind !== 'structTypeNode') {
    throw new Error(`${context}.data kind ${String(data.kind)} is unsupported.`);
  }
  const fields = asArray(data.fields, `${context}.data.fields`);
  return {
    name: toPascalCase(asString(entry.name, `${context}.name`)),
    discriminator: extractDiscriminatorField(fields, `${context}.data`),
  };
}

function convertAccountType(account: unknown, context: string): CodamaTypeDef {
  const entry = asObject(account, context);
  const data = asObject(entry.data, `${context}.data`);
  if (data.kind !== 'structTypeNode') {
    throw new Error(`${context}.data kind ${String(data.kind)} is unsupported.`);
  }
  return {
    name: toPascalCase(asString(entry.name, `${context}.name`)),
    type: {
      kind: 'struct',
      fields: convertStructFields(data.fields, `${context}.data`),
    },
  };
}

function getProgram(codama: CodamaDocument): JsonRecord {
  return asObject(asObject(codama, 'codama').program, 'codama.program');
}

async function loadJsonByPath<T>(filePath: string): Promise<T> {
  const cacheKey = filePath;
  if (!codamaFetchCache.has(cacheKey)) {
    codamaFetchCache.set(
      cacheKey,
      fetch(resolveAppUrl(filePath)).then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to load JSON from ${filePath}.`);
        }
        return (await response.json()) as JsonRecord;
      }),
    );
  }
  return (await codamaFetchCache.get(cacheKey)!) as T;
}

function resolveProtocolCodecArtifact(runtime: { decoderArtifacts?: Record<string, RuntimeDecoderArtifact> }, protocolId: string) {
  const artifactEntries = Object.entries(runtime.decoderArtifacts ?? {});
  if (artifactEntries.length === 0) {
    throw new Error(`Protocol ${protocolId} runtime spec declares no decoder artifacts.`);
  }
  if (artifactEntries.length > 1) {
    throw new Error(`Protocol ${protocolId} declares multiple decoder artifacts; runtime decode resolution is ambiguous.`);
  }
  return artifactEntries[0]!;
}

export async function loadProtocolCodamaFromRuntime(protocolId: string): Promise<CodamaDocument> {
  if (!protocolCodamaCache.has(protocolId)) {
    protocolCodamaCache.set(
      protocolId,
      (async () => {
        const runtime = await loadProtocolRuntimeSpec(protocolId);
        if (!runtime) {
          throw new Error(`Protocol ${protocolId} has no runtime spec; active runtime decode requires runtime-backed protocols.`);
        }
        const [artifactName, artifact] = resolveProtocolCodecArtifact(runtime, protocolId);
        const codamaPath = asString((artifact as RuntimeDecoderArtifact).codamaPath, `${protocolId}.decoderArtifacts.${artifactName}.codamaPath`);
        return await loadJsonByPath<CodamaDocument>(codamaPath);
      })(),
    );
  }
  return await protocolCodamaCache.get(protocolId)!;
}

export function listCodamaInstructions(codama: CodamaDocument): CodamaInstructionDef[] {
  const cached = instructionCache.get(codama);
  if (cached) {
    return cached;
  }
  const program = getProgram(codama);
  const instructions = asArray(program.instructions ?? [], 'codama.program.instructions').map((instruction, index) =>
    convertInstruction(instruction, `codama.program.instructions[${index}]`),
  );
  instructionCache.set(codama, instructions);
  return instructions;
}

export function listCodamaAccounts(codama: CodamaDocument): CodamaAccountDef[] {
  const cached = accountCache.get(codama);
  if (cached) {
    return cached;
  }
  const program = getProgram(codama);
  const accounts = asArray(program.accounts ?? [], 'codama.program.accounts').map((account, index) =>
    convertAccount(account, `codama.program.accounts[${index}]`),
  );
  accountCache.set(codama, accounts);
  return accounts;
}

export function listCodamaTypeDefs(codama: CodamaDocument): CodamaTypeDef[] {
  const cached = typeDefCache.get(codama);
  if (cached) {
    return cached;
  }
  const program = getProgram(codama);
  const accounts = asArray(program.accounts ?? [], 'codama.program.accounts');
  const definedTypes = asArray(program.definedTypes ?? [], 'codama.program.definedTypes');
  const types = [
    ...accounts.map((account, index) => convertAccountType(account, `codama.program.accounts[${index}]`)),
    ...definedTypes.map((definedType, index) => convertDefinedType(definedType, `codama.program.definedTypes[${index}]`)),
  ];
  typeDefCache.set(codama, types);
  return types;
}

export function findCodamaInstructionByName(codama: CodamaDocument, instructionName: string): CodamaInstructionDef | null {
  const normalizedTarget = toSnakeCase(instructionName);
  return (
    listCodamaInstructions(codama).find((candidate) => candidate.name === instructionName) ??
    listCodamaInstructions(codama).find((candidate) => toSnakeCase(candidate.name) === normalizedTarget) ??
    null
  );
}

export function findCodamaAccountByName(codama: CodamaDocument, accountName: string): CodamaAccountDef | null {
  const normalizedTarget = toSnakeCase(accountName);
  return (
    listCodamaAccounts(codama).find((candidate) => candidate.name === accountName) ??
    listCodamaAccounts(codama).find((candidate) => toSnakeCase(candidate.name) === normalizedTarget) ??
    null
  );
}

export function findCodamaTypeDefByName(codama: CodamaDocument, typeName: string): CodamaTypeDef | null {
  const normalizedTarget = toSnakeCase(typeName);
  return (
    listCodamaTypeDefs(codama).find((candidate) => candidate.name === typeName) ??
    listCodamaTypeDefs(codama).find((candidate) => toSnakeCase(candidate.name) === normalizedTarget) ??
    null
  );
}
