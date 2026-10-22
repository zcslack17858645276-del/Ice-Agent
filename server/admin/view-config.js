import { admin, formatBytes, isTokenRemembered, setToken, v1 } from './core.js';
import {
  busy,
  card,
  confirmDialog,
  copyText,
  dl,
  el,
  errorText,
  field,
  notice,
  toast
} from './ui.js';

const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{16,128}$/;

function maskToken(token) {
  if (!token) return '未设置';
  if (token.length <= 8) return '••••';
  return `${token.slice(0, 4)}••••${token.slice(-4)}`;
}

export async function render() {
  const [settingsRes, statusRes] = await Promise.all([admin.settings(), admin.status()]);
  const data = settingsRes.data;
  const status = statusRes.data;
  const config = data.config || {};
  const voice = config.voice || data.voiceDefaults || {};
  const commands = voice.commands || {};
  const root = el('div', { class: 'stack' });

  const modelInput = el('input', { class: 'input', value: config.model || '', spellcheck: false });
  const baseUrlInput = el('input', {
    class: 'input',
    value: config.baseUrl || '',
    spellcheck: false
  });
  const apiKeyInput = el('input', {
    class: 'input mono',
    type: 'password',
    value: config.apiKey || '',
    autocomplete: 'off',
    spellcheck: false
  });

  const whisperInput = el('input', {
    class: 'input mono',
    value: voice.whisperUrl || '',
    spellcheck: false
  });
  const ttsInput = el('input', {
    class: 'input mono',
    value: voice.ttsUrl || '',
    spellcheck: false
  });
  const enabledInput = el('input', { type: 'checkbox', checked: Boolean(voice.enabled) });
  const refAudioInput = el('input', {
    class: 'input mono',
    value: voice.referenceAudio || '',
    spellcheck: false
  });
  const refTextInput = el('textarea', {
    class: 'textarea',
    rows: 2,
    value: voice.referenceTranscript || ''
  });
  const refLangInput = el('input', {
    class: 'input',
    value: voice.referenceLanguage || 'zh',
    spellcheck: false
  });

  const commandFields = [
    ['whisperStart', 'Whisper 启动命令'],
    ['whisperStop', 'Whisper 停止命令'],
    ['sovitsStart', 'SoVITS 启动命令'],
    ['sovitsStop', 'SoVITS 停止命令']
  ].map(([key, label]) => {
    const area = el('textarea', {
      class: 'textarea mono',
      rows: 2,
      value: commands[key] || '',
      spellcheck: false
    });
    return { key, node: field(label, area) };
  });

  const saveButton = el(
    'button',
    {
      class: 'btn btn-primary',
      type: 'button',
      onclick: async (event) => {
        const button = event.currentTarget;
        if (!modelInput.value.trim()) {
          toast('模型不能为空', 'error');
          return;
        }
        if (!baseUrlInput.value.trim()) {
          toast('上游地址不能为空', 'error');
          return;
        }
        const voicePatch = {
          whisperUrl: whisperInput.value.trim(),
          ttsUrl: ttsInput.value.trim(),
          enabled: enabledInput.checked,
          referenceAudio: refAudioInput.value.trim(),
          referenceTranscript: refTextInput.value,
          referenceLanguage: refLangInput.value.trim() || 'zh',
          commands: {}
        };
        for (const entry of commandFields) {
          voicePatch.commands[entry.key] = entry.node.querySelector('textarea').value;
        }
        await busy(button, async () => {
          try {
            await v1.patchConfig({
              model: modelInput.value.trim(),
              baseUrl: baseUrlInput.value.trim(),
              apiKey: apiKeyInput.value.trim(),
              voice: voicePatch
            });
            toast('配置已保存', 'ok');
          } catch (error) {
            toast(errorText(error), 'error');
          }
        });
      }
    },
    '保存配置'
  );

  root.append(
    card(
      { title: '模型', actions: saveButton },
      el(
        'div',
        { class: 'field-grid' },
        field('模型 model', modelInput),
        field('上游 baseUrl', baseUrlInput),
        field('API Key', apiKeyInput, '保存在 config.json，仅本机可读')
      )
    ),
    card(
      { title: '语音链路' },
      el(
        'div',
        { class: 'stack' },
        el(
          'div',
          { class: 'field-grid' },
          field('Whisper 地址', whisperInput),
          field('GPT-SoVITS 地址', ttsInput),
          field('参考语言', refLangInput)
        ),
        el('label', { class: 'switch-row' }, enabledInput, el('span', null, '启用语音链路')),
        el(
          'div',
          { class: 'field-grid' },
          field('参考音频路径', refAudioInput, '服务器本地路径，客户端不可见'),
          field('参考文本', refTextInput)
        ),
        el('div', { class: 'field-grid' }, ...commandFields.map((entry) => entry.node)),
        el(
          'p',
          { class: 'hint' },
          '命令在 WSL 中执行；启动命令末尾保留 sleep，否则 wsl -e 退出会带走后台进程。'
        )
      )
    ),
    tokenCard(),
    portCard(),
    pathsCard()
  );

  return { el: root };

  function tokenCard() {
    const tokenInput = el('input', {
      class: 'input mono',
      placeholder: '新的 token（16–128 位）',
      autocomplete: 'off',
      spellcheck: false,
      style: { flex: '1 1 220px' }
    });
    const maskedEl = el('code', null, maskToken(data.tokenConfigured ? data.tokenMasked : ''));

    const applyToken = async (button, token) => {
      const confirmed = await confirmDialog({
        title: '更新访问令牌',
        message:
          '更新后，桌宠与手机端需要使用新令牌才能继续访问服务器；本页面会自动改用新令牌。确定继续？',
        confirmText: '更新令牌',
        danger: true
      });
      if (!confirmed) return;
      await busy(button, async () => {
        try {
          const { data: result } = await admin.rotateToken(token);
          setToken(result.token, isTokenRemembered());
          maskedEl.textContent = maskToken(result.token);
          tokenInput.value = '';
          const copied = await copyText(result.token);
          toast(copied ? '新令牌已复制到剪贴板' : `新令牌：${result.token}`, 'ok', 8000);
        } catch (error) {
          toast(errorText(error), 'error');
        }
      });
    };

    return card(
      { title: '访问令牌' },
      el(
        'p',
        { class: 'muted' },
        '当前令牌：',
        maskedEl,
        '。令牌用于所有 /v1 接口鉴权，更新后立刻生效。'
      ),
      el(
        'div',
        { class: 'row' },
        tokenInput,
        el(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: async (event) => {
              const button = event.currentTarget;
              const value = tokenInput.value.trim();
              if (!TOKEN_PATTERN.test(value)) {
                toast('令牌需为 16–128 位字母、数字或 . _ ~ -', 'error');
                return;
              }
              await applyToken(button, value);
            }
          },
          '应用自定义'
        ),
        el(
          'button',
          {
            class: 'btn btn-danger',
            type: 'button',
            onclick: async (event) => {
              await applyToken(event.currentTarget, '');
            }
          },
          '生成随机令牌'
        )
      )
    );
  }

  function portCard() {
    const portInput = el('input', {
      class: 'input mono',
      type: 'number',
      min: '1',
      max: '65535',
      value: String(config.port || status.listeningPort || 8787),
      style: { width: '150px', flex: 'none' }
    });
    const hint = el('div', { class: 'stack' });
    return card(
      { title: '监听端口' },
      el(
        'div',
        { class: 'stack' },
        el(
          'div',
          { class: 'row' },
          portInput,
          el(
            'button',
            {
              class: 'btn',
              type: 'button',
              onclick: async (event) => {
                const button = event.currentTarget;
                const port = Number(portInput.value);
                if (!Number.isInteger(port) || port < 1 || port > 65535) {
                  toast('端口需为 1–65535 的整数', 'error');
                  return;
                }
                const confirmed = await confirmDialog({
                  title: '修改监听端口',
                  message: `将配置端口改为 ${port}。修改会写入 config.json，需要重启服务器后生效。`,
                  confirmText: '保存端口'
                });
                if (!confirmed) return;
                await busy(button, async () => {
                  try {
                    const { data: result } = await admin.setPort(port);
                    hint.replaceChildren(
                      result.changed === false
                        ? notice('端口没有变化。', 'info')
                        : notice(
                            `已写入端口 ${result.port}。请重启服务器：node D:\\IceAgent\\server\\server.mjs`,
                            'warn'
                          )
                    );
                    toast('端口配置已保存，重启后生效', 'ok');
                  } catch (error) {
                    hint.replaceChildren(notice(errorText(error), 'danger'));
                  }
                });
              }
            },
            '保存端口'
          )
        ),
        hint,
        el(
          'p',
          { class: 'hint' },
          `当前实际监听 ${status.listeningPort}；服务器以 0.0.0.0 监听，管理后台只响应 127.0.0.1。`
        )
      )
    );
  }

  function pathsCard() {
    return card(
      { title: '运行路径' },
      dl([
        ['数据根目录', status.root],
        ['配置', status.configPath],
        ['人格目录', status.personasDir],
        ['请求日志', `${status.logPath}（${formatBytes(status.logSize)}）`],
        ['管理后台', status.adminDir || '未安装'],
        ['Node', status.node]
      ])
    );
  }
}
