// public/orders.js
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

let state = {
  page: 1,
  pageSize: 50,
  group: 'all',
  es: null,            // EventSource do stream
  streaming: false,
  lastRange: null
};

// Utils
const fmtCurrency = v => (typeof v === 'number' ? v : Number(v || 0))
  .toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtDateTime = iso => {
  if (!iso) return '';
  const d = new Date(iso);
  const dia = d.toLocaleDateString('pt-BR');
  const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `${dia}, ${hora}`;
};
const ymd = d => new Date(d).toISOString().slice(0, 10);

// Períodos predefinidos: 24h, 7d, 1m, 6m, 1y ou intervalo personalizado
function getSelectedPeriod() {
  const sel = $('#periodSelect')?.value || '7d';
  const now = new Date();
  let from = new Date(now), to = new Date(now);

  if (sel === '24h') from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  else if (sel === '7d') from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  else if (sel === '1m') from.setMonth(from.getMonth() - 1);
  else if (sel === '6m') from.setMonth(from.getMonth() - 6);
  else if (sel === '1y') from.setFullYear(from.getFullYear() - 1);
  else if (sel === 'custom') {
    const f = $('#fromDate').value;
    const t = $('#toDate').value;
    if (!f || !t) return null;
    from = new Date(f);
    to = new Date(t);
  }
  return { from: ymd(from), to: ymd(to) };
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
  $('#tbody').innerHTML = `<tr><td colspan="11" class="muted">Sincronizando pedidos…</td></tr>`;
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
    $('#count-all').textContent = s.total ?? 0;
    $('#count-delivered').textContent = s.stats?.delivered ?? 0;
    $('#count-in_transit').textContent = s.stats?.in_transit ?? 0;
    $('#count-ready_to_ship').textContent = s.stats?.ready_to_ship ?? 0;
    if (s.syncedAt) updateSyncedAt(state.lastRange, s.syncedAt);
  } catch {}
}

// Tabela paginada normal (pós stream ou quando navegar)
async function loadPage() {
  const params = new URLSearchParams({
    page: String(state.page),
    pageSize: String(state.pageSize),
    group: state.group
  });
  const r = await fetch(`/api/orders/page?${params.toString()}`);
  if (!r.ok) {
    $('#tbody').innerHTML = `<tr><td colspan="11" class="muted">Falha ao carregar pedidos.</td></tr>`;
    return;
  }
  const data = await r.json();

  $('#pageInfo').textContent = `Página ${data.page} de ${data.pages}`;
  $('#prevBtn').disabled = data.page <= 1;
  $('#nextBtn').disabled = data.page >= data.pages;

  if (!data.data || data.data.length === 0) {
    $('#tbody').innerHTML = `<tr><td colspan="11" class="muted">Sem pedidos para exibir.</td></tr>`;
    return;
  }

  const rows = data.data.map(renderRow).join('');
  $('#tbody').innerHTML = rows;
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

  const estimatedDelivery = (() => {
    const d = row.shipping?.estimated_delivery_final || row.shipping?.estimated_delivery_limit?.date;
    return d ? fmtDateTime(d) : '';
  })();

  const trackingInfo = (() => {
    const num = row.shipping?.tracking_number || row.shipping?.tracking_id;
    const url = row.shipping?.tracking_url;
    if (!num) return '';
    return url ? `<a href="${url}" target="_blank">${num}</a>` : num;
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
      <td>${estimatedDelivery}</td>
      <td>${trackingInfo}</td>
      <td>${row.shipping?.id ? `<a href="/api/shipments/${row.shipping.id}/label" target="_blank">${row.shipping.id}</a>` : ''}</td>
      <td>${o.pack_id || ''}</td>
    </tr>
  `;
}
function appendRow(row) {
  $('#tbody').insertAdjacentHTML('beforeend', renderRow(row));
}

document.addEventListener('DOMContentLoaded', initUI);
