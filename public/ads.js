// public/ads.js — módulo da página de Anúncios
'use strict';

// ===== Helpers básicos =====
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const fmtBRL = (v) =>
  Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function ensureToastStack() {
  let n = document.querySelector('.toast-stack');
  if (!n) {
    n = document.createElement('div');
    n.className = 'toast-stack';
    Object.assign(n.style, {
      position: 'fixed',
      top: '16px',
      right: '16px',
      zIndex: 1000,
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      pointerEvents: 'none'
    });
    document.body.appendChild(n);
  }
  return n;
}
function toast(msg, ms = 2200) {
  const stack = ensureToastStack();
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  Object.assign(el.style, {
    background: 'var(--surface-2, #222)',
    color: 'var(--text, #fff)',
    border: '1px solid var(--border, #333)',
    borderRadius: '10px',
    padding: '10px 12px',
    boxShadow: '0 6px 20px rgba(0,0,0,.35)',
    pointerEvents: 'auto'
  });
  stack.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// ===== Estado =====
const PAGE_SIZE = 50; // mantido fixo conforme o backend
const state = {
  search: { items: [], total: 0, page: 1, pageSize: PAGE_SIZE },
  es: null,
  streaming: false,
  expected: 0,
  editingId: null
};

// ===== Progresso acessível =====
let progressHideTimer = null;
function progressEls() {
  return {
    wrap: $('#progress'),
    bar: $('#progressBar'),
    label: $('#progressLabel')
  };
}
function progressResetUI() {
  const { bar, label } = progressEls();
  if (bar) bar.style.width = '0%';
  if (label) label.textContent = 'Aguardando…';
}
function progressHideNow() {
  const { wrap } = progressEls();
  if (wrap) {
    try {
      wrap.removeAttribute('aria-busy');
      wrap.removeAttribute('aria-label');
    } catch {}
    wrap.hidden = true;
  }
  progressResetUI();
  if (progressHideTimer) {
    clearTimeout(progressHideTimer);
    progressHideTimer = null;
  }
}
function progressStart(text = 'Sincronizando…', pct = 5) {
  const { wrap } = progressEls();
  if (!wrap) return;
  wrap.hidden = false;
  try {
    wrap.setAttribute('aria-busy', 'true');
    if (typeof text === 'string') wrap.setAttribute('aria-label', text);
  } catch {}
  progressUpdate(pct, text);
}
function progressUpdate(pct = 10, text) {
  const { bar, label } = progressEls();
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, Number(pct) || 0))}%`;
  if (typeof text === 'string' && label) label.textContent = text;
  try {
    const w = $('#progress');
    if (w && typeof text === 'string') w.setAttribute('aria-label', text);
  } catch {}
}
function progressFinish(text = 'Concluído', hideAfterMs = 900) {
  try {
    $('#progress')?.setAttribute('aria-busy', 'false');
  } catch {}
  progressUpdate(100, text);
  if (progressHideTimer) clearTimeout(progressHideTimer);
  progressHideTimer = setTimeout(progressHideNow, hideAfterMs);
}
function progressError(text = 'Erro', hideAfterMs = 1600) {
  try {
    $('#progress')?.setAttribute('aria-busy', 'false');
  } catch {}
  progressUpdate(100, text);
  if (progressHideTimer) clearTimeout(progressHideTimer);
  progressHideTimer = setTimeout(progressHideNow, hideAfterMs);
}
function progressCancel(text = 'Stream cancelado', hideAfterMs = 1000) {
  try {
    $('#progress')?.setAttribute('aria-busy', 'false');
  } catch {}
  progressUpdate(100, text);
  if (progressHideTimer) clearTimeout(progressHideTimer);
  progressHideTimer = setTimeout(progressHideNow, hideAfterMs);
}

// ===== Busca HTTP =====
async function doSearch() {
  const q = $('#adsQ')?.value?.trim() || '';
  const status = $('#adsStatus')?.value || '';
  const category = $('#adsCategory')?.value?.trim() || '';
  const free = $('#adsFreeShipping')?.checked ? 'true' : '';
  const sort = $('#adsSort')?.value || '';

  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (status) params.set('status', status);
  if (category) params.set('category', category);
  if (free) params.set('free_shipping', 'true');
  if (sort) params.set('sort', sort);
  params.set('limit', String(PAGE_SIZE));
  params.set('page', '1');

  progressStart('Buscando anúncios…', 15);
  try {
    const res = await fetch(`/api/ads/search?${params.toString()}`, {
      headers: { 'Accept': 'application/json' },
      credentials: 'same-origin'
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.search.items = Array.isArray(data.items) ? data.items : [];
    state.search.total = Number(data.total || state.search.items.length || 0);
    state.search.page = 1;

    renderTable();
    progressFinish(`Encontrados ${state.search.total} anúncio(s).`);
  } catch (err) {
    console.error('Busca falhou', err);
    toast('Falha ao buscar anúncios');
    progressError('Falha ao buscar anúncios');
  }
}

// ===== Renderização da Tabela =====
function renderTable() {
  const tbody = $('#tbody');
  if (!tbody) return;

  const items = state.search.items || [];
  if (!items.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted">Nenhum resultado. Ajuste os filtros e tente novamente.</td></tr>`;
    return;
  }

  const rows = items.map((it) => {
    const id = it.id || it.item_id || '';
    const title = it.title || '(sem título)';
    const status = it.status || it.listing_status || '';
    const sold = it.sold_quantity ?? it.sold ?? 0;
    const permalink = it.permalink || it.perma_link || '';
    const price = it.sale_price && it.sale_price > 0 ? it.sale_price : it.price;
    const hasSale = it.sale_price && it.sale_price > 0 && Number(it.price) !== Number(it.sale_price);

    const priceHtml = hasSale
      ? `<div><strong>${fmtBRL(price)}</strong> <span class="muted" style="text-decoration:line-through;opacity:.8;margin-left:6px">${fmtBRL(it.price)}</span></div>`
      : `<div>${fmtBRL(price)}</div>`;

    const titleHtml = permalink
      ? `<a href="${permalink}" target="_blank" rel="noopener">${escapeHtml(title)}</a>`
      : escapeHtml(title);

    return `
      <tr>
        <td>${titleHtml}</td>
        <td>${priceHtml}</td>
        <td>${Number(sold || 0)}</td>
        <td>${escapeHtml(status)}</td>
        <td>${escapeHtml(String(id))}</td>
        <td style="text-align:right">
          <button class="btn small" data-act="desc" data-id="${escapeAttr(id)}">Descrição</button>
        </td>
      </tr>
    `.trim();
  });

  tbody.innerHTML = rows.join('\n');

  // Bind ação de descrição
  $$('#tbody [data-act="desc"]').forEach((btn) => {
    btn.addEventListener('click', () => openDescription(btn.getAttribute('data-id')));
  });
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
function escapeAttr(s) {
  return escapeHtml(s).replaceAll('"', '&quot;');
}

// ===== Painel de Descrição =====
async function openDescription(itemId) {
  if (!itemId) return;
  const panel = $('#descPanel');
  const textarea = $('#descText');
  if (!panel || !textarea) return;

  progressStart('Carregando descrição…', 20);
  try {
    const res = await fetch(`/api/items/${encodeURIComponent(itemId)}/description`, {
      headers: { 'Accept': 'application/json' },
      credentials: 'same-origin'
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // Mercado Livre retorna algo como { text, plain_text, date_created, last_updated }
    textarea.value = data?.text || data?.plain_text || '';
    state.editingId = itemId;
    panel.hidden = false;
    textarea.focus();
    progressFinish('Descrição carregada');
  } catch (err) {
    console.error('Erro ao carregar descrição', err);
    toast('Não foi possível carregar a descrição');
    progressError('Falha ao carregar descrição');
  }
}

async function saveDescription() {
  const itemId = state.editingId;
  const panel = $('#descPanel');
  const textarea = $('#descText');
  if (!itemId || !panel || !textarea) return;

  const body = { plain_text: String(textarea.value || '') };

  progressStart('Salvando descrição…', 25);
  try {
    const res = await fetch(`/api/items/${encodeURIComponent(itemId)}/description`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await res.json().catch(() => null); // algumas APIs podem não retornar body
    toast('Descrição salva com sucesso');
    progressFinish('Descrição salva');
  } catch (err) {
    console.error('Erro ao salvar descrição', err);
    toast('Falha ao salvar descrição');
    progressError('Falha ao salvar descrição');
  }
}

function closeDescription() {
  const panel = $('#descPanel');
  const textarea = $('#descText');
  if (panel) panel.hidden = true;
  if (textarea) textarea.value = '';
  state.editingId = null;
}

// ===== Sincronização por Stream (SSE) =====
function startStreamSync() {
  if (state.streaming) return;
  state.streaming = true;

  const syncBtn = $('#syncBtn');
  const cancelBtn = $('#cancelBtn');
  if (syncBtn) syncBtn.style.display = 'none';
  if (cancelBtn) cancelBtn.style.display = 'inline-block';

  progressStart('Iniciando stream de itens…', 5);
  try {
    state.es = new EventSource('/api/items/all/stream', { withCredentials: true });
  } catch (err) {
    console.error('EventSource erro de criação', err);
    toast('Seu navegador pode não suportar stream');
    progressError('Falha ao iniciar stream');
    state.streaming = false;
    if (syncBtn) syncBtn.style.display = 'inline-block';
    if (cancelBtn) cancelBtn.style.display = 'none';
    return;
  }

  state.es.addEventListener('open', () => {
    progressUpdate(10, 'Conexão aberta…');
  });

  state.es.addEventListener('message', (evt) => {
    if (!evt?.data) return;
    let data;
    try { data = JSON.parse(evt.data); } catch { return; }

    // Protocolo flexível: aceitamos keys comuns
    if (typeof data.total === 'number') {
      state.expected = data.total;
      progressUpdate(12, `Total previsto: ${data.total}`);
    }
    if (typeof data.processed === 'number' && state.expected > 0) {
      const pct = Math.max(0, Math.min(100, Math.round((data.processed / state.expected) * 100)));
      progressUpdate(pct, `Processados ${data.processed}/${state.expected}`);
    }
    if (data.item) {
      // opcional: enriquecer a UI quando vier item a item
      // por padrão não inserimos dinamicamente para evitar flicker
    }
    if (data.done || data.finished) {
      progressFinish('Sincronização concluída');
      stopStreamSync(false);
      // dica: recarregar busca após concluir
      if (($('#adsQ')?.value || '').length || $('#adsStatus')?.value || $('#adsCategory')?.value) {
        doSearch().catch(() => {});
      }
    }
    if (data.error) {
      toast(`Erro no stream: ${data.error}`);
      progressError('Erro durante o stream');
      stopStreamSync(true);
    }
    if (data.message && !data.done && !data.error) {
      // mensagens informativas do servidor
      progressUpdate(undefined, String(data.message));
    }
  });

  state.es.addEventListener('error', (e) => {
    console.error('SSE error', e);
    toast('Conexão de stream encerrada');
    progressError('Conexão encerrada');
    stopStreamSync(true);
  });
}

function stopStreamSync(userCanceled = true) {
  if (state.es) {
    try { state.es.close(); } catch {}
  }
  state.es = null;
  const syncBtn = $('#syncBtn');
  const cancelBtn = $('#cancelBtn');
  if (syncBtn) syncBtn.style.display = 'inline-block';
  if (cancelBtn) cancelBtn.style.display = 'none';
  state.streaming = false;

  if (userCanceled) {
    progressCancel('Stream cancelado');
  }
}

// ===== Eventos da UI =====
function bindUi() {
  $('#adsSearchBtn')?.addEventListener('click', doSearch);
  $('#adsQ')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch();
  });

  $('#syncBtn')?.addEventListener('click', startStreamSync);
  $('#cancelBtn')?.addEventListener('click', () => stopStreamSync(true));

  $('#descSaveBtn')?.addEventListener('click', saveDescription);
  $('#descCloseBtn')?.addEventListener('click', closeDescription);

  // Ações de autenticação do topo podem ser tratadas por /app.js
}

// ===== Inicialização =====
document.addEventListener('DOMContentLoaded', () => {
  bindUi();
  // opcional: carregar lista inicial em branco, aguardar ação do usuário
  // doSearch();
});
