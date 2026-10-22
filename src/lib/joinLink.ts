const PUBLIC_APP_URL = import.meta.env.VITE_PUBLIC_APP_URL?.trim();
const PUBLIC_SERVER_URL = import.meta.env.VITE_SERVER_URL?.trim();

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

export function getJoinBaseUrl(): string {
  if (PUBLIC_APP_URL) {
    return normalizeBaseUrl(PUBLIC_APP_URL);
  }

  if (PUBLIC_SERVER_URL) {
    return normalizeBaseUrl(PUBLIC_SERVER_URL);
  }

  const { protocol, origin } = window.location;
  if (protocol === 'http:' || protocol === 'https:') {
    return normalizeBaseUrl(origin);
  }

  return '';
}

export function createRoomJoinUrl(roomCode: string): string {
  const baseUrl = getJoinBaseUrl();
  const url = new URL(baseUrl || '/', window.location.href);
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  url.searchParams.set('room', roomCode);
  return url.toString();
}

export function isMobileReachabilityWarningUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return (
      protocol !== 'https:' ||
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0' ||
      hostname === '::1'
    );
  } catch {
    return true;
  }
}
