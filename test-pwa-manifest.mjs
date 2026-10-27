import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
const m=JSON.parse(readFileSync('public/manifest.webmanifest','utf8'));
assert.equal(m.name,'Training History');assert.equal(m.display,'standalone');
assert.equal(m.id,'/');assert.equal(m.start_url,'/');assert.equal(m.scope,'/');
assert.equal(m.prefer_related_applications,false);
for(const size of [192,512])assert.ok(m.icons.some(i=>i.type==='image/png'&&i.sizes===`${size}x${size}`&&i.purpose==='any'));
assert.ok(m.icons.some(i=>i.purpose==='maskable'&&i.sizes==='512x512'));
for(const icon of m.icons){
 assert.ok(/^\/icons\/[a-z0-9.-]+$/.test(icon.src));
 const file=path.join('public',icon.src);assert.ok(existsSync(file));
 if(icon.type==='image/png'){
  const bytes=readFileSync(file);assert.equal(bytes.subarray(1,4).toString(),'PNG');
  assert.equal(`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`,icon.sizes);
 }
}
const html=readFileSync('public/dashboard.html','utf8');
assert.match(html,/<link\b(?=[^>]*rel="manifest")(?=[^>]*href="\/manifest\.webmanifest")(?=[^>]*crossorigin="use-credentials")[^>]*>/);
assert.match(html,/apple-touch-icon/);assert.match(html,/\/pwa\.js|\.\/pwa\.js/);
const source=readFileSync('public/data.js','utf8');const data=JSON.parse(source.split('=',2)[1].trim().replace(/;$/,''));
assert.deepEqual(data.records,[]);assert.deepEqual(data.settings,{});
console.log('PASS installable manifest, icon dimensions, authenticated manifest link and empty starter data');
