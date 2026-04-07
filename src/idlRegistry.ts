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
  transport: string;
  supportedCommands: string[];
  status: 'active' | 'inactive';
};

export type IndexingSourceManifest = {
  id: string;
  protocolId: string;
  ingestSpecPath: string;
  dependsOn?: string[];
};

export type IndexingManifest = {
  id: string;
  entitySchemaPath?: string;
  sources: IndexingSourceManifest[];
  status: 'active' | 'inactive';
};

type RegistryShape = {
  version: string;
  globalCommands?: string[];
  protocols: ProtocolManifest[];
  indexings?: IndexingManifest[];
};

type AgentRuntimeShape = {
  schema: string;
  protocol_id: string;
  program_id: string;
  codama_path: string;
  label?: string;
  views?: Record<string, unknown>;
  writes?: Record<string, unknown>;
  transforms?: Record<string, unknown>;
};

let registryCache: RegistryShape | null = null;
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

function resolveLocalJsonPath(localRegistryPath: string, filePath: string): string {
  if (!filePath.startsWith('/')) {
    throw new Error(`Local runtime registry only supports root-relative JSON paths. Got ${filePath}.`);
  }

  const registryDir = path.dirname(localRegistryPath);
  if (filePath.startsWith('/idl/')) {
    const relativePath = filePath.slice('/idl/'.length);
    const siblingPath = path.resolve(registryDir, relativePath);
    if (fs.existsSync(siblingPath)) {
      return siblingPath;
    }

    const nestedIdlPath = path.resolve(registryDir, 'idl', relativePath);
    if (fs.existsSync(nestedIdlPath)) {
      return nestedIdlPath;
    }
  }

  return path.resolve(registryDir, filePath.slice(1));
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

export async function listIndexingSourcesForProtocol(protocolId: string): Promise<Array<IndexingSourceManifest & { indexingId: string }>> {
  const registry = await loadRegistry();
  const indexings = Array.isArray(registry.indexings) ? registry.indexings : [];
  const matches: Array<IndexingSourceManifest & { indexingId: string }> = [];
  for (const indexing of indexings) {
    if (!indexing || indexing.status === 'inactive' || !Array.isArray(indexing.sources)) {
      continue;
    }
    for (const source of indexing.sources) {
      if (!source || source.protocolId !== protocolId || typeof source.ingestSpecPath !== 'string') {
        continue;
      }
      matches.push({
        indexingId: indexing.id,
        id: source.id,
        protocolId: source.protocolId,
        ingestSpecPath: source.ingestSpecPath,
        dependsOn: Array.isArray(source.dependsOn) ? source.dependsOn : undefined,
      });
    }
  }
  return matches;
}

async function loadJsonByPath<T>(filePath: string): Promise<T> {
  const localRegistryPath = resolveLocalRegistryPath();
  if (localRegistryPath) {
    const resolvedPath = resolveLocalJsonPath(localRegistryPath, filePath);
    return readLocalJson<T>(resolvedPath);
  }

  const response = await fetch(resolveAppUrl(filePath));
  if (!response.ok) {
    throw new Error(`Failed to load JSON from ${filePath}.`);
  }
  return (await response.json()) as T;
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
  if (parsed.protocol_id !== protocolId) {
    throw new Error(`Protocol ${protocolId} agent runtime protocol_id mismatch: ${parsed.protocol_id}.`);
  }
  if (parsed.program_id !== manifest.programId) {
    throw new Error(`Protocol ${protocolId} agent runtime program_id mismatch: ${parsed.program_id}.`);
  }
  if (parsed.codama_path !== manifest.codamaIdlPath) {
    throw new Error(`Protocol ${protocolId} agent runtime codama_path mismatch: ${parsed.codama_path}.`);
  }

  agentRuntimeCache.set(protocolId, parsed);
  return parsed;
}
