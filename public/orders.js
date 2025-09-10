// public/orders.js — versão com auto-sync ao abrir/refresh e SSE por grupo

// ===== Utils DOM e formatação =====
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const esc = (s) =>
  s == null
    ? ""
    : String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

function fmtCurrency(n) {
  if (n == null || Number.isNaN(Number(n))) return "";
  return Number(n).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function fmtDateTime(s) {
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return esc(String(s));
  return d.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ===== Estado da página =====
let state = {
  page: 1,
  pageSize: 50,
  group: "today", // today | upcoming | in_transit | delivered | ready_to_ship | all
  form: "all",    // all | full | flex | drop_off | xd_drop_off | cross_docking | turbo
  es: null,
  streaming: false,
  lastRange: "7d",
};

// ===== Progresso =====
function showProgress() { $("#progress")?.removeAttribute("hidden"); }
function hideProgressSoon() { setTimeout(() => $("#progress")?.setAttribute("hidden", "true"), 400); }
function setProgress(pct, label) {
  const wrap = $("#progress"), bar = $("#progressBar"), lbl = $("#progressLabel");
  if (!wrap || !bar || !lbl) return;
  wrap.hidden = false;
  const v = Math.max(0, Math.min(100, Number(pct) || 0));
  bar.style.width = `${v}%`;
  bar.setAttribute("aria-valuenow", String(Math.round(v)));
  if (typeof label === "string") { bar.setAttribute("aria-valuetext", label); lbl.textContent = label; }
}

// ===== Auto Sync (ao abrir/refresh) =====
const AUTO_SYNC = true;
const STALE_MS = 30 * 60 * 1000; // 30 min

async function getStats() {
  const r = await fetch('/api/orders/stats', { cache: 'no-store' });
  if (!r.ok) throw new Error('stats');
  return r.json();
}
async function maybeAutoSync(reason = 'load') {
  if (!AUTO_SYNC || state.streaming) return;
  try {
    const s = await getStats();
    const syncedAtMs = s?.syncedAt ? new Date(s.syncedAt).getTime() : 0;
    const stale = !syncedAtMs || (Date.now() - syncedAtMs) > STALE_MS;
    // se não tem nada ou está "stale", sincroniza automaticamente
    if ((s?.total || 0) === 0 || stale) startStream();
  } catch { /* silencioso */ }
}

// ===== Sincronização via SSE =====
function cancelStream() {
  if (state.es) { try { state.es.close(); } catch {} state.es = null; }
  state.streaming = false;
  $("#syncBtn")?.removeAttribute("disabled");
  const cancel = $("#cancelBtn");
  if (cancel) cancel.style.display = "none";
  hideProgressSoon();
}

async function startStream() {
  if (state.streaming) return;
  state.streaming = true;
  $("#syncBtn")?.setAttribute("disabled", "true");
  const cancel = $("#cancelBtn");
  if (cancel) cancel.style.display = "inline-block";
  showProgress();
  setProgress(1, "Conectando…");

  // Passa o agrupamento atual para o backend decidir janela/basis
  const params = new URLSearchParams({ group: state.group });
  // “Finalizadas” → base por fechamento e clamp implícito de 3 meses no backend
  if (state.group === 'delivered') params.set('basis', 'closed');

  const es = new EventSource("/api/orders/stream?" + params.toString());
  state.es = es;

  let total = 0;
  let sent = 0;

  es.addEventListener("meta", (ev) => {
    try {
      const d = JSON.parse(ev.data || "{}");
      // backend envia expectedTotal incremental por janela; usa o maior conhecido
      const t = Number(d.expectedTotal || d.total || d.total_ids || 0) || 0;
      if (t > total) total = t;
      setProgress(1, `Preparando… 0/${total || '∞'}`);
    } catch {}
  });

  // backend envia linhas incrementais por 'row'
  es.addEventListener("row", () => {
    sent++;
    const pct = total ? Math.round((sent / total) * 100) : 0;
    setProgress(pct, `Sincronizando… ${sent}/${total || '∞'}`);
  });

  es.addEventListener("progress", (ev) => {
    try {
      const d = JSON.parse(ev.data || "{}");
      const s = Number(d.sent || sent);
      const t = Number(d.expectedTotal || d.total || total);
      const pct = t ? Math.round((s / t) * 100) : 0;
      setProgress(pct, `Sincronizando… ${s}/${t || '∞'}`);
    } catch {}
  });

  es.addEventListener("done", async () => {
    setProgress(100, "Concluído");
    cancelStream();
    await refreshStats();
    await loadPage();
  });

  es.addEventListener("error", () => {
    cancelStream();
    setProgress(0, "Erro no stream");
    hideProgressSoon();
  });
}

// ===== Stats e listagem =====
async function refreshStats() {
  try {
    const r = await fetch("/api/orders/stats");
    const s = await r.json();

    // chips topo
    $("#count-today").textContent = s?.chips?.today ?? 0;
    $("#count-upcoming").textContent = s?.chips?.upcoming ?? 0;
    $("#count-in_transit").textContent = s?.chips?.in_transit ?? s?.stats?.in_transit ?? 0;
    $("#count-delivered").textContent = s?.chips?.delivered ?? s?.stats?.delivered ?? 0;

    // formas
    $("#count-flex").textContent = s?.forms?.flex ?? 0;
    $("#count-full").textContent = s?.forms?.full ?? 0;
    $("#count-drop_off").textContent = s?.forms?.drop_off ?? 0;
    $("#count-xd_drop_off").textContent = s?.forms?.xd_drop_off ?? 0;
    $("#count-cross_docking").textContent = s?.forms?.cross_docking ?? 0;
    $("#count-turbo").textContent = s?.forms?.turbo ?? 0;

    if (s?.syncedAt) updateSyncedAt(s.syncedAt);
  } catch { /* silencioso */ }
}

async function loadPage() {
  const params = new URLSearchParams({
    page: String(state.page),
    pageSize: String(state.pageSize),
    group: state.group,
    form: state.form,
  });
  const r = await fetch("/api/orders/page?" + params.toString());
  const p = await r.json();

  $("#pageInfo").textContent = `Página ${p.page} de ${p.pages}`;
  $("#prevBtn").disabled = p.page <= 1;
  $("#nextBtn").disabled = p.page >= p.pages;

  const tbody = $("#tbody");
  tbody.innerHTML = "";
  (p.data || []).forEach(appendRow);
  if (!p.data || !p.data.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="muted" style="text-align:center;padding:48px;">Sem pedidos para exibir.</td></tr>`;
  }
}

// ===== Renderização de linhas =====
function getShippingStatusRaw(row) {
  return (
    row?.shipping?.status ||
    row?.order?.shipping_status ||
    row?.shipping_group ||
    ""
  );
}
function shippingStatusLabel(s) {
  const v = String(s || "").toLowerCase();
  switch (v) {
    case "ready_to_ship": return "Pronto p/ envio";
    case "to_be_agreed": return "A combinar";
    case "pending": return "Pendente";
    case "handling": return "Manuseando";
    case "shipped": return "Enviado";
    case "in_transit": return "Em trânsito";
    case "out_for_delivery": return "Saiu p/ entrega";
    case "soon_deliver": return "Entrega em breve";
    case "delivered": return "Entregue";
    case "not_delivered": return "Não entregue";
    default: return v || "—";
  }
}
function shippingStatusClass(s) {
  const v = String(s || "").toLowerCase();
  if (v === "delivered") return "ok";
  if (v === "ready_to_ship") return "warn";
  if (["in_transit", "shipped", "out_for_delivery"].includes(v)) return "ship";
  return "muted";
}
function badgeShipping(raw) {
  const label = shippingStatusLabel(raw);
  const cls = shippingStatusClass(raw);
  return `<span class="badge-status shipping ${cls}">${esc(label)}</span>`;
}

function appendRow(row) {
  const o = row?.order || {};
  const buyer = (o?.buyer && (o.buyer.nickname || o.buyer.first_name)) || "";
  const total = o.total_amount != null ? o.total_amount : o.paid_amount;
  const date = o.date_closed || o.date_created;
  const items = Array.isArray(o.order_items)
    ? o.order_items.map((it) => esc(it?.item?.title || "")).join("<br>")
    : "";

  const shipRaw = getShippingStatusRaw(row);
  const shipBadge = badgeShipping(shipRaw);
  const shippingId = row?.shipping?.id || "";
  const packId = o?.pack_id || "";

  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td><strong>${esc(o.id || "")}</strong></td>
    <td>${fmtDateTime(date)}</td>
    <td>${esc(buyer)}</td>
    <td>${items}</td>
    <td>${fmtCurrency(total)}</td>
    <td>${esc(shippingStatusLabel(shipRaw))}</td>
    <td>${shipBadge}${row?.turbo ? ' <span class="badge-status ok">Turbo</span>' : ''}</td>
    <td>${esc(shippingId)}</td>
    <td>${esc(packId)}</td>
  `;
  $("#tbody").appendChild(tr);
}

// ===== UI e listeners =====
function updateSyncedAt(syncedAtISO) {
  const el = $("#syncedAt");
  if (!el) return;
  const d = new Date(syncedAtISO);
  if (Number.isNaN(d.getTime())) { el.textContent = "Sincronização concluída"; return; }
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  el.textContent = `Sincronizado em ${dd}/${mo} ${hh}:${mm}`;
}

function initUI() {
  // page size
  const pageSizeSel = $("#pageSize");
  if (pageSizeSel) {
    pageSizeSel.value = String(state.pageSize);
    pageSizeSel.addEventListener("change", () => {
      state.pageSize = Number(pageSizeSel.value || 50);
      state.page = 1;
      if (!state.streaming) loadPage();
    });
  }

  // chips topo
  $$("#chips .chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$("#chips .chip").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.group = btn.dataset.group;
      state.page = 1;
      if (!state.streaming) loadPage();
    });
  });

  // chips formas
  $$("#forms .chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$("#forms .chip").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.form = btn.dataset.form;
      state.page = 1;
      if (!state.streaming) loadPage();
    });
  });

  // paginação
  $("#prevBtn")?.addEventListener("click", () => {
    if (state.page > 1) { state.page--; loadPage(); }
  });
  $("#nextBtn")?.addEventListener("click", () => { state.page++; loadPage(); });

  // sync
  $("#syncBtn")?.addEventListener("click", startStream);
  $("#cancelBtn")?.addEventListener("click", cancelStream);

  // carga inicial
  refreshStats();
  loadPage();
  maybeAutoSync('init'); // dispara auto-sync se necessário
}

// auto init
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initUI);
} else {
  initUI();
}
