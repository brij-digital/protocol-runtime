export type ProtocolManifest = {
  id: string;
  name: string;
  network: string;
  programId: string;
  idlPath: string;
  codamaIdlPath?: string;
  runtimeSpecPath?: string;
  metaPath?: string;
  metaCorePath?: string;
  appPath: string;
  transport: string;
  supportedCommands: string[];
  status: 'active' | 'inactive';
};

type RegistryShape = {
  version: string;
  globalCommands?: string[];
  protocols: ProtocolManifest[];
};

let registryCache: RegistryShape | null = null;

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
import { resolveAppUrl } from './appUrl.js';
