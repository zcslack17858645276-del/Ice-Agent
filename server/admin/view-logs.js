import { admin, formatBytes, request } from './core.js';
import { busy, card, confirmDialog, el, errorText, toast } from './ui.js';

const LINE_PATTERN = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d{3})\s+(\d+)ms$/;

function clock(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || '').slice(0, 12);
  const pad = (part) => String(part).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function statusTone(status) {
  if (status >= 500) return ' is-bad';
  if (status >= 400) return ' is-warn';
  return '';
}

export function render() {
  const root = el('div', { class: 'stack' });
  const state = { disposed: false, timer: null, loading: false };

  const linesSelect = el(
    'select',
    {
      class: 'select',
      style: { width: '120px' },
      onchange: () => void load()
    },
    ...[100, 200, 500, 1000, 2000].map((count) =>
      el('option', { value: String(count), selected: count === 200 }, `${count} 行`)
    )
  );
  const filterInput = el('input', {
    class: 'input',
    placeholder: '过滤：路径 / 状态码 / 方法',
    spellcheck: false
  });
  let filterTimer = null;
  filterInput.addEventListener('input', () => {
    if (filterTimer) clearTimeout(filterTimer);
    filterTimer = setTimeout(() => void load(), 320);
  });

  const autoInput = el('input', { type: 'checkbox', checked: true });
  const meta = el('span', { class: 'muted small' }, '');
  const box = el('div', { class: 'log-box' });
  const refreshButton = el(
    'button',
    {
      class: 'btn btn-sm',
      type: 'button',
      onclick: (event) => busy(event.currentTarget, () => load())
    },
    '刷新'
  );
  const downloadButton = el(
    'button',
    {
      class: 'btn btn-sm',
      type: 'button',
      onclick: async (event) => {
        await busy(event.currentTarget, async () => {
          try {
            const result = await request('/admin/api/log/download');
            const blob = new Blob([result.raw || ''], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const link = el('a', { href: url, download: 'requests.log' });
            document.body.append(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 2000);
          } catch (error) {
            toast(errorText(error), 'error');
          }
        });
      }
    },
    '下载'
  );
  const clearButton = el(
    'button',
    {
      class: 'btn btn-sm btn-danger',
      type: 'button',
      onclick: async (event) => {
        const button = event.currentTarget;
        const confirmed = await confirmDialog({
          title: '清空请求日志',
          message: '确定清空 requests.log？清空后无法恢复。',
          confirmText: '清空',
          danger: true
        });
        if (!confirmed) return;
        await busy(button, async () => {
          try {
            await admin.clearLog();
            toast('日志已清空', 'ok');
            await load();
          } catch (error) {
            toast(errorText(error), 'error');
          }
        });
      }
    },
    '清空'
  );

  root.append(
    card(
      { title: '请求日志' },
      el(
        'div',
        { class: 'stack' },
        el(
          'div',
          { class: 'log-toolbar' },
          linesSelect,
          filterInput,
          el('label', { class: 'switch-row' }, autoInput, el('span', null, '自动刷新')),
          meta,
          el('span', { class: 'spacer' }),
          refreshButton,
          downloadButton,
          clearButton
        ),
        box
      )
    )
  );

  void load();
  state.timer = setInterval(() => {
    if (autoInput.checked && !document.hidden) void load();
  }, 5000);

  return {
    el: root,
    destroy() {
      state.disposed = true;
      if (state.timer) clearInterval(state.timer);
      if (filterTimer) clearTimeout(filterTimer);
    }
  };

  async function load() {
    if (state.disposed || state.loading) return;
    state.loading = true;
    try {
      const { data } = await admin.log({
        lines: Number(linesSelect.value) || 200,
        q: filterInput.value.trim()
      });
      if (state.disposed) return;
      const stickToBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
      renderLines(data.lines || []);
      meta.textContent = `${data.matched}/${data.total} 行 · ${formatBytes(data.size)}`;
      if (stickToBottom) box.scrollTop = box.scrollHeight;
    } catch (error) {
      if (!state.disposed) {
        box.replaceChildren(el('div', { class: 'empty' }, errorText(error)));
      }
    } finally {
      state.loading = false;
    }
  }

  function renderLines(lines) {
    if (lines.length === 0) {
      box.replaceChildren(el('div', { class: 'empty' }, '暂无日志'));
      return;
    }
    box.replaceChildren(
      ...lines.map((line) => {
        const match = LINE_PATTERN.exec(line);
        if (!match) {
          return el('div', { class: 'log-line log-line-plain' }, line);
        }
        const [, stamp, address, method, target, status, duration] = match;
        const code = Number(status);
        return el(
          'div',
          { class: 'log-line', title: `${stamp} ${address} ${method} ${target}` },
          el('span', { class: 'log-time' }, clock(stamp)),
          el('span', { class: 'log-method' }, method),
          el('span', { class: 'log-path' }, target),
          el('span', { class: `log-status${statusTone(code)}` }, status),
          el('span', { class: 'log-ms' }, `${duration}ms`)
        );
      })
    );
  }
}
