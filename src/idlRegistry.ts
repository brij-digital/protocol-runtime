import fs from 'node:fs';
import path from 'node:path';
import { resolveAppUrl } from './appUrl.js';

export type ProtocolManifest = {
  id: string;
  name: string;
  network: string;
  programId: string;
  codamaIdlPath?: string;
  agentRuntimePath?: string;
  indexingSpecPath?: string;
  transport: string;
  supportedCommands: string[];
  status: 'active' | 'inactive';
};

type RegistryShape = {
  version: string;
  globalCommands?: string[];
  protocols: ProtocolManifest[];
};

type RuntimeDecoderArtifact = {
  codamaPath?: string;
};

type RuntimeInputSpec = {
  type: string;
  required?: boolean;
  default?: unknown;
};

type ReadOutputSpec = {
  type: 'array' | 'object' | 'scalar' | 'list';
  source: string;
  object_schema?: Record<string, unknown>;
  item_schema?: Record<string, unknown>;
  scalar_type?: string;
};

type IndexingSpecShape = {
  schema: string;
  protocolId: string;
  decoderArtifacts?: Record<string, RuntimeDecoderArtifact>;
  operations?: Record<string, {
    index_view?: {
      kind?: string;
      inputs?: Record<string, RuntimeInputSpec>;
      read_output?: ReadOutputSpec;
    };
  }>;
};

type AgentRuntimeShape = {
  schema: string;
  protocol: {
    protocolId?: string;
  };
  computes?: Record<string, unknown>;
  contract_writes?: Record<string, unknown>;
};

let registryCache: RegistryShape | null = null;
const indexingSpecCache = new Map<string, IndexingSpecShape | null>();
const agentRuntimeCache = new Map<string, AgentRuntimeShape | null>();

function resolveLocalRegistryPath(): string | null {
  if (typeof window !== 'undefined') {
    return null;
  }
  const explicit = typeof process !== 'undefined' && process.env
    ? process.env.APPPACK_RUNTIME_REGISTRY_PATH
    : undefined;
  if (typeof explicit !== 'string' || explicit.trim().length === 0) {
    return null;
  }
  return path.resolve(explicit.trim());
}

function readLocalJson<T>(absolutePath: string): T {
  return JSON.parse(fs.readFileSync(absolutePath, 'utf8')) as T;
}

export async function loadRegistry(): Promise<RegistryShape> {
  if (registryCache) {
    return registryCache;
  }

  const localRegistryPath = resolveLocalRegistryPath();
  if (localRegistryPath) {
    const parsed = readLocalJson<RegistryShape>(localRegistryPath);
    registryCache = parsed;
    return parsed;
  }

  const response = await fetch(resolveAppUrl('/idl/registry.json'));
  if (!response.ok) {
    throw new Error('Failed to load local IDL registry.');
  }

  const parsed = (await response.json()) as RegistryShape;
  registryCache = parsed;
  return parsed;
}

export async function getProtocolById(protocolId: string): Promise<ProtocolManifest> {
  const registry = await loadRegistry();
  const manifest = registry.protocols.find((protocol) => protocol.id === protocolId);

  if (!manifest) {
    throw new Error(`Protocol ${protocolId} not found in local IDL registry.`);
  }
  if (manifest.status === 'inactive') {
    throw new Error(`Protocol ${protocolId} is inactive in the local IDL registry.`);
  }

  return manifest;
}

async function loadJsonByPath<T>(filePath: string): Promise<T> {
  const localRegistryPath = resolveLocalRegistryPath();
  if (localRegistryPath) {
    if (!filePath.startsWith('/idl/')) {
      throw new Error(`Local runtime registry only supports /idl/* JSON paths. Got ${filePath}.`);
    }
    const resolvedPath = path.resolve(path.dirname(localRegistryPath), filePath.slice('/idl/'.length));
    return readLocalJson<T>(resolvedPath);
  }

  const response = await fetch(resolveAppUrl(filePath));
  if (!response.ok) {
    throw new Error(`Failed to load JSON from ${filePath}.`);
  }
  return (await response.json()) as T;
}

export async function loadProtocolIndexingSpec(protocolId: string): Promise<IndexingSpecShape | null> {
  if (indexingSpecCache.has(protocolId)) {
    return indexingSpecCache.get(protocolId)!;
  }

  const manifest = await getProtocolById(protocolId);
  if (!manifest.indexingSpecPath) {
    indexingSpecCache.set(protocolId, null);
    return null;
  }

  const parsed = await loadJsonByPath<IndexingSpecShape>(manifest.indexingSpecPath);
  if (parsed.schema !== 'declarative-decoder-runtime.v1') {
    throw new Error(`Protocol ${protocolId} indexing spec at ${manifest.indexingSpecPath} is not declarative-decoder-runtime.v1.`);
  }
  if (parsed.protocolId !== protocolId) {
    throw new Error(`Protocol ${protocolId} indexing spec protocolId mismatch: ${parsed.protocolId}.`);
  }

  indexingSpecCache.set(protocolId, parsed);
  return parsed;
}

export async function loadProtocolAgentRuntime(protocolId: string): Promise<AgentRuntimeShape | null> {
  if (agentRuntimeCache.has(protocolId)) {
    return agentRuntimeCache.get(protocolId)!;
  }

  const manifest = await getProtocolById(protocolId);
  if (!manifest.agentRuntimePath) {
    agentRuntimeCache.set(protocolId, null);
    return null;
  }

  const parsed = await loadJsonByPath<AgentRuntimeShape>(manifest.agentRuntimePath);
  if (parsed.schema !== 'solana-agent-runtime.v1') {
    throw new Error(`Protocol ${protocolId} agent runtime at ${manifest.agentRuntimePath} is not solana-agent-runtime.v1.`);
  }
  if (parsed.protocol?.protocolId !== protocolId) {
    throw new Error(`Protocol ${protocolId} agent runtime protocolId mismatch: ${String(parsed.protocol?.protocolId)}.`);
  }

  agentRuntimeCache.set(protocolId, parsed);
  return parsed;
}
