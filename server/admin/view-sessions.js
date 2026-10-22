import { formatShortTime, formatTime, v1 } from './core.js';
import { badge, busy, card, confirmDialog, dataTable, el, errorText, modal, toast } from './ui.js';

export async function render() {
  const root = el('div', { class: 'stack' });
  const state = { disposed: false };
  let sessions = [];

  await load();

  return {
    el: root,
    destroy() {
      state.disposed = true;
    }
  };

  async function load() {
    const { data } = await v1.sessions();
    sessions = data.sessions || [];
    paint();
  }

  function paint() {
    if (state.disposed) return;
    root.replaceChildren(
      card(
        {
          title: `会话（${sessions.length}）`,
          actions: [
            el(
              'button',
              {
                class: 'btn btn-sm',
                type: 'button',
                onclick: async (event) => {
                  await busy(event.currentTarget, async () => {
                    try {
                      await v1.createSession();
                      toast('已创建空会话', 'ok');
                      await load();
                    } catch (error) {
                      toast(errorText(error), 'error');
                    }
                  });
                }
              },
              '新建会话'
            ),
            el(
              'button',
              {
                class: 'btn btn-sm',
                type: 'button',
                onclick: async (event) => {
                  await busy(event.currentTarget, async () => {
                    try {
                      await load();
                      toast('已刷新', 'ok');
                    } catch (error) {
                      toast(errorText(error), 'error');
                    }
                  });
                }
              },
              '刷新'
            )
          ]
        },
        el('p', { class: 'muted small' }, '桌面端与手机端共用同一批会话文件，服务器是唯一数据源。'),
        dataTable(
          [
            { label: '标题', render: (row) => row.title || '未命名' },
            { label: '条数', render: (row) => String(row.count ?? 0) },
            { label: '创建时间', render: (row) => formatShortTime(row.createdAt) },
            { label: '最后一条', cellClass: 'truncate', render: (row) => row.last || '—' },
            {
              label: '操作',
              cellClass: 'actions',
              render: (row) => [
                el(
                  'button',
                  {
                    class: 'btn btn-sm',
                    type: 'button',
                    onclick: (event) => openSession(row, event.currentTarget)
                  },
                  '查看'
                ),
                el(
                  'button',
                  {
                    class: 'btn btn-sm btn-danger',
                    type: 'button',
                    onclick: (event) => removeSession(row, event.currentTarget)
                  },
                  '删除'
                )
              ]
            }
          ],
          sessions,
          { empty: '还没有会话' }
        )
      )
    );
  }

  async function openSession(row, button) {
    await busy(button, async () => {
      try {
        const { data } = await v1.session(row.id);
        const messages = Array.isArray(data.messages) ? data.messages : [];
        const handle = modal({
          title: row.title || row.id,
          wide: true,
          body: [
            el(
              'p',
              { class: 'muted small' },
              `id：${row.id} · 创建：${formatTime(row.createdAt)} · 消息：${messages.length}`
            ),
            messages.length === 0
              ? el('div', { class: 'empty' }, '这个会话还没有消息')
              : el(
                  'div',
                  { class: 'stack' },
                  ...messages.map((message) =>
                    el(
                      'div',
                      { class: 'card' },
                      el(
                        'div',
                        { class: 'row' },
                        badge(
                          message.role === 'assistant' ? 'assistant' : message.role || 'user',
                          message.role === 'assistant' ? 'accent' : undefined
                        ),
                        el('span', { class: 'muted small' }, formatTime(message.ts))
                      ),
                      el('p', { class: 'pre-wrap' }, message.content || '')
                    )
                  )
                )
          ]
        });
        handle.footer.append(
          el('button', { class: 'btn', type: 'button', onclick: () => handle.close() }, '关闭')
        );
      } catch (error) {
        toast(errorText(error), 'error');
      }
    });
  }

  async function removeSession(row, button) {
    const confirmed = await confirmDialog({
      title: '删除会话',
      message: `确定删除「${row.title || row.id}」？该操作不可撤销。`,
      confirmText: '删除',
      danger: true
    });
    if (!confirmed) return;
    await busy(button, async () => {
      try {
        await v1.deleteSession(row.id);
        toast('会话已删除', 'ok');
        await load();
      } catch (error) {
        toast(errorText(error), 'error');
      }
    });
  }
}
