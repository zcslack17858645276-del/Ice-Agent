export function appendChildren(node, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) {
      appendChildren(node, child);
      continue;
    }
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function el(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = String(value);
      else if (key === 'text') node.textContent = String(value);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key === 'attrs') {
        for (const [name, attrValue] of Object.entries(value)) {
          if (attrValue === null || attrValue === undefined || attrValue === false) continue;
          node.setAttribute(name, attrValue === true ? '' : String(attrValue));
        }
      } else if (key === 'style' && typeof value === 'object') {
        Object.assign(node.style, value);
      } else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key === 'value') {
        node.value = value;
      } else if (key in node) {
        node[key] = value;
      } else {
        node.setAttribute(key, String(value));
      }
    }
  }
  appendChildren(node, children);
  return node;
}

export function fragment(...children) {
  const node = document.createDocumentFragment();
  appendChildren(node, children);
  return node;
}

export function clear(node) {
  node.replaceChildren();
}

export function field(label, control, hint) {
  return el(
    'label',
    { class: 'field' },
    el('span', { class: 'field-label' }, label),
    control,
    hint ? el('small', { class: 'hint' }, hint) : null
  );
}

export function card(options, ...children) {
  const { title, actions, className } = options;
  const head =
    title || actions
      ? el(
          'div',
          { class: 'card-head' },
          el('h2', null, title || ''),
          actions ? el('div', { class: 'row' }, actions) : null
        )
      : null;
  return el('section', { class: className ? `card ${className}` : 'card' }, head, children);
}

export function statCard(label, value, sub) {
  return el(
    'div',
    { class: 'stat' },
    el('span', { class: 'stat-label' }, label),
    el('span', { class: 'stat-value' }, value),
    sub ? el('span', { class: 'stat-sub' }, sub) : null
  );
}

export function pill(text, tone) {
  const className =
    tone === true || tone === 'ok'
      ? 'pill is-ok'
      : tone === false || tone === 'bad'
        ? 'pill is-bad'
        : 'pill';
  return el('span', { class: className }, text);
}

export function badge(text, tone) {
  const className = tone ? `badge is-${tone}` : 'badge';
  return el('span', { class: className }, text);
}

export function dataTable(columns, rows, options = {}) {
  if (!rows.length) return el('div', { class: 'empty' }, options.empty || '暂无数据');
  const head = el(
    'thead',
    null,
    el('tr', null, ...columns.map((column) => el('th', null, column.label)))
  );
  const body = el(
    'tbody',
    null,
    ...rows.map((row) =>
      el(
        'tr',
        null,
        ...columns.map((column) => el('td', { class: column.cellClass }, column.render(row)))
      )
    )
  );
  return el('div', { class: 'table-wrap' }, el('table', { class: 'table' }, head, body));
}

export function errorText(error) {
  if (!error) return '未知错误';
  const data = error.data;
  const detail =
    data && typeof data === 'object'
      ? data.error || data.raw || error.message
      : error.message || String(error);
  const status = error.status ? `HTTP ${error.status}` : '无响应';
  return `${detail}（${status}）`;
}

export async function busy(button, task) {
  if (!button) return task();
  button.disabled = true;
  try {
    return await task();
  } finally {
    button.disabled = false;
  }
}

export function toast(message, type = 'info', timeout = 3600) {
  const host = document.getElementById('toast-host');
  if (!host) return;
  const node = el('div', { class: `toast toast-${type}`, role: 'status' }, message);
  host.append(node);
  requestAnimationFrame(() => node.classList.add('show'));
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    node.classList.remove('show');
    setTimeout(() => node.remove(), 220);
  };
  const timer = setTimeout(remove, timeout);
  node.addEventListener('click', () => {
    clearTimeout(timer);
    remove();
  });
}

export function modal(options) {
  const { title, body, footer, wide = false, onClose } = options || {};
  const overlay = el('div', { class: 'overlay' });
  const bodyEl = el('div', { class: 'modal-body' });
  appendChildren(bodyEl, [body]);
  const footerEl = el('div', { class: 'modal-footer' });
  if (footer) appendChildren(footerEl, [footer]);

  const dialog = el(
    'div',
    { class: wide ? 'modal modal-wide' : 'modal', attrs: { role: 'dialog', 'aria-modal': 'true' } },
    el(
      'header',
      { class: 'modal-head' },
      el('h3', null, title || ''),
      el(
        'button',
        {
          class: 'icon-button',
          type: 'button',
          attrs: { 'aria-label': '关闭' },
          onclick: () => close()
        },
        '×'
      )
    ),
    bodyEl,
    footerEl
  );
  overlay.append(dialog);
  document.body.append(overlay);
  document.body.classList.add('modal-open');

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    overlay.classList.remove('show');
    document.removeEventListener('keydown', onKeydown);
    document.body.classList.remove('modal-open');
    setTimeout(() => overlay.remove(), 180);
    if (typeof onClose === 'function') onClose();
  }
  function onKeydown(event) {
    if (event.key === 'Escape') close();
  }
  document.addEventListener('keydown', onKeydown);
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) close();
  });
  requestAnimationFrame(() => {
    overlay.classList.add('show');
    const focusable = dialog.querySelector('input, textarea, select, button');
    if (focusable) focusable.focus();
  });
  return { overlay, dialog, body: bodyEl, footer: footerEl, close };
}

export function confirmDialog(options) {
  const {
    title = '确认操作',
    message = '',
    confirmText = '确认',
    cancelText = '取消',
    danger = false
  } = options || {};
  return new Promise((resolve) => {
    const handle = modal({
      title,
      body: el('p', { class: 'confirm-text' }, message),
      footer: [
        el(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: () => {
              handle.close();
            }
          },
          cancelText
        ),
        el(
          'button',
          {
            class: danger ? 'btn btn-danger' : 'btn btn-primary',
            type: 'button',
            onclick: () => {
              resolve(true);
              handle.close();
            }
          },
          confirmText
        )
      ],
      onClose: () => resolve(false)
    });
  });
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = el('textarea', { class: 'sr-only' });
    area.value = text;
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

export function notice(text, tone = 'warn') {
  const suffix = tone === 'info' ? ' is-info' : tone === 'danger' ? ' is-danger' : '';
  return el('div', { class: `notice${suffix}` }, text);
}

export function dl(pairs) {
  return el(
    'dl',
    { class: 'kv' },
    ...pairs.map(([key, value]) => [
      el('dt', null, key),
      el('dd', null, value === null || value === undefined || value === '' ? '—' : value)
    ])
  );
}
