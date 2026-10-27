import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const workerSource = readFileSync(new URL('./public/sw.js', import.meta.url), 'utf8');
const offlineHtml = readFileSync(new URL('./public/offline.html', import.meta.url), 'utf8');
const origin = 'https://training.example';
const cacheName = 'training-history-app-v2';
const assetPaths = ['/offline', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png', '/icons/apple-touch-icon.png', '/icons/app-icon.svg'];
const urlOf = value => typeof value === 'string' ? new URL(value, origin).href : value.url;
const pathOf = value => new URL(urlOf(value)).pathname;

function assetResponse(input) {
  const path = pathOf(input);
  const type = path === '/offline' ? 'text/html; charset=utf-8' : path.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
  const body = path === '/offline' ? offlineHtml : path.endsWith('.svg') ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>' : new Uint8Array([137,80,78,71,13,10,26,10,0]);
  return new Response(body, {headers:{'content-type':type,'x-test-private-header':'must-not-be-cached'}});
}

function harness(initialNetwork = assetResponse) {
  const handlers = new Map();
  const stores = new Map();
  const fetchCalls = [];
  let network = initialNetwork;
  let claimCount = 0;
  let skipCount = 0;
  function makeCache() {
    const rows = new Map();
    return {
      rows,
      async put(request, response) { rows.set(urlOf(request), response.clone()); },
      async match(request) { return rows.get(urlOf(request))?.clone(); },
    };
  }
  const caches = {
    async open(name) { if (!stores.has(name)) stores.set(name, makeCache()); return stores.get(name); },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
  const self = {
    location:new URL(origin + '/sw.js'),
    addEventListener(name, handler) { handlers.set(name,handler); },
    clients:{async claim() { claimCount++; }},
    skipWaiting() { skipCount++; return Promise.resolve(); },
  };
  vm.runInNewContext(workerSource, {
    self, caches, URL, Request, Response, Uint8Array, console,
    fetch:async input => { fetchCalls.push(input); return network(input); },
  },{filename:'sw.js'});
  return {
    stores,caches,fetchCalls,
    setNetwork(fn) { network = fn; },
    get claimCount() { return claimCount; },
    get skipCount() { return skipCount; },
    async dispatch(name) {
      const pending=[];
      handlers.get(name)({waitUntil(promise) { pending.push(promise); }});
      await Promise.all(pending);
    },
    fetch(path, options={}) {
      let response;
      const request = {
        url:new URL(path,origin).href,method:options.method||'GET',mode:options.mode||'cors',
        headers:new Headers(options.headers||{}),
      };
      handlers.get('fetch')({request,respondWith(promise) { response=Promise.resolve(promise); }});
      return response;
    },
  };
}

let count=0;
async function check(name, fn) { await fn(); count++; console.log('PASS '+name); }

await check('install caches exactly the six generic resources without private headers',async()=>{
  const h=harness();await h.dispatch('install');
  const cache=await h.caches.open(cacheName);
  assert.deepEqual([...cache.rows.keys()].sort(),assetPaths.map(path=>origin+path).sort());
  assert.equal(h.fetchCalls.length,6);
  for(const request of h.fetchCalls){assert.equal(request.redirect,'error');assert.equal(request.credentials,'same-origin');assert.equal(request.cache,'reload');}
  for(const response of cache.rows.values()){assert.equal(response.headers.get('x-test-private-header'),null);assert.deepEqual([...response.headers.keys()],['content-type']);}
  assert.equal(h.skipCount,0);
});

await check('sign-in pages, redirects, wrong MIME and wrong image content are never cached',async()=>{
  const cases=[
    ['/offline',()=>new Response('<html><h1>Sign in</h1></html>',{headers:{'content-type':'text/html'}})],
    ['/offline',()=>new Response(offlineHtml,{status:401,headers:{'content-type':'text/html'}})],
    ['/offline',()=>{const r=assetResponse('/offline');Object.defineProperty(r,'redirected',{value:true});return r;}],
    ['/offline',()=>{const r=assetResponse('/offline');Object.defineProperty(r,'type',{value:'opaque'});return r;}],
    ['/icons/icon-192.png',()=>new Response('<html>Sign in</html>',{headers:{'content-type':'text/html'}})],
    ['/icons/icon-192.png',()=>new Response('<html>Sign in</html>',{headers:{'content-type':'image/png'}})],
    ['/icons/app-icon.svg',()=>new Response('<html>Sign in</html>',{headers:{'content-type':'image/svg+xml'}})],
  ];
  for(const [badPath,badResponse] of cases){
    const h=harness(input=>pathOf(input)===badPath?badResponse():assetResponse(input));
    await assert.rejects(h.dispatch('install'),/offline resources are unavailable/);
    assert.equal(h.stores.size,0,'Responses must all validate before cache writes begin');
  }
});

await check('activation removes only old app caches and never forces a page reload',async()=>{
  const h=harness();await h.caches.open('training-history-app-v0');await h.caches.open('training-history-app-v1');await h.caches.open(cacheName);await h.caches.open('another-app-v1');
  await h.dispatch('activate');
  assert.deepEqual([...h.stores.keys()].sort(),['another-app-v1',cacheName].sort());
  assert.equal(h.claimCount,1);assert.equal(h.skipCount,0);
});

await check('online dashboard content and HTTP authentication responses pass through uncached',async()=>{
  const h=harness();await h.dispatch('install');
  for(const status of [200,401,403,503]){
    h.setNetwork(()=>new Response('Private dashboard response',{status,headers:{'content-type':'text/html'}}));
    const response=await h.fetch('/',{mode:'navigate'});
    assert.equal(response.status,status);assert.equal(await response.text(),'Private dashboard response');
  }
  const cache=await h.caches.open(cacheName);
  assert.equal(await cache.match(origin+'/'),undefined);
  assert.equal(cache.rows.size,6);
});

await check('failed dashboard navigation gets only the generic reconnect page',async()=>{
  const h=harness();await h.dispatch('install');h.setNetwork(()=>Promise.reject(new Error('offline')));
  for(const path of ['/','/dashboard.html','/?view=history']){
    const response=await h.fetch(path,{mode:'navigate'});
    const body=await response.text();assert.equal(body,offlineHtml);assert.match(body,/internet connection is needed to load or save workouts/);
  }
  assert.equal((await h.caches.open(cacheName)).rows.size,6);
});

await check('API methods, auth routes, private assets and unrelated URLs are not intercepted',async()=>{
  const h=harness();
  const paths=['/api','/api/workouts','/api/plans','/api/climbing-workouts','/api/hangboard-workouts','/api/record-deletions','/signin-with-chatgpt?return_to=%2F','/signout-with-chatgpt','/callback?code=synthetic','/data.js','/offline.html','/app.js','/manifest.webmanifest','/some-other-page','https://other.example/'];
  for(const path of paths)assert.equal(h.fetch(path,{mode:'navigate'}),undefined,path);
  for(const method of ['POST','PUT','DELETE','PATCH'])assert.equal(h.fetch('/',{method,mode:'navigate'}),undefined,method);
  assert.equal(h.fetch('/',{mode:'cors'}),undefined);
  assert.equal(h.fetch('/icons/icon-192.png?v=other'),undefined);
  assert.equal(h.fetch('/icons/icon-192.png',{headers:{range:'bytes=0-8'}}),undefined);
  assert.equal(h.fetchCalls.length,0);assert.equal(h.stores.size,0);
});

await check('cached icons work offline and bad runtime responses cannot repopulate the cache',async()=>{
  const h=harness();await h.dispatch('install');const before=h.fetchCalls.length;
  h.setNetwork(()=>Promise.reject(new Error('offline')));
  const response=await h.fetch('/icons/icon-192.png');assert.equal(response.headers.get('content-type'),'image/png');assert.equal(h.fetchCalls.length,before);
  const cache=await h.caches.open(cacheName);cache.rows.delete(origin+'/icons/icon-512.png');
  h.setNetwork(()=>new Response('<html>Sign in</html>',{headers:{'content-type':'text/html'}}));
  assert.equal(await (await h.fetch('/icons/icon-512.png')).text(),'<html>Sign in</html>');
  assert.equal(cache.rows.has(origin+'/icons/icon-512.png'),false);
});

await check('evicted offline storage still returns a generic no-store reconnect response',async()=>{
  const h=harness(()=>Promise.reject(new Error('offline')));
  const response=await h.fetch('/',{mode:'navigate'});
  assert.equal(response.status,503);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.match(await response.text(),/Reconnect to your training log/);
  assert.equal((await h.caches.open(cacheName)).rows.size,0);
});

console.log(`${count} PWA worker privacy checks passed.`);
