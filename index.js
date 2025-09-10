// index.js — backend com clamp de 3 meses para “Finalizadas” e /shipments com x-format-new

import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import qs from 'qs';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs/promises';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import FormData from 'form-data';
import { fileURLToPath } from 'url';
import { createMLClient } from './lib/mlClient.js';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  ML_APP_ID,
  ML_CLIENT_SECRET,
  ML_REDIRECT_URI,
  BASE_AUTH_URL = 'https://auth.mercadolivre.com.br',
  BASE_API_URL = 'https://api.mercadolibre.com',
  SESSION_SECRET = 'change-me',
  PORT = 3000,
  USE_PKCE = 'false',
  SITE_ID = 'MLB'
} = process.env;

const PORT_USED = process.env.PORT || PORT || 3000;

// -------------------- Utils --------------------
function showLiteral(s) { if (s == null) return '<null>'; return '⟨' + String(s) + '⟩'; }
function sanitizeRedirect(uri) { return (uri || '').trim(); }
function fmtErr(e) {
  const r = e?.response;
  return JSON.stringify({ status: r?.status, statusText: r?.statusText, data: r?.data });
}
const REDIRECT_URI = sanitizeRedirect(ML_REDIRECT_URI);

// PKCE
function base64url(buffer) { return buffer.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest(); }

// Persistência simples de tokens
const TOKENS_FILE = path.join(__dirname, 'tokens.json');
async function saveTokens(userId, payload) {
  try {
    let db = {};
    try { db = JSON.parse(await fs.readFile(TOKENS_FILE, 'utf-8')); } catch {}
    db[userId] = payload;
    await fs.writeFile(TOKENS_FILE, JSON.stringify(db, null, 2));
  } catch {}
}

// -------------------- Flash helpers --------------------
function setFlash(req, type, message) { req.session.flash = { type, message, ts: Date.now() }; }
function consumeFlash(req) { const f = req.session.flash; delete req.session.flash; return f || null; }

// -------------------- Middlewares --------------------
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(helmet());
app.use(rateLimit({ windowMs: 60 * 1000, max: 90 }));
app.set('trust proxy', 1);
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' }
}));
app.use(express.static(path.join(__dirname, 'public')));

// Upload local para repassar ao ML
const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } });

// -------------------- Páginas --------------------
app.get('/', async (req, res) => {
  if (req.query.code) return oauthCallbackHandler(req, res);
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});
app.get('/orders', (req, res) => res.sendFile(path.join(__dirname, 'views', 'orders.html')));
app.get('/oauth/paste', (req, res) => res.sendFile(path.join(__dirname, 'views', 'oauth-paste.html')));
app.get('/ads', (req, res) => res.sendFile(path.join(__dirname, 'views', 'ads.html')));

// -------------------- Diag + Flash --------------------
app.get('/diag', (req, res) => {
  res.json({
    ml_app_id: ML_APP_ID,
    redirect_uri_env: showLiteral(ML_REDIRECT_URI),
    redirect_uri_used: showLiteral(REDIRECT_URI),
    base_auth_url: BASE_AUTH_URL,
    base_api_url: BASE_API_URL,
    use_pkce: String(USE_PKCE).toLowerCase() === 'true',
    has_session_state: !!req.session?.oauth_state,
    user_id: req.session?.user_id || null,
    nickname: req.session?.nickname || null,
    now_iso: new Date().toISOString()
  });
});
app.get('/api/flash', (req, res) => res.json(consumeFlash(req) || {}));

// -------------------- OAuth --------------------
app.get('/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauth_state = state;

  const authUrl = new URL('/authorization', BASE_AUTH_URL);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', ML_APP_ID);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('state', state);

  if (String(USE_PKCE).toLowerCase() === 'true') {
    const code_verifier = base64url(crypto.randomBytes(32));
    const code_challenge = base64url(sha256(Buffer.from(code_verifier)));
    req.session.code_verifier = code_verifier;
    authUrl.searchParams.set('code_challenge', code_challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
  } else {
    req.session.code_verifier = null;
  }

  return res.redirect(authUrl.toString());
});

app.get('/callback', oauthCallbackHandler);

app.post('/oauth/paste', async (req, res) => {
  try {
    const { code, state } = req.body || {};
    if (!code || !state) { setFlash(req, 'error', 'Preencha code e state.'); return res.redirect('/'); }
    if (!req.session.oauth_state || state !== req.session.oauth_state) {
      setFlash(req, 'error', 'State inválido. Clique em “Gerar novo state” e tente novamente.');
      return res.redirect('/');
    }
    const token = await exchangeCodeForToken(code, req);
    await onLoginSuccess(req, token);
    const nick = req.session?.nickname || 'vendedor';
    setFlash(req, 'success', `Autorização concluída! Bem-vindo, ${nick}.`);
    return res.redirect('/');
  } catch (err) {
    const friendly = err?.response?.data ? JSON.stringify(err.response.data) : String(err?.message || err);
    setFlash(req, 'error', `Erro ao trocar code por token: ${friendly}`);
    return res.redirect('/');
  }
});

async function oauthCallbackHandler(req, res) {
  try {
    const { code, state } = req.query;
    if (!code) { setFlash(req, 'error', 'Callback sem “code”.'); return res.redirect('/'); }
    if (!state || state !== req.session.oauth_state) { setFlash(req, 'error', 'State inválido no callback.'); return res.redirect('/'); }

    const token = await exchangeCodeForToken(code, req);
    await onLoginSuccess(req, token);

    const nick = req.session?.nickname || 'vendedor';
    setFlash(req, 'success', `Autorização concluída! Olá, ${nick}.`);
    return res.redirect('/');
  } catch (err) {
    const friendly = err?.response?.data ? JSON.stringify(err.response.data) : String(err?.message || err);
    setFlash(req, 'error', `Erro no callback: ${friendly}`);
    return res.redirect('/');
  }
}

app.get('/oauth/paste/legacy', (req, res) => {
  res.send(`
    <!doctype html><meta charset="utf-8">
    <h1>Colar code e state do Mercado Livre</h1>
    <form method="post" action="/oauth/paste" style="display:grid;gap:8px;max-width:520px">
      <label>code <input name="code" required style="width:100%"/></label>
      <label>state <input name="state" required style="width:100%"/></label>
      <button type="submit">Trocar por tokens</button>
    </form>
    <p><a href="/">Voltar</a></p>
  `);
});

async function onLoginSuccess(req, token) {
  req.session.access_token = token.access_token;
  req.session.refresh_token = token.refresh_token;
  req.session.expires_at = Date.now() + token.expires_in * 1000 - 60 * 1000;

  // users/me pós login
  const meResp = await axios.get(`${BASE_API_URL}/users/me`, {
    headers: { Authorization: `Bearer ${token.access_token}` }
  });
  const me = meResp.data;
  req.session.user_id = me?.id;
  req.session.nickname = me?.nickname;

  await saveTokens(req.session.user_id || 'unknown', {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expires_at: Date.now() + token.expires_in * 1000
  });
}

async function exchangeCodeForToken(code, reqForSession) {
  const url = `${BASE_API_URL}/oauth/token`;
  const payload = {
    grant_type: 'authorization_code',
    client_id: ML_APP_ID,
    client_secret: ML_CLIENT_SECRET,
    code,
    redirect_uri: REDIRECT_URI
  };
  const cv = reqForSession?.session?.code_verifier;
  if (cv) payload.code_verifier = cv;

  const data = qs.stringify(payload);
  const headers = { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' };
  const { data: resp } = await axios.post(url, data, { headers });
  return resp;
}

async function refreshAccessToken(refresh_token) {
  const url = `${BASE_API_URL}/oauth/token`;
  const data = qs.stringify({
    grant_type: 'refresh_token',
    client_id: ML_APP_ID,
    client_secret: ML_CLIENT_SECRET,
    refresh_token
  });
  const headers = { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' };
  const { data: resp } = await axios.post(url, data, { headers });
  return resp;
}

// -------------------- Auth guard --------------------
async function ensureAccessToken(req, res, next) {
  try {
    if (!req.session.access_token) return res.status(401).send('Não autenticado');
    if (Date.now() >= (req.session.expires_at || 0)) {
      const token = await refreshAccessToken(req.session.refresh_token);
      req.session.access_token = token.access_token;
      req.session.refresh_token = token.refresh_token;
      req.session.expires_at = Date.now() + token.expires_in * 1000 - 60 * 1000;
    }
    return next();
  } catch (err) {
    return res.status(401).send(`Falha ao garantir token: ${fmtErr(err)}`);
  }
}

// Cliente ML por requisição
function mlFor(req) {
  return createMLClient({
    baseURL: BASE_API_URL,
    getAccessToken: () => req.session.access_token,
    refreshAccessToken: async () => {
      const token = await refreshAccessToken(req.session.refresh_token);
      req.session.access_token = token.access_token;
      req.session.refresh_token = token.refresh_token;
      req.session.expires_at = Date.now() + token.expires_in * 1000 - 60 * 1000;
      await saveTokens(req.session.user_id || 'unknown', {
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        expires_at: Date.now() + token.expires_in * 1000
      });
      return token.access_token;
    }
  });
}

// -------------------- MENSAGENS (mantido) --------------------
app.get('/api/messages/unread', ensureAccessToken, async (req, res) => {
  try {
    const ml = mlFor(req);
    const role = (req.query.role || 'seller').toLowerCase();
    const { data } = await ml.get('/messages/unread', { params: { role, tag: 'post_sale' } });
    res.json(data);
  } catch (err) {
    res.status(500).send(`Erro em /api/messages/unread: ${fmtErr(err)}`);
  }
});

app.get('/api/messages/packs/:packId', ensureAccessToken, async (req, res) => {
  try {
    const ml = mlFor(req);
    const { packId } = req.params;
    const mark = String(req.query.mark_as_read || 'true').toLowerCase() === 'true';
    const limit = req.query.limit || 10;
    const offset = req.query.offset || 0;
    const sellerId = req.session.user_id || req.query.seller_id;
    if (!sellerId) return res.status(400).send('seller_id ausente');

    const url = `/messages/packs/${encodeURIComponent(packId)}/sellers/${encodeURIComponent(sellerId)}`;
    const { data } = await ml.get(url, { params: { tag: 'post_sale', mark_as_read: mark, limit, offset } });
    res.json(data);
  } catch (err) {
    res.status(500).send(`Erro em /api/messages/packs/:packId: ${fmtErr(err)}`);
  }
});

app.post('/api/messages/packs/:packId/send', ensureAccessToken, async (req, res) => {
  try {
    const ml = mlFor(req);
    const { packId } = req.params;
    const sellerId = req.session.user_id;
    const { to_user_id, text, attachments } = req.body || {};
    if (!sellerId) return res.status(401).send('Não autenticado');
    if (!to_user_id) return res.status(400).send("Campo 'to_user_id' é obrigatório");
    if (!text) return res.status(400).send("Campo 'text' é obrigatório");
    if (text.length > 350) return res.status(400).send('Texto excede 350 caracteres');

    const url = `/messages/packs/${encodeURIComponent(packId)}/sellers/${encodeURIComponent(sellerId)}`;
    const payload = { from: { user_id: String(sellerId) }, to: { user_id: String(to_user_id) }, text: String(text) };
    if (attachments && Array.isArray(attachments) && attachments.length) payload.attachments = attachments;

    const { data } = await ml.post(url, payload, { params: { tag: 'post_sale' }, idempotent: false });
    res.json(data);
  } catch (err) {
    res.status(500).send(`Erro ao enviar mensagem: ${fmtErr(err)}`);
  }
});

app.post('/api/messages/attachments', ensureAccessToken, upload.single('file'), async (req, res) => {
  try {
    const ml = mlFor(req);
    if (!req.file) return res.status(400).send('Arquivo não enviado (campo "file")');
    const form = new FormData();
    form.append('file', req.file.buffer, { filename: req.file.originalname });

    const { data } = await ml.post('/messages/attachments', form, {
      params: { tag: 'post_sale', site_id: SITE_ID },
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      idempotent: false
    });
    res.json(data);
  } catch (err) {
    res.status(500).send(`Erro no upload de anexo: ${fmtErr(err)}`);
  }
});

app.get('/api/messages/attachments/:attachmentId', ensureAccessToken, async (req, res) => {
  try {
    const ml = mlFor(req);
    const { attachmentId } = req.params;
    const resp = await ml.get(`/messages/attachments/${encodeURIComponent(attachmentId)}`, {
      params: { tag: 'post_sale', site_id: SITE_ID },
      responseType: 'arraybuffer'
    });
    res.setHeader('Content-Type', resp.headers['content-type'] || 'application/octet-stream');
    res.send(resp.data);
  } catch (err) {
    res.status(500).send(`Erro ao obter anexo: ${fmtErr(err)}`);
  }
});

// -------------------- PEDIDOS --------------------
const ordersCache = {
  syncedAt: 0,
  items: [] // { order, shipping, shipping_group, when_group, shipping_form, turbo }
};

async function getSellerId(req) {
  if (req.session.user_id) return req.session.user_id;
  const ml = mlFor(req);
  const { data } = await ml.get('/users/me');
  req.session.user_id = data.id;
  return data.id;
}
function mapShippingToGroup(status = '') {
  const s = String(status || '').toLowerCase();
  if (s === 'delivered') return 'delivered';
  if (s === 'ready_to_ship' || s === 'pending') return 'ready_to_ship';
  if (s === 'in_transit' || s === 'shipped' || s === 'handling' || s === 'out_for_delivery' || s === 'soon_deliver') return 'in_transit';
  return 'other';
}
function normalizeYMD(d) { if (!d) return null; const dt = new Date(d); return dt.toISOString().slice(0, 10); }
function mapShippingForm(shipping = {}) {
  const t = String(shipping?.logistic_type || shipping?.logistic?.type || '').toLowerCase();
  if (t.includes('fulfillment')) return 'full';
  if (t.includes('self_service') || t.includes('flex')) return 'flex';
  if (t.includes('xd_drop_off')) return 'xd_drop_off';
  if (t.includes('drop_off')) return 'drop_off';
  if (t.includes('cross_docking')) return 'cross_docking';
  return 'other';
}
function isTurbo(shipping = {}) {
  const tags = Array.isArray(shipping?.tags) ? shipping.tags.map(String) : [];
  const svc = String(shipping?.service || '').toLowerCase();
  return tags.map(s => s.toLowerCase()).includes('turbo') || svc.includes('turbo');
}
function mapWhenGroup(order, shipping) {
  const s = String(shipping?.status || order?.shipping_status || '').toLowerCase();
  if (s === 'delivered') return 'delivered';
  if (['in_transit','shipped','handling','out_for_delivery','soon_deliver'].includes(s)) return 'in_transit';
  const buf = shipping?.lead_time?.buffering?.date || shipping?.estimated_handling_limit?.date;
  const y = normalizeYMD(buf);
  const today = new Date().toISOString().slice(0, 10);
  if (y === today) return 'today';
  if (y && y > today) return 'upcoming';
  return 'other';
}

async function hydrateShipments(orders, ml) {
  const maxConcurrent = 8;
  const queue = [...orders];
  const out = [];
  let running = 0;
  return await new Promise((resolve, reject) => {
    const runNext = () => {
      if (queue.length === 0 && running === 0) return resolve(out);
      while (running < maxConcurrent && queue.length) {
        const order = queue.shift();
        running++;
        (async () => {
          let shipping = null;
          let group = 'other';
          try {
            const shippingId = order?.shipping?.id || order?.shipping;
            if (shippingId) {
              const { data } = await ml.get(`/shipments/${shippingId}`, { headers: { 'x-format-new': 'true' } });
              shipping = data || null;
              group = mapShippingToGroup(data?.status);
            } else {
              group = mapShippingToGroup(order?.shipping_status || '');
            }
          } catch {}
          const when_group = mapWhenGroup(order, shipping);
          const shipping_form = mapShippingForm(shipping);
          const turbo = isTurbo(shipping);
          out.push({ order, shipping, shipping_group: group, when_group, shipping_form, turbo });
        })()
          .then(() => { running--; runNext(); })
          .catch(err => { running--; reject(err); });
      }
    };
    runNext();
  });
}

function computeStats(items) {
  const byStatus = { delivered: 0, in_transit: 0, ready_to_ship: 0, other: 0 };
  const chips    = { today: 0, upcoming: 0, in_transit: 0, delivered: 0, other: 0 };
  const forms    = { full: 0, flex: 0, drop_off: 0, xd_drop_off: 0, cross_docking: 0, other: 0, turbo: 0 };

  for (const it of items) {
    if (byStatus[it.shipping_group] != null) byStatus[it.shipping_group]++; else byStatus.other++;
    const w = it.when_group ?? mapWhenGroup(it.order, it.shipping);
    if (chips[w] != null) chips[w]++; else chips.other++;
    const f = it.shipping_form ?? mapShippingForm(it.shipping);
    if (forms[f] != null) forms[f]++; else forms.other++;
    if (it.turbo || isTurbo(it.shipping)) forms.turbo++;
  }
  return { byStatus, chips, forms };
}

// Helpers de DATA
function toISOAtBoundary(d, endOfDay = false) { const dt = new Date(d); if (endOfDay) dt.setUTCHours(23,59,59,999); else dt.setUTCHours(0,0,0,0); return dt.toISOString(); }
function parseDateRangeFromQuery(query) {
  const now = new Date();
  const to = query.to ? new Date(query.to) : now;
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - 90 * 24 * 60 * 60 * 1000);
  return { from, to };
}
function* dateWindows(from, to, windowDays = 30) {
  const clampDays = Math.max(1, Math.min(31, Number(windowDays || 30)));
  let end = new Date(to);
  const oneDay = 24 * 60 * 60 * 1000;
  while (end >= from) {
    const startMs = Math.max(from.getTime(), end.getTime() - clampDays * oneDay + 1);
    const start = new Date(startMs);
    yield { fromISO: toISOAtBoundary(start, false), toISO: toISOAtBoundary(end, true) };
    end = new Date(startMs - 1);
  }
}
function dateFilterKeys(basis) {
  const b = String(basis || 'created');
  if (b === 'updated') return ['order.date_last_updated.from', 'order.date_last_updated.to'];
  if (b === 'closed')  return ['order.date_closed.from',       'order.date_closed.to'];
  return ['order.date_created.from',     'order.date_created.to'];
}

// Sync (batch via /orders/search → enrich /shipments)
app.post('/api/orders/sync', ensureAccessToken, async (req, res) => {
  try {
    const ml = mlFor(req);
    const sellerId = await getSellerId(req);

    const { from, to } = parseDateRangeFromQuery(req.query);
    const windowDays = Number(req.query.windowDays || 30);
    const basis = String(req.query.basis || 'created');
    const [fromKey, toKey] = dateFilterKeys(basis);

    const allOrders = [];
    const limit = 50;

    for (const win of dateWindows(from, to, windowDays)) {
      let offset = 0;
      while (true) {
        const url = new URL('/orders/search', BASE_API_URL);
        url.searchParams.set('seller', String(sellerId));
        url.searchParams.set('sort', 'date_desc');
        url.searchParams.set('limit', String(limit));
        url.searchParams.set('offset', String(offset));
        url.searchParams.set(fromKey, win.fromISO);
        url.searchParams.set(toKey,   win.toISO);

        const { data } = await ml.get(url.pathname + url.search);
        const chunk = Array.isArray(data?.results) ? data.results : [];
        allOrders.push(...chunk);

        if (chunk.length < limit) break;
        offset += limit;
        if (offset >= 10000) break;
      }
    }

    const enriched = await hydrateShipments(allOrders, ml);
    ordersCache.items = enriched;
    ordersCache.syncedAt = Date.now();

    const stats = computeStats(ordersCache.items);
    return res.json({
      ok: true,
      total: ordersCache.items.length,
      stats,
      syncedAt: ordersCache.syncedAt,
      range: { from: from.toISOString(), to: to.toISOString(), windowDays: Math.max(1, Math.min(31, Number(windowDays))) },
      basis
    });
  } catch (err) {
    const msg = err?.response?.data ? JSON.stringify(err.response.data) : String(err?.message || err);
    return res.status(500).send(`Erro ao sincronizar pedidos: ${msg}`);
  }
});

// Estatísticas
app.get('/api/orders/stats', ensureAccessToken, (req, res) => {
  const s = computeStats(ordersCache.items);
  res.json({
    total: ordersCache.items.length,
    stats: s.byStatus,
    chips: s.chips,
    forms: s.forms,
    syncedAt: ordersCache.syncedAt
  });
});

// Paginação
app.get('/api/orders/page', ensureAccessToken, (req, res) => {
  const page = Number(req.query.page || 1);
  const pageSize = Math.min(Number(req.query.pageSize || 20), 100);
  const group = String(req.query.group || 'all'); // all | today | upcoming | in_transit | delivered | ready_to_ship
  const form  = String(req.query.form  || 'all'); // all | full | flex | drop_off | xd_drop_off | cross_docking | turbo

  let arr = ordersCache.items;

  if (group === 'today' || group === 'upcoming') {
    arr = arr.filter(o => (o.when_group ?? mapWhenGroup(o.order, o.shipping)) === group);
  } else if (group !== 'all') {
    arr = arr.filter(o => o.shipping_group === group);
  }

  if (form !== 'all') {
    if (form === 'turbo') arr = arr.filter(o => o.turbo || isTurbo(o.shipping));
    else arr = arr.filter(o => (o.shipping_form ?? mapShippingForm(o.shipping)) === form);
  }

  arr = [...arr].sort((a, b) => {
    const ad = a.order.date_closed || a.order.date_created || '';
    const bd = b.order.date_closed || b.order.date_created || '';
    return (bd || '').localeCompare(ad || '');
  });

  const start = (page - 1) * pageSize;
  const slice = arr.slice(start, start + pageSize);

  res.json({ page, pageSize, total: arr.length, pages: Math.max(1, Math.ceil(arr.length / pageSize)), data: slice });
});

// STREAM SSE — com clamp automático para 'delivered'
app.get('/api/orders/stream', ensureAccessToken, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  const send = (event, data) => { res.write(`event: ${event}\n`); res.write(`data: ${JSON.stringify(data)}\n\n`); };
  const ping = setInterval(() => { try { res.write(':\n\n'); } catch {} }, 25000);

  let closed = false;
  req.on('close', () => { closed = true; clearInterval(ping); });

  try {
    const ml = mlFor(req);
    const sellerId = await getSellerId(req);

    const group = String(req.query.group || '').toLowerCase();

    // Base de datas/basis
    let { from, to } = parseDateRangeFromQuery(req.query);
    let basis = String(req.query.basis || 'created');

    // Clamp implícito para FINALIZADAS (3 meses por date_closed)
    if (group === 'delivered' && !req.query.from && !req.query.to) {
      to = new Date();
      from = new Date(to.getTime() - 90 * 24 * 60 * 60 * 1000); // 3 meses
      basis = 'closed';
    }

    const [fromKey, toKey] = dateFilterKeys(basis);
    const limit = 50;

    ordersCache.items = [];
    ordersCache.syncedAt = Date.now();

    let sent = 0;
    let expectedTotal = 0;
    const seen = new Set();

    send('meta', { range: { from: from.toISOString(), to: to.toISOString() }, basis, expectedTotal });

    async function streamEnriched(chunk) {
      const maxConcurrent = 6;
      const queue = [...chunk];
      let running = 0;

      return await new Promise((resolve) => {
        const runNext = () => {
          if (closed) return resolve();
          if (queue.length === 0 && running === 0) return resolve();

          while (!closed && running < maxConcurrent && queue.length) {
            const order = queue.shift();
            running++;
            (async () => {
              try {
                const key = String(order?.id || order?.id_str || JSON.stringify(order));
                if (seen.has(key)) return;
                seen.add(key);

                let shipping = null;
                let groupClassic = 'other';
                try {
                  const shippingId = order?.shipping?.id || order?.shipping;
                  if (shippingId) {
                    const { data } = await ml.get(`/shipments/${shippingId}`, { headers: { 'x-format-new': 'true' } });
                    shipping = data || null;
                    groupClassic = mapShippingToGroup(data?.status);
                  } else {
                    groupClassic = mapShippingToGroup(order?.shipping_status || '');
                  }
                } catch {}

                const when_group = mapWhenGroup(order, shipping);
                const shipping_form = mapShippingForm(shipping);
                const turbo = isTurbo(shipping);

                const enriched = { order, shipping, shipping_group: groupClassic, when_group, shipping_form, turbo };
                ordersCache.items.push(enriched);

                sent++;
                send('row', enriched);
                if (expectedTotal > 0 || sent % 25 === 0) send('progress', { sent, expectedTotal });
              } finally { running--; }
            })().then(runNext).catch(() => { running--; runNext(); });
          }
        };
        runNext();
      });
    }

    for (const win of dateWindows(from, to, 30)) {
      if (closed) break;

      let offset = 0;
      let firstPage = true;

      while (!closed) {
        const url = new URL('/orders/search', BASE_API_URL);
        url.searchParams.set('seller', String(sellerId));
        url.searchParams.set('sort', 'date_desc');
        url.searchParams.set('limit', String(limit));
        url.searchParams.set('offset', String(offset));
        url.searchParams.set(fromKey, toISOAtBoundary(win.fromISO || win.from, false));
        url.searchParams.set(toKey,   toISOAtBoundary(win.toISO || win.to, true));

        let data;
        try {
          const resp = await ml.get(url.pathname + url.search);
          data = resp.data;
        } catch (e) {
          send('error', { scope: 'page', window: win, message: String(e?.message || e) });
          break;
        }

        const results = Array.isArray(data?.results) ? data.results : [];
        if (firstPage) {
          const totalWin = Number(data?.paging?.total || 0);
          expectedTotal += totalWin;
          send('meta', { window: win, windowTotal: totalWin, expectedTotal });
          firstPage = false;
        }

        if (results.length === 0) break;

        await streamEnriched(results);

        if (results.length < limit) break;
        offset += limit;
        if (offset >= 10000) break; // guarda
      }
    }

    ordersCache.syncedAt = Date.now();
    send('done', { sent, expectedTotal, syncedAt: ordersCache.syncedAt, basis, group });
  } catch (err) {
    send('error', { scope: 'fatal', message: String(err?.message || err) });
  }
});

// -------------------- Exemplos --------------------
app.get('/api/me', ensureAccessToken, async (req, res) => {
  try {
    const ml = mlFor(req);
    const { data } = await ml.get('/users/me');
    return res.json(data);
  } catch (err) {
    return res.status(500).send(`Erro em /api/me: ${fmtErr(err)}`);
  }
});

app.post('/refresh', async (req, res) => {
  try {
    const rt = req.session.refresh_token;
    if (!rt) return res.status(400).send('Sem refresh_token na sessão');
    const token = await refreshAccessToken(rt);
    req.session.access_token = token.access_token;
    req.session.refresh_token = token.refresh_token;
    req.session.expires_at = Date.now() + token.expires_in * 1000 - 60 * 1000;
    return res.json({ ok: true, expires_in: token.expires_in });
  } catch (err) {
    return res.status(500).send(`Erro no refresh: ${fmtErr(err)}`);
  }
});

app.post('/logout', (req, res) => { req.session.destroy(() => res.redirect('/')); });

app.listen(PORT_USED, () => { console.log(`Servidor ouvindo em http://localhost:${PORT_USED}`); });
