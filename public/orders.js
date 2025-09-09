// public/orders.js
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

// estado
let state = {
  page: 1,
  pageSize: 50,
  group: 'today',
  form: 'all',
  es: null,
  streaming: false,
  lastRange: null
};

// initUI: listeners dos chips de grupo e forma
function initUI() {
  $('#pageSize').value = String(state.pageSize);
  $('#pageSize').addEventListener('change', () => {
    state.pageSize = Number($('#pageSize').value || 50);
    state.page = 1;
    if (!state.streaming) loadPage();
  });

  // chips do topo (grupos)
  $$('#chips .chip').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('#chips .chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.group = btn.dataset.group;
      state.page = 1;
      if (!state.streaming) loadPage();
    });
  });

  // chips de forma (novo)
  $$('#forms .chip').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('#forms .chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.form = btn.dataset.form;
      state.page = 1;
      if (!state.streaming) loadPage();
    });
  });

  // paginação
  $('#prevBtn').addEventListener('click', () => { if (state.page > 1) { state.page--; loadPage(); } });
  $('#nextBtn').addEventListener('click', () => { state.page++; loadPage(); });

  // período custom
  const sel = $('#periodSelect');
  if (sel) {
    sel.addEventListener('change', () => {
      const custom = sel.value === 'custom';
      $('#customDates').style.display = custom ? 'inline-flex' : 'none';
    });
  }

  $('#syncBtn').addEventListener('click', startStream);
  $('#cancelBtn')?.addEventListener('click', cancelStream);

  refreshStats();
  loadPage();
}

/* ======================= APRESENTAÇÃO DO STATUS DE ENVIO =======================
   Traduz e colore o chip de envio com base em um mapa centralizado.
   Você pode sobrescrever via window.SHIPPING_STATUS_UI antes de carregar este script. */
const DEFAULT_SHIPPING_STATUS_UI = {
  delivered:     { label: 'Entregue',        variant: 'ok'   },
  ready_to_ship: { label: 'Pronto p/ envio', variant: 'info' },
  pending:       { label: 'Aguardando',      variant: 'warn' },
  in_transit:    { label: 'A caminho',       variant: 'info' },
  shipped:       { label: 'Enviado',         variant: 'info' },
  handling:      { label: 'Preparando',      variant: 'info' },
  not_delivered: { label: 'Não entregue',    variant: 'warn' },
  cancelled:     { label: 'Cancelado',       variant: 'muted' }
};
// window overrides default (se quiser customizar fora do arquivo)
const SHIPPING_STATUS_UI = { ...DEFAULT_SHIPPING_STATUS_UI, ...(window?.SHIPPING_STATUS_UI || {}) };

function titleCaseFromSlug(slug) {
  return String(slug || '')
    .replace(/_/g, ' ')
    .replace(/\b(\w)/g, (m, ch) => ch.toUpperCase());
}
function presentShippingStatus(raw) {
  const key = String(raw || '').toLowerCase();
  const conf = SHIPPING_STATUS_UI[key];
  return {
    label: conf?.label ?? titleCaseFromSlug(key),
    variant: conf?.variant ?? 'muted'
  };
}
function badgeShipping(status) {
  const { label, variant } = presentShippingStatus(status);
  // Requer as classes base no layout.css: .badge-status, .ok/.info/.warn/.muted e a variante .shipping
  return `<span class="badge-status shipping ${variant}">${label}</span>`;
}
function getShippingStatusRaw(row) {
  // Preferimos o status do shipment; fallback para um possível status no pedido
  return row?.shipping?.status ?? row?.order?.shipping_status ?? '';
}

// UI inicial
function initUI() {
  // page size
  $('#pageSize').value = String(state.pageSize);
  $('#pageSize').addEventListener('change', () => {
    state.pageSize = Number($('#pageSize').value || 50);
    state.page = 1;
    if (!state.streaming) loadPage();
  });

  // chips grupo
  $$('#chips .chip').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('#chips .chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.group = btn.dataset.group;
      state.page = 1;
      if (!state.streaming) loadPage();
    });
  });

  // navegação
  $('#prevBtn').addEventListener('click', () => { if (state.page > 1) { state.page--; loadPage(); } });
  $('#nextBtn').addEventListener('click', () => { state.page++; loadPage(); });

  // período custom
  const sel = $('#periodSelect');
  if (sel) {
    sel.addEventListener('change', () => {
      const custom = sel.value === 'custom';
      $('#customDates').style.display = custom ? 'inline-flex' : 'none';
    });
  }

  // ações
  $('#syncBtn').addEventListener('click', startStream);
  $('#cancelBtn')?.addEventListener('click', cancelStream);

  // carrega estado atual
  refreshStats();
  loadPage();
}

// Barra de progresso
function setProgress(pct, label) {
  const bar = $('#progressBar');
  const wrap = $('#progress');
  if (!wrap) return;
  wrap.hidden = false;
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  if (label) $('#progressLabel').textContent = label;
}
function hideProgressSoon() {
  const wrap = $('#progress');
  if (!wrap) return;
  setTimeout(() => { wrap.hidden = true; const bar = $('#progressBar'); if (bar) bar.style.width = '0%'; }, 600);
}

// Stream SSE
function startStream() {
  if (state.streaming) return;
  const range = getSelectedPeriod();
  if (!range) {
    alert('Selecione as datas em "Data personalizada".');
    return;
  }

  state.streaming = true;
  $('#syncBtn').disabled = true;
  $('#cancelBtn').style.display = 'inline-block';
  $('#prevBtn').disabled = true;
  $('#nextBtn').disabled = true;

  // limpa tabela e contagens visuais
  $('#tbody').innerHTML = `<tr><td colspan="9" class="muted">Sincronizando pedidos…</td></tr>`;
  setCounts(0, { delivered: 0, in_transit: 0, ready_to_ship: 0, other: 0 });

  const url = `/api/orders/stream?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
  const es = new EventSource(url);
  state.es = es;

  let expected = 0;
  let received = 0;
  let firstRow = true;

  es.addEventListener('meta', e => {
    const meta = JSON.parse(e.data || '{}');
    expected = Number(meta.expectedTotal || expected || 0);
    setProgress(expected > 0 ? (received / expected) * 100 : 10, 'Preparando…');
  });

  es.addEventListener('row', e => {
    const row = JSON.parse(e.data);
    if (firstRow) {
      $('#tbody').innerHTML = '';
      firstRow = false;
    }
    appendRow(row);
    received++;
    if (expected > 0) setProgress((received / expected) * 100, `Recebidos ${received}/${expected}`);
    else if (received < 50) setProgress(15 + received, `Recebidos ${received}…`);
    else setProgress(65, `Recebidos ${received}…`); // estimativa quando não há total
  });

  es.addEventListener('progress', e => {
    const p = JSON.parse(e.data || '{}');
    if (p.stats) setCounts(p.sent ?? received, p.stats);
  });

  es.addEventListener('done', async e => {
    const d = JSON.parse(e.data || '{}');
    state.lastRange = { from: range.from, to: range.to };
    updateSyncedAt(state.lastRange, d.syncedAt);
    setCounts(d.sent ?? received, d.stats || {});
    setProgress(100, 'Concluído');
    hideProgressSoon();
    stopStream();
    // carrega paginação normal para manter UX padrão
    await refreshStats();
    state.page = 1;
    await loadPage();
  });

  es.addEventListener('error', e => {
    // Se o servidor fechou, o readyState será 2 (closed)
    if (state.es && state.es.readyState === 2) return;
    console.warn('SSE error', e);
  });
}

function cancelStream() {
  if (!state.streaming) return;
  stopStream();
  $('#progressLabel').textContent = 'Sincronização cancelada';
  hideProgressSoon();
}

function stopStream() {
  try { state.es?.close(); } catch {}
  state.es = null;
  state.streaming = false;
  $('#syncBtn').disabled = false;
  $('#cancelBtn').style.display = 'none';
  $('#prevBtn').disabled = false;
  $('#nextBtn').disabled = false;
}

// Atualiza contagens nos chips
function setCounts(total, s) {
  if (typeof total === 'number') $('#count-all').textContent = total;
  if (s && typeof s === 'object') {
    if (s.delivered != null) $('#count-delivered').textContent = s.delivered;
    if (s.in_transit != null) $('#count-in_transit').textContent = s.in_transit;
    if (s.ready_to_ship != null) $('#count-ready_to_ship').textContent = s.ready_to_ship;
  }
}

// Resumo de sincronização
function updateSyncedAt(range, syncedAtMs) {
  const when = syncedAtMs ? new Date(syncedAtMs) : new Date();
  let txt = `Atualizado em ${when.toLocaleDateString('pt-BR')}, ${when.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  if (range && range.from && range.to) txt += ` • Período: ${range.from} a ${range.to}`;
  $('#syncedAt').textContent = txt;
}

// Carrega estatísticas atuais do backend
async function refreshStats() {
  try {
    const r = await fetch('/api/orders/stats');
    const s = await r.json();
    // chips topo (novo)
    $('#count-today').textContent = s.chips?.today ?? 0;
    $('#count-upcoming').textContent = s.chips?.upcoming ?? 0;
    $('#count-in_transit').textContent = s.chips?.in_transit ?? (s.stats?.in_transit ?? 0);
    $('#count-delivered').textContent = s.chips?.delivered ?? (s.stats?.delivered ?? 0);
    // formas
    $('#count-flex').textContent = s.forms?.flex ?? 0;
    $('#count-full').textContent = s.forms?.full ?? 0;
    $('#count-drop_off').textContent = s.forms?.drop_off ?? 0;
    $('#count-xd_drop_off').textContent = s.forms?.xd_drop_off ?? 0;
    $('#count-cross_docking').textContent = s.forms?.cross_docking ?? 0;
    $('#count-turbo').textContent = s.forms?.turbo ?? 0;

    if (s.syncedAt) updateSyncedAt(state.lastRange, s.syncedAt);
  } catch {}
}

// Tabela paginada normal (pós stream ou quando navegar)
async function loadPage() {
  const params = new URLSearchParams({
    page: String(state.page),
    pageSize: String(state.pageSize),
    group: state.group,
    form: state.form
  });
  const r = await fetch('/api/orders/page?' + params.toString());
  const p = await r.json();

  $('#pageInfo').textContent = `Página ${p.page} de ${p.pages}`;
  $('#prevBtn').disabled = p.page <= 1;
  $('#nextBtn').disabled = p.page >= p.pages;

  const tbody = $('#tbody');
  tbody.innerHTML = '';
  (p.data || []).forEach(appendRow);
  if (!p.data?.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="muted" style="text-align:center;padding:48px;">Sem pedidos para exibir.</td></tr>`;
  }
}

// Renderiza uma linha a partir do formato do backend
function renderRow(row) {
  const o = row.order || {};
  const buyer = (o.buyer && (o.buyer.nickname || o.buyer.first_name)) || '';
  const total = (o.total_amount != null ? o.total_amount : o.paid_amount);
  const status = (o.order_status || o.status || '').toString();
  const items = Array.isArray(o.order_items) ? o.order_items.map(it => (it.item?.title || '')).join('<br>') : '';
  const date = o.date_closed || o.date_created;

  const shippingStatus = (() => {
    const raw = getShippingStatusRaw(row);
    return raw ? badgeShipping(raw) : '';
  })();

  return `
    <tr>
      <td><strong>${o.id || ''}</strong></td>
      <td>${fmtDateTime(date)}</td>
      <td>${buyer}</td>
      <td>${items}</td>
      <td>${fmtCurrency(total)}</td>
      <td>${status}</td>
      <td>${shippingStatus}</td>
      <td>${row.shipping?.id || ''}</td>
      <td>${o.pack_id || ''}</td>
    </tr>
  `;
}
function appendRow(row) {
  const tr = document.createElement('tr');
  tr.innerHTML = renderRow(row);
  // O renderRow devolve <tr>...</tr>, então puxamos o conteúdo interno
  $('#tbody').insertAdjacentHTML('beforeend', tr.innerHTML);
}

document.addEventListener('DOMContentLoaded', initUI);
// Chame a inicialização da página de pedidos
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initUI);
} else {
  initUI();
}