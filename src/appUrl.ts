const PROTOCOL_URL_RE = /^[a-zA-Z][a-zA-Z\d+\-.]*:/;
const IDL_CACHE_BUST_VERSION = 'runtime-0.1.63';

type ImportMetaWithOptionalEnv = ImportMeta & {
  env?: {
    BASE_URL?: string;
  };
};

function resolveRuntimeBaseUrl(): string {
  const importMetaBase = (import.meta as ImportMetaWithOptionalEnv).env?.BASE_URL;
  if (typeof importMetaBase === 'string' && importMetaBase.trim().length > 0) {
    return importMetaBase;
  }

  const processBase =
    typeof process !== 'undefined' && process.env
      ? process.env.APPPACK_RUNTIME_BASE_URL
      : undefined;
  if (typeof processBase === 'string' && processBase.trim().length > 0) {
    return processBase;
  }

  if (typeof window === 'undefined') {
    return 'http://127.0.0.1:8080';
  }

  return '/';
}

function normalizeBaseUrl(baseRaw: string | undefined): string {
  const trimmed = (baseRaw ?? '/').trim();
  if (!trimmed) {
    return '/';
  }
  if (PROTOCOL_URL_RE.test(trimmed) || trimmed.startsWith('//')) {
    return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
  }
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`;
}

export function resolveAppUrl(url: string): string {
  const withCacheBust = (resolved: string): string => {
    if (!resolved.includes('/idl/') || !resolved.endsWith('.json')) {
      return resolved;
    }
    const separator = resolved.includes('?') ? '&' : '?';
    return `${resolved}${separator}v=${IDL_CACHE_BUST_VERSION}`;
  };

  if (PROTOCOL_URL_RE.test(url) || url.startsWith('//')) {
    return withCacheBust(url);
  }

  const base = normalizeBaseUrl(resolveRuntimeBaseUrl());

  if (url.startsWith('/')) {
    if (base === '/') {
      return withCacheBust(url);
    }
    return withCacheBust(`${base.slice(0, -1)}${url}`);
  }

  const cleaned = url.replace(/^\.\//, '');
  if (base === '/') {
    return withCacheBust(`/${cleaned}`);
  }
  return withCacheBust(`${base}${cleaned}`);
}
