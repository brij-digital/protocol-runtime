const PROTOCOL_URL_RE = /^[a-zA-Z][a-zA-Z\d+\-.]*:/;

function normalizeBaseUrl(baseRaw: string | undefined): string {
  const trimmed = (baseRaw ?? '/').trim();
  if (!trimmed) {
    return '/';
  }
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`;
}

export function resolveAppUrl(url: string): string {
  if (PROTOCOL_URL_RE.test(url) || url.startsWith('//')) {
    return url;
  }

  const base = normalizeBaseUrl(import.meta.env.BASE_URL);

  if (url.startsWith('/')) {
    if (base === '/') {
      return url;
    }
    return `${base.slice(0, -1)}${url}`;
  }

  const cleaned = url.replace(/^\.\//, '');
  if (base === '/') {
    return `/${cleaned}`;
  }
  return `${base}${cleaned}`;
}
