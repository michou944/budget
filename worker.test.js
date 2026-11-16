import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './cloudflare-worker.js';
import { b64u, unb64u, makeVapid, encrypt, vapidHeader } from './webpush.js';

// A fake KV storage, a phone's push subscription, and an independent decryption (HKDF from WebCrypto, not the app's own code).
const fakeKv = () => {
  const m = new Map();
  return { async get(k, t) { return m.has(k) ? (t === 'json' ? JSON.parse(m.get(k)) : m.get(k)) : null; }, async put(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); } };
};
async function phone(endpoint = 'https://push.example/abc') {
  const k = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey)), auth = crypto.getRandomValues(new Uint8Array(16));
  return { sub: { endpoint, keys: { p256dh: b64u(pub), auth: b64u(auth) } }, priv: k.privateKey, pub, auth };
}
async function decrypt(body, who) {
  const salt = body.slice(0, 16), idlen = body[20], asPub = body.slice(21, 21 + idlen), ct = body.slice(21 + idlen), te = new TextEncoder();
  const asKey = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, who.priv, 256));
  const hkdf = async (ikm, s, info, n) => new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: s, info }, await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), n * 8));
  const ikm = await hkdf(ecdh, who.auth, Uint8Array.from([...te.encode('WebPush: info\0'), ...who.pub, ...asPub]), 32);
  const cek = await hkdf(ikm, salt, te.encode('Content-Encoding: aes128gcm\0'), 16), nonce = await hkdf(ikm, salt, te.encode('Content-Encoding: nonce\0'), 12);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']), ct));
  return { text: new TextDecoder().decode(plain.slice(0, -1)), delimiter: plain.at(-1) };
}
const call = (env, path, { key, body } = {}) =>
  worker.fetch(new Request(`https://w.example${path}`, { method: body ? 'POST' : 'GET', headers: key ? { 'x-key': key } : {}, body: body ? JSON.stringify(body) : undefined }), env);

test('Push: a message is encrypted for one phone, readable only with its key, fresh at each send', async () => {
  const me = await phone(), other = await phone();
  const text = JSON.stringify({ title: 'Boussole', body: 'Total : -10 % é€', tab: 'stock' });
  const a = await encrypt(me.sub, text), b = await encrypt(me.sub, text);
  const got = await decrypt(a, me);
  assert.equal(got.text, text); assert.equal(got.delimiter, 2);
  assert.notDeepEqual(a, b); // a new salt and a new key at each send
  await assert.rejects(decrypt(a, other)); // another phone cannot read it
});

test('Push: the sender signature (VAPID) names the site and the push service, and verifies with the public key', async () => {
  const v = await makeVapid(), contact = 'https://michou944.github.io';
  const header = await vapidHeader('https://push.example/abc/def', v, contact);
  const [, jwt, k] = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, v.publicKey);
  const [h, c, sig] = jwt.split('.'), claims = JSON.parse(Buffer.from(unb64u(c)).toString());
  assert.equal(JSON.parse(Buffer.from(unb64u(h)).toString()).alg, 'ES256');
  assert.equal(claims.aud, 'https://push.example'); assert.equal(claims.sub, contact);
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 13 * 3600);
  const key = await crypto.subtle.importKey('raw', unb64u(k), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, unb64u(sig), new TextEncoder().encode(`${h}.${c}`)));
});

test('Service: no password, a wrong one or none set is refused; the public health page is gone; only https phones and known news paths', async () => {
  const env = { KEY: 'sesame', KV: fakeKv() };
  for (const [e, key] of [[env, undefined], [env, 'wrong'], [{ KV: fakeKv() }, 'anything']]) {
    const r = await call(e, '/search?q=x', { key }); assert.equal(r.status, 401); assert.equal((await r.json()).error, 'mot de passe refusé');
  }
  assert.equal((await call(env, '/sante')).status, 401); // no longer answers anyone
  assert.equal((await call(env, '/sante', { key: 'sesame' })).status, 404);
  assert.equal((await call(env, '/push/watch', { key: 'sesame', body: { subscription: { endpoint: 'http://push.example/x' }, watch: [] } })).status, 400);
  const ok = await call(env, '/push/watch', { key: 'sesame', body: { subscription: { endpoint: 'https://push.example/x' }, watch: [{ s: 'TTE.PA', n: 'Total', rules: [] }] } });
  assert.deepEqual(await ok.json(), { ok: true, watched: 1 });
  assert.equal((await env.KV.get('push', 'json')).subscription.endpoint, 'https://push.example/x');
  assert.equal((await call(env, '/mx/secret/path', { key: 'sesame' })).status, 404); // only the three news calls the app makes
  assert.equal((await call(env, '/mx/news/all', { key: 'sesame' })).status, 401); // no news key handed over yet
  assert.equal((await call(env, '/config', { key: 'sesame', body: { newsKey: '  ' } })).status, 400);
  assert.equal((await call(env, '/config', { key: 'sesame', body: { newsKey: ' abc ' } })).status, 200);
  assert.equal(await env.KV.get('newsKey'), 'abc');
});

test('Alerts: one notification per new crossing, again only after the price recovers, a phone that left is forgotten', async () => {
  const real = globalThis.fetch, bodies = []; let price = 90, status = 201;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://query2.finance.yahoo.com/'))
      return new Response(JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: price, currency: 'EUR' }, timestamp: [1, 2], indicators: { quote: [{ close: [100, price] }] } }] } }));
    bodies.push(init.body); return new Response(null, { status });
  };
  try {
    const env = { KEY: 'sesame', KV: fakeKv() }, me = await phone();
    await env.KV.put('push', JSON.stringify({ subscription: me.sub, watch: [{ s: 'TTE.PA', n: 'Total', rules: [{ below: 95, msg: 'sous 95' }], move: 6 }] }));
    const run = async () => { let p; await worker.scheduled(null, env, { waitUntil: x => { p = x; } }); await p; };
    await run();
    assert.equal(bodies.length, 1); // 90 is under 95 and −10 % passes 6 %: sent once, two lines
    const msg = JSON.parse((await decrypt(bodies[0], me)).text);
    assert.equal(msg.title, 'Boussole · 2 alertes'); assert.equal(msg.tab, 'stock');
    assert.equal(msg.body, 'Total : sous 95\nTotal : -10,0 % sur la séance');
    await run(); assert.equal(bodies.length, 1); // the same crossing is not sent again
    price = 100; await run(); assert.equal(bodies.length, 1); // recovered: nothing sent, the memory is cleared
    price = 90; await run(); assert.equal(bodies.length, 2); // crossed again: sent again
    status = 410; price = 100; await run(); price = 90; await run(); // the push service says the phone is gone
    assert.equal(await env.KV.get('push'), null);
  } finally { globalThis.fetch = real; }
});
