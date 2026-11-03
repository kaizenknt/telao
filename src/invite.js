// Telão — código de convite curto e ilegível: TELAO-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX
// Guarda o endereço da sala e a senha codificados (não dá para ler olhando o link) e com conferência
// (um caractere errado é detectado). Os convites antigos (TELAO-<base64>) continuam valendo.
// Atenção: isto esconde os dados do link, não é uma tranca — quem tem o convite entra, que é a ideia.
// Sem dependências: usado pelo app e pelo instalador do servidor (node invite.js <ip> <senha>).
const crypto = require('crypto');

const KEY = crypto.createHash('sha256').update('telao/convite/v1').digest();
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford: sem I, L, O, U (não confunde)
const PW = 'abcdefghjkmnpqrstuvwxyz23456789';   // letras das senhas que o Telão gera

const sha = (...parts) => crypto.createHash('sha256').update(Buffer.concat(parts)).digest();

function seal(plain) {
  const check = sha(KEY, plain).subarray(0, 2);
  const out = Buffer.alloc(plain.length);
  for (let i = 0, block = 0; i < plain.length; block++) {
    const ks = sha(KEY, check, Buffer.from([block]));
    for (let j = 0; j < ks.length && i < plain.length; j++, i++) out[i] = plain[i] ^ ks[j];
  }
  return Buffer.concat([check, out]);
}
function open(sealed) {
  if (sealed.length < 3) return null;
  const check = sealed.subarray(0, 2), body = sealed.subarray(2);
  const plain = Buffer.alloc(body.length);
  for (let i = 0, block = 0; i < body.length; block++) {
    const ks = sha(KEY, check, Buffer.from([block]));
    for (let j = 0; j < ks.length && i < body.length; j++, i++) plain[i] = body[i] ^ ks[j];
  }
  return sha(KEY, plain).subarray(0, 2).equals(check) ? plain : null;
}

function toB32(buf) {
  let bits = 0, val = 0, s = '';
  for (const b of buf) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { s += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
    val &= (1 << bits) - 1;
  }
  if (bits) s += B32[(val << (5 - bits)) & 31];
  return s;
}
function fromB32(str) {
  const clean = String(str).toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  let bits = 0, val = 0; const out = [];
  for (const c of clean) {
    const v = B32.indexOf(c); if (v < 0) return null;
    val = (val << 5) | v; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; val &= (1 << bits) - 1; }
  }
  return Buffer.from(out);
}
const group = (s) => s.match(/.{1,4}/g).join('-');

// senha no formato do Telão (12 letras de PW, com ou sem hífens) cabe em 8 bytes
function packPw(p) {
  const s = String(p).replace(/-/g, '');
  if (s.length !== 12 || [...s].some((c) => !PW.includes(c))) return null;
  let n = 0n; for (const c of s) n = n * 31n + BigInt(PW.indexOf(c));
  const b = Buffer.alloc(8); b.writeBigUInt64BE(n); return b;
}
function unpackPw(b) {
  let n = b.readBigUInt64BE(0), s = '';
  for (let i = 0; i < 12; i++) { s = PW[Number(n % 31n)] + s; n /= 31n; }
  return s.replace(/(.{4})(?=.)/g, '$1-');
}
const ipv4 = (h) => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(h) && h.split('.').every((x) => +x <= 255);

function makeInvite(host, password) {
  const pw = packPw(password);
  let plain;
  if (ipv4(host) && pw) plain = Buffer.concat([Buffer.from([1]), Buffer.from(host.split('.').map(Number)), pw]); // 13 bytes -> 24 letras
  else plain = Buffer.concat([Buffer.from([2]), Buffer.from(JSON.stringify({ h: host, p: password }))]);
  return 'TELAO-' + group(toB32(seal(plain)));
}

function readInvite(code) {
  const m = String(code || '').trim().match(/TELAO-([A-Za-z0-9_-]+)/i);
  if (!m) return null;
  const body = m[1];
  // antigo: TELAO-<base64url de {"h":..,"p":..}> (começa com "eyJ")
  if (/^eyJ/.test(body)) {
    try { const o = JSON.parse(Buffer.from(body, 'base64url').toString()); return o.h && o.p ? { host: String(o.h), password: String(o.p) } : null; } catch { return null; }
  }
  const raw = fromB32(body); if (!raw) return null;
  const plain = open(raw); if (!plain) return null;
  if (plain[0] === 1 && plain.length === 13) return { host: [...plain.subarray(1, 5)].join('.'), password: unpackPw(plain.subarray(5, 13)) };
  if (plain[0] === 2) { try { const o = JSON.parse(plain.subarray(1).toString()); return o.h && o.p ? { host: String(o.h), password: String(o.p) } : null; } catch { return null; } }
  return null;
}

module.exports = { makeInvite, readInvite };

if (require.main === module) {
  const [, , host, pw] = process.argv;
  if (!host || !pw) { console.error('uso: node invite.js <ip> <senha>'); process.exit(1); }
  process.stdout.write(makeInvite(host, pw));
}
