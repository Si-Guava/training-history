/*
 * Only the generic reconnect page and app icons are cached. Workout records,
 * dashboard HTML, scripts, sign-in responses and API requests stay network-only.
 * Bump this version when changing offline.html or the cached icon files.
 */
const CACHE_PREFIX = 'training-history-app-';
const CACHE_NAME = CACHE_PREFIX + 'v2';
// The deployed static asset public/offline.html has this canonical URL.
const OFFLINE_PATH = '/offline';
const OFFLINE_MARKER = '<meta name="training-history-offline" content="v1">';
const SAFE_ASSETS = new Map([
  [OFFLINE_PATH, 'text/html'],
  ['/icons/icon-192.png', 'image/png'],
  ['/icons/icon-512.png', 'image/png'],
  ['/icons/icon-maskable-512.png', 'image/png'],
  ['/icons/apple-touch-icon.png', 'image/png'],
  ['/icons/app-icon.svg', 'image/svg+xml'],
]);
const DASHBOARD_PATHS = new Set(['/', '/dashboard.html']);
const AUTH_PATHS = new Set(['/signin-with-chatgpt', '/signout-with-chatgpt', '/callback']);
const assetUrl = path => new URL(path, self.location.origin).href;

async function safeAssetResponse(path, response) {
  if (!SAFE_ASSETS.has(path) || response.status !== 200 || response.redirected ||
      !['basic', 'default'].includes(response.type)) return false;
  const type = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  if (type !== SAFE_ASSETS.get(path)) return false;
  // A private hosting gate can return a sign-in page with status 200. Validate
  // the known offline marker and image formats as well as the response MIME.
  if (path === OFFLINE_PATH) return (await response.clone().text()).includes(OFFLINE_MARKER);
  if (type === 'image/png') {
    const bytes = new Uint8Array(await response.clone().arrayBuffer());
    return [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
  }
  return /^\s*(?:<\?xml[^?]*\?>\s*)?<svg(?:\s|>)/i.test(await response.clone().text());
}

async function storeAsset(cache, path, response) {
  // Store only the generic resource body and its type, without response headers
  // from the hosting authentication boundary or the original request's cookies.
  const body = await response.clone().arrayBuffer();
  await cache.put(assetUrl(path), new Response(body, {
    status: 200, headers: {'Content-Type': SAFE_ASSETS.get(path)},
  }));
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    // Validate every response before writing anything to the new app cache.
    const assets = await Promise.all([...SAFE_ASSETS.keys()].map(async path => {
      const response = await fetch(new Request(assetUrl(path), {
        credentials: 'same-origin', cache: 'reload', redirect: 'error',
      }));
      if (!await safeAssetResponse(path, response)) throw new Error('App offline resources are unavailable.');
      return [path, response];
    }));
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(assets.map(([path, response]) => storeAsset(cache, path, response)));
    // Do not skipWaiting: a newer worker must not interrupt an open workout.
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

async function offlineResponse() {
  const cache = await caches.open(CACHE_NAME);
  const saved = await cache.match(assetUrl(OFFLINE_PATH));
  if (saved) return saved;
  // Storage may have been cleared by the browser. This fallback is also generic.
  return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Training History · Reconnect</title><main><h1>Reconnect to your training log</h1><p>An internet connection is needed to load or save workouts.</p><p><a href="/">Try again</a></p></main></html>', {
    status: 503, headers: {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'},
  });
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || request.headers.has('range')) return;
  if (url.pathname === '/api' || url.pathname.startsWith('/api/') || AUTH_PATHS.has(url.pathname)) return;

  if (SAFE_ASSETS.has(url.pathname) && !url.search) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const saved = await cache.match(assetUrl(url.pathname));
      if (saved) return saved;
      const response = await fetch(request);
      if (await safeAssetResponse(url.pathname, response)) {
        await storeAsset(cache, url.pathname, response).catch(() => {});
      }
      return response;
    })());
    return;
  }

  if (request.mode === 'navigate' && DASHBOARD_PATHS.has(url.pathname)) {
    // Even successful dashboard responses are deliberately never written to a
    // cache. HTTP authentication/error responses also pass through unchanged.
    event.respondWith(fetch(request).catch(() => offlineResponse()));
  }
});
