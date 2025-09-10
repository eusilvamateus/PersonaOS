// public/ads.js
(function () {
  'use strict';
  const $ = s => document.querySelector(s);

  // ===== Config =====
  const PAGE_SIZE = 50; // FIXO

  // ===== Toast mínimo =====
  function ensureToastStack() {
    let n = document.querySelector('.toast-stack');
    if (!n) {
      n = document.createElement('div');
      n.className = 'toast-stack';
      Object.assign(n.style, {
        position: 'fixed', top: '16px', right: '16px', zIndex: 1000,
        display: 'grid', gap: '10px'
      });
      document.body.appendChild(n);
    }
    return n;
  }
  function toast(message, type = 'ok', ms = 3500) {
    const stack = ensureToastStack();
    const node = document.createElement('div');
    node.className = 'toast';
    Object.assign(node.style, {
      background: 'var(--panel-bg,#111827)', border: '1px solid rgba(255,255,255,.08)',
      borderRadius: '14px', padding: '10px 12px'
    });
    node.textContent = message;
    stack.appendChild(node);
    setTimeout(() => { try { node.remove(); } catch {} }, ms);
  }

  // ===== Estado =====
  const state = {
    search: { items: [], total: 0, page: 1, pageSize: PAGE_SIZE },
    es: null,
    streaming: false,
    expected: 0
  };

  // ===== Progresso (helpers) =====
  let progressHideTimer = null;
  const progressEl = () => ({
    wrap: document.getElementById('progress'),
    bar: document.getElementById('progressBar'),
    label: document.getElementById('progressLabel')
  });
  function progressResetUI() {
    const { bar, label } = progressEl();
    if (bar) bar.style.width = '0%';
    if (label) label.textContent = 'Aguardando…';
  }
  function progressHideNow() {
    const { wrap } = progressEl();
    if (wrap) wrap.hidden = true;
    progressResetUI();
    if (progressHideTimer) { clearTimeout(progressHideTimer); progressHideTimer = null; }
  }
  function progressStart(text = 'Sincronizando…', pct = 5) {
    const { wrap } = progressEl();
    if (!wrap) return;
    wrap.hidden = false;
    progressUpdate(pct, text);
  }
  function progressUpdate(pct = 10, text) {
    const { bar, label } = progressEl();
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, Number(pct) || 0))}%`;
    if (typeof text === 'string' && label) label.textContent = text;
  }
  function progressFinish(text = 'Concluído', hideAfterMs = 800) {
    progressUpdate(100, text);
    if (progressHideTimer) clearTimeout(progressHideTimer);
    progressHideTimer = setTimeout(progressHideNow, hideAfterMs);
  }
  function progressError(text = 'Erro', hideAfterMs = 1400) {
    progressUpdate(100, text);
    if (progressHideTimer) clearTimeout(progressHideTimer);
    progressHideTimer = setTimeout(progressHideNow, hideAfterMs);
  }
  function progressCancel(text = 'Stream cancelado', hideAfterMs = 900) {
    progressUpdate(100, text);
    if (progressHideTimer) clearTimeout(progressHideTimer);
    progressHideTimer = setTimeout(progressHideNow, hideAfterMs);
  }

  // ===== Utils =====
  const fmtBRL = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const fmtInt = v => Number(v || 0).toLocaleString('pt-BR');
  const fmtDate = iso => iso ? new Date(iso).toLocaleString('pt-BR', { hour12:false }) : '';
  const escapeHtml = s => String(s || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

  // ===== Render (tabela) =====
  function renderRow(it) {
    const title = it.title || it.id;
    const price = it.sale_price?.price != null ? fmtBRL(it.sale_price.price) : fmtBRL(it.price);
    const disp  = fmtInt(it.available_quantity);
    const sold  = fmtInt(it.sold_quantity);
    const status = it.status || '';
    const updated = fmtDate(it.last_updated);
    const link = it.permalink ? `<a class="btn" href="${it.permalink}" target="_blank" rel="noopener">Abrir</a>` : '';

    return `<tr>
      <td>
        <button class="link open-desc" data-id="${it.id}" title="Ver/editar descrição">${escapeHtml(title)}</button>
        <div class="muted" style="font-size:.8rem">${it.id}</div>
      </td>
      <td>${price || ''}</td>
      <td>${disp || ''}</td>
      <td>${sold || ''}</td>
      <td>${escapeHtml(status)}</td>
      <td>${updated || ''}</td>
      <td>${link}</td>
    </tr>`;
  }

  function renderTableFromSearch() {
    const { items, total, page, pageSize } = state.search;
    $('#adsTotal').textContent = total;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    $('#adsPageInfo').textContent = `Página ${page}/${pages}`;
    $('#adsPrevBtn').disabled = page <= 1;
    $('#adsNextBtn').disabled = page >= pages;
    $('#adsTbody').innerHTML = items.length
      ? items.map(renderRow).join('')
      : `<tr><td colspan="7" class="muted">Nenhum dado para exibir.</td></tr>`;
  }

  // ===== Busca =====
  async function doSearch(page = 1) {
    state.search.page = page;
    const { pageSize } = state.search;
    const offset = (page - 1) * pageSize;

    const q = $('#adsQ').value.trim();
    const status = $('#adsStatus').value;
    const category_id = $('#adsCategory').value.trim();
    const free_shipping = $('#adsFreeShipping').checked ? 'true' : 'false';
    const sort = $('#adsSort').value;

    progressStart('Buscando anúncios…', 15);

    const params = new URLSearchParams({
      limit: String(pageSize),          // FIXO 50
      offset: String(offset),
      include: 'details,sale_price',
      sort
    });
    if (q) params.set('q', q);
    if (status) params.set('status', status);
    if (category_id) params.set('category_id', category_id);
    if (free_shipping === 'true') params.set('free_shipping', 'true');

    try {
      const r = await fetch(`/api/ads/search?${params.toString()}`);
      if (!r.ok) throw new Error('Falha na busca');
      const data = await r.json();
      state.search.items = Array.isArray(data.items) ? data.items : [];
      state.search.total = Number(data?.paging?.total || state.search.items.length);
      renderTableFromSearch();
      progressFinish(`Encontrados ${state.search.total}`);
    } catch (e) {
      console.error(e);
      $('#adsTbody').innerHTML = `<tr><td colspan="7" class="muted">Erro ao buscar anúncios.</td></tr>`;
      progressError('Erro na busca');
    }
  }

  // ===== Painel "Descrição" =====
  function openDescPanel(id) {
    $('#descPanel').hidden = false;
    $('#descItemId').textContent = id;
    $('#descText').value = '';
    $('#descMeta').textContent = 'Carregando descrição…';
    $('#descError').textContent = '';
    updateDescCounter();
    loadDescription(id).then(updateDescCounter);
  }
  function closeDescPanel() {
    $('#descPanel').hidden = true;
    $('#descItemId').textContent = '';
    $('#descText').value = '';
    $('#descMeta').textContent = '';
    $('#descError').textContent = '';
  }
  async function loadDescription(id) {
    try {
      const r = await fetch(`/api/items/${encodeURIComponent(id)}/description`);
      const data = await r.json();
      if (data?.ok) {
        $('#descText').value = data.plain_text || '';
        $('#descMeta').textContent = data.last_updated
          ? `Última atualização: ${new Date(data.last_updated).toLocaleString('pt-BR', { hour12:false })}`
          : '';
      } else {
        $('#descMeta').textContent = 'Não foi possível obter a descrição.';
      }
    } catch {
      $('#descMeta').textContent = 'Erro ao obter a descrição.';
    }
  }
  function updateDescCounter() {
    const len = $('#descText').value.length;
    $('#descCount').textContent = `${len} caracteres`;
  }
  async function saveDescription() {
    const id = $('#descItemId').textContent.trim();
    const plain_text = $('#descText').value;
    $('#descError').textContent = '';
    try {
      const r = await fetch(`/api/items/${encodeURIComponent(id)}/description`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plain_text })
      });
      const data = await r.json();
      if (!r.ok || !data?.ok) throw data?.error || { message: 'Falha ao salvar' };
      toast('Descrição salva com sucesso.');
      closeDescPanel();
    } catch (e) {
      const position = e?.position ?? (() => {
        const msg = typeof e?.message === 'string' ? e.message : JSON.stringify(e || {});
        const m = /plain_text\[(\d+)\]/.exec(msg);
        return m ? Number(m[1]) : null;
      })();
      if (position != null) {
        const ta = $('#descText');
        const pos = Math.max(0, Math.min(position, ta.value.length - 1));
        ta.focus();
        try { ta.setSelectionRange(pos, Math.min(pos + 1, ta.value.length)); } catch {}
        $('#descError').textContent = `Erro de validação próximo da posição ${position}. Revise o caracter/trecho destacado.`;
      } else {
        $('#descError').textContent = 'Erro ao salvar descrição. Verifique o conteúdo.';
      }
      toast('Erro ao salvar descrição.', 'warn', 4500);
    }
  }

  // ===== Stream =====
  function startStream() {
    if (state.streaming) return;
    state.streaming = true;
    state.search.items = [];
    state.search.total = 0;
    state.search.page = 1;
    renderTableFromSearch();

    $('#adsStreamBtn').disabled = true;
    $('#adsHttpBtn').disabled = true;
    $('#adsCancelBtn').style.display = 'inline-block';

    progressStart('Preparando…', 5);

    const es = new EventSource('/api/items/all/stream');
    state.es = es;

    es.addEventListener('meta', e => {
      const meta = JSON.parse(e.data || '{}');
      state.expected = Number(meta.total_ids || 0);
      progressUpdate(8, state.expected ? `Ids coletados: ${state.expected}` : 'Coletando IDs…');
    });

    es.addEventListener('batch', e => {
      const payload = JSON.parse(e.data || '{}');
      const items = Array.isArray(payload.items) ? payload.items : [];
      state.search.items.push(...items);
      state.search.total = state.search.items.length;
      renderTableFromSearch();

      if (state.expected > 0) {
        const pct = (state.search.total / state.expected) * 100;
        progressUpdate(pct, `Recebidos ${state.search.total}/${state.expected}`);
      } else {
        const approx = 10 + Math.min(70, state.search.total / 2);
        progressUpdate(approx, `Recebidos ${state.search.total}…`);
      }
    });

    es.addEventListener('done', () => {
      stopStreamUI();
      progressFinish('Concluído');
    });
  }
  function cancelStream() {
    if (!state.streaming) return;
    try { state.es?.close(); } catch {}
    stopStreamUI();
    progressCancel('Stream cancelado');
  }
  function stopStreamUI() {
    try { state.es?.close(); } catch {}
    state.es = null;
    state.streaming = false;
    $('#adsStreamBtn').disabled = false;
    $('#adsHttpBtn').disabled = false;
    $('#adsCancelBtn').style.display = 'none';
  }

  // ===== HTTP fallback =====
  async function syncHttp() {
    if (state.streaming) return;
    $('#adsStreamBtn').disabled = true;
    $('#adsHttpBtn').disabled = true;
    progressStart('Consultando…', 10);

    try {
      const r = await fetch('/api/items/all');
      if (!r.ok) throw new Error('Falha na API');
      const data = await r.json();
      state.search.items = Array.isArray(data.items) ? data.items : [];
      state.search.total = state.search.items.length;
      state.search.page = 1;
      renderTableFromSearch();
      progressFinish('Concluído');
    } catch (e) {
      console.error(e);
      $('#adsTbody').innerHTML = `<tr><td colspan="7" class="muted">Erro ao sincronizar.</td></tr>`;
      progressError('Erro');
    } finally {
      $('#adsStreamBtn').disabled = false;
      $('#adsHttpBtn').disabled = false;
    }
  }

  // ===== Eventos =====
  function wire() {
    $('#adsPrevBtn').addEventListener('click', () => doSearch(Math.max(1, state.search.page - 1)));
    $('#adsNextBtn').addEventListener('click', () => {
      const pages = Math.max(1, Math.ceil(state.search.total / state.search.pageSize));
      doSearch(Math.min(pages, state.search.page + 1));
    });

    $('#adsSearchBtn').addEventListener('click', () => doSearch(1));
    $('#adsQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(1); });
    $('#adsSort').addEventListener('change', () => doSearch(1));
    $('#adsFreeShipping').addEventListener('change', () => doSearch(1));
    $('#adsCategory').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(1); });

    $('#adsTbody').addEventListener('click', (e) => {
      const btn = e.target.closest('.open-desc');
      if (btn) openDescPanel(btn.dataset.id);
    });
    $('#descSaveBtn').addEventListener('click', saveDescription);
    $('#descCloseBtn').addEventListener('click', closeDescPanel);
    $('#descText').addEventListener('input', updateDescCounter);

    $('#adsStreamBtn').addEventListener('click', startStream);
    $('#adsCancelBtn').addEventListener('click', cancelStream);
    $('#adsHttpBtn').addEventListener('click', syncHttp);

    renderTableFromSearch();
    progressHideNow();
  }

  document.addEventListener('DOMContentLoaded', wire);
})();
