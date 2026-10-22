import { request } from './core.js';
import { busy, card, copyText, el, errorText, field, pill, toast } from './ui.js';

const PRESETS = [
  { label: '健康检查', method: 'GET', path: '/v1/health' },
  { label: '读取配置', method: 'GET', path: '/v1/config' },
  { label: '人格列表', method: 'GET', path: '/v1/personas' },
  { label: '会话列表', method: 'GET', path: '/v1/sessions' },
  { label: '新建会话', method: 'POST', path: '/v1/sessions', body: '{}' },
  { label: '角色列表', method: 'GET', path: '/v1/characters' },
  { label: '语音状态', method: 'GET', path: '/v1/voice/status' },
  {
    label: '普通聊天（非流式）',
    method: 'POST',
    path: '/v1/chat',
    body: JSON.stringify(
      { stream: false, messages: [{ role: 'user', content: '你好，简单介绍一下自己。' }] },
      null,
      2
    )
  },
  { label: '管理：状态', method: 'GET', path: '/admin/api/status' },
  { label: '管理：日志', method: 'GET', path: '/admin/api/log?lines=50' }
];

export function render() {
  const root = el('div', { class: 'stack' });

  const methodSelect = el(
    'select',
    { class: 'select', style: { width: '110px', flex: 'none' } },
    ...['GET', 'POST', 'DELETE'].map((method) => el('option', { value: method }, method))
  );
  const pathInput = el('input', {
    class: 'input mono',
    value: '/v1/health',
    spellcheck: false,
    attrs: { list: 'endpoint-list' }
  });
  const bodyArea = el('textarea', {
    class: 'textarea mono',
    rows: 8,
    spellcheck: false,
    placeholder: 'POST/DELETE 请求体（JSON，可留空）'
  });
  const responseSlot = el(
    'div',
    { class: 'stack' },
    el('div', { class: 'empty' }, '还没有发送请求')
  );

  const presetSelect = el(
    'select',
    {
      class: 'select',
      style: { width: 'auto', maxWidth: '260px' },
      onchange: (event) => {
        const preset = PRESETS[Number(event.currentTarget.value)];
        if (!preset) return;
        methodSelect.value = preset.method;
        pathInput.value = preset.path;
        bodyArea.value = preset.body || '';
      }
    },
    el('option', { value: '' }, '选择示例接口…'),
    ...PRESETS.map((preset, index) =>
      el('option', { value: String(index) }, `${preset.method} ${preset.path}`)
    )
  );

  const sendButton = el(
    'button',
    {
      class: 'btn btn-primary',
      type: 'button',
      onclick: async (event) => {
        const button = event.currentTarget;
        await busy(button, () => send(methodSelect, pathInput, bodyArea, responseSlot));
      }
    },
    '发送'
  );

  root.append(
    el(
      'datalist',
      { id: 'endpoint-list' },
      ...PRESETS.map((preset) => el('option', { value: preset.path }))
    ),
    card(
      { title: '请求', actions: presetSelect },
      el(
        'div',
        { class: 'stack' },
        el('div', { class: 'row' }, methodSelect, pathInput),
        field('请求体', bodyArea),
        el(
          'div',
          { class: 'row' },
          sendButton,
          el(
            'span',
            { class: 'muted small' },
            '会自动带上当前登录令牌；SSE 流式接口不适用于本测试器。'
          )
        )
      )
    ),
    responseSlot
  );

  return { el: root };
}

async function send(methodSelect, pathInput, bodyArea, slot) {
  const method = methodSelect.value;
  const path = pathInput.value.trim();
  if (!path) {
    toast('请填写接口路径', 'error');
    return;
  }
  let body;
  if (method !== 'GET') {
    const raw = bodyArea.value.trim();
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch (error) {
        toast(`请求体 JSON 无效：${error.message}`, 'error');
        return;
      }
    }
  }
  try {
    const result = await request(path, {
      method,
      body,
      admin: path.startsWith('/admin/api/')
    });
    slot.replaceChildren(responseCard(result, path));
  } catch (error) {
    slot.replaceChildren(
      card(
        { title: '请求失败' },
        el('p', { class: 'muted' }, errorText(error)),
        error.data ? el('pre', { class: 'code' }, JSON.stringify(error.data, null, 2)) : null
      )
    );
  }
}

function responseCard(result, path) {
  const ok = result.status >= 200 && result.status < 300;
  const pretty =
    result.data && typeof result.data === 'object'
      ? JSON.stringify(result.data, null, 2)
      : result.raw || '(空响应)';
  const raw = result.raw || '';
  const bodyEl = el('pre', { class: 'code' }, pretty);

  return card(
    { title: '响应' },
    el(
      'div',
      { class: 'row' },
      pill(`${result.status}`, ok),
      el('span', { class: 'muted small' }, `${result.ms} ms`),
      el('span', { class: 'muted small' }, `${raw.length} 字符`),
      el('span', { class: 'muted small' }, path),
      el('span', { class: 'spacer' }),
      el(
        'button',
        {
          class: 'btn btn-sm',
          type: 'button',
          onclick: async () => {
            const copied = await copyText(raw);
            toast(copied ? '已复制响应原文' : '复制失败', copied ? 'ok' : 'error');
          }
        },
        '复制原文'
      ),
      el(
        'button',
        {
          class: 'btn btn-sm',
          type: 'button',
          onclick: (event) => {
            const showingRaw = bodyEl.dataset.raw === '1';
            const next = !showingRaw;
            bodyEl.dataset.raw = next ? '1' : '0';
            bodyEl.textContent = next ? raw || '(空响应)' : pretty;
            event.currentTarget.textContent = next ? '显示格式化' : '显示原文';
          }
        },
        '显示原文'
      )
    ),
    bodyEl
  );
}
