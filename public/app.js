// app.js (Completo e Atualizado)

// Helpers fetch e UI
const $ = sel => document.querySelector(sel);
async function getJSON(url, opts = {}) { const r = await fetch(url, opts); const t = await r.text(); try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return t } }
async function getObj(url, opts = {}) { const r = await fetch(url, opts); return r.json(); }
function go(url) { window.location.href = url }
const esc = (s) => (s == null ? '' : String(s).replace(/[<>&]/g, m => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[m])));

function toast(msg, type = 'ok') {
  const root = document.getElementById('toast');
  if (!root) return;
  const el = document.createElement('div');
  el.className = type;
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => root.removeChild(el), 4400);
}

// Helpers para exibir/ocultar respeitando o atributo `hidden`
const show = el => { if (el) { el.hidden = false; el.style.removeProperty?.('display'); } };
const hide = el => { if (el) { el.hidden = true; } };

// Lógica de Autenticação e UI Dinâmica
async function loadDiag() {
  const t = await getJSON('/diag');
  const statusOut = document.getElementById('statusOut');
  if (statusOut) statusOut.textContent = t;

  // Seletores dos elementos da UI
  const authSuccessMessage = document.getElementById('auth-success-message');
  const authActionsUnauthed = document.getElementById('auth-actions-unauthed');
  const authActionsAuthed = document.getElementById('auth-actions-authed');
  const topActionsUnauthed = document.getElementById('top-actions-unauthed');
  const topActionsAuthed = document.getElementById('top-actions-authed');
  const userChip = document.getElementById('userChip');

  try {
    const o = JSON.parse(t);
    if (o && o.nickname) {
      // ESTADO: AUTENTICADO
      if (userChip) userChip.innerHTML = `<span class="dot ok"></span> ${o.nickname} (#${o.user_id})`;
      if (authSuccessMessage) {
        authSuccessMessage.className = 'auth-status-banner success';
        authSuccessMessage.innerHTML = `<span class="icon">✅</span><span>Autenticado como <strong>${o.nickname}</strong>.</span>`;
        show(authSuccessMessage);
      }

      hide(authActionsUnauthed);
      show(authActionsAuthed);

      hide(topActionsUnauthed);
      show(topActionsAuthed);
    } else {
      throw new Error('Usuário não autenticado.');
    }
  } catch (e) {
    // ESTADO: NÃO AUTENTICADO OU ERRO
    if (userChip) userChip.innerHTML = `<span class="dot warn"></span> não autenticado`;

    hide(authSuccessMessage);

    show(authActionsUnauthed);
    hide(authActionsAuthed);

    show(topActionsUnauthed);
    hide(topActionsAuthed);
  }
}

// ===== BINDINGS =====
document.addEventListener('DOMContentLoaded', () => {
  // Topbar
  $('#loginBtn')?.addEventListener('click', () => go('/login'));
  $('#refreshBtn')?.addEventListener('click', async () => { const t = await getJSON('/refresh', { method: 'POST' }); toast(t.includes('ok') ? 'Token renovado' : 'Refresh solicitado'); });

  // Atalhos Auth
  $('#loginBtn2')?.addEventListener('click', () => go('/login'));
  $('#pasteBtn2')?.addEventListener('click', () => go('/oauth/paste'));
  $('#refreshBtn2')?.addEventListener('click', async () => { const t = await getJSON('/refresh', { method: 'POST' }); toast(t.includes('ok') ? 'Token renovado' : 'Refresh solicitado'); });
  $('#statusBtn')?.addEventListener('click', loadDiag);

  // Unread
  $('#unreadBtn')?.addEventListener('click', async () => {
    const role = $('#role').value;
    const t = await getJSON('/api/messages/unread?role=' + encodeURIComponent(role));
    $('#unreadOut').textContent = t;
  });

  // Pack list
  $('#packBtn')?.addEventListener('click', async () => {
    const packId = $('#packId').value.trim();
    const mark = $('#markRead').checked;
    const limit = $('#limit').value;
    const offset = $('#offset').value;
    const t = await getJSON(`/api/messages/packs/${encodeURIComponent(packId)}?mark_as_read=${mark}&limit=${limit}&offset=${offset}`);
    $('#packOut').textContent = t;
  });

  // Enviar mensagem
  $('#sendBtn')?.addEventListener('click', async () => {
    const packId = $('#send_packId').value.trim();
    const to_user_id = $('#to_user_id').value.trim();
    const text = $('#msg_text').value;
    const attach_raw = $('#attach_ids').value.trim();
    const attachments = attach_raw ? attach_raw.split(',').map(s => s.trim()).filter(Boolean) : [];
    const t = await getJSON(`/api/messages/packs/${encodeURIComponent(packId)}/send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to_user_id, text, attachments })
    });
    $('#sendOut').textContent = t;
  });

  // Upload anexo
  $('#uploadBtn')?.addEventListener('click', async () => {
    const file = $('#file').files[0];
    if (!file) { toast('Selecione um arquivo', 'err'); return; }
    const fd = new FormData(); fd.append('file', file);
    const r = await fetch('/api/messages/attachments', { method: 'POST', body: fd });
    const t = await r.text();
    $('#attachOut').textContent = (() => { try { return JSON.stringify(JSON.parse(t), null, 2) } catch { return t } })();
    toast('Upload concluído', 'ok');
  });

  // ===== SYNC TOTAL =====
  const syncPageSizeSel = $('#sync_page_size');
  const syncStreamBtn = $('#sync_stream');
  const syncHttpBtn = $('#sync_http');
  const syncCancelBtn = $('#sync_cancel');
  const syncMeta = $('#sync_meta');
  const syncBar = $('#sync_bar');
  const pgPrev = $('#pg_prev');
  const pgNext = $('#pg_next');
  const pgInfo = $('#pg_info');

  let allItems = [];
  let page = 1;

  function pageSize() { return parseInt(syncPageSizeSel.value, 10) || 20; }
  function totalPages() { return Math.max(1, Math.ceil(allItems.length / pageSize())); }
  function setProgress(sent, total) {
    const pct = total ? Math.round((sent / total) * 100) : 0;
    if (syncBar) syncBar.style.width = pct + '%';
    if (syncMeta) syncMeta.textContent = `Sincronizando… ${sent}/${total} (${pct}%)`;
  }
  function renderSyncPage() {
    const pz = pageSize();
    const start = (page - 1) * pz;
    const slice = allItems.slice(start, start + pz);
    renderTable('sync_tbody', slice);
    if (pgInfo) pgInfo.textContent = `Página ${page}/${totalPages()}`;
    if (pgPrev) pgPrev.disabled = page <= 1;
    if (pgNext) pgNext.disabled = page >= totalPages();
  }
  function goto(p) { page = Math.max(1, Math.min(totalPages(), p)); renderSyncPage(); }

  pgPrev?.addEventListener('click', () => goto(page - 1));
  pgNext?.addEventListener('click', () => goto(page + 1));
  syncPageSizeSel?.addEventListener('change', () => { page = 1; renderSyncPage(); });

  let esSync = null;
  function closeSync() { if (esSync) { esSync.close(); esSync = null; toast('Stream cancelado', 'ok'); } }
  syncCancelBtn?.addEventListener('click', closeSync);

  syncStreamBtn?.addEventListener('click', () => {
    closeSync();
    allItems = []; renderTable('sync_tbody', []);
    setProgress(0, 0);
    if (syncMeta) syncMeta.textContent = 'Conectando…';

    const es = new EventSource('/api/items/all/stream');
    esSync = es;
    let total = 0, sent = 0;

    es.addEventListener('meta', (ev) => { const data = JSON.parse(ev.data); total = data.total_ids || 0; setProgress(0, total); });
    es.addEventListener('batch', (ev) => {
      const data = JSON.parse(ev.data);
      const items = data.items || [];
      allItems.push(...items);
      sent += data.count || 0;
      setProgress(sent, total);
      if (allItems.length <= pageSize()) renderSyncPage();
    });
    es.addEventListener('progress', (ev) => { const data = JSON.parse(ev.data); setProgress(data.sent || sent, data.total || total); });
    es.addEventListener('done', () => {
      if (syncMeta) syncMeta.textContent = `Sincronização concluída · ${allItems.length} itens.`;
      renderSyncPage();
      toast('Sync concluído', 'ok');
      closeSync();
    });
    es.addEventListener('error', () => { toast('Erro no stream (sync)', 'err'); closeSync(); });
  });

  syncHttpBtn?.addEventListener('click', async () => {
    closeSync();
    setProgress(0, 0);
    if (syncMeta) syncMeta.textContent = 'Baixando via HTTP…';
    const res = await getObj('/api/items/all');
    allItems = res.items || [];
    if (syncBar) syncBar.style.width = '100%';
    if (syncMeta) syncMeta.textContent = `Total: ${allItems.length} itens (HTTP).`;
    page = 1;
    renderSyncPage();
    toast('Sync HTTP concluído', 'ok');
  });

  // Carregar status inicial
  loadDiag();
});

// ===== Helpers de Renderização =====
function getItemStatusClass(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'active') return 'ok';
  if (s === 'paused') return 'warn';
  return 'muted';
}

function renderTable(tbodyId, items) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  tbody.innerHTML = '';

  if (!items || !items.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="muted" style="text-align:center;padding:40px;">Sem dados para exibir.</td></tr>`;
    return;
  }

  const fmtBRL = (n) => (typeof n === 'number' ? n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '');
  const rows = items.map(it => {
    const thumb = it.thumbnail ? `<img src="${esc(it.thumbnail)}" alt="">` : '';
    const title = esc(it.title);
    const price = fmtBRL(it.price);
    const avail = esc(it.available_quantity);
    const sold = esc(it.sold_quantity);
    const statusText = esc(it.status || '');
    const statusClass = getItemStatusClass(statusText);
    const status = `<span class="badge-status ${statusClass}">${statusText}</span>`;
    const updt = it.last_updated ? new Date(it.last_updated).toLocaleDateString('pt-BR') : '';
    const link = it.permalink ? `<a href="${esc(it.permalink)}" target="_blank" rel="noopener">Abrir</a>` : '';
    return `
      <tr>
        <td>${thumb}</td>
        <td>${title}</td>
        <td>${price}</td>
        <td>${avail}</td>
        <td>${sold}</td>
        <td>${status}</td>
        <td>${updt}</td>
        <td>${link}</td>
      </tr>
    `;
  }).join('');
  tbody.innerHTML = rows;
}
