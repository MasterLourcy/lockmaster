// app.js — interface e fluxo da app Lockmaster.
import * as V from './vault.js';
import { idbGet, idbSet, idbDel } from './storage.js';
import { icon, hydrateIcons } from './icons.js';

// ---------- utilitários ----------

const $ = (sel, root = document) => root.querySelector(sel);

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  n.append(...kids);
  return n;
}

const fmtDate = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : new Intl.DateTimeFormat('pt-PT', { dateStyle: 'short', timeStyle: 'short' }).format(d);
};

const tick = () => new Promise((r) => setTimeout(r, 30)); // deixa o browser pintar antes de trabalho pesado
const collator = new Intl.Collator('pt', { sensitivity: 'base' });
const sameName = (a, b) => collator.compare(a, b) === 0;
const byName = (a, b) => collator.compare(a.name, b.name);
const NAME_MAX = 60;

// ---------- estado ----------

const SETTINGS_KEY = 'lockmaster.settings';
const defaults = { consulta: null, autoLockMin: 2, lastSpace: null };

function loadSettings() {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...defaults };
  }
}
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  } catch {
    /* sem armazenamento: as definições ficam só nesta sessão */
  }
}

const state = {
  settings: loadSettings(),
  session: null, // { key, kdf, spaces, categories, entries, updatedAt } — só existe enquanto está desbloqueado
  cached: null, // ficheiro de cofre (cifrado) guardado neste dispositivo
  pending: null, // ficheiro escolhido pelo utilizador, ainda por validar com a palavra-passe
  handle: null, // ficheiro ligado (File System Access API, só desktop)
  dirty: false, // há alterações que ainda não estão num ficheiro externo
  spaceId: null, // espaço em vista
  catFilter: 'all', // 'all' | 'none' | id de categoria
  searchAll: false, // pesquisar em todos os espaços
  query: '',
  viewId: null,
  editId: null,
  lockTimer: null,
  clipTimer: null,
  clipNeedsClear: false,
  hiddenAt: null,
};

const fsa = 'showSaveFilePicker' in window && 'showOpenFilePicker' in window;
const FILE_TYPES = [{ description: 'Cofre Lockmaster', accept: { 'application/json': ['.json'] } }];
const FILE_NAME = 'lockmaster.json';

function isConsulta() {
  if (state.settings.consulta === null) return matchMedia('(pointer: coarse)').matches;
  return state.settings.consulta;
}

function applyMode() {
  document.body.dataset.mode = isConsulta() ? 'consulta' : 'completo';
}

function show(name) {
  for (const id of ['unlock', 'create', 'main']) $('#screen-' + id).hidden = id !== name;
}

// ---------- acesso aos dados da sessão ----------

const S = () => state.session;
const spaceById = (id) => S().spaces.find((x) => x.id === id);
const catById = (id) => S().categories.find((x) => x.id === id);
const entryById = (id) => S().entries.find((x) => x.id === id);
const catsOf = (spaceId) => S().categories.filter((c) => c.spaceId === spaceId).sort(byName);
const entriesIn = (spaceId) => S().entries.filter((e) => e.spaceId === spaceId);

function ensureSpace() {
  if (spaceById(state.spaceId)) return;
  const last = state.settings.lastSpace;
  state.spaceId = last && spaceById(last) ? last : S().spaces[0].id;
}

function rememberSpace() {
  state.settings.lastSpace = state.spaceId;
  saveSettings();
}

// ---------- avisos e área de transferência ----------

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  try {
    if (!t.matches(':popover-open')) t.showPopover();
  } catch {
    /* sem suporte a popover: fica visível no sítio normal */
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    try {
      t.hidePopover();
    } catch {
      /* idem */
    }
    t.textContent = '';
  }, 2800);
}

async function clearClipboard() {
  try {
    await navigator.clipboard.writeText('');
    state.clipNeedsClear = false;
  } catch {
    // Se a app não está em primeiro plano (ex.: o utilizador foi colar noutra app),
    // o browser recusa. Tentamos de novo quando voltar.
    state.clipNeedsClear = true;
  }
}

async function copy(text, what) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    toast('Não foi possível copiar.');
    return;
  }
  toast(`Copiado: ${what}. A área de transferência é limpa em 20 s.`);
  clearTimeout(state.clipTimer);
  state.clipTimer = setTimeout(clearClipboard, 20_000);
}

// ---------- força da palavra-passe ----------

function updateMeter(meterEl, labelEl, pw) {
  const s = V.strength(pw);
  meterEl.dataset.level = String(s.level);
  labelEl.textContent = s.label ? `Força: ${s.label}` : '';
}

function checkMaster(pw) {
  if ([...pw].length < 12) return 'A palavra-passe mestra deve ter pelo menos 12 caracteres.';
  if (V.strength(pw).level < 3) return 'Palavra-passe demasiado fraca. Junta mais palavras ou caracteres diferentes.';
  return '';
}

// ---------- ficheiros ----------

async function writeHandle(handle, file) {
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) !== 'granted' && (await handle.requestPermission(opts)) !== 'granted') {
    throw new Error('Sem permissão para escrever no ficheiro.');
  }
  const w = await handle.createWritable();
  await w.write(JSON.stringify(file));
  await w.close();
}

function download(file) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(file)], { type: 'application/json' }));
  const a = el('a', { href: url, download: FILE_NAME });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  state.dirty = false;
  renderBanner();
}

/** Deixa o utilizador escolher um ficheiro de cofre. Devolve { file, name, handle } ou null. */
async function pickFile() {
  let picked;
  if (fsa && !isConsulta()) {
    try {
      const [handle] = await window.showOpenFilePicker({ types: FILE_TYPES });
      const f = await handle.getFile();
      picked = { text: await f.text(), name: f.name, handle };
    } catch (err) {
      if (err.name === 'AbortError') return null;
      throw err;
    }
  } else {
    picked = await new Promise((resolve) => {
      const input = $('#file-input');
      input.value = '';
      input.onchange = async () => {
        const f = input.files[0];
        resolve(f ? { text: await f.text(), name: f.name, handle: null } : null);
      };
      input.oncancel = () => resolve(null);
      input.click();
    });
    if (!picked) return null;
  }
  try {
    return { file: V.parseVaultText(picked.text), name: picked.name, handle: picked.handle };
  } catch (err) {
    toast(err.message || 'Ficheiro inválido.');
    return null;
  }
}

// ---------- gravação ----------

async function persist() {
  const file = await V.encryptVault(state.session);
  await idbSet('vault', file);
  state.cached = file;
  state.dirty = true;
  if (state.handle) {
    try {
      await writeHandle(state.handle, file);
      state.dirty = false;
    } catch {
      /* o aviso no topo diz ao utilizador para tentar de novo */
    }
  }
  renderBanner();
}

// ---------- ecrã de desbloqueio ----------

function renderUnlock() {
  const source = state.pending?.file ?? state.cached;
  const info = $('#unlock-info');
  if (state.pending) {
    info.textContent = `Ficheiro selecionado: ${state.pending.name}${
      state.pending.file.updatedAt ? ` · atualizado a ${fmtDate(state.pending.file.updatedAt)}` : ''
    }`;
  } else if (state.cached) {
    info.textContent = `Cofre neste dispositivo · atualizado a ${fmtDate(state.cached.updatedAt)}`;
  } else {
    info.textContent = isConsulta()
      ? 'Ainda não há cofre neste dispositivo. Abre o ficheiro do cofre (por exemplo, a partir do Google Drive).'
      : 'Ainda não há cofre neste dispositivo. Cria um novo ou abre um ficheiro existente.';
  }
  $('#form-unlock').hidden = !source;
  $('#btn-open').textContent = source ? 'Atualizar / abrir outro ficheiro…' : 'Abrir ficheiro do cofre…';
  $('#btn-clear-pending').hidden = !(state.pending && state.cached);
  $('#btn-mode').textContent = isConsulta()
    ? 'Modo consulta ativo · mudar para modo completo'
    : 'Modo completo ativo · mudar para modo consulta';
  $('#unlock-error').hidden = true;
}

function goUnlock() {
  renderUnlock();
  show('unlock');
  if (!$('#form-unlock').hidden) $('#unlock-pw').focus();
}

async function onUnlock(ev) {
  ev.preventDefault();
  const pw = $('#unlock-pw').value;
  const source = state.pending?.file ?? state.cached;
  if (!pw || !source) return;
  const btn = $('#btn-unlock');
  const err = $('#unlock-error');
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = 'A desbloquear…';
  await tick();
  try {
    const session = await V.openVault(source, pw);
    if (state.pending) {
      // só agora (palavra-passe confirmada) é que o ficheiro escolhido passa a ser o cofre local
      await idbSet('vault', source);
      state.cached = source;
      state.handle = state.pending.handle;
      try {
        if (state.handle) await idbSet('handle', state.handle);
        else await idbDel('handle');
      } catch {
        /* sem suporte para guardar o handle: não é crítico */
      }
      state.pending = null;
    }
    state.session = session;
    state.dirty = false;
    $('#unlock-pw').value = '';
    enterMain();
  } catch (e) {
    err.textContent =
      e.code === 'WRONG_PASSWORD'
        ? 'Palavra-passe incorreta (ou o ficheiro foi alterado).'
        : e.message || 'Não foi possível abrir o cofre.';
    err.hidden = false;
    $('#unlock-pw').select();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Desbloquear';
  }
}

async function onOpenFile() {
  const picked = await pickFile();
  if (!picked) return;
  state.pending = picked;
  goUnlock();
}

// ---------- criar cofre ----------

function startCreate() {
  if (state.cached && !confirm('Já existe um cofre neste dispositivo. Criar um novo vai substituí-lo quando terminares. Continuar?')) return;
  $('#form-create').reset();
  updateMeter($('#create-meter'), $('#create-meter-label'), '');
  $('#create-error').hidden = true;
  show('create');
  $('#create-pw').focus();
}

async function onCreate(ev) {
  ev.preventDefault();
  const pw = $('#create-pw').value;
  const err = $('#create-error');
  const fail = (m) => {
    err.textContent = m;
    err.hidden = false;
  };
  err.hidden = true;
  const weak = checkMaster(pw);
  if (weak) return fail(weak);
  if (pw !== $('#create-pw2').value) return fail('As palavras-passe não coincidem.');
  if (!$('#create-ack').checked) return fail('Confirma que percebes que não há recuperação.');
  const btn = $('#btn-create-submit');
  btn.disabled = true;
  btn.textContent = 'A criar…';
  await tick();
  try {
    state.session = await V.createVault(pw);
    state.handle = null;
    state.pending = null;
    state.spaceId = null;
    await idbDel('handle').catch(() => {});
    await persist();
    navigator.storage?.persist?.().catch(() => {}); // pede ao browser para não apagar os dados
    $('#form-create').reset();
    enterMain();
    toast('Cofre criado. Exporta uma cópia para o Drive.');
  } catch {
    fail('Não foi possível criar o cofre neste browser.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Criar cofre';
  }
}

// ---------- ecrã principal ----------

function enterMain() {
  state.query = '';
  state.catFilter = 'all';
  state.searchAll = false;
  $('#search').value = '';
  $('#btn-search-all').setAttribute('aria-pressed', 'false');
  ensureSpace();
  applyMode();
  renderAll();
  show('main');
  armLock();
}

function renderAll() {
  renderSpaceSelect();
  renderChips();
  renderList();
  renderBanner();
}

function renderSpaceSelect() {
  const sel = $('#space-select');
  sel.replaceChildren(...S().spaces.map((s) => el('option', { value: s.id, text: s.name })));
  sel.value = state.spaceId;
}

function renderChips() {
  const nav = $('#chips');
  nav.replaceChildren();
  const cats = catsOf(state.spaceId);
  if (state.searchAll || !cats.length) {
    nav.hidden = true;
    return;
  }
  if (state.catFilter !== 'all' && state.catFilter !== 'none' && !cats.some((c) => c.id === state.catFilter)) {
    state.catFilter = 'all';
  }
  const inSpace = entriesIn(state.spaceId);
  const chip = (value, label, n) =>
    el(
      'button',
      { class: 'chip', type: 'button', 'data-cat': value, 'aria-pressed': String(state.catFilter === value) },
      label,
      el('span', { class: 'n', text: String(n) }),
    );
  nav.append(chip('all', 'Todas', inSpace.length));
  for (const c of cats) nav.append(chip(c.id, c.name, inSpace.filter((e) => e.categoryId === c.id).length));
  nav.append(chip('none', 'Sem categoria', inSpace.filter((e) => !e.categoryId).length));
  nav.hidden = false;
}

function renderList() {
  const list = $('#list');
  list.replaceChildren();
  if (!state.session) return;
  const q = state.query.trim().toLowerCase();

  let items = state.searchAll ? S().entries : entriesIn(state.spaceId);
  if (!state.searchAll) {
    if (state.catFilter === 'none') items = items.filter((e) => !e.categoryId);
    else if (state.catFilter !== 'all') items = items.filter((e) => e.categoryId === state.catFilter);
  }
  const total = items.length;
  if (q) items = items.filter((e) => [e.title, e.username, e.url].some((f) => f.toLowerCase().includes(q)));
  items.sort((a, b) => collator.compare(a.title, b.title));

  const showCat = state.searchAll || state.catFilter === 'all';
  for (const e of items) {
    const hue = [...e.id].reduce((h, c) => (h + c.charCodeAt(0)) % 8, 0);
    const sub = [
      state.searchAll ? spaceById(e.spaceId)?.name : '',
      showCat && e.categoryId ? catById(e.categoryId)?.name : '',
      e.username || e.url,
    ]
      .filter(Boolean)
      .join(' · ');
    list.append(
      el(
        'li',
        {},
        el(
          'button',
          { class: 'item', type: 'button', 'data-id': e.id },
          el('span', { class: `avatar av${hue}` }, icon('key')),
          el(
            'span',
            { class: 'item-text' },
            el('div', { class: 'item-title', text: e.title || '(sem nome)' }),
            el('div', { class: 'item-sub', text: sub }),
          ),
        ),
      ),
    );
  }

  const empty = $('#empty');
  empty.hidden = items.length > 0;
  if (!items.length) {
    if (q || total) empty.textContent = 'Nada encontrado.';
    else if (state.searchAll) empty.textContent = 'O cofre ainda não tem passwords.';
    else if (state.catFilter !== 'all') empty.textContent = 'Não há passwords nesta categoria.';
    else
      empty.textContent = isConsulta()
        ? 'Este espaço ainda não tem passwords.'
        : 'Este espaço ainda não tem passwords. Toca em + para adicionar a primeira.';
  }
}

function renderBanner() {
  const b = $('#banner');
  if (!state.session || isConsulta() || !state.dirty) {
    b.hidden = true;
    return;
  }
  b.hidden = false;
  if (state.handle) {
    $('#banner-text').textContent = 'Não foi possível gravar no ficheiro ligado.';
    $('#btn-banner').textContent = 'Tentar de novo';
  } else {
    $('#banner-text').textContent = 'As alterações só estão neste dispositivo. Exporta uma cópia para o Drive.';
    $('#btn-banner').textContent = 'Exportar';
  }
}

async function onBanner() {
  if (state.handle) {
    try {
      await writeHandle(state.handle, state.cached);
      state.dirty = false;
      toast('Guardado no ficheiro.');
    } catch {
      toast('Ainda não foi possível gravar no ficheiro.');
    }
    renderBanner();
  } else {
    download(state.cached);
  }
}

function switchSpace(id) {
  state.spaceId = id;
  state.catFilter = 'all';
  rememberSpace();
}

// ---------- ver password ----------

function safeUrl(v) {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

function detailRow(label, value, { secret = false, link = false, pre = false } = {}) {
  if (!value) return null;
  const valueEl = el('div', { class: `value${secret ? ' mono' : ''}${pre ? ' pre' : ''}` });
  const hidden = '••••••••••';
  const href = link ? safeUrl(value) : null;
  if (href) valueEl.append(el('a', { href, target: '_blank', rel: 'noopener noreferrer', text: value }));
  else valueEl.textContent = secret ? hidden : value;

  const btns = el('div', { class: 'btns' });
  if (secret) {
    const toggle = el('button', { class: 'icon-btn small', type: 'button', title: 'Mostrar', 'aria-label': 'Mostrar' }, icon('eye'));
    let shown = false;
    toggle.addEventListener('click', () => {
      shown = !shown;
      valueEl.textContent = shown ? value : hidden;
      toggle.replaceChildren(icon(shown ? 'eye-off' : 'eye'));
      const l = shown ? 'Ocultar' : 'Mostrar';
      toggle.title = l;
      toggle.setAttribute('aria-label', l);
    });
    btns.append(toggle);
  }
  btns.append(el('button', { class: 'btn small', type: 'button', onclick: () => copy(value, label) }, icon('copy'), 'Copiar'));
  return el(
    'div',
    { class: 'detail' },
    el('div', { class: 'lbl', text: label }),
    el('div', { class: 'line' }, valueEl, btns),
  );
}

function pathOf(e) {
  const sp = spaceById(e.spaceId)?.name || '';
  const c = e.categoryId ? catById(e.categoryId)?.name : '';
  return c ? `${sp} › ${c}` : sp;
}

function openView(id) {
  const e = entryById(id);
  if (!e) return;
  state.viewId = id;
  $('#view-title').textContent = e.title || '(sem nome)';
  $('#view-path').textContent = pathOf(e);
  $('#view-body').replaceChildren(
    ...[
      detailRow('Utilizador', e.username),
      detailRow('Palavra-passe', e.password, { secret: true }),
      detailRow('Site', e.url, { link: true }),
      detailRow('Notas', e.notes, { pre: true }),
      el('p', { class: 'muted small', text: `Atualizado a ${fmtDate(e.updatedAt)}` }),
    ].filter(Boolean),
  );
  $('#dlg-view').showModal();
}

async function onDelete() {
  const e = entryById(state.viewId);
  if (!e || !confirm(`Apagar "${e.title}"? Esta ação não pode ser desfeita.`)) return;
  S().entries = S().entries.filter((x) => x.id !== e.id);
  try {
    await persist();
  } catch {
    toast('Erro ao guardar.');
  }
  $('#dlg-view').close();
  renderChips();
  renderList();
  toast('Password apagada.');
}

// ---------- selects de espaço e categoria ----------

function fillSpaceSelect(selectEl, selected) {
  selectEl.replaceChildren(...S().spaces.map((s) => el('option', { value: s.id, text: s.name })));
  selectEl.value = selected;
}

function fillCatSelect(selectEl, spaceId, selected = '') {
  const cats = catsOf(spaceId);
  selectEl.replaceChildren(
    el('option', { value: '', text: 'Sem categoria' }),
    ...cats.map((c) => el('option', { value: c.id, text: c.name })),
  );
  selectEl.value = cats.some((c) => c.id === selected) ? selected : '';
}

// ---------- criar / editar password ----------

function setReveal(visible) {
  const b = $('#btn-reveal');
  $('#e-pass').type = visible ? 'text' : 'password';
  b.replaceChildren(icon(visible ? 'eye-off' : 'eye'));
  const l = visible ? 'Ocultar palavra-passe' : 'Mostrar palavra-passe';
  b.title = l;
  b.setAttribute('aria-label', l);
}

function refreshEntryMeter() {
  updateMeter($('#e-meter'), $('#e-meter-label'), $('#e-pass').value);
}

function openEdit(id) {
  const e = id ? entryById(id) : null;
  state.editId = e ? e.id : null;
  $('#entry-heading').textContent = e ? 'Editar password' : 'Nova password';
  const spaceId = e ? e.spaceId : state.spaceId;
  const catId = e ? e.categoryId || '' : state.catFilter !== 'all' && state.catFilter !== 'none' && !state.searchAll ? state.catFilter : '';
  fillSpaceSelect($('#e-space'), spaceId);
  fillCatSelect($('#e-cat'), spaceId, catId);
  $('#e-title').value = e?.title ?? '';
  $('#e-url').value = e?.url ?? '';
  $('#e-user').value = e?.username ?? '';
  $('#e-pass').value = e?.password ?? '';
  $('#e-notes').value = e?.notes ?? '';
  setReveal(false);
  refreshEntryMeter();
  if ($('#dlg-view').open) $('#dlg-view').close();
  $('#dlg-entry').showModal();
  if (!e) $('#e-title').focus();
}

function generateInto() {
  const pw = V.generatePassword({
    length: Number($('#g-len').value),
    lower: $('#g-lower').checked,
    upper: $('#g-upper').checked,
    digits: $('#g-digits').checked,
    symbols: $('#g-symbols').checked,
    noAmbiguous: $('#g-noamb').checked,
  });
  $('#e-pass').value = pw;
  setReveal(true);
  refreshEntryMeter();
}

async function onSaveEntry(ev) {
  ev.preventDefault();
  const data = {
    title: $('#e-title').value.trim(),
    spaceId: $('#e-space').value,
    categoryId: $('#e-cat').value || null,
    url: $('#e-url').value.trim(),
    username: $('#e-user').value.trim(),
    password: $('#e-pass').value,
    notes: $('#e-notes').value,
  };
  if (!data.title || !spaceById(data.spaceId)) return;
  const now = new Date().toISOString();
  if (state.editId) {
    Object.assign(entryById(state.editId), data, { updatedAt: now });
  } else {
    S().entries.push({ id: crypto.randomUUID(), ...data, createdAt: now, updatedAt: now });
  }
  try {
    await persist();
  } catch {
    toast('Erro ao guardar neste dispositivo.');
    return;
  }
  if (data.spaceId !== state.spaceId) switchSpace(data.spaceId); // segue a password para o espaço onde ficou
  $('#dlg-entry').close();
  renderAll();
  toast('Guardado.');
}

// ---------- mover password ----------

function openMove() {
  const e = entryById(state.viewId);
  if (!e) return;
  fillSpaceSelect($('#mv-space'), e.spaceId);
  fillCatSelect($('#mv-cat'), e.spaceId, e.categoryId || '');
  $('#dlg-view').close();
  $('#dlg-move').showModal();
}

async function onMove(ev) {
  ev.preventDefault();
  const e = entryById(state.viewId);
  const spaceId = $('#mv-space').value;
  if (!e || !spaceById(spaceId)) return;
  e.spaceId = spaceId;
  e.categoryId = $('#mv-cat').value || null;
  e.updatedAt = new Date().toISOString();
  try {
    await persist();
  } catch {
    toast('Erro ao guardar neste dispositivo.');
    return;
  }
  if (spaceId !== state.spaceId) switchSpace(spaceId);
  $('#dlg-move').close();
  renderAll();
  toast(`Movida para ${pathOf(e)}.`);
}

// ---------- gerir espaços e categorias ----------

function openManage() {
  renderManage();
  $('#dlg-manage').showModal();
}

function nameRow(name, count, { onRename, onDelete: del, label }) {
  const input = el('input', { value: name, maxlength: String(NAME_MAX), spellcheck: 'false', 'aria-label': `Nome ${label}` });
  input.addEventListener('change', () => onRename(input));
  const btn = el('button', { class: 'icon-btn small', type: 'button', title: `Apagar ${label}`, 'aria-label': `Apagar ${label} ${name}` }, icon('trash'));
  btn.addEventListener('click', del);
  return el('li', {}, input, el('span', { class: 'count muted small', title: 'Passwords', text: String(count) }), btn);
}

function renderManage() {
  const spacesUl = $('#mg-spaces');
  spacesUl.replaceChildren(
    ...S().spaces.map((sp) =>
      nameRow(sp.name, entriesIn(sp.id).length, {
        label: 'do espaço',
        onRename: (input) => renameItem(S().spaces, sp, input, 'espaço', () => S().spaces.some((x) => x.id !== sp.id && sameName(x.name, input.value.trim()))),
        onDelete: () => deleteSpace(sp.id),
      }),
    ),
  );

  const cur = spaceById(state.spaceId);
  $('#mg-cats-title').textContent = `Categorias de "${cur.name}"`;
  const cats = catsOf(state.spaceId);
  $('#mg-cats').replaceChildren(
    ...cats.map((c) =>
      nameRow(c.name, S().entries.filter((e) => e.categoryId === c.id).length, {
        label: 'da categoria',
        onRename: (input) => renameItem(S().categories, c, input, 'categoria', () => cats.some((x) => x.id !== c.id && sameName(x.name, input.value.trim()))),
        onDelete: () => deleteCategory(c.id),
      }),
    ),
  );
  $('#mg-cats-empty').hidden = cats.length > 0;
}

/** Grava a alteração à estrutura e atualiza tudo o que depende dela. */
async function saveStructure(msg) {
  try {
    await persist();
  } catch {
    toast('Erro ao guardar neste dispositivo.');
    return false;
  }
  if ($('#dlg-manage').open) renderManage();
  renderSpaceSelect();
  renderChips();
  renderList();
  if (msg) toast(msg);
  return true;
}

async function renameItem(_list, item, input, kind, isDuplicate) {
  const name = input.value.trim();
  if (!name) {
    input.value = item.name;
    return toast('O nome não pode ficar vazio.');
  }
  if (isDuplicate()) {
    input.value = item.name;
    return toast(`Já existe ${kind === 'espaço' ? 'um espaço' : 'uma categoria'} com esse nome.`);
  }
  if (name === item.name) return;
  item.name = name;
  await saveStructure(kind === 'espaço' ? 'Espaço renomeado.' : 'Categoria renomeada.');
}

async function deleteSpace(id) {
  const sp = spaceById(id);
  if (entriesIn(id).length) return toast('Este espaço ainda tem passwords. Move-as ou apaga-as primeiro.');
  if (S().spaces.length <= 1) return toast('Tem de existir pelo menos um espaço.');
  if (!confirm(`Apagar o espaço "${sp.name}"?`)) return;
  S().spaces = S().spaces.filter((x) => x.id !== id);
  S().categories = S().categories.filter((c) => c.spaceId !== id);
  if (state.spaceId === id) switchSpace(S().spaces[0].id);
  await saveStructure('Espaço apagado.');
}

async function deleteCategory(id) {
  const c = catById(id);
  const n = S().entries.filter((e) => e.categoryId === id).length;
  const msg = n
    ? `Apagar a categoria "${c.name}"? ${n === 1 ? 'A password fica' : `As ${n} passwords ficam`} em "Sem categoria".`
    : `Apagar a categoria "${c.name}"?`;
  if (!confirm(msg)) return;
  for (const e of S().entries) if (e.categoryId === id) e.categoryId = null;
  S().categories = S().categories.filter((x) => x.id !== id);
  if (state.catFilter === id) state.catFilter = 'all';
  await saveStructure('Categoria apagada.');
}

async function onAddSpace(ev) {
  ev.preventDefault();
  const input = $('#add-space');
  const name = input.value.trim();
  if (!name) return;
  if (S().spaces.some((x) => sameName(x.name, name))) return toast('Já existe um espaço com esse nome.');
  const sp = { id: crypto.randomUUID(), name };
  S().spaces.push(sp);
  switchSpace(sp.id); // passa logo para o espaço novo, para lhe poderes juntar categorias
  input.value = '';
  await saveStructure(`Espaço "${name}" criado.`);
}

async function onAddCategory(ev) {
  ev.preventDefault();
  const input = $('#add-cat');
  const name = input.value.trim();
  if (!name) return;
  if (catsOf(state.spaceId).some((x) => sameName(x.name, name))) return toast('Já existe uma categoria com esse nome.');
  S().categories.push({ id: crypto.randomUUID(), spaceId: state.spaceId, name });
  input.value = '';
  await saveStructure(`Categoria "${name}" criada.`);
}

// ---------- definições ----------

function openSettings() {
  $('#s-consulta').checked = isConsulta();
  $('#s-lock').value = String(state.settings.autoLockMin);
  const info = $('#s-file-info');
  if (state.handle) info.textContent = `Ligado ao ficheiro: ${state.handle.name}. Cada alteração é gravada lá automaticamente.`;
  else if (!fsa && !isConsulta())
    info.textContent = 'Este browser não permite ligar a um ficheiro. Usa "Exportar cópia" e guarda-a na pasta do Drive.';
  else info.textContent = 'Sem ficheiro ligado.';
  $('#s-link').hidden = !fsa || !!state.handle;
  $('#s-savefile').hidden = !state.handle;
  $('#s-unlink').hidden = !state.handle;
  $('#dlg-settings').showModal();
}

async function onLink() {
  try {
    const handle = await window.showSaveFilePicker({ suggestedName: FILE_NAME, types: FILE_TYPES });
    await writeHandle(handle, state.cached);
    state.handle = handle;
    await idbSet('handle', handle).catch(() => {});
    state.dirty = false;
    renderBanner();
    $('#dlg-settings').close();
    toast(`Ligado a ${handle.name}.`);
  } catch (err) {
    if (err.name !== 'AbortError') toast('Não foi possível ligar ao ficheiro.');
  }
}

async function onSaveFile() {
  try {
    await writeHandle(state.handle, state.cached);
    state.dirty = false;
    renderBanner();
    toast('Guardado no ficheiro.');
  } catch {
    toast('Não foi possível gravar no ficheiro.');
  }
}

async function onUnlink() {
  state.handle = null;
  await idbDel('handle').catch(() => {});
  $('#dlg-settings').close();
  toast('Ficheiro desligado.');
}

async function onRefresh() {
  const picked = await pickFile();
  if (!picked) return;
  $('#dlg-settings').close();
  state.pending = picked;
  lock();
}

async function onWipe() {
  if (!confirm('Apagar o cofre DESTE dispositivo? Se não tiveres uma cópia exportada, os dados perdem-se para sempre.')) return;
  await idbDel('vault').catch(() => {});
  await idbDel('handle').catch(() => {});
  state.cached = null;
  state.handle = null;
  state.pending = null;
  lock();
  toast('Cofre apagado deste dispositivo.');
}

async function onChangeMaster(ev) {
  ev.preventDefault();
  const err = $('#m-error');
  const fail = (m) => {
    err.textContent = m;
    err.hidden = false;
  };
  err.hidden = true;
  const next = $('#m-new').value;
  const weak = checkMaster(next);
  if (weak) return fail(weak);
  if (next !== $('#m-new2').value) return fail('As palavras-passe novas não coincidem.');
  const btn = $('#m-submit');
  btn.disabled = true;
  btn.textContent = 'A alterar…';
  await tick();
  try {
    try {
      await V.openVault(state.cached, $('#m-cur').value);
    } catch (e) {
      return fail(e.code === 'WRONG_PASSWORD' ? 'A palavra-passe atual está incorreta.' : 'Erro ao validar o cofre.');
    }
    state.session = await V.rekey(state.session, next);
    await persist();
    $('#dlg-master').close();
    toast('Palavra-passe mestra alterada.');
  } catch {
    fail('Não foi possível alterar a palavra-passe.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Alterar';
  }
}

// ---------- bloqueio ----------

function lock() {
  clearTimeout(state.lockTimer);
  state.session = null;
  state.viewId = state.editId = null;
  $('#list').replaceChildren();
  $('#chips').replaceChildren();
  $('#view-body').replaceChildren();
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  $('#unlock-pw').value = '';
  goUnlock();
}

function armLock() {
  clearTimeout(state.lockTimer);
  if (!state.session) return;
  state.lockTimer = setTimeout(lock, state.settings.autoLockMin * 60_000);
}

// ---------- ligações aos elementos ----------

function wire() {
  hydrateIcons();

  $('#form-unlock').addEventListener('submit', onUnlock);
  $('#btn-open').addEventListener('click', onOpenFile);
  $('#btn-clear-pending').addEventListener('click', () => {
    state.pending = null;
    goUnlock();
  });
  $('#btn-create').addEventListener('click', startCreate);
  $('#btn-mode').addEventListener('click', () => {
    state.settings.consulta = !isConsulta();
    saveSettings();
    applyMode();
    renderUnlock();
  });

  $('#form-create').addEventListener('submit', onCreate);
  $('#btn-create-cancel').addEventListener('click', goUnlock);
  $('#create-pw').addEventListener('input', (e) => updateMeter($('#create-meter'), $('#create-meter-label'), e.target.value));

  $('#space-select').addEventListener('change', (e) => {
    switchSpace(e.target.value);
    renderChips();
    renderList();
  });
  $('#chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    state.catFilter = b.dataset.cat;
    renderChips();
    renderList();
  });
  $('#btn-search-all').addEventListener('click', (e) => {
    state.searchAll = !state.searchAll;
    e.currentTarget.setAttribute('aria-pressed', String(state.searchAll));
    renderChips();
    renderList();
  });
  $('#search').addEventListener('input', (e) => {
    state.query = e.target.value;
    renderList();
  });
  $('#list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-id]');
    if (b) openView(b.dataset.id);
  });
  $('#btn-lock').addEventListener('click', lock);
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-manage').addEventListener('click', openManage);
  $('#btn-add').addEventListener('click', () => openEdit(null));
  $('#btn-banner').addEventListener('click', onBanner);

  $('#btn-edit').addEventListener('click', () => openEdit(state.viewId));
  $('#btn-move').addEventListener('click', openMove);
  $('#btn-delete').addEventListener('click', onDelete);

  $('#form-entry').addEventListener('submit', onSaveEntry);
  $('#e-space').addEventListener('change', (e) => fillCatSelect($('#e-cat'), e.target.value));
  $('#btn-reveal').addEventListener('click', () => setReveal($('#e-pass').type === 'password'));
  $('#btn-gen-quick').addEventListener('click', generateInto);
  $('#btn-generate').addEventListener('click', generateInto);
  $('#e-pass').addEventListener('input', refreshEntryMeter);
  $('#g-len').addEventListener('input', (e) => ($('#g-len-out').textContent = e.target.value));

  $('#form-move').addEventListener('submit', onMove);
  $('#mv-space').addEventListener('change', (e) => fillCatSelect($('#mv-cat'), e.target.value));

  $('#form-add-space').addEventListener('submit', onAddSpace);
  $('#form-add-cat').addEventListener('submit', onAddCategory);

  $('#s-consulta').addEventListener('change', (e) => {
    state.settings.consulta = e.target.checked;
    saveSettings();
    applyMode();
    renderAll();
    const dlg = $('#dlg-settings');
    dlg.close();
    openSettings(); // volta a abrir para mostrar/esconder as opções de edição
  });
  $('#s-lock').addEventListener('change', (e) => {
    state.settings.autoLockMin = Number(e.target.value);
    saveSettings();
    armLock();
  });
  $('#s-export').addEventListener('click', () => download(state.cached));
  $('#s-link').addEventListener('click', onLink);
  $('#s-savefile').addEventListener('click', onSaveFile);
  $('#s-unlink').addEventListener('click', onUnlink);
  $('#s-refresh').addEventListener('click', onRefresh);
  $('#s-wipe').addEventListener('click', onWipe);
  $('#s-master').addEventListener('click', () => {
    $('#dlg-settings').close();
    $('#m-error').hidden = true;
    updateMeter($('#m-meter'), $('#m-meter-label'), '');
    $('#dlg-master').showModal();
  });
  $('#form-master').addEventListener('submit', onChangeMaster);
  $('#m-new').addEventListener('input', (e) => updateMeter($('#m-meter'), $('#m-meter-label'), e.target.value));

  // fechar diálogos e limpar campos sensíveis
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-close]');
    if (b) b.closest('dialog').close();
  });
  for (const d of document.querySelectorAll('dialog')) {
    d.addEventListener('close', () => {
      if (d.id === 'dlg-entry') $('#form-entry').reset();
      if (d.id === 'dlg-view') $('#view-body').replaceChildren();
      if (d.id === 'dlg-master') $('#form-master').reset();
    });
  }

  // bloqueio por inatividade
  for (const ev of ['pointerdown', 'keydown', 'input']) document.addEventListener(ev, armLock, { capture: true, passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      state.hiddenAt = Date.now();
    } else {
      if (state.session && state.hiddenAt && Date.now() - state.hiddenAt > state.settings.autoLockMin * 60_000) lock();
      state.hiddenAt = null;
      if (state.clipNeedsClear) clearClipboard();
    }
  });
  window.addEventListener('focus', () => {
    if (state.clipNeedsClear) clearClipboard();
  });
}

// ---------- arranque ----------

async function boot() {
  wire();
  setReveal(false);
  applyMode();
  try {
    state.cached = (await idbGet('vault')) ?? null;
    state.handle = (await idbGet('handle')) ?? null;
  } catch {
    state.cached = null;
    state.handle = null;
  }
  goUnlock();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {
      /* sem service worker (ex.: ficheiro aberto sem HTTPS): a app funciona na mesma, só não instala offline */
    });
  }
}

boot();
