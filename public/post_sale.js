'use strict';

/**
 * Pós-venda (UI unificada)
 * Mantém: sincronização de pedidos, pendentes, abertura de conversa, Action Guide,
 * envio de mensagem e anexos por ícone (upload automático + chips).
 * Remove: painel antigo de anexos e seus handlers.
 */

const $  = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

function toast(msg) {
  let root = document.getElementById('toast');
  if (!root) { root = document.createElement('div'); root.id = 'toast'; document.body.appendChild(root); }
  const el = document.createElement('div');
  el.className = 'ok';
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => root.removeChild(el), 2800);
}

async function j(url, init){ const r=await fetch(url,init); const t=await r.text(); try{return JSON.parse(t);}catch{return t;} }
const fmtBRL = (n, c='BRL') => n==null? '—' : new Intl.NumberFormat('pt-BR',{style:'currency',currency:c}).format(Number(n));

/* ===== Autenticação visual (topbar) ===== */
async function diag() {
  try {
    const st = await j('/diag');
    const isAuthed = !!st?.user_id;
    $('#top-actions-unauthed') && ($('#top-actions-unauthed').hidden = isAuthed);
    $('#top-actions-authed')   && ($('#top-actions-authed').hidden   = !isAuthed);
  } catch {
    $('#top-actions-unauthed') && ($('#top-actions-unauthed').hidden = false);
    $('#top-actions-authed')   && ($('#top-actions-authed').hidden   = true);
  }
}

/* ===== Estado ===== */
const state = {
  packs: new Map(),       // packId => { unreadCount, conversation_status, order, lastUpdated }
  selected: null,         // pack atual
  sellerId: null,
  cacheDetails: new Map(),// packId => detalhes do pedido/itens
  attachments: []         // [{id, name}]
};

/* ===== Utils ===== */
function escapeHtml(s){return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;')}
function escapeAttr(s){return escapeHtml(s).replaceAll('"','&quot;')}
function autoresizeTextArea(el){
  if(!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(160, Math.max(56, el.scrollHeight)) + 'px';
}
function scrollThreadToBottom(){
  const t = $('#thread');
  if (t) t.scrollTop = t.scrollHeight;
}

/* ===== Pedidos + Mensagens ===== */
async function syncOrders() {
  const res = await j('/api/orders/sync?windowDays=30&basis=created');
  if (!res || !res.ok) { toast('Falha ao sincronizar pedidos'); return; }

  const byPack = new Map();
  for (const row of (res.items || res.data || [])) {
    const o = row?.order || row;
    const packId = o?.pack_id; if (!packId) continue;
    byPack.set(String(packId), {
      pack_id: String(packId),
      order_id: o?.id,
      title: o?.order_items?.[0]?.item?.title || '—',
      price: o?.order_items?.[0]?.unit_price || 0,
      buyer: o?.buyer?.nickname || '',
      date: o?.date_closed || o?.date_created,
      shipping_group: row?.shipping_group || 'other'
    });
  }
  for (const [pid, summary] of byPack.entries()) {
    const cur = state.packs.get(pid) || {};
    state.packs.set(pid, { ...cur, order: summary });
  }
}

async function loadUnread() {
  const res = await j('/api/messages/unread?role=seller');
  const arr = Array.isArray(res?.results) ? res.results : [];
  for (const r of arr) {
    const m = /\/packs\/(\d+)\/sellers\/(\d+)/.exec(r.resource || '');
    if (!m) continue;
    const packId = m[1], sellerId = m[2];
    state.sellerId = state.sellerId || sellerId;
    const cur = state.packs.get(packId) || {};
    state.packs.set(packId, { ...cur, unreadCount: Number(r.count || 0) });
  }
}

/* ===== Lista ===== */
function summarize(){
  let total=state.packs.size, unread=0, active=0, blocked=0;
  for (const v of state.packs.values()) {
    unread += v.unreadCount ? 1 : 0;
    const st=v.conversation_status?.status;
    if(st==='active') active++; else if(st==='blocked') blocked++;
  }
  $('#summary') && ($('#summary').textContent=`Packs: ${total} • Pendentes: ${unread} • Ativas: ${active} • Bloqueadas: ${blocked}`);
}

function renderList() {
  const q = ($('#q')?.value || '').toLowerCase();
  const flt = $('#fltStatus')?.value || 'all';
  const root = $('#packs'); if (!root) return;

  const items = [];
  for (const [packId, info] of state.packs.entries()) {
    const ord=info.order||{}; const title=(ord.title||'').toLowerCase();
    const okQ = !q || packId.includes(q) || String(ord.order_id||'').includes(q) || title.includes(q);
    let okF = true;
    if (flt==='unread')  okF=(info.unreadCount||0)>0;
    if (flt==='active')  okF=info.conversation_status?.status==='active';
    if (flt==='blocked') okF=info.conversation_status?.status==='blocked';
    if (!okQ || !okF) continue;

    const st=info.conversation_status?.status;
    const badge = st==='blocked' ? `<span class="badge err">blocked</span>` :
                  st==='active'  ? `<span class="badge ok">active</span>`  :
                                   `<span class="badge">—</span>`;
    const u = info.unreadCount ? `<span class="badge warn">🔔 ${info.unreadCount}</span>` : '';
    items.push(`
      <div class="pack-card ${state.selected===packId?'active':''}" data-pack="${packId}">
        <div class="row">
          <strong>#${packId}</strong>${badge}${u}
          <span class="tiny muted2" style="margin-left:auto">${ord.date?new Date(ord.date).toLocaleDateString():''}</span>
        </div>
        <div class="tiny">${ord.title||'—'}</div>
        <div class="tiny muted2">pedido: ${ord.order_id||'—'} • frete: ${ord.shipping_group||'—'}</div>
      </div>`);
  }

  root.innerHTML = items.length ? items.join('') : `<div class="muted">Sem resultados.</div>`;
  $$('#packs .pack-card').forEach(el => el.addEventListener('click',()=>openPack(el.getAttribute('data-pack'))));
  summarize();
}

/* ===== Abrir conversa ===== */
async function openPack(packId){
  state.selected = packId;
  $('#convHead') && ($('#convHead').textContent = `Pack #${packId}`);
  $('#convState') && ($('#convState').textContent = '');
  $('#thread') && ($('#thread').innerHTML = `<div class="muted">Carregando conversa…</div>`);
  $('#details') && ($('#details').innerHTML = `<div class="muted">Carregando itens…</div>`);

  const mark = $('#markAsRead')?.checked;
  const data = await j(`/api/messages/packs/${encodeURIComponent(packId)}?mark_as_read=${!!mark}&limit=40&offset=0`);

  const cst = data?.conversation_status || {};
  $('#convState') && ($('#convState').textContent = cst?.status==='blocked' ? `blocked: ${cst?.substatus||'-'}` : (cst?.status||'—'));
  showBlockedHint(cst);

  const me = Number(state.sellerId || 0);
  const arr = Array.isArray(data?.messages) ? data.messages : [];
  const html = arr.map(m=>{
    const mine = Number(m?.from?.user_id)===me;
    const when = m?.message_date?.available || m?.message_date?.created || m?.message_date?.received || m?.date || '';
    const text = (typeof m?.text==='string')?m.text:(m?.text?.plain||m?.text?.text||'');
    return `<div class="bubble ${mine?'me':'them'}">
      <div class="meta tiny muted2">${new Date(when).toLocaleString()}</div>
      <div>${text?escapeHtml(text):'<span class="muted">[sem texto]</span>'}</div>
    </div>`;
  }).join('');
  $('#thread') && ($('#thread').innerHTML = html || `<div class="muted">Sem mensagens.</div>`);
  scrollThreadToBottom();

  await loadActionGuide(packId);

  try { const det = await getPackDetails(packId); renderDetails(det); }
  catch { const d=$('#details'); d && (d.innerHTML = '<div class="muted">Falha ao carregar detalhes do pack.</div>'); }

  const p = state.packs.get(packId) || {};
  if (mark && p.unreadCount){ p.unreadCount=0; state.packs.set(packId,p); renderList(); }
}

function showBlockedHint(cst){
  const box=$('#blockedHint'); if(!box) return;
  if(!cst || cst.status!=='blocked'){ box.hidden=true; box.textContent=''; return; }
  const sub=String(cst.substatus||'');
  const explain={
    blocked_by_payment:'Pagamento ainda não confirmado/impactado.',
    blocked_by_buyer:'Comprador bloqueou a recepção de mensagens.',
    blocked_by_time:'Janela de mensagens fechada (após ~30 dias).',
    blocked_by_fulfillment:'Envio Full ainda não entregue — aguarde a entrega.',
    blocked_by_cancelled_order:'Venda cancelada — mensageria indisponível.'
  };
  box.textContent=`Conversa bloqueada (${sub||'motivo não informado'}). ${explain[sub]||''}`;
  box.hidden=false;
}

/* ===== Detalhes do Pedido/Itens ===== */
async function getPackDetails(packId){
  if (state.cacheDetails.has(packId)) return state.cacheDetails.get(packId);
  const det = await j(`/api/packs/${encodeURIComponent(packId)}/orders`);
  state.cacheDetails.set(packId, det);
  return det;
}

function renderDetails(det){
  const box=$('#details'); if(!box) return;
  if(!det || !Array.isArray(det.orders) || !det.orders.length){ box.innerHTML='<div class="muted">Sem dados do pack.</div>'; return; }

  const cards=[];
  for(const od of det.orders){
    for(const it of (od.items||[])){
      const img=it.thumbnail||'';
      const sku=it.seller_sku||it.seller_custom_field||'—';
      const price=it.sale_price?.amount ?? it.unit_price;
      const currency=it.currency_id||'BRL';
      cards.push(`
        <div class="prod-card" style="display:flex;gap:12px;border:1px solid var(--border);background:var(--surface-1);border-radius:12px;padding:10px;margin-bottom:10px">
          <img alt="Foto do item" src="${escapeAttr(img)}" onerror="this.style.visibility='hidden'" style="width:56px;height:56px;object-fit:cover;border-radius:10px;border:1px solid var(--border)" />
          <div class="grow">
            <div style="font-weight:600">${escapeHtml(it.title||'—')}</div>
            <div class="tiny muted2">Item ${escapeHtml(it.id||'')}</div>
            <div class="tiny muted2">SKU: ${escapeHtml(sku)}</div>
            <div class="tiny">${fmtBRL(price, currency)} • Qtd: ${it.quantity ?? 1}</div>
          </div>
        </div>`);
    }
  }
  box.innerHTML = `${cards.join('')}
    <div class="kv" style="display:grid;grid-template-columns:auto 1fr;gap:4px 10px;font-size:14px;margin-top:4px">
      <div class="k" style="color:var(--muted)">Pack</div><div>${det.pack_id || '—'}</div>
      <div class="k" style="color:var(--muted)">Status</div><div>${det.status || '—'}</div>
      <div class="k" style="color:var(--muted)">Pedidos</div><div>${det.orders.map(o=>o.id).join(', ')}</div>
    </div>`;
}

/* ===== Action Guide ===== */
async function loadActionGuide(packId){
  const sel=$('#guideOption'), charInfo=$('#charLimit'), capsInfo=$('#capAvail');
  if(sel) sel.innerHTML=`<option value="">– Selecionar motivo (Action Guide) –</option>`;
  charInfo && (charInfo.textContent=''); capsInfo && (capsInfo.textContent='–');

  const guide=await j(`/api/messages/action_guide/${encodeURIComponent(packId)}`);
  if(guide?.error && guide?.cause==='blocked_by_excepted_case'){
    sel && (sel.innerHTML += `<option value="__OTHER__">Texto livre (OTHER)</option>`);
  } else if(guide?.options?.length){
    for(const op of guide.options){
      const val=op.option_id, label=op.title||op.option_id, char=Number(op.char_limit||0);
      sel && (sel.innerHTML += `<option value="${escapeAttr(val)}" data-template="${escapeAttr(op.template_id||'')}" data-char="${char}">${escapeHtml(label)}</option>`);
    }
  }
  const caps=await j(`/api/messages/action_guide/${encodeURIComponent(packId)}/caps_available`);
  const cap=typeof caps?.cap_available==='number'?caps.cap_available:(caps?.cap_available?.cap_available ?? caps?.cap_available);
  capsInfo && (capsInfo.textContent=(cap ?? '–'));
}

$('#guideOption')?.addEventListener('change',(e)=>{
  const opt=e.target.selectedOptions?.[0]; const char=Number(opt?.dataset?.char||0);
  const el=$('#charLimit'); el && (el.textContent=char?`Limite de caracteres para esta opção: ${char}`:'');
});

/* ===== Composer: mensagem (contador + auto-resize) ===== */
function updateCharCount(){
  const t=$('#msgText'), cnt=$('#charCount'); if(!t||!cnt) return;
  cnt.textContent = `${t.value.length}/350`;
  autoresizeTextArea(t);
}
$('#msgText')?.addEventListener('input', updateCharCount);
$('#msgText')?.addEventListener('focus', updateCharCount);

/* ===== Anexos por ícone (upload automático) ===== */
$('#attachBtn')?.addEventListener('click', ()=> $('#attachInput')?.click());
$('#attachInput')?.addEventListener('change', async (e)=>{
  const files = Array.from(e.target.files || []); if(!files.length) return;
  for(const f of files){
    try{
      const fd=new FormData(); fd.append('file', f);
      const r = await fetch('/api/messages/attachments',{ method:'POST', body:fd });
      const out = await r.json().catch(()=>null);
      const id = out?.id || out?.attachment_id || out; // tolerante a formatos
      if(!id) throw new Error('upload_failed');
      state.attachments.push({ id, name:f.name });
      addChip({ id, name:f.name });
    }catch{ toast(`Falha ao anexar: ${f.name}`); }
  }
  e.target.value = ''; // permite re-selecionar o mesmo arquivo depois
});

function addChip({id, name}){
  const wrap=$('#chips'); if(!wrap) return;
  const el=document.createElement('span');
  el.className='chip';
  el.innerHTML = `${escapeHtml(name)} <button title="remover" aria-label="remover">&times;</button>`;
  el.querySelector('button').addEventListener('click', ()=>{
    const i=state.attachments.findIndex(a=>a.id===id); if(i>=0) state.attachments.splice(i,1);
    wrap.removeChild(el);
  });
  wrap.appendChild(el);
}

/* ===== Envio ===== */
$('#sendBtn')?.addEventListener('click', async ()=>{
  const packId=state.selected; if(!packId){ toast('Selecione uma conversa'); return; }
  const text = ($('#msgText')?.value || '').trim();

  const optEl=$('#guideOption');
  const optionId = optEl?.value || '';
  const templateId = optEl?.selectedOptions?.[0]?.dataset?.template || '';

  try{
    let resp;
    if(optionId && templateId){
      // Action Guide com template: geralmente não aceita anexos
      if(state.attachments.length){
        toast('Aviso: este motivo não suporta anexos; enviando sem anexos.');
      }
      const body={ option_id:optionId, template_id:templateId };
      if(text) body.text = text;
      resp = await j(`/api/messages/action_guide/${encodeURIComponent(packId)}/option`,{
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
      });
    }else{
      // Texto livre (sem motivo) OU motivo sem template => suporta attachments
      const conv = await j(`/api/messages/packs/${encodeURIComponent(packId)}?mark_as_read=false&limit=1&offset=0`);
      const me=Number(state.sellerId||0); let to=null;
      for(const m of (conv?.messages||[])){
        const from=Number(m?.from?.user_id); const toUser=Number(m?.to?.user_id||m?.to?.[0]?.user_id);
        if(from&&toUser&&(from===me)) { to=toUser; break; }
        if(from&&from!==me) { to=from; break; }
      }
      if(!to){ toast('Não foi possível identificar o destinatário'); return; }
      const attachments = state.attachments.map(a=>a.id);
      resp = await j(`/api/messages/packs/${encodeURIComponent(packId)}/send`,{
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({ to_user_id:String(to), text, attachments: attachments.length?attachments:undefined })
      });
    }

    toast('Mensagem enviada');
    const ta=$('#msgText'); if(ta){ ta.value=''; updateCharCount(); }
    state.attachments.length=0; $('#chips') && ($('#chips').innerHTML='');
    await openPack(packId); // recarrega thread e autoscroll
    scrollThreadToBottom();
  }catch{
    toast('Falha ao enviar');
  }
});

/* ===== Boot ===== */
document.addEventListener('DOMContentLoaded', async ()=>{
  $('#loginBtn')?.addEventListener('click', ()=> location.href='/login');
  $('#refreshBtn')?.addEventListener('click', async ()=>{ await fetch('/refresh',{method:'POST'}); toast('Token renovado'); });
  $('#syncOrdersBtn')?.addEventListener('click', async ()=>{ await syncOrders(); renderList(); toast('Pedidos sincronizados'); });

  $('#q')?.addEventListener('input', renderList);
  $('#fltStatus')?.addEventListener('change', renderList);

  // contador + auto-resize já no load
  updateCharCount();

  await diag();
  await Promise.all([ syncOrders(), loadUnread() ]);

  // status das conversas (sem marcar como lidas)
  for (const packId of state.packs.keys()) {
    try{
      const data=await j(`/api/messages/packs/${encodeURIComponent(packId)}?mark_as_read=false&limit=0&offset=0`);
      const cur=state.packs.get(packId)||{};
      state.packs.set(packId,{ ...cur, conversation_status:data?.conversation_status, lastUpdated:Date.now() });
    }catch{}
  }
  renderList();
});
