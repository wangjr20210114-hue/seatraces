import { url } from '@kit.ArkTS';

// The Web app uses origin-relative API paths, so only an origin is accepted.
export function backendOrigin(value: string): string {
  try {
    const parsed = url.URL.parseURL(value.trim());
    if (parsed.username || parsed.password || parsed.search || parsed.hash ||
      (parsed.pathname !== '' && parsed.pathname !== '/')) return '';
    if (parsed.protocol === 'https:' && parsed.hostname) return parsed.origin;
    if (parsed.origin === 'http://127.0.0.1:8788' || parsed.origin === 'http://127.0.0.1:8787') return parsed.origin;
  } catch (_) {}
  return '';
}

export function sameBackendOrigin(value: string, backend: string): boolean {
  const expected = backendOrigin(backend);
  if (!expected) return false;
  try {
    const parsed = url.URL.parseURL(value);
    return !parsed.username && !parsed.password && parsed.origin === expected;
  } catch (_) { return false; }
}
