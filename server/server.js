#!/usr/bin/env node
/**
 * Servidor de autenticação do projeto (roda no celular via Termux).
 *
 * - Sem dependências externas: só Node.js >= 18.
 * - Senhas NUNCA são gravadas em texto puro: scrypt + salt aleatório.
 * - Lista de usuários em server/data/users.json.
 * - Sessão via cookie HttpOnly assinado com HMAC-SHA256.
 *
 * Variáveis de ambiente:
 *   PORT            porta HTTP (padrão 3000)
 *   DATA_DIR        pasta dos dados (padrão ./data)
 *   SESSION_SECRET  segredo do cookie (obrigatório em produção)
 *   ADMIN_TOKEN     token para GET /api/users (se vazio, endpoint não existe)
 *   ALLOWED_ORIGIN  origem permitida quando o front chama a API direto (CORS)
 */

import { createServer } from 'node:http';
import {
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
  createHmac,
} from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '..');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || join(__dirname, 'data');
const USERS_FILE = join(DATA_DIR, 'users.json');
const SESSION_SECRET =
  process.env.SESSION_SECRET || randomBytes(32).toString('hex');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';

const SESSION_COOKIE = 'pf_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 10 * 1024;

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

if (!process.env.SESSION_SECRET) {
  console.warn(
    '[aviso] SESSION_SECRET não definido. Usando um segredo temporário:\n' +
      '        sessões serão invalidadas a cada reinício. Defina em produção.'
  );
}

/* ------------------------------------------------------------------ */
/* Senhas                                                             */
/* ------------------------------------------------------------------ */

async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT.keylen, SCRYPT);
  return [
    'scrypt',
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString('base64url'),
    hash.toString('base64url'),
  ].join('$');
}

async function verifyPassword(password, stored) {
  try {
    const [alg, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64url');
    const expected = Buffer.from(hashB64, 'base64url');
    if (!salt.length || !expected.length) return false;
    const actual = await scrypt(password, salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: SCRYPT.maxmem,
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// Hash descartável: garante tempo parecido quando o e-mail não existe.
const DUMMY_HASH = await hashPassword(randomBytes(24).toString('hex'));

/* ------------------------------------------------------------------ */
/* Persistência (lista simples em JSON)                               */
/* ------------------------------------------------------------------ */

let writeQueue = Promise.resolve();

async function loadUsers() {
  try {
    const raw = await readFile(USERS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function saveUsers(users) {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${USERS_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(users, null, 2), 'utf8');
  await rename(tmp, USERS_FILE); // troca atômica
}

/** Serializa leitura+escrita para não perder cadastros simultâneos. */
function withStore(work) {
  const run = writeQueue.then(async () => {
    const users = await loadUsers();
    const outcome = await work(users);
    if (outcome?.changed) await saveUsers(users);
    return outcome?.value;
  });
  writeQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/* ------------------------------------------------------------------ */
/* Sessão                                                             */
/* ------------------------------------------------------------------ */

function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function readSession(req) {
  const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!raw || typeof raw !== 'string') return null;

  const [body, sig] = raw.split('.');
  if (!body || !sig) return null;

  const expected = createHmac('sha256', SESSION_SECRET)
    .update(body)
    .digest('base64url');

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload?.sub || !payload?.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function isHttps(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  if (proto) return proto === 'https';
  const origin = String(process.env.PUBLIC_ORIGIN || '');
  return origin.startsWith('https://');
}

function sessionCookie(token, req) {
  // Cookie entre sites (front na Vercel chamando o túnel direto) precisa de None.
  const sameSite = ALLOWED_ORIGIN ? 'None' : 'Lax';
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'Path=/',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    `SameSite=${sameSite}`,
  ];
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

function clearSessionCookie(req) {
  const sameSite = ALLOWED_ORIGIN ? 'None' : 'Lax';
  const parts = [`${SESSION_COOKIE}=`, 'HttpOnly', 'Path=/', 'Max-Age=0', `SameSite=${sameSite}`];
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                       */
/* ------------------------------------------------------------------ */

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGIN && origin && origin === ALLOWED_ORIGIN) {
    return {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      Vary: 'Origin',
    };
  }
  return {};
}

function send(req, res, status, body, extra = {}) {
  const isObject = typeof body !== 'string';
  const data = isObject ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': isObject
      ? 'application/json; charset=utf-8'
      : 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...corsHeaders(req),
    ...extra,
  });
  res.end(data);
}

function fail(req, res, status, message) {
  send(req, res, status, { ok: false, error: message });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Corpo da requisição muito grande.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('JSON inválido.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '')
    .split(',')[0]
    .trim();
  return forwarded || req.socket.remoteAddress || 'desconhecido';
}

/* ------------------------------------------------------------------ */
/* Rate limit simples em memória                                      */
/* ------------------------------------------------------------------ */

const buckets = new Map();

function tooManyAttempts(key, limit, windowMs) {
  const now = Date.now();
  const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  buckets.set(key, hits);
  return hits.length > limit;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, hits] of buckets) {
    if (!hits.some((t) => now - t < 5 * 60 * 1000)) buckets.delete(key);
  }
}, 60 * 1000).unref();

/* ------------------------------------------------------------------ */
/* Validação                                                          */
/* ------------------------------------------------------------------ */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function validateCredentials(body) {
  const email = normalizeEmail(body?.email);
  const password = typeof body?.password === 'string' ? body.password : '';

  if (!EMAIL_RE.test(email) || email.length > 254) {
    return { error: 'Informe um e-mail válido.' };
  }
  if (password.length < 8) {
    return { error: 'A senha precisa ter pelo menos 8 caracteres.' };
  }
  if (password.length > 200) {
    return { error: 'A senha é muito longa (máximo 200 caracteres).' };
  }
  return { email, password };
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    createdAt: user.createdAt,
  };
}

/* ------------------------------------------------------------------ */
/* Rotas                                                              */
/* ------------------------------------------------------------------ */

async function handleRegister(req, res) {
  if (tooManyAttempts(`register:${clientIp(req)}`, 10, 10 * 60 * 1000)) {
    return fail(req, res, 429, 'Muitas tentativas. Tente novamente mais tarde.');
  }

  const body = await readJson(req);
  const data = validateCredentials(body);
  if (data.error) return fail(req, res, 400, data.error);

  const passwordHash = await hashPassword(data.password);

  const result = await withStore(async (users) => {
    if (users.some((u) => u.email === data.email)) {
      return { changed: false, value: { conflict: true } };
    }
    const user = {
      id: randomUUID(),
      email: data.email,
      passwordHash,
      createdAt: new Date().toISOString(),
    };
    users.push(user);
    return { changed: true, value: { user } };
  });

  if (result.conflict) {
    return fail(req, res, 409, 'Já existe uma conta com esse e-mail.');
  }

  const token = signSession({
    sub: result.user.id,
    exp: Date.now() + SESSION_TTL_MS,
  });

  return send(
    req,
    res,
    201,
    { ok: true, user: publicUser(result.user) },
    { 'Set-Cookie': sessionCookie(token, req) }
  );
}

async function handleLogin(req, res) {
  if (tooManyAttempts(`login:${clientIp(req)}`, 20, 5 * 60 * 1000)) {
    return fail(req, res, 429, 'Muitas tentativas. Aguarde alguns minutos.');
  }

  const body = await readJson(req);
  const data = validateCredentials(body);
  if (data.error) return fail(req, res, 400, data.error);

  const user = await withStore(async (users) => {
    return { changed: false, value: users.find((u) => u.email === data.email) || null };
  });

  // Sempre executa o hash, exista ou não a conta (evita descobrir e-mails).
  const valid = user
    ? await verifyPassword(data.password, user.passwordHash)
    : (await verifyPassword(data.password, DUMMY_HASH), false);

  if (!user || !valid) {
    return fail(req, res, 401, 'E-mail ou senha inválidos.');
  }

  const token = signSession({ sub: user.id, exp: Date.now() + SESSION_TTL_MS });
  return send(
    req,
    res,
    200,
    { ok: true, user: publicUser(user) },
    { 'Set-Cookie': sessionCookie(token, req) }
  );
}

async function handleMe(req, res) {
  const session = readSession(req);
  // 200 com user:null evita erro no console do navegador para visitantes.
  if (!session) return send(req, res, 200, { ok: true, user: null });

  const user = await withStore(async (users) => {
    return { changed: false, value: users.find((u) => u.id === session.sub) || null };
  });

  if (!user) return send(req, res, 200, { ok: true, user: null });
  return send(req, res, 200, { ok: true, user: publicUser(user) });
}

async function handleLogout(req, res) {
  return send(req, res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie(req) });
}

async function handleUsers(req, res) {
  if (!ADMIN_TOKEN) return fail(req, res, 404, 'Não encontrado.');

  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(token);
  const b = Buffer.from(ADMIN_TOKEN);
  if (!token || a.length !== b.length || !timingSafeEqual(a, b)) {
    return fail(req, res, 401, 'Não autorizado.');
  }

  const users = await loadUsers();
  return send(req, res, 200, {
    ok: true,
    total: users.length,
    users: users.map((u) => ({
      ...publicUser(u),
      hashPreview: String(u.passwordHash).slice(0, 28) + '…',
    })),
  });
}

/* ------------------------------------------------------------------ */
/* Estáticos (só para rodar local com `node server/server.js`)        */
/* ------------------------------------------------------------------ */

const STATIC_ROUTES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

async function serveStatic(req, res, pathname) {
  const entry = STATIC_ROUTES[pathname];
  if (!entry) return false;

  try {
    const data = await readFile(join(ROOT_DIR, entry[0]));
    res.writeHead(200, {
      'Content-Type': entry[1],
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy':
        "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'",
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Roteador                                                           */
/* ------------------------------------------------------------------ */

const server = createServer(async (req, res) => {
  const started = Date.now();
  let pathname = '/';

  try {
    const url = new URL(req.url || '/', 'http://localhost');
    pathname = url.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...corsHeaders(req), 'Cache-Control': 'no-store' });
      return res.end();
    }

    if (pathname === '/health') {
      return send(req, res, 200, { ok: true, uptime: Math.round(process.uptime()) });
    }

    if (pathname.startsWith('/api/')) {
      if (req.method === 'POST' && pathname === '/api/register') return await handleRegister(req, res);
      if (req.method === 'POST' && pathname === '/api/login') return await handleLogin(req, res);
      if (req.method === 'POST' && pathname === '/api/logout') return await handleLogout(req, res);
      if (req.method === 'GET' && pathname === '/api/me') return await handleMe(req, res);
      if (req.method === 'GET' && pathname === '/api/users') return await handleUsers(req, res);
      return fail(req, res, 404, 'Rota não encontrada.');
    }

    if (req.method === 'GET' && (await serveStatic(req, res, pathname))) return;

    return fail(req, res, 404, 'Não encontrado.');
  } catch (err) {
    const status = Number(err?.status) || 500;
    if (status >= 500) console.error('[erro]', err);
    if (!res.headersSent) {
      return fail(req, res, status, status === 500 ? 'Erro interno.' : err.message);
    }
    res.end();
  } finally {
    // Log mínimo: nunca registra corpo, senha ou e-mail.
    console.log(`${req.method} ${pathname} -> ${res.statusCode} (${Date.now() - started}ms)`);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`API ouvindo em http://localhost:${PORT}`);
  console.log(`Dados em: ${USERS_FILE}`);
});
