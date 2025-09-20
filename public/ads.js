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
  // backend espera category_id
  if (category) params.set('category_id', category);
  if (free) params.set('free_shipping', 'true');
  if (sort) params.set('sort', sort);
  params.set('limit', String(PAGE_SIZE));
  params.set('page', '1');
  // incluir imagens na busca para reduzir hidratação
  params.set('include', 'details,sale_price,images');

  progressStart('Buscando anúncios…', 15);
  try {
    const res = await fetch(`/api/ads/search?${params.toString()}`, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin'
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    state.search.items = Array.isArray(data.items) ? data.items : [];
    // usar paging.total quando fornecido
    state.search.total = Number(data?.paging?.total ?? state.search.items.length ?? 0);
    state.search.page = 1;

    renderTable();
    progressFinish(`Encontrados ${state.search.total} anúncio(s).`);
  } catch (err) {
    console.error('Busca falhou', err);
    toast('Falha ao buscar anúncios');
    progressError('Falha ao buscar anúncios');
  }
}

// ===== Helpers de imagem/variações =====
function fixImageUrl(u) {
  if (!u) return '';
  return String(u).replace(/^http:\/\//i, 'https://');
}
function thumbFromItem(it) {
  // Capa do item: secure_thumbnail > thumbnail > primeira picture
  return fixImageUrl(
    it?.secure_thumbnail ||
      it?.thumbnail ||
      it?.pictures?.[0]?.secure_url ||
      it?.pictures?.[0]?.url ||
      ''
  );
}
function mapPictureIdsToUrls(item) {
  const map = new Map();
  (item?.pictures || []).forEach((p) => {
    if (p?.id) map.set(String(p.id), fixImageUrl(p.secure_url || p.url || ''));
  });
  return map;
}
function formatVariationLabel(v) {
  // monta "Cor: Preto • Tamanho: 42" (quando existir)
  const parts = (v?.attribute_combinations || []).map((a) => {
    const k = a?.name || a?.id || '';
    const val = a?.value_name || a?.value_id || '';
    return `${k}: ${val}`.trim();
  });
  return parts.join(' • ') || `Variação ${v?.id || ''}`.trim();
}

// Garante contêineres dentro do painel de descrição para mídia e variações
function ensureDescMediaContainers() {
  const ta = $('#descText');
  if (!ta || !ta.parentElement) return { media: null, grid: null };

  let media = $('#descMedia');
  if (!media) {
    media = document.createElement('div');
    media.id = 'descMedia';
    media.className = 'tiny';
    media.style.margin = '8px 0 12px';
    ta.parentElement.insertBefore(media, ta); // mídia fica acima do textarea
  }

  let grid = $('#variationsGrid');
  if (!grid) {
    grid = document.createElement('div');
    grid.id = 'variationsGrid';
    Object.assign(grid.style, {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
      gap: '10px',
      marginTop: '8px'
    });
    ta.parentElement.appendChild(grid); // grid de variações abaixo do textarea
  }

  return { media, grid };
}

async function loadItemMedia(itemId) {
  // Tenta pegar variações + pictures num único request (proxy passa query em frente)
  let item = null;
  try {
    const r1 = await fetch(
      `/api/items/${encodeURIComponent(itemId)}?attributes=variations,pictures,thumbnail,secure_thumbnail`,
      { headers: { Accept: 'application/json' }, credentials: 'same-origin' }
    );
    if (r1.ok) {
      item = await r1.json();
    }
  } catch {}

  // fallback: busca variações e depois o item completo
  if (!item || (!item.pictures && !item.variations)) {
    try {
      const [vRes, iRes] = await Promise.all([
        fetch(`/api/items/${encodeURIComponent(itemId)}/variations`, {
          headers: { Accept: 'application/json' },
          credentials: 'same-origin'
        }),
        fetch(`/api/items/${encodeURIComponent(itemId)}`, {
          headers: { Accept: 'application/json' },
          credentials: 'same-origin'
        })
      ]);
      const variations = vRes.ok ? await vRes.json().catch(() => []) : [];
      const baseItem = iRes.ok ? await iRes.json().catch(() => null) : null;
      item = baseItem || {};
      if (Array.isArray(variations)) item.variations = variations;
    } catch {}
  }

  const { media, grid } = ensureDescMediaContainers();
  if (!media || !grid) return;

  // Render capa do item
  const cover = thumbFromItem(item) || '';
  media.innerHTML = cover
    ? `<div class="row" style="align-items:center; gap:10px">
         <img src="${cover}" alt="Capa do anúncio" style="width:64px;height:64px;object-fit:cover;border-radius:10px;border:1px solid var(--border)"/>
         <div class="tiny muted2">Capa do anúncio</div>
       </div>`
    : `<div class="tiny muted2">Sem imagem de capa do anúncio.</div>`;

  // Render grid de variações (cada uma com sua capa)
  grid.innerHTML = '';
  const variations = Array.isArray(item?.variations) ? item.variations : [];
  if (!variations.length) {
    grid.innerHTML = `<div class="muted tiny">Este anúncio não possui variações.</div>`;
    return;
  }

  const idToUrl = mapPictureIdsToUrls(item);
  const cards = variations.map((v) => {
    // picture_ids pode conter IDs (que mapeiam em item.pictures) ou URLs diretas
    let pic = '';
    const picId = (v?.picture_ids || [])[0];
    if (picId) {
      if (/^https?:\/\//i.test(picId)) pic = fixImageUrl(picId);
      else pic = idToUrl.get(String(picId)) || cover || '';
    } else {
      pic = cover || '';
    }
    const label = formatVariationLabel(v);
    const vid = v?.id ? `#${v.id}` : '';
    return `
      <div class="panel" style="padding:8px">
        <div class="row" style="align-items:center; gap:10px">
          <img src="${pic}" alt="Capa da variação ${vid}" onerror="this.style.visibility='hidden'"
               style="width:56px;height:56px;object-fit:cover;border-radius:10px;border:1px solid var(--border)"/>
          <div class="grow">
            <div style="font-weight:600; font-size:14px">${label || 'Variação'}</div>
            <div class="tiny muted2">${vid}</div>
          </div>
        </div>
      </div>
    `.trim();
  });
  grid.innerHTML = cards.join('\n');
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

    // sale_price pode ser objeto { amount, regular_amount, ... } ou número legado
    const sp = it && typeof it.sale_price === 'object' ? it.sale_price : null;
    const saleAmount = sp?.amount ?? (typeof it.sale_price === 'number' ? it.sale_price : null);
    const regular = sp?.regular_amount ?? null;

    const basePrice = Number(it.price ?? 0);
    const price = saleAmount != null && Number(saleAmount) > 0 ? Number(saleAmount) : basePrice;
    const hasSale = regular != null && Number(regular) > Number(price);

    const priceHtml = hasSale
      ? `<div><strong>${fmtBRL(price)}</strong> <span class="muted" style="text-decoration:line-through;opacity:.8;margin-left:6px">${fmtBRL(regular)}</span></div>`
      : `<div>${fmtBRL(price)}</div>`;

    const titleHtml = permalink
      ? `<a href="${permalink}" target="_blank" rel="noopener">${escapeHtml(title)}</a>`
      : escapeHtml(title);

    // miniatura no título (sem alterar cabeçalho/colunas)
    const thumb = thumbFromItem(it);
    const titleWithThumb = `
      <div style="display:flex;align-items:center;gap:10px">
        <img class="ad-thumb" data-id="${escapeAttr(id)}"
             ${thumb ? `src="${thumb}"` : ''} referrerpolicy="no-referrer"
             alt="Foto" onerror="this.style.visibility='hidden'"
             style="width:40px;height:40px;object-fit:cover;border-radius:8px;border:1px solid var(--border)" />
        <div>
          <div>${titleHtml}</div>
          <div class="tiny muted2">${escapeHtml(String(id))}</div>
        </div>
      </div>`;

    return `
      <tr>
        <td>${titleWithThumb}</td>
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

  // bind da ação de descrição
  $$('#tbody [data-act="desc"]').forEach((btn) => {
    btn.addEventListener('click', () => openDescription(btn.getAttribute('data-id')));
  });

  // preenche thumbs ausentes (quando a busca não trouxe imagens)
  hydrateThumbs();
}

// carrega thumbs que faltaram (busca 1x o item e injeta a imagem)
async function hydrateThumbs() {
  const imgs = $$('#tbody img.ad-thumb[data-id]');
  await Promise.all(
    imgs.map(async (img) => {
      if (img.getAttribute('src')) return; // já tem
      const id = img.dataset.id;
      try {
        const r = await fetch(
          `/api/items/${encodeURIComponent(id)}?attributes=secure_thumbnail,thumbnail,pictures`,
          { headers: { Accept: 'application/json' }, credentials: 'same-origin' }
        );
        if (!r.ok) return;
        const it = await r.json();
        const url =
          thumbFromItem(it) ||
          fixImageUrl(it?.pictures?.[0]?.secure_url || it?.pictures?.[0]?.url);
        if (url) img.src = url;
      } catch {}
    })
  );
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
      headers: { Accept: 'application/json' },
      credentials: 'same-origin'
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // Mercado Livre retorna algo como { text, plain_text, date_created, last_updated }
    textarea.value = data?.text || data?.plain_text || '';
    state.editingId = itemId;
    panel.hidden = false;
    textarea.focus();

    // carrega capa do item + variações com suas capas (via pictures/picture_ids)
    await loadItemMedia(itemId);

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
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
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
  // limpa mídia/variações quando fecha
  $('#descMedia')?.remove();
  $('#variationsGrid')?.remove();
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

  // ouvir eventos nomeados emitidos pelo backend
  state.es.addEventListener('meta', (evt) => {
    try {
      const data = JSON.parse(evt.data || '{}');
      const total = Number(data.total_ids ?? data.total ?? 0);
      state.expected = total;
      if (total > 0) progressUpdate(12, `Total previsto: ${total}`);
    } catch {}
  });

  state.es.addEventListener('progress', (evt) => {
    try {
      const data = JSON.parse(evt.data || '{}');
      const total = Number(data.total ?? state.expected ?? 0);
      const sent = Number(data.sent ?? 0);
      if (total > 0) {
        const pct = Math.max(0, Math.min(100, Math.round((sent / total) * 100)));
        progressUpdate(pct, `Processados ${sent}/${total}`);
      }
    } catch {}
  });

  state.es.addEventListener('batch', () => {
    // opcional: atualizar UI incremental com pacotes
  });

  state.es.addEventListener('done', () => {
    progressFinish('Sincronização concluída');
    stopStreamSync(false);
    // refazer busca se há filtros preenchidos
    if (($('#adsQ')?.value || '').length || $('#adsStatus')?.value || $('#adsCategory')?.value) {
      doSearch().catch(() => {});
    }
  });

  // erro de rede
  state.es.addEventListener('error', (evt) => {
    console.error('SSE error', evt);
    toast('Conexão de stream encerrada');
    progressError('Conexão encerrada');
    stopStreamSync(true);
  });

  // também tratar um possível evento nomeado "error" vindo do servidor
  state.es.addEventListener('error', (evt) => {
    try {
      const data = JSON.parse(evt.data || '{}');
      if (data?.message || data?.detail) {
        toast(`Erro no stream: ${data.message || 'erro'}`);
      }
    } catch {}
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

  // ESC fecha o painel de descrição, se aberto
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const panel = $('#descPanel');
      if (panel && !panel.hidden) closeDescription();
    }
  });

  // ações de autenticação do topo podem ser tratadas por /app.js
}

// ===== Inicialização =====
document.addEventListener('DOMContentLoaded', () => {
  bindUi();
  // doSearch(); // se quiser carregar algo ao abrir a página
});
