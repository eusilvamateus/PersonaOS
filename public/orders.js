// public/orders.js - página de Pedidos
'use strict';

// ===== Helpers =====
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const fmtCurrency = (v) =>
  (typeof v === 'number' ? v : Number(v || 0)).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  });

const pad2 = (n) => String(n).padStart(2, '0');
function fmtDateTimeBR(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const dd = pad2(d.getDate());
  const mm = pad2(d.getMonth() + 1);
  const yyyy = d.getFullYear();
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  return `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function toast(msg, ms = 2200) {
  let stack = document.querySelector('.toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.className = 'toast-stack';
    Object.assign(stack.style, {
      position: 'fixed',
      top: '16px',
      right: '16px',
      zIndex: 1000,
      display: 'flex',
      flexDirection: 'column',
      gap: '8px'
    });
    document.body.appendChild(stack);
  }
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  stack.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// ===== Estado =====
const state = {
  page: 1,
  pageSize: 50,
  group: 'all',
  es: null,
  streaming: false,
  lastRange: null // { from, to, basis }
};

// ===== Progresso acessível =====
let hideTimer = null;
function progressEls() {
  return {
    wrap: $('#progress'),
    bar: $('#progressBar'),
    label: $('#progressLabel')
  };
}
function progressReset() {
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
  progressReset();
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
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
function progressFinish(text = 'Concluído', delay = 700) {
  try {
    $('#progress')?.setAttribute('aria-busy', 'false');
  } catch {}
  progressUpdate(100, text);
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(progressHideNow, delay);
}
function progressError(text = 'Erro', delay = 1400) {
  try {
    $('#progress')?.setAttribute('aria-busy', 'false');
  } catch {}
  progressUpdate(100, text);
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(progressHideNow, delay);
}
function progressCancel(text = 'Stream cancelado', delay = 900) {
  try {
    $('#progress')?.setAttribute('aria-busy', 'false');
  } catch {}
  progressUpdate(100, text);
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(progressHideNow, delay);
}

// ===== Intervalos de Data =====
function todayAt(hour = 0, min = 0, sec = 0, ms = 0) {
  const d = new Date();
  d.setHours(hour, min, sec, ms);
  return d;
}
function toISO(d) {
  return new Date(d).toISOString();
}
function getSelectedRange() {
  const sel = $('#periodSelect')?.value || '7d';
  if (sel === 'custom') {
    const from = $('#fromDate')?.value;
    const to = $('#toDate')?.value;
    if (from && to) {
      const fromD = new Date(from);
      const toD = new Date(to);
      toD.setHours(23, 59, 59, 999);
      return { from: toISO(fromD), to: toISO(toD), basis: 'created' };
    }
  }
  const now = new Date();
  let fromD;
  if (sel === '24h') {
    fromD = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  } else if (sel === '1m') {
    fromD = new Date(now); fromD.setMonth(fromD.getMonth() - 1);
  } else if (sel === '6m') {
    fromD = new Date(now); fromD.setMonth(fromD.getMonth() - 6);
  } else {
    fromD = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  }
  const toD = now;
  return { from: toISO(fromD), to: toISO(toD), basis: 'created' };
}
function updateCustomDateVisibility() {
  const sel = $('#periodSelect')?.value || '7d';
  const show = sel === 'custom';
  const from = $('#fromDate');
  const to = $('#toDate');
  if (from) from.style.display = show ? '' : 'none';
  if (to) to.style.display = show ? '' : 'none';
}

// ===== Chips de Grupo =====
function setActiveGroup(group) {
  state.group = group;
  $$('#chips .chip').forEach((btn) => {
    if (btn.getAttribute('data-group') === group) btn.classList.add('active');
    else btn.classList.remove('active');
  });
}
function updateChipCounts(stats, total) {
  $('#count-all') && ($('#count-all').textContent = String(total ?? 0));
  $('#count-delivered') && ($('#count-delivered').textContent = String(stats?.delivered ?? 0));
  $('#count-in_transit') && ($('#count-in_transit').textContent = String(stats?.in_transit ?? 0));
  $('#count-ready_to_ship') && ($('#count-ready_to_ship').textContent = String(stats?.ready_to_ship ?? 0));
  $('#count-other') && ($('#count-other').textContent = String(stats?.other ?? 0));
}

// ===== Carregamento de dados =====
async function fetchStats() {
  try {
    const r = await fetch('/api/orders/stats', { cache: 'no-store', credentials: 'same-origin' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    updateChipCounts(j?.stats, j?.total);
    return j;
  } catch (err) {
    console.error('Falha em /api/orders/stats', err);
    toast('Falha ao consultar estatísticas');
    return null;
  }
}
async function fetchPage(page = 1) {
  try {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(state.pageSize),
      group: state.group || 'all'
    });
    const r = await fetch(`/api/orders/page?${params.toString()}`, {
      cache: 'no-store',
      credentials: 'same-origin'
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    renderTable(j?.data || []);
    updatePagination(page, j?.pages || 1);
    return j;
  } catch (err) {
    console.error('Falha em /api/orders/page', err);
    toast('Falha ao carregar a página de pedidos');
    return null;
  }
}
async function doSyncHttp() {
  const { from, to, basis } = getSelectedRange();
  const params = new URLSearchParams({ from, to, basis, windowDays: '30' });
  progressStart('Sincronizando pedidos…', 8);
  try {
    const r = await fetch(`/api/orders/sync?${params.toString()}`, {
      method: 'POST',
      headers: { 'Accept': 'application/json' },
      credentials: 'same-origin'
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    await fetchStats();
    await fetchPage(1);
    progressFinish('Sincronização concluída');
    return j;
  } catch (err) {
    console.error('Erro no sync HTTP', err);
    toast('Falha ao sincronizar pedidos');
    progressError('Erro ao sincronizar pedidos');
    return null;
  }
}

// ===== Stream SSE =====
function startStream() {
  if (state.streaming) return;
  const syncBtn = $('#syncBtn');
  const cancelBtn = $('#cancelBtn');
  if (syncBtn) syncBtn.disabled = true;
  if (cancelBtn) cancelBtn.style.display = '';

  const { from, to, basis } = getSelectedRange();
  state.lastRange = { from, to, basis };

  const qs = new URLSearchParams({ from, to, basis, windowDays: '30' });
  progressStart('Iniciando stream de pedidos…', 5);

  try {
    state.es = new EventSource(`/api/orders/stream?${qs.toString()}`, { withCredentials: true });
  } catch (err) {
    console.error('Falha ao abrir EventSource', err);
    toast('Seu navegador bloqueou a conexão de stream');
    progressError('Falha ao iniciar stream');
    if (syncBtn) syncBtn.disabled = false;
    if (cancelBtn) cancelBtn.style.display = 'none';
    return;
  }

  state.streaming = true;

  state.es.addEventListener('open', () => {
    progressUpdate(10, 'Conexão aberta…');
  });

  state.es.addEventListener('meta', (evt) => {
    try {
      const data = JSON.parse(evt.data);
      const win = data?.window;
      if (win?.from && win?.to) {
        const msg = `Janela ${new Date(win.from).toLocaleDateString('pt-BR')} a ${new Date(win.to).toLocaleDateString('pt-BR')}`;
        progressUpdate(undefined, msg);
      }
      if (typeof data?.expectedTotal === 'number') {
        progressUpdate(undefined, `Previstos ${data.expectedTotal} pedidos…`);
      }
    } catch {}
  });

  state.es.addEventListener('item', (evt) => {
    try {
      const data = JSON.parse(evt.data);
      if (typeof data?.sent === 'number' && typeof data?.expectedTotal === 'number' && data.expectedTotal > 0) {
        const pct = Math.round((data.sent / data.expectedTotal) * 100);
        progressUpdate(pct, `Processados ${data.sent}/${data.expectedTotal}`);
      }
    } catch {}
  });

  state.es.addEventListener('done', async (evt) => {
    try {
      const data = JSON.parse(evt.data || '{}');
      if (typeof data?.expectedTotal === 'number' && typeof data?.sent === 'number' && data.expectedTotal > 0) {
        progressUpdate(100, `Recebidos ${data.sent}/${data.expectedTotal}`);
      }
    } catch {}
    progressFinish('Sincronização concluída');
    stopStream(false);
    await fetchStats();
    await fetchPage(1);
  });

  state.es.addEventListener('error', (evt) => {
    console.error('SSE erro', evt);
    toast('Conexão de stream encerrada');
    progressError('Conexão encerrada');
    stopStream(true);
  });
}

function stopStream(userCanceled = true) {
  if (state.es) {
    try { state.es.close(); } catch {}
  }
  state.es = null;
  state.streaming = false;

  const syncBtn = $('#syncBtn');
  const cancelBtn = $('#cancelBtn');
  if (syncBtn) syncBtn.disabled = false;
  if (cancelBtn) cancelBtn.style.display = 'none';

  if (userCanceled) progressCancel('Stream cancelado');
}

// ===== Renderização =====
function updatePagination(page, pages) {
  state.page = Math.max(1, Math.min(page || 1, pages || 1));
  $('#pageLabel') && ($('#pageLabel').textContent = `Página ${state.page}`);
  const prev = $('#prevBtn');
  const next = $('#nextBtn');
  if (prev) prev.disabled = state.page <= 1;
  if (next) next.disabled = state.page >= (pages || 1);
}

function renderTable(rows) {
  const tb = $('#tbody');
  if (!tb) return;
  if (!rows || rows.length === 0) {
    tb.innerHTML = `<tr><td colspan="9" class="muted">Nenhum pedido encontrado para o filtro atual.</td></tr>`;
    return;
  }
  const html = rows.map(renderRow).join('');
  tb.innerHTML = html;
}

function orderDisplayDate(o) {
  return o?.date_closed || o?.date_created || o?.date_last_updated || '';
}

function renderRow(row) {
  const o = row?.order || {};
  const ship = row?.shipping || {};
  const dateIso = orderDisplayDate(o);
  const date = fmtDateTimeBR(dateIso);

  const orderId = o?.id || '';
  const buyer = o?.buyer || {};
  const buyerName = buyer?.nickname || buyer?.first_name || buyer?.last_name
    ? `${buyer?.first_name || ''} ${buyer?.last_name || ''}`.trim() || buyer?.nickname || ''
    : (buyer?.nickname || '');

  const items = Array.isArray(o?.order_items) ? o.order_items : [];
  const itemsText = items
    .map(it => `${escapeHtml(it?.item?.title || it?.title || '')} x${Number(it?.quantity || 0)}`)
    .join('<br>');

  const totalAmount = o?.total_amount ?? o?.paid_amount ?? 0;

  let payStatus = '';
  if (Array.isArray(o?.payments) && o.payments.length) {
    const p = o.payments[0];
    payStatus = `${p?.status || ''}${p?.status_detail ? ` (${p.status_detail})` : ''}`.trim();
  }

  const shippingStatus = row?.shipping_group || (ship?.status || '');

  return `
    <tr>
      <td>${escapeHtml(date)}</td>
      <td>${escapeHtml(String(orderId))}</td>
      <td>${escapeHtml(buyerName)}</td>
      <td>${itemsText || ''}</td>
      <td>${fmtCurrency(totalAmount)}</td>
      <td>${escapeHtml(payStatus)}</td>
      <td>${escapeHtml(shippingStatus)}</td>
      <td>${escapeHtml(String(ship?.id || ''))}</td>
      <td>${escapeHtml(String(o?.pack_id || ''))}</td>
    </tr>
  `;
}

// ===== Bind de UI =====
function bindUI() {
  $$('#chips .chip').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const g = btn.getAttribute('data-group') || 'all';
      setActiveGroup(g);
      await fetchPage(1);
    });
  });

  $('#periodSelect')?.addEventListener('change', () => {
    updateCustomDateVisibility();
  });
  updateCustomDateVisibility();

  $('#syncBtn')?.addEventListener('click', startStream);
  $('#cancelBtn')?.addEventListener('click', () => stopStream(true));

  $('#prevBtn')?.addEventListener('click', async () => {
    if (state.page > 1) {
      await fetchPage(state.page - 1);
    }
  });
  $('#nextBtn')?.addEventListener('click', async () => {
    await fetchPage(state.page + 1);
  });
}

// ===== Inicialização =====
async function init() {
  bindUI();
  await fetchStats();
  await fetchPage(1);
}

document.addEventListener('DOMContentLoaded', init);
