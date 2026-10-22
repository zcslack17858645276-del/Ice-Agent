import { admin, formatBytes, formatShortTime, readFileAsBase64, v1 } from './core.js';
import { badge, busy, confirmDialog, el, errorText, field, modal, toast } from './ui.js';

const IMAGE_ENTRY = /\.(png|jpe?g|webp)$/i;
const THUMB_SIZE = 384;
const FULL_SIZE = 640;
const PORTRAIT_RATIO = 0.55;

const thumbCache = new Map();
let renderChain = Promise.resolve();
let rendererPromise = null;

function relativePath(file) {
  return file.webkitRelativePath || file.name;
}

function assetUrl(character, path) {
  const entry = path || character.entry;
  if (!entry) return null;
  return `/assets/${encodeURIComponent(character.id)}/${String(entry)
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = el('script', { src, attrs: { async: '' } });
    script.addEventListener('load', () => resolve());
    script.addEventListener('error', () => reject(new Error(`脚本加载失败：${src}`)));
    document.head.append(script);
  });
}

/** Loads the Cubism core + bundled thumbnail renderer once. */
function ensureRenderer() {
  if (window.IceLive2D) return Promise.resolve(window.IceLive2D);
  if (!rendererPromise) {
    rendererPromise = loadScript('./vendor/live2d/live2dcubismcore.min.js')
      .then(() => loadScript('./vendor/live2d-preview.js'))
      .then(() => {
        if (!window.IceLive2D) throw new Error('Live2D 渲染器未就绪');
        return window.IceLive2D;
      })
      .catch((error) => {
        rendererPromise = null;
        throw error;
      });
  }
  return rendererPromise;
}

/** Renders are serialized: they share one WebGL context. */
function enqueue(task) {
  const run = renderChain.then(task);
  renderChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function renderFramed(character, framing, size) {
  const api = await ensureRenderer();
  const model = assetUrl(character, character.modelEntry || character.entry);
  if (!model) throw new Error('缺少 model3.json');
  return api.renderThumbnail({
    modelUrl: model,
    shaderBase: './vendor/live2d/shaders/',
    size,
    framing,
    portraitRatio: PORTRAIT_RATIO
  });
}

function thumbImage(src, character) {
  const image = el('img', {
    src,
    alt: character.name || character.id,
    loading: 'lazy'
  });
  image.addEventListener('error', () => {
    image.replaceWith(el('span', { class: 'placeholder' }, '图片缺失'));
  });
  return image;
}

export async function render() {
  const root = el('div', { class: 'stack' });
  const state = { disposed: false };
  let characters = [];
  const boxes = new Map();

  await load();

  return {
    el: root,
    destroy() {
      state.disposed = true;
    }
  };

  async function load() {
    const { data } = await admin.characters();
    characters = data.characters || [];
    paint();
  }

  function paint() {
    if (state.disposed) return;
    boxes.clear();
    const live2d = characters.filter((character) => character.kind === 'live2d');
    const images = characters.filter((character) => character.kind !== 'live2d');

    root.replaceChildren(
      el(
        'div',
        { class: 'row' },
        el('h2', { class: 'section-title', style: { flex: '1' } }, `角色（${characters.length}）`),
        el(
          'button',
          {
            class: 'btn btn-primary',
            type: 'button',
            onclick: () => openUpload()
          },
          '导入角色'
        )
      ),
      el(
        'p',
        { class: 'muted small' },
        '角色存放在 D:\\IceAgent\\characters\\<id>\\。Live2D 缩略图取模型首帧，首次生成约 1–2 秒，之后走服务器缓存。'
      ),
      characterSection('Live2D 角色', live2d, '还没有导入 Live2D 角色', true),
      characterSection('图片角色', images, '还没有导入图片角色', false)
    );

    for (const character of live2d) void hydrateThumb(character);
  }

  function characterSection(title, list, emptyText, isLive2d) {
    return el(
      'section',
      { class: 'char-section' },
      el(
        'div',
        { class: 'section-head' },
        el('h2', { class: 'section-title' }, title),
        el('span', { class: 'badge' }, String(list.length)),
        isLive2d && list.length > 0
          ? el('span', { class: 'muted small' }, '缩略图 = 模型首帧 · 点击查看全身')
          : null
      ),
      list.length === 0
        ? el('div', { class: 'empty' }, emptyText)
        : el('div', { class: 'cards' }, ...list.map((character) => characterCard(character)))
    );
  }

  function characterCard(character) {
    const isLive2d = character.kind === 'live2d';
    const thumb = el('div', { class: 'thumb', dataset: { id: character.id } });
    boxes.set(character.id, thumb);

    if (isLive2d) {
      thumb.classList.add('is-clickable');
      thumb.setAttribute('title', '点击查看全身首帧');
      if (character.preview) {
        const version = character.previewAt || 0;
        thumb.append(
          thumbImage(
            `/assets/${encodeURIComponent(character.id)}/preview.png?v=${version}`,
            character
          )
        );
      } else if (!character.modelEntry && !character.entry) {
        thumb.append(el('span', { class: 'placeholder' }, '缺少 model3.json'));
      } else {
        thumb.append(el('span', { class: 'placeholder' }, '生成预览…'));
      }
      thumb.addEventListener('click', () => void openPreview(character));
    } else if (IMAGE_ENTRY.test(character.entry || '')) {
      const url = assetUrl(character);
      if (url) thumb.append(thumbImage(url, character));
      else thumb.append(el('span', { class: 'placeholder' }, '图片缺失'));
    } else {
      thumb.append(el('span', { class: 'placeholder' }, character.kind || '未知'));
    }

    const resolved = isLive2d && character.entry && character.entryExists === false;
    return el(
      'article',
      { class: 'char-card' },
      thumb,
      el('div', { class: 'char-name' }, character.name || character.id),
      el(
        'div',
        { class: 'char-meta' },
        el('code', null, character.id),
        badge(character.kind || 'image', 'accent'),
        el('span', null, `${character.fileCount} 个文件`),
        el('span', null, formatBytes(character.size)),
        el('span', null, formatShortTime(character.updatedAt))
      ),
      resolved
        ? el(
            'div',
            { class: 'char-meta' },
            badge('entry 失效，已按目录解析', 'warn'),
            el('span', null, character.modelEntry || '')
          )
        : null,
      el(
        'div',
        { class: 'row' },
        isLive2d
          ? el(
              'button',
              {
                class: 'btn btn-sm',
                type: 'button',
                onclick: () => void openPreview(character)
              },
              '预览'
            )
          : assetUrl(character)
            ? el(
                'a',
                {
                  class: 'btn btn-sm',
                  href: assetUrl(character),
                  target: '_blank',
                  rel: 'noreferrer'
                },
                '查看入口文件'
              )
            : null,
        el('span', { class: 'spacer' }),
        el(
          'button',
          {
            class: 'btn btn-sm btn-danger',
            type: 'button',
            onclick: (event) => void removeCharacter(character, event.currentTarget)
          },
          '删除'
        )
      )
    );
  }

  async function hydrateThumb(character) {
    if (state.disposed || character.preview) return;
    if (character.kind !== 'live2d') return;
    if (!character.modelEntry && !character.entry) return;
    const box = boxes.get(character.id);
    if (!box) return;
    const key = `${character.id}:${character.updatedAt || 0}`;
    if (thumbCache.has(key)) {
      box.replaceChildren(thumbImage(thumbCache.get(key), character));
      return;
    }
    try {
      const dataUrl = await enqueue(() => renderFramed(character, 'portrait', THUMB_SIZE));
      if (state.disposed) return;
      thumbCache.set(key, dataUrl);
      box.replaceChildren(thumbImage(dataUrl, character));
      void persistPreview(character, dataUrl);
    } catch (error) {
      if (state.disposed) return;
      box.replaceChildren(el('span', { class: 'placeholder' }, '预览失败'));
      box.setAttribute('title', String(error && error.message ? error.message : error));
      console.warn('[admin] live2d thumbnail failed', error);
    }
  }

  async function persistPreview(character, dataUrl) {
    try {
      const base64 = String(dataUrl).split(',')[1] || '';
      await admin.savePreview(character.id, base64);
      character.preview = 'preview.png';
    } catch (error) {
      console.warn('[admin] live2d preview cache failed', error);
    }
  }

  async function openPreview(character) {
    const handle = modal({
      title: character.name || character.id,
      wide: true,
      body: [el('div', { class: 'empty' }, character.kind === 'live2d' ? '渲染中…' : '加载中…')]
    });
    try {
      const src =
        character.kind === 'live2d'
          ? await enqueue(() => renderFramed(character, 'full', FULL_SIZE))
          : assetUrl(character);
      if (!src) throw new Error('没有可预览的入口文件');
      handle.body.replaceChildren(
        el('img', { class: 'preview-img', src, alt: character.name || character.id }),
        el(
          'p',
          { class: 'muted small' },
          `${character.id} · ${character.fileCount} 个文件 · ${formatBytes(character.size)}`
        )
      );
    } catch (error) {
      handle.body.replaceChildren(el('p', { class: 'muted' }, errorText(error)));
    }
  }

  async function removeCharacter(character, button) {
    const confirmed = await confirmDialog({
      title: '删除角色',
      message: `确定删除角色 ${character.id}？目录及其 ${character.fileCount} 个文件会被移除。`,
      confirmText: '删除',
      danger: true
    });
    if (!confirmed) return;
    await busy(button, async () => {
      try {
        await admin.deleteCharacter(character.id);
        thumbCache.delete(`${character.id}:${character.updatedAt || 0}`);
        toast('角色已删除', 'ok');
        await load();
      } catch (error) {
        toast(errorText(error), 'error');
      }
    });
  }

  function openUpload() {
    let selected = [];
    const nameInput = el('input', { class: 'input', placeholder: '例如 Sigrika' });
    const kindSelect = el(
      'select',
      { class: 'select' },
      el('option', { value: 'image' }, '静态图片'),
      el('option', { value: 'live2d' }, 'Live2D 模型')
    );
    const fileList = el('div', { class: 'file-list' });
    const status = el('p', { class: 'hint' }, '尚未选择文件');

    const fileInput = el('input', {
      type: 'file',
      multiple: true,
      hidden: true,
      onchange: () => addFiles(fileInput.files)
    });
    const dirInput = el('input', {
      type: 'file',
      hidden: true,
      attrs: { webkitdirectory: '' },
      onchange: () => addFiles(dirInput.files)
    });

    const dropzone = el(
      'div',
      {
        class: 'dropzone',
        onclick: () => fileInput.click(),
        ondragover: (event) => {
          event.preventDefault();
          dropzone.classList.add('is-over');
        },
        ondragleave: () => dropzone.classList.remove('is-over'),
        ondrop: (event) => {
          event.preventDefault();
          dropzone.classList.remove('is-over');
          addFiles(event.dataTransfer ? event.dataTransfer.files : null);
        }
      },
      '拖拽文件到此处，或点击选择多个文件'
    );

    const submit = el('button', { class: 'btn btn-primary', type: 'button' }, '开始导入');
    const handle = modal({
      title: '导入角色',
      wide: true,
      body: [
        el(
          'div',
          { class: 'field-grid' },
          field('名称', nameInput, '用于生成角色目录 id'),
          field('类型', kindSelect)
        ),
        dropzone,
        el(
          'div',
          { class: 'row' },
          el(
            'button',
            { class: 'btn btn-sm', type: 'button', onclick: () => dirInput.click() },
            '选择整个文件夹'
          ),
          el(
            'button',
            { class: 'btn btn-sm', type: 'button', onclick: () => fileInput.click() },
            '选择文件'
          )
        ),
        fileInput,
        dirInput,
        status,
        fileList
      ]
    });
    handle.footer.append(
      el('button', { class: 'btn', type: 'button', onclick: () => handle.close() }, '取消'),
      submit
    );

    function addFiles(list) {
      if (!list) return;
      const merged = new Map(selected.map((file) => [relativePath(file), file]));
      for (const file of Array.from(list)) merged.set(relativePath(file), file);
      selected = Array.from(merged.values());
      renderSelection();
    }

    function renderSelection() {
      const total = selected.reduce((sum, file) => sum + file.size, 0);
      status.textContent = selected.length
        ? `已选择 ${selected.length} 个文件，合计 ${formatBytes(total)}`
        : '尚未选择文件';
      fileList.replaceChildren(
        ...selected.map((file) =>
          el(
            'div',
            { class: 'row' },
            el('span', { class: 'spacer' }, relativePath(file)),
            formatBytes(file.size)
          )
        )
      );
    }

    submit.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      const kind = kindSelect.value;
      if (!name) {
        toast('请填写名称', 'error');
        return;
      }
      if (selected.length === 0) {
        toast('请选择文件', 'error');
        return;
      }
      const hasModel = selected.some((file) =>
        relativePath(file).toLowerCase().endsWith('.model3.json')
      );
      const hasImage = selected.some((file) => IMAGE_ENTRY.test(relativePath(file)));
      if (kind === 'live2d' && !hasModel) {
        toast('Live2D 角色需要包含 model3.json', 'error');
        return;
      }
      if (kind === 'image' && !hasImage) {
        toast('静态图片角色需要 png/jpg/webp', 'error');
        return;
      }
      await busy(submit, async () => {
        try {
          const files = [];
          for (const file of selected) {
            status.textContent = `读取 ${files.length + 1}/${selected.length}：${relativePath(file)}`;
            files.push({ path: relativePath(file), data: await readFileAsBase64(file) });
          }
          status.textContent = '上传中…';
          await v1.importCharacter({ name, kind, files });
          toast('角色已导入', 'ok');
          handle.close();
          await load();
        } catch (error) {
          status.textContent = '导入失败';
          toast(errorText(error), 'error');
        }
      });
    });
  }
}
