import { admin, clearToken, getToken, onUnauthorized, request, setToken, v1 } from './core.js';
import { el, errorText } from './ui.js';
import { render as renderDashboard } from './view-dashboard.js';
import { render as renderConfig } from './view-config.js';
import { render as renderPersonas } from './view-personas.js';
import { render as renderSessions } from './view-sessions.js';
import { render as renderCharacters } from './view-characters.js';
import { render as renderTester } from './view-tester.js';
import { render as renderLogs } from './view-logs.js';

const VIEWS = [
  { id: 'dashboard', title: '概览', render: renderDashboard },
  { id: 'config', title: '配置', render: renderConfig },
  { id: 'personas', title: '人格', render: renderPersonas },
  { id: 'sessions', title: '会话', render: renderSessions },
  { id: 'characters', title: '角色', render: renderCharacters },
  { id: 'tester', title: '接口测试', render: renderTester },
  { id: 'logs', title: '请求日志', render: renderLogs }
];

const dom = {
  login: document.getElementById('login'),
  loginForm: document.getElementById('login-form'),
  loginToken: document.getElementById('login-token'),
  loginRemember: document.getElementById('login-remember'),
  loginError: document.getElementById('login-error'),
  loginSubmit: document.getElementById('login-submit'),
  shell: document.getElementById('shell'),
  nav: document.getElementById('nav'),
  view: document.getElementById('view'),
  viewTitle: document.getElementById('view-title'),
  healthPill: document.getElementById('health-pill'),
  serverDot: document.getElementById('server-dot'),
  serverLine: document.getElementById('server-line'),
  refresh: document.getElementById('refresh'),
  logout: document.getElementById('logout')
};

let current = null;
let healthTimer = null;

function setLoginError(message) {
  if (!dom.loginError) return;
  dom.loginError.hidden = false;
  dom.loginError.textContent = message;
}

function hideLoginError() {
  if (!dom.loginError) return;
  dom.loginError.hidden = true;
  dom.loginError.textContent = '';
}

function stopHealth() {
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
}

function showLogin(message) {
  stopHealth();
  if (current && current.instance && current.instance.destroy) current.instance.destroy();
  current = null;
  dom.shell.hidden = true;
  dom.login.hidden = false;
  hideLoginError();
  if (message) setLoginError(message);
  if (dom.loginToken) {
    dom.loginToken.value = '';
    dom.loginToken.focus();
  }
}

function currentViewId() {
  const raw = location.hash.replace(/^#\/?/, '').split('?')[0];
  return VIEWS.some((view) => view.id === raw) ? raw : 'dashboard';
}

function navigate(id) {
  if (currentViewId() === id && current && current.instance) {
    void renderRoute();
    return;
  }
  location.hash = `#/${id}`;
}

function errorCard(error) {
  return el(
    'div',
    { class: 'card' },
    el('h2', null, '加载失败'),
    el('p', { class: 'muted' }, errorText(error))
  );
}

async function renderRoute() {
  const id = currentViewId();
  const view = VIEWS.find((entry) => entry.id === id) || VIEWS[0];
  if (current && current.instance && current.instance.destroy) current.instance.destroy();
  current = { id: view.id, instance: null };
  dom.viewTitle.textContent = view.title;
  for (const item of dom.nav.querySelectorAll('.nav-item')) {
    item.classList.toggle('is-active', item.dataset.view === view.id);
  }
  dom.view.replaceChildren(el('div', { class: 'empty' }, '加载中…'));
  try {
    const instance = await view.render({ navigate });
    if (!current || current.id !== view.id) {
      if (instance && instance.destroy) instance.destroy();
      return;
    }
    current.instance = instance;
    dom.view.replaceChildren(instance.el || instance);
  } catch (error) {
    dom.view.replaceChildren(errorCard(error));
  }
}

async function checkHealth() {
  try {
    const { data } = await v1.health();
    dom.healthPill.textContent = `在线 · v${data.version ?? '?'}`;
    dom.healthPill.className = 'pill is-ok';
    dom.serverDot.className = 'dot is-ok';
  } catch {
    dom.healthPill.textContent = '离线';
    dom.healthPill.className = 'pill is-bad';
    dom.serverDot.className = 'dot is-bad';
    dom.serverLine.textContent = '未连接';
  }
}

async function refreshStatus() {
  try {
    const { data } = await admin.status();
    const pending = data.portPending ? '（端口待生效）' : '';
    dom.serverLine.textContent = `${location.hostname}:${data.listeningPort}${pending}`;
  } catch {
    dom.serverLine.textContent = '状态未知';
  }
}

function startHealth() {
  stopHealth();
  void checkHealth();
  healthTimer = setInterval(() => {
    void checkHealth();
  }, 10000);
}

async function boot() {
  dom.shell.hidden = false;
  dom.login.hidden = true;
  startHealth();
  try {
    await refreshStatus();
  } catch {
    /* status is advisory */
  }
  if (!getToken()) return;
  await renderRoute();
}

async function login(token) {
  await request('/v1/config', { token });
  setToken(token, dom.loginRemember.checked);
  hideLoginError();
  dom.loginForm.reset();
  await boot();
}

if (dom.loginForm) {
  dom.loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const token = dom.loginToken.value.trim();
    if (!token) {
      setLoginError('请输入访问令牌');
      return;
    }
    hideLoginError();
    dom.loginSubmit.disabled = true;
    dom.loginSubmit.textContent = '验证中…';
    try {
      await login(token);
    } catch (error) {
      setLoginError(errorText(error));
    } finally {
      dom.loginSubmit.disabled = false;
      dom.loginSubmit.textContent = '登录';
    }
  });
}

if (dom.logout) {
  dom.logout.addEventListener('click', () => {
    clearToken();
    showLogin();
  });
}

if (dom.refresh) {
  dom.refresh.addEventListener('click', () => {
    void checkHealth();
    void refreshStatus();
    void renderRoute();
  });
}

window.addEventListener('hashchange', () => {
  if (!getToken()) return;
  void renderRoute();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && getToken()) void checkHealth();
});

onUnauthorized(() => {
  clearToken();
  showLogin('令牌无效或已更新，请重新登录。');
});

if (getToken()) {
  void boot();
} else {
  showLogin();
}
