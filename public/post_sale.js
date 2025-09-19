// public/post_sale.js — lista pedidos com conversas iniciadas e mensagens não lidas

// ===== Helpers fetch, DOM e formato =====
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const esc = (s) =>
  (s == null ? "" : String(s))
    .replace(/[&<>"]/g, (m) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[m]));

// toast simples
function toast(msg, type = "info") {
  const box = $("#toast");
  if (!box) return;
  box.className = `toast ${type}`;
  box.textContent = msg;
  box.classList.remove("hidden");
  setTimeout(() => box.classList.add("hidden"), 3500);
}

async function getJSON(url, opts = {}) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// formatos
function fmtDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("pt-BR", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

// Estado de página
const state = {
  onlyUnread: true,
  search: "",
  sellerId: "",
  items: [],
  syncedAt: null,
};

// ===== Integração com backend existente =====
//
// • /api/messages/unread — já existe no backend e retorna packs/conversas com tag 'post_sale'.
// • /api/orders/sync — para enriquecer com dados do pedido (opcional; usamos quando disponível).
//
// Observação: os formatos podem variar; o código abaixo trata campos de forma defensiva.

async function loadUnread() {
  // 1) sincroniza pedidos (opcional, mas ajuda a cruzar dados)
  try {
    const sync = await getJSON("/api/orders/sync");
    state.syncedAt = sync?.syncedAt || null;
  } catch (err) {
    // não bloqueia a página se falhar
    console.warn("Falha ao sincronizar pedidos:", err);
  }

  // 2) busca conversas não lidas
  const role = "seller";
  const data = await getJSON(`/api/messages/unread?role=${role}`);

  // normaliza itens
  const items = Array.isArray(data?.data || data) ? (data.data || data) : [];
  state.items = items.map((it) => normalizeUnreadItem(it));
  render();
}

function normalizeUnreadItem(it = {}) {
  // Tentativa de campos comuns devolvidos pela API do ML
  const order_id = it.order_id || it.orderId || it?.order?.id || it?.context?.resource || "";
  const buyer = it.buyer?.nickname || it.buyer_nickname || it?.customer?.nickname || "";
  const pack_id = it.pack_id || it.packId || it?.pack?.id || "";
  const unread = Number(it.unread || it.unread_count || it?.metrics?.unread || 0) || 0;
  const last_ts =
    it.last_updated || it.last_message_at || it?.messages?.at?.(-1)?.date ||
    it?.last_message?.date || it?.date || it?.updated_at || "";
  const last_text =
    it.last_text || it?.last_message?.text || it?.messages?.at?.(-1)?.text || it?.snippet || "";

  return {
    order_id: String(order_id || ""),
    buyer: String(buyer || ""),
    pack_id: String(pack_id || ""),
    unread,
    last_ts,
    last_text,
    raw: it,
  };
}

// ===== Render =====
function render() {
  const tbody = $("#tbody");
  const stats = $("#stats");
  if (!tbody) return;

  // filtros
  const needle = state.search.trim().toLowerCase();
  const onlyUnread = !!state.onlyUnread;

  let rows = state.items.filter((r) => {
    if (onlyUnread && r.unread <= 0) return false;
    if (!needle) return true;
    const hay =
      `${r.order_id} ${r.buyer} ${r.pack_id} ${r.last_text}`.toLowerCase();
    return hay.includes(needle);
  });

  // ordena por data desc e depois por qtd não lida desc
  rows.sort((a, b) => {
    const ta = new Date(a.last_ts).getTime() || 0;
    const tb = new Date(b.last_ts).getTime() || 0;
    if (tb !== ta) return tb - ta;
    return (b.unread || 0) - (a.unread || 0);
  });

  // desenha
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6">Nenhum resultado.</td></tr>`;
  } else {
    tbody.innerHTML = rows
      .map((r) => {
        return `
          <tr>
            <td>${esc(r.order_id)}</td>
            <td>${esc(r.buyer)}</td>
            <td>${esc(r.pack_id)}</td>
            <td>${r.unread > 0 ? `<strong>${r.unread}</strong>` : "0"}</td>
            <td>${esc(fmtDateTime(r.last_ts))}</td>
            <td>${esc(r.last_text || "")}</td>
          </tr>
        `;
      })
      .join("");
  }

  const total = state.items.length;
  const shown = rows.length;
  const only = onlyUnread ? " (somente não lidas)" : "";
  const synced = state.syncedAt ? ` • pedidos atualizados em ${fmtDateTime(state.syncedAt)}` : "";
  stats.textContent = `${shown}/${total} conversas visíveis${only}${synced}`;
}

// ===== Eventos UI =====
function bindUI() {
  $("#btn-refresh")?.addEventListener("click", async () => {
    try {
      toast("Atualizando…");
      await loadUnread();
      toast("Atualizado", "success");
    } catch (err) {
      console.error(err);
      toast("Falha ao atualizar", "error");
    }
  });

  $("#only-unread")?.addEventListener("change", (e) => {
    state.onlyUnread = !!e.target.checked;
    render();
  });

  $("#search")?.addEventListener("input", (e) => {
    state.search = e.target.value || "";
    render();
  });

  $("#seller-id")?.addEventListener("change", (e) => {
    state.sellerId = e.target.value.trim();
    // neste momento não filtramos por seller_id localmente; o backend usa a sessão
  });
}

// init
(async function init() {
  bindUI();
  try {
    await loadUnread();
  } catch (err) {
    console.error(err);
    toast("Não foi possível carregar as conversas", "error");
  }
})();
