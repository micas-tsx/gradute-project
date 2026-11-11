#!/usr/bin/env node
/**
 * Servidor de autenticação do projeto (roda no celular via Termux).
 *
 * - Sem dependências externas: só Node.js >= 18.
 * - ATENÇÃO: do users.json são gravados apenas os 3 primeiros caracteres
 *   da senha, em texto puro. Use apenas para demonstração/estudo; não use
 *   em produção (o login aceita qualquer senha com o mesmo prefixo).
 * - Lista de usuários em server/data/users.json.
 * - O login cria a conta automaticamente se ela ainda não existir.
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
  timingSafeEqual,
  createHmac,
} from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

if (!process.env.SESSION_SECRET) {
  console.warn(
    '[aviso] SESSION_SECRET não definido. Usando um segredo temporário:\n' +
      '        sessões serão invalidadas a cada reinício. Defina em produção.'
  );
}

/* ------------------------------------------------------------------ */
/* Senhas                                                             */
/* ------------------------------------------------------------------ */

// Senha comparada em texto puro, com tempo constante para não vazar
// informação pelo tempo de resposta.
function passwordMatches(stored, provided) {
  const a = Buffer.from(String(stored));
  const b = Buffer.from(String(provided));
  return a.length === b.length && timingSafeEqual(a, b);
}

// Só os 3 primeiros caracteres da senha são guardados/comparados.
const PASSWORD_PREFIX_LEN = 3;

function passwordPrefix(value) {
  return String(value).slice(0, PASSWORD_PREFIX_LEN);
}

/* ------------------------------------------------------------------ */
/* Persistência (lista simples em JSON)                               */
/* ------------------------------------------------------------------ */

let writeQueue = Promise.resolve();

async function loadUsers() {
  try {
    const raw = await readFile(USERS_FILE, 'utf8');
    // Tolera BOM (comum em editores do Windows) e arquivo vazio.
    const text = raw.replace(/^\uFEFF/, '').trim();
    if (!text) return [];
    const parsed = JSON.parse(text);
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

const IDENTIFIER_MAX_LEN = 254;

function normalizeIdentifier(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function validateCredentials(body) {
  const email = normalizeIdentifier(body?.email);
  const password = typeof body?.password === 'string' ? body.password : '';

  if (!email || email.length > IDENTIFIER_MAX_LEN) {
    return { error: 'Informe um usuário, e-mail ou telefone.' };
  }
  if (!password) {
    return { error: 'Informe sua senha.' };
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

async function handleLogin(req, res) {
  if (tooManyAttempts(`login:${clientIp(req)}`, 20, 5 * 60 * 1000)) {
    return fail(req, res, 429, 'Muitas tentativas. Aguarde alguns minutos.');
  }

  const body = await readJson(req);
  const data = validateCredentials(body);
  if (data.error) return fail(req, res, 400, data.error);

  // O login também cria a conta (não existe mais cadastro separado).
  // Para conta existente, compara a senha; usuários inseridos à mão no
  // users.json sem "id" ganham um id aleatório no primeiro login.
  const result = await withStore(async (users) => {
    const found = users.find((u) => u.email === data.email) || null;

    if (found) {
      const valid =
        typeof found.password === 'string' &&
        passwordMatches(passwordPrefix(found.password), passwordPrefix(data.password));
      if (!valid) return { changed: false, value: { invalid: true } };

      let changed = false;
      if (!found.id) {
        found.id = randomUUID();
        changed = true;
      }
      return { changed, value: { user: found } };
    }

    const user = {
      id: randomUUID(),
      email: data.email,
      password: passwordPrefix(data.password),
      createdAt: new Date().toISOString(),
    };
    users.push(user);
    return { changed: true, value: { user } };
  });

  if (result.invalid) {
    return fail(req, res, 401, 'Usuário ou senha inválidos.');
  }

  const token = signSession({
    sub: result.user.id,
    exp: Date.now() + SESSION_TTL_MS,
  });
  return send(
    req,
    res,
    200,
    { ok: true, user: publicUser(result.user) },
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
    users: users.map(publicUser),
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
