// vault.js — cifra, formato do ficheiro, espaços/categorias e gerador de palavras-passe.
// Tudo corre no browser com a Web Crypto API. Nada sai do dispositivo.
//
// Formato do ficheiro (versão 1):
// {
//   "format": "lockmaster-vault",
//   "version": 1,
//   "kdf":    { "name": "PBKDF2", "hash": "SHA-256", "iterations": 600000, "salt": "<base64>" },
//   "cipher": { "name": "AES-GCM", "iv": "<base64>" },
//   "data":   "<base64 do conteúdo cifrado>",
//   "updatedAt": "<ISO 8601>"
// }
// O cabeçalho (formato, versão, kdf, cifra) é autenticado como "additional data"
// do AES-GCM: se alguém o alterar, a decifra falha.
//
// Conteúdo decifrado:
// {
//   "spaces":     [ { id, name } ],
//   "categories": [ { id, spaceId, name } ],
//   "entries":    [ { id, spaceId, categoryId | null, title, url, username, password, notes, createdAt, updatedAt } ]
// }
// Cada entrada pertence a um espaço e, opcionalmente, a uma categoria desse espaço.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const FORMAT = 'lockmaster-vault';
export const VERSION = 1;
export const DEFAULT_SPACE_NAME = 'Minhas passwords';
export const KDF_ITERATIONS = 600_000;
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 5_000_000;

export class VaultError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code; // 'BAD_FORMAT' | 'WRONG_PASSWORD'
  }
}

// ---------- base64 ----------

function toB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function fromB64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ---------- chaves ----------

async function deriveKey(password, salt, iterations) {
  const base = await crypto.subtle.importKey(
    'raw',
    enc.encode(password.normalize('NFKC')),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false, // a chave nunca pode ser extraída
    ['encrypt', 'decrypt'],
  );
}

function aadFor(h) {
  return enc.encode(
    [h.format, h.version, h.kdf.name, h.kdf.hash, h.kdf.iterations, h.kdf.salt, h.cipher.name].join('|'),
  );
}

function bad(msg) {
  return new VaultError('BAD_FORMAT', msg);
}

function validateFile(f) {
  if (!f || typeof f !== 'object') throw bad('Ficheiro inválido.');
  if (f.format !== FORMAT) throw bad('Isto não é um ficheiro de cofre.');
  if (f.version !== VERSION) throw bad('Versão do cofre não suportada.');
  const k = f.kdf;
  if (!k || k.name !== 'PBKDF2' || k.hash !== 'SHA-256') throw bad('Parâmetros de chave inválidos.');
  if (!Number.isInteger(k.iterations) || k.iterations < MIN_ITERATIONS || k.iterations > MAX_ITERATIONS) {
    throw bad('Parâmetros de chave inválidos.');
  }
  if (typeof k.salt !== 'string' || typeof f.data !== 'string') throw bad('Ficheiro inválido.');
  if (!f.cipher || f.cipher.name !== 'AES-GCM' || typeof f.cipher.iv !== 'string') throw bad('Cifra inválida.');
  try {
    if (fromB64(k.salt).length !== 16 || fromB64(f.cipher.iv).length !== 12) throw new Error();
    fromB64(f.data);
  } catch {
    throw bad('Ficheiro corrompido.');
  }
}

const str = (v) => (typeof v === 'string' ? v : '');

/** Garante um conteúdo coerente, mesmo que o ficheiro tenha sido editado à mão. */
function normalizePayload(p) {
  const now = new Date().toISOString();
  const used = new Set();
  const uniqueId = (v) => {
    let id = str(v);
    if (!id || used.has(id)) id = crypto.randomUUID();
    used.add(id);
    return id;
  };

  let spaces = (Array.isArray(p?.spaces) ? p.spaces : [])
    .map((x) => ({ id: uniqueId(x?.id), name: str(x?.name).trim() }))
    .filter((x) => x.name);
  if (!spaces.length) spaces = [{ id: uniqueId(''), name: DEFAULT_SPACE_NAME }];
  const spaceIds = new Set(spaces.map((x) => x.id));

  const categories = (Array.isArray(p?.categories) ? p.categories : [])
    .map((x) => ({ id: uniqueId(x?.id), spaceId: str(x?.spaceId), name: str(x?.name).trim() }))
    .filter((x) => x.name && spaceIds.has(x.spaceId));
  const catById = new Map(categories.map((x) => [x.id, x]));

  const entries = (Array.isArray(p?.entries) ? p.entries : []).map((e) => {
    const entry = {
      id: uniqueId(e?.id),
      spaceId: str(e?.spaceId),
      categoryId: str(e?.categoryId) || null,
      title: str(e?.title),
      url: str(e?.url),
      username: str(e?.username),
      password: str(e?.password),
      notes: str(e?.notes),
      createdAt: str(e?.createdAt) || now,
      updatedAt: str(e?.updatedAt) || now,
    };
    if (!spaceIds.has(entry.spaceId)) entry.spaceId = spaces[0].id;
    const cat = catById.get(entry.categoryId);
    if (!cat || cat.spaceId !== entry.spaceId) entry.categoryId = null;
    return entry;
  });

  return { spaces, categories, entries };
}

// ---------- API do cofre ----------

/** Lê e valida o texto de um ficheiro de cofre (sem o decifrar). */
export function parseVaultText(text) {
  let f;
  try {
    f = JSON.parse(text);
  } catch {
    throw bad('Isto não é um ficheiro de cofre.');
  }
  validateFile(f);
  return f;
}

/** Cria um cofre novo e vazio. Devolve a "sessão" em memória. */
export async function createVault(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const kdf = { name: 'PBKDF2', hash: 'SHA-256', iterations: KDF_ITERATIONS, salt: toB64(salt) };
  const key = await deriveKey(password, salt, kdf.iterations);
  return {
    key,
    kdf,
    spaces: [{ id: crypto.randomUUID(), name: DEFAULT_SPACE_NAME }],
    categories: [],
    entries: [],
    updatedAt: new Date().toISOString(),
  };
}

/** Abre um cofre. Lança VaultError('WRONG_PASSWORD') se a palavra-passe estiver errada. */
export async function openVault(file, password) {
  validateFile(file);
  const salt = fromB64(file.kdf.salt);
  const key = await deriveKey(password, salt, file.kdf.iterations);
  let plain;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(file.cipher.iv), additionalData: aadFor(file) },
      key,
      fromB64(file.data),
    );
  } catch {
    throw new VaultError('WRONG_PASSWORD');
  }
  let payload;
  try {
    payload = JSON.parse(dec.decode(plain));
  } catch {
    throw bad('Conteúdo do cofre ilegível.');
  }
  return { key, kdf: { ...file.kdf }, ...normalizePayload(payload), updatedAt: file.updatedAt };
}

/** Cifra a sessão atual e devolve o objeto de ficheiro (novo IV em cada gravação). */
export async function encryptVault(session) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const header = {
    format: FORMAT,
    version: VERSION,
    kdf: { ...session.kdf },
    cipher: { name: 'AES-GCM', iv: toB64(iv) },
  };
  const plain = enc.encode(
    JSON.stringify({ spaces: session.spaces, categories: session.categories, entries: session.entries }),
  );
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aadFor(header) },
    session.key,
    plain,
  );
  session.updatedAt = new Date().toISOString();
  return { ...header, data: toB64(ct), updatedAt: session.updatedAt };
}

/** Muda a palavra-passe mestra: novo salt, nova chave, mesmas entradas. */
export async function rekey(session, newPassword) {
  const fresh = await createVault(newPassword);
  return { ...fresh, spaces: session.spaces, categories: session.categories, entries: session.entries };
}

// ---------- gerador e força ----------

const SETS = {
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  symbols: '!@#$%&*-_=+?.,;:',
};
const AMBIGUOUS = /[0O1lI|]/g;

function randInt(max) {
  // inteiro uniforme em [0, max) sem enviesamento
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  do {
    crypto.getRandomValues(buf);
  } while (buf[0] >= limit);
  return buf[0] % max;
}

export function generatePassword(opts = {}) {
  const o = { length: 20, lower: true, upper: true, digits: true, symbols: true, noAmbiguous: true, ...opts };
  let sets = ['lower', 'upper', 'digits', 'symbols']
    .filter((k) => o[k])
    .map((k) => (o.noAmbiguous ? SETS[k].replace(AMBIGUOUS, '') : SETS[k]));
  if (!sets.length) sets = [o.noAmbiguous ? SETS.lower.replace(AMBIGUOUS, '') : SETS.lower];
  const length = Math.max(sets.length, Math.min(128, Math.floor(o.length) || 20));
  const all = sets.join('');
  const chars = sets.map((s) => s[randInt(s.length)]); // garante pelo menos um de cada grupo
  while (chars.length < length) chars.push(all[randInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/** Estimativa simples de entropia (bits). É uma ajuda visual, não uma garantia. */
export function estimateBits(pw) {
  if (!pw) return 0;
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/\d/.test(pw)) pool += 10;
  if (/[^A-Za-z0-9]/.test(pw)) pool += 33;
  const chars = [...pw];
  const unique = new Set(chars).size;
  const effective = unique + (chars.length - unique) * 0.25; // repetições valem pouco
  return effective * Math.log2(pool || 1);
}

/** Nível 0–4 e etiqueta para mostrar ao utilizador. */
export function strength(pw) {
  if (!pw) return { level: 0, label: '' };
  const bits = estimateBits(pw);
  if (bits < 35) return { level: 1, label: 'Fraca' };
  if (bits < 55) return { level: 2, label: 'Razoável' };
  if (bits < 75) return { level: 3, label: 'Boa' };
  return { level: 4, label: 'Forte' };
}
