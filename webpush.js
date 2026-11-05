// Web Push without a library (RFC 8291 payload encryption + RFC 8292 VAPID), with WebCrypto only:
// runs in the Cloudflare Worker, and in Node for the tests.
const te = new TextEncoder();
export const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const hmac = async (key, data) => new Uint8Array(await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), data));
const P256 = { namedCurve: 'P-256' };

// the server's own signing key pair, made once and kept by the Worker
export async function makeVapid() {
  const k = await crypto.subtle.generateKey({ name: 'ECDSA', ...P256 }, true, ['sign', 'verify']);
  return { privateJwk: await crypto.subtle.exportKey('jwk', k.privateKey), publicKey: b64u(await crypto.subtle.exportKey('raw', k.publicKey)) };
}

export async function vapidHeader(endpoint, vapid, contact) {
  const part = o => b64u(te.encode(JSON.stringify(o)));
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: contact })}`;
  const key = await crypto.subtle.importKey('jwk', vapid.privateJwk, { name: 'ECDSA', ...P256 }, false, ['sign']);
  return `vapid t=${unsigned}.${b64u(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(unsigned)))}, k=${vapid.publicKey}`;
}

// aes128gcm body: salt(16) | record size(4) | key id length(1) | sender public key(65) | ciphertext
export async function encrypt(sub, payload) {
  const ua = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth), salt = crypto.getRandomValues(new Uint8Array(16));
  const as = await crypto.subtle.generateKey({ name: 'ECDH', ...P256 }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', ua, { name: 'ECDH', ...P256 }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hmac(await hmac(auth, ecdh), cat(te.encode('WebPush: info\0'), ua, asPub, [1]));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(te.encode('Content-Encoding: aes128gcm\0'), [1]))).slice(0, 16);
  const nonce = (await hmac(prk, cat(te.encode('Content-Encoding: nonce\0'), [1]))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, cat(te.encode(payload), [2])));
  return cat(salt, [0, 0, 16, 0, 65], asPub, ct);
}

export async function sendPush(sub, message, vapid, contact) {
  return fetch(sub.endpoint, { method: 'POST', body: await encrypt(sub, JSON.stringify(message)),
    headers: { TTL: '43200', Urgency: 'high', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', Authorization: await vapidHeader(sub.endpoint, vapid, contact) } });
}
