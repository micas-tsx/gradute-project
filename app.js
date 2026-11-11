/* global document, fetch, window */

const API_BASE = (document.documentElement.dataset.apiBase || '').replace(/\/$/, '');

const els = {
  authView: document.getElementById('authView'),
  accountView: document.getElementById('accountView'),
  tabLogin: document.getElementById('tab-login'),
  tabRegister: document.getElementById('tab-register'),
  loginForm: document.getElementById('panel-login'),
  registerForm: document.getElementById('panel-register'),
  loginSubmit: document.querySelector('#panel-login button[type="submit"]'),
  registerSubmit: document.querySelector('#panel-register button[type="submit"]'),
  loginEmail: document.getElementById('login-email'),
  loginPassword: document.getElementById('login-password'),
  registerEmail: document.getElementById('register-email'),
  registerPassword: document.getElementById('register-password'),
  registerConfirm: document.getElementById('register-confirm'),
  status: document.getElementById('status'),
  statusAccount: document.getElementById('status-account'),
  accountEmail: document.getElementById('account-email'),
  accountCreated: document.getElementById('account-created'),
  logoutBtn: document.getElementById('logoutBtn'),
};

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function setStatus(el, message, kind = '') {
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('is-error', kind === 'error');
  el.classList.toggle('is-success', kind === 'success');
}

async function api(path, options = {}) {
  const { headers, ...rest } = options;
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...rest,
    headers: {
      'Content-Type': 'application/json',
      ...(headers || {}),
    },
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const error = new Error(data?.error || 'Não foi possível concluir a solicitação.');
    error.status = response.status;
    throw error;
  }

  return data;
}

function friendlyError(err) {
  if (err?.status) return err.message;
  return 'Não foi possível conectar ao servidor. Verifique se a API está online e tente novamente.';
}

function setBusy(button, busy, label) {
  if (!button) return;
  if (busy) {
    button.dataset.originalLabel = button.textContent;
    button.textContent = label;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalLabel || button.textContent;
    button.disabled = false;
    delete button.dataset.originalLabel;
  }
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

function formatDate(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(date);
}

/* ------------------------------------------------------------------ */
/* Alternância de abas                                                */
/* ------------------------------------------------------------------ */

function selectTab(tab) {
  const loginSelected = tab === 'login';
  els.tabLogin.classList.toggle('is-active', loginSelected);
  els.tabRegister.classList.toggle('is-active', !loginSelected);
  els.tabLogin.setAttribute('aria-selected', String(loginSelected));
  els.tabRegister.setAttribute('aria-selected', String(!loginSelected));
  els.tabLogin.tabIndex = loginSelected ? 0 : -1;
  els.tabRegister.tabIndex = loginSelected ? -1 : 0;

  els.loginForm.hidden = !loginSelected;
  els.registerForm.hidden = loginSelected;

  setStatus(els.status, '');
  const firstInput = loginSelected ? els.loginEmail : els.registerEmail;
  firstInput.focus({ preventScroll: true });
}

els.tabLogin.addEventListener('click', () => selectTab('login'));
els.tabRegister.addEventListener('click', () => selectTab('register'));

[els.tabLogin, els.tabRegister].forEach((tab) => {
  tab.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const next = tab === els.tabLogin ? els.tabRegister : els.tabLogin;
      next.focus();
      next.click();
    }
  });
});

/* ------------------------------------------------------------------ */
/* Mostrar / ocultar senha                                            */
/* ------------------------------------------------------------------ */

document.querySelectorAll('[data-reveal]').forEach((button) => {
  button.addEventListener('click', () => {
    const input = document.getElementById(button.dataset.reveal);
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    button.textContent = show ? 'Ocultar' : 'Mostrar';
    button.setAttribute('aria-label', show ? 'Ocultar senha' : 'Mostrar senha');
    button.setAttribute('aria-pressed', String(show));
    input.focus({ preventScroll: true });
  });
});

/* ------------------------------------------------------------------ */
/* Login                                                              */
/* ------------------------------------------------------------------ */

els.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setStatus(els.status, '');

  const email = els.loginEmail.value.trim().toLowerCase();
  const password = els.loginPassword.value;

  if (!isValidEmail(email)) {
    setStatus(els.status, 'Informe um e-mail válido.', 'error');
    els.loginEmail.focus();
    return;
  }
  if (!password) {
    setStatus(els.status, 'Informe sua senha.', 'error');
    els.loginPassword.focus();
    return;
  }

  setBusy(els.loginSubmit, true, 'Entrando…');
  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    els.loginForm.reset();
    showAccount(data.user);
  } catch (err) {
    setStatus(els.status, friendlyError(err), 'error');
  } finally {
    setBusy(els.loginSubmit, false);
  }
});

/* ------------------------------------------------------------------ */
/* Cadastro                                                           */
/* ------------------------------------------------------------------ */

els.registerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setStatus(els.status, '');

  const email = els.registerEmail.value.trim().toLowerCase();
  const password = els.registerPassword.value;
  const confirm = els.registerConfirm.value;

  if (!isValidEmail(email)) {
    setStatus(els.status, 'Informe um e-mail válido.', 'error');
    els.registerEmail.focus();
    return;
  }
  if (password.length < 8) {
    setStatus(els.status, 'A senha precisa ter pelo menos 8 caracteres.', 'error');
    els.registerPassword.focus();
    return;
  }
  if (password !== confirm) {
    setStatus(els.status, 'As senhas não conferem.', 'error');
    els.registerConfirm.focus();
    return;
  }

  setBusy(els.registerSubmit, true, 'Criando conta…');
  try {
    const data = await api('/api/register', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    els.registerForm.reset();
    showAccount(data.user, 'Conta criada com sucesso.');
  } catch (err) {
    setStatus(els.status, friendlyError(err), 'error');
  } finally {
    setBusy(els.registerSubmit, false);
  }
});

/* ------------------------------------------------------------------ */
/* Sessão                                                             */
/* ------------------------------------------------------------------ */

function showAccount(user, message = '') {
  els.authView.hidden = true;
  els.accountView.hidden = false;
  els.accountEmail.textContent = user?.email || '—';
  els.accountCreated.textContent = formatDate(user?.createdAt);
  setStatus(els.statusAccount, message, message ? 'success' : '');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showAuth() {
  els.accountView.hidden = true;
  els.authView.hidden = false;
  setStatus(els.statusAccount, '');
}

els.logoutBtn.addEventListener('click', async () => {
  setBusy(els.logoutBtn, true, 'Saindo…');
  try {
    await api('/api/logout', { method: 'POST' });
  } catch {
    /* Sessão local é encerrada de qualquer forma. */
  } finally {
    setBusy(els.logoutBtn, false);
    showAuth();
    selectTab('login');
  }
});

async function checkSession() {
  try {
    const data = await api('/api/me', { method: 'GET' });
    if (data?.user) showAccount(data.user);
  } catch (err) {
    if (err?.status === 401) return; // visitante normal
    setStatus(
      els.status,
      'Servidor indisponível no momento. Você ainda pode preencher o formulário e tentar enviar.',
      'error'
    );
  }
}

checkSession();
