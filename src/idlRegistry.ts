import { resolveAppUrl } from './appUrl.js';

export type ProtocolManifest = {
  id: string;
  name: string;
  network: string;
  programId: string;
  idlPath?: string;
  codamaIdlPath?: string;
  runtimeSpecPath?: string;
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
  idlPath?: string;
  codecIdlPath?: string;
};

type RuntimeSpecShape = {
  schema: string;
  protocolId: string;
  decoderArtifacts?: Record<string, RuntimeDecoderArtifact>;
};

let registryCache: RegistryShape | null = null;
const runtimeSpecCache = new Map<string, RuntimeSpecShape | null>();
const codecIdlPathCache = new Map<string, string>();

export async function loadRegistry(): Promise<RegistryShape> {
  if (registryCache) {
    return registryCache;
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

  return manifest;
}

async function loadJsonByPath<T>(filePath: string): Promise<T> {
  const response = await fetch(resolveAppUrl(filePath));
  if (!response.ok) {
    throw new Error(`Failed to load JSON from ${filePath}.`);
  }
  return (await response.json()) as T;
}

export async function loadProtocolRuntimeSpec(protocolId: string): Promise<RuntimeSpecShape | null> {
  if (runtimeSpecCache.has(protocolId)) {
    return runtimeSpecCache.get(protocolId)!;
  }

  const manifest = await getProtocolById(protocolId);
  if (!manifest.runtimeSpecPath) {
    runtimeSpecCache.set(protocolId, null);
    return null;
  }

  const parsed = await loadJsonByPath<RuntimeSpecShape>(manifest.runtimeSpecPath);
  if (parsed.schema !== 'declarative-decoder-runtime.v1') {
    throw new Error(`Protocol ${protocolId} runtime spec at ${manifest.runtimeSpecPath} is not declarative-decoder-runtime.v1.`);
  }
  if (parsed.protocolId !== protocolId) {
    throw new Error(`Protocol ${protocolId} runtime spec protocolId mismatch: ${parsed.protocolId}.`);
  }

  runtimeSpecCache.set(protocolId, parsed);
  return parsed;
}

export async function resolveProtocolCodecIdlPath(protocolId: string): Promise<string> {
  if (codecIdlPathCache.has(protocolId)) {
    return codecIdlPathCache.get(protocolId)!;
  }

  const manifest = await getProtocolById(protocolId);
  const runtimeSpec = await loadProtocolRuntimeSpec(protocolId);
  const runtimeCodecPaths = new Set<string>();

  for (const artifact of Object.values(runtimeSpec?.decoderArtifacts ?? {})) {
    if (typeof artifact.codecIdlPath === 'string' && artifact.codecIdlPath.length > 0) {
      runtimeCodecPaths.add(artifact.codecIdlPath);
    }
  }

  if (runtimeSpec) {
    if (runtimeCodecPaths.size === 0) {
      throw new Error(
        `Protocol ${protocolId} has a runtime spec but no codec IDL path in decoderArtifacts; migrated execution must resolve codecs from runtime spec.`,
      );
    }
    if (runtimeCodecPaths.size > 1) {
      throw new Error(`Protocol ${protocolId} declares multiple codec IDL paths in runtime spec; resolve the ambiguity before execution.`);
    }
    const resolved = Array.from(runtimeCodecPaths)[0]!;
    codecIdlPathCache.set(protocolId, resolved);
    return resolved;
  }

  const resolved = manifest.idlPath;
  if (!resolved) {
    throw new Error(`Protocol ${protocolId} has no codec IDL path; migrated execution must provide one via runtimeSpec.decoderArtifacts.*.codecIdlPath.`);
  }

  codecIdlPathCache.set(protocolId, resolved);
  return resolved;
}
