const PROTOCOL_URL_RE = /^[a-zA-Z][a-zA-Z\d+\-.]*:/;
const IDL_CACHE_BUST_VERSION = 'runtime-0.1.42';

type ImportMetaWithOptionalEnv = ImportMeta & {
  env?: {
    BASE_URL?: string;
  };
};

function normalizeBaseUrl(baseRaw: string | undefined): string {
  const trimmed = (baseRaw ?? '/').trim();
  if (!trimmed) {
    return '/';
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

  const base = normalizeBaseUrl((import.meta as ImportMetaWithOptionalEnv).env?.BASE_URL);

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
