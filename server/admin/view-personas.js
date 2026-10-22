import { admin, formatBytes, formatShortTime, v1 } from './core.js';
import {
  badge,
  busy,
  card,
  confirmDialog,
  dataTable,
  el,
  errorText,
  field,
  modal,
  toast
} from './ui.js';

function templatePersona() {
  return {
    name: '新人格',
    personality: '',
    responseStyle: '',
    behaviorRules: [''],
    version: 'admin-1'
  };
}

export async function render() {
  const root = el('div', { class: 'stack' });
  const state = { disposed: false };
  let snapshot = { active: '', dir: '', personas: [] };

  await load();

  return {
    el: root,
    destroy() {
      state.disposed = true;
    }
  };

  async function load() {
    const { data } = await admin.personas();
    snapshot = data;
    paint();
  }

  function paint() {
    if (state.disposed) return;
    root.replaceChildren(
      card(
        {
          title: `人格（${snapshot.personas.length}）`,
          actions: [
            el(
              'button',
              {
                class: 'btn btn-primary btn-sm',
                type: 'button',
                onclick: () => openEditor(null)
              },
              '新建人格'
            )
          ]
        },
        el('p', { class: 'muted small' }, `目录：${snapshot.dir} · 当前使用：${snapshot.active}`),
        dataTable(
          [
            { label: 'id', render: (row) => el('code', null, row.id) },
            {
              label: '名称',
              render: (row) => [
                row.name || row.id,
                row.id === snapshot.active ? badge('使用中', 'accent') : null,
                row.invalid ? badge('JSON 损坏', 'warn') : null
              ]
            },
            { label: '版本', render: (row) => row.version || '—' },
            { label: '更新时间', render: (row) => formatShortTime(row.updatedAt) },
            { label: '大小', render: (row) => formatBytes(row.size) },
            {
              label: '操作',
              cellClass: 'actions',
              render: (row) => [
                el(
                  'button',
                  {
                    class: 'btn btn-sm',
                    type: 'button',
                    disabled: row.id === snapshot.active,
                    onclick: (event) => activate(row, event.currentTarget)
                  },
                  '设为当前'
                ),
                el(
                  'button',
                  {
                    class: 'btn btn-sm',
                    type: 'button',
                    onclick: () => openEditor(row)
                  },
                  '编辑'
                ),
                el(
                  'button',
                  {
                    class: 'btn btn-sm btn-danger',
                    type: 'button',
                    disabled: row.id === snapshot.active,
                    onclick: (event) => removePersona(row, event.currentTarget)
                  },
                  '删除'
                )
              ]
            }
          ],
          snapshot.personas,
          { empty: '还没有人格文件' }
        )
      )
    );
  }

  async function activate(row, button) {
    await busy(button, async () => {
      try {
        await v1.activatePersona(row.id);
        toast(`已切换到人格 ${row.name || row.id}`, 'ok');
        await load();
      } catch (error) {
        toast(errorText(error), 'error');
      }
    });
  }

  async function removePersona(row, button) {
    const confirmed = await confirmDialog({
      title: '删除人格',
      message: `确定删除 ${row.id}.json？该操作不可撤销。`,
      confirmText: '删除',
      danger: true
    });
    if (!confirmed) return;
    await busy(button, async () => {
      try {
        await admin.deletePersona(row.id);
        toast('人格已删除', 'ok');
        await load();
      } catch (error) {
        toast(errorText(error), 'error');
      }
    });
  }

  function openEditor(existing) {
    const isNew = !existing;
    const idInput = el('input', {
      class: 'input mono',
      value: existing ? existing.id : '',
      placeholder: '例如 tsundere',
      disabled: !isNew,
      spellcheck: false
    });
    const nameInput = el('input', {
      class: 'input',
      value: existing && existing.content ? existing.content.name || '' : '',
      placeholder: '显示名称'
    });
    const area = el('textarea', { class: 'textarea mono', rows: 16, spellcheck: false });
    area.value = JSON.stringify(
      existing && existing.content ? existing.content : templatePersona(),
      null,
      2
    );
    const errorLine = el('p', { class: 'form-error', hidden: true });

    const formatButton = el(
      'button',
      {
        class: 'btn btn-sm',
        type: 'button',
        onclick: () => {
          try {
            area.value = JSON.stringify(JSON.parse(area.value), null, 2);
            errorLine.hidden = true;
          } catch (error) {
            showError(`JSON 无效：${error.message}`);
          }
        }
      },
      '格式化'
    );

    const saveButton = el('button', { class: 'btn btn-primary', type: 'button' }, '保存');

    const handle = modal({
      title: isNew ? '新建人格' : `编辑 ${existing.id}`,
      wide: true,
      body: [
        el(
          'div',
          { class: 'field-grid' },
          field('id', idInput, isNew ? '小写字母、数字、点、下划线与短横线' : 'id 不可修改'),
          field('名称 name', nameInput)
        ),
        el(
          'div',
          { class: 'field' },
          el(
            'div',
            { class: 'row' },
            el('span', { class: 'field-label' }, '人格 JSON'),
            el('span', { class: 'spacer' }),
            formatButton
          ),
          area
        ),
        errorLine
      ],
      footer: [
        el('button', { class: 'btn', type: 'button', onclick: () => handle.close() }, '取消'),
        saveButton
      ]
    });

    saveButton.addEventListener('click', async () => {
      let content;
      try {
        content = JSON.parse(area.value);
      } catch (error) {
        showError(`JSON 无效：${error.message}`);
        return;
      }
      if (!content || typeof content !== 'object' || Array.isArray(content)) {
        showError('人格必须是 JSON 对象');
        return;
      }
      if (!content.name && nameInput.value.trim()) content.name = nameInput.value.trim();
      errorLine.hidden = true;
      await busy(saveButton, async () => {
        try {
          if (isNew) {
            const id = idInput.value.trim();
            if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) {
              showError('id 需为 1–64 位字母、数字、点、下划线或短横线');
              return;
            }
            try {
              await admin.createPersona({ id, content });
            } catch (error) {
              if (error.status !== 409) throw error;
              const overwrite = await confirmDialog({
                title: '人格已存在',
                message: `${id}.json 已存在，是否覆盖？`,
                confirmText: '覆盖',
                danger: true
              });
              if (!overwrite) return;
              await admin.createPersona({ id, content, overwrite: true });
            }
          } else {
            await admin.updatePersona(existing.id, { content });
          }
          toast('人格已保存', 'ok');
          handle.close();
          await load();
        } catch (error) {
          showError(errorText(error));
        }
      });
    });

    function showError(message) {
      errorLine.hidden = false;
      errorLine.textContent = message;
    }
  }
}
