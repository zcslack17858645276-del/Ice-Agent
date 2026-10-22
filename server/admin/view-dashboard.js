import { admin, formatBytes, formatDuration, formatShortTime, v1 } from './core.js';
import { badge, busy, card, dataTable, dl, el, errorText, pill, statCard, toast } from './ui.js';

export function render(ctx) {
  const state = { disposed: false };
  const root = el('div', { class: 'stack' });
  root.append(el('div', { class: 'empty' }, '正在加载…'));

  void load();

  return {
    el: root,
    destroy() {
      state.disposed = true;
    }
  };

  async function load() {
    try {
      const [status, voice, sessions] = await Promise.all([
        admin.status(),
        v1.voiceStatus().catch(() => null),
        v1.sessions().catch(() => null)
      ]);
      if (state.disposed) return;
      paint(status.data, voice ? voice.data : null, sessions ? sessions.data.sessions : []);
    } catch (error) {
      if (state.disposed) return;
      root.replaceChildren(
        card(
          { title: '无法读取服务器状态' },
          el('p', { class: 'muted' }, errorText(error)),
          el(
            'button',
            {
              class: 'btn',
              type: 'button',
              onclick: () => {
                root.replaceChildren(el('div', { class: 'empty' }, '正在加载…'));
                void load();
              }
            },
            '重试'
          )
        )
      );
    }
  }

  function paint(status, voice, sessions) {
    const recent = sessions.slice(0, 5);
    root.replaceChildren(
      el(
        'div',
        { class: 'grid' },
        statCard(
          '运行时长',
          formatDuration(status.uptimeSec),
          `自 ${formatShortTime(status.startedAt)}`
        ),
        statCard('会话', String(status.counts.sessions), 'D:\\IceAgent\\sessions'),
        statCard('人格', String(status.counts.personas), `当前 ${status.activePersona}`),
        statCard('角色', String(status.counts.characters), '已导入角色'),
        statCard('内存', `${status.memoryRss} MB`, `Node ${status.node}`),
        statCard('请求日志', formatBytes(status.logSize), 'server/requests.log')
      ),
      card(
        { title: '服务器' },
        dl([
          ['版本', `v${status.version}`],
          [
            '端口',
            status.portPending
              ? `${status.listeningPort}（配置 ${status.port}，重启后生效）`
              : String(status.listeningPort)
          ],
          ['模型', status.model],
          ['上游', status.baseUrl],
          ['数据目录', status.root],
          ['配置', status.configPath],
          ['人格目录', status.personasDir],
          ['管理后台', status.adminDir || '未安装']
        ])
      ),
      voiceCard(voice),
      card(
        {
          title: '最近会话',
          actions: el('a', { class: 'btn btn-sm', href: '#/sessions' }, '全部会话')
        },
        dataTable(
          [
            { label: '标题', render: (row) => row.title || '未命名' },
            { label: '消息', render: (row) => String(row.count) },
            { label: '创建', render: (row) => formatShortTime(row.createdAt) },
            { label: '最后一条', cellClass: 'truncate', render: (row) => row.last || '—' }
          ],
          recent,
          { empty: '还没有会话' }
        )
      )
    );
  }

  function voiceCard(voice) {
    if (!voice) {
      return card({ title: '语音服务' }, el('p', { class: 'muted' }, '无法读取语音状态'));
    }
    const asr = pill(voice.asr ? 'Whisper 在线' : 'Whisper 离线', voice.asr);
    const tts = pill(voice.tts ? 'GPT-SoVITS 在线' : 'GPT-SoVITS 离线', voice.tts);
    const refresh = el(
      'button',
      {
        class: 'btn btn-sm',
        type: 'button',
        onclick: async (event) => {
          await busy(event.currentTarget, async () => {
            try {
              const { data } = await v1.voiceStatus();
              toast(
                `Whisper ${data.asr ? '在线' : '离线'} · GPT-SoVITS ${data.tts ? '在线' : '离线'}`,
                data.asr || data.tts ? 'ok' : 'warn'
              );
            } catch (error) {
              toast(errorText(error), 'error');
            }
          });
        }
      },
      '重新检测'
    );
    return card(
      { title: '语音服务', actions: refresh },
      el(
        'div',
        { class: 'stack' },
        el('div', { class: 'row' }, asr, el('span', { class: 'muted small' }, voice.whisperUrl)),
        el('div', { class: 'row' }, tts, el('span', { class: 'muted small' }, voice.ttsUrl)),
        el(
          'div',
          { class: 'row' },
          serviceButton('启动 Whisper', 'start', 'whisper'),
          serviceButton('停止 Whisper', 'stop', 'whisper'),
          el('span', { class: 'spacer' }),
          serviceButton('启动 SoVITS', 'start', 'sovits'),
          serviceButton('停止 SoVITS', 'stop', 'sovits')
        )
      )
    );
  }

  function serviceButton(label, action, service) {
    return el(
      'button',
      {
        class: action === 'stop' ? 'btn btn-sm' : 'btn btn-sm btn-primary',
        type: 'button',
        onclick: async (event) => {
          await busy(event.currentTarget, async () => {
            try {
              await v1.voice(action, service);
              toast(`已发送${action === 'start' ? '启动' : '停止'}命令：${service}`, 'ok');
            } catch (error) {
              toast(errorText(error), 'error');
            }
          });
        }
      },
      label
    );
  }
}
