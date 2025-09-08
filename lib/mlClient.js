// lib/mlClient.js
import axios from 'axios';

/**
 * Cliente Axios para a API do Mercado Livre com:
 * - Authorization: Bearer <token> (injetado a cada request)
 * - Timeout padrão (configurável)
 * - Retries com backoff exponencial + jitter para erros transitórios:
 *   - 5xx, 429, timeouts (ECONNABORTED) e erro de rede
 *   - Honra o cabeçalho Retry-After quando presente
 * - Refresh automático em 401 (uma única vez por requisição)
 * - Idempotência: retries automáticos só em métodos "seguros" (GET/HEAD/OPTIONS),
 *   a menos que você defina { idempotent: true } explicitamente.
 *
 * ============================================================================
 * EXEMPLOS DE USO (BOAS PRÁTICAS)
 * ============================================================================
 *
 * // 1) GET idempotente (retries automáticos ativados por padrão)
 * const ml = createMLClient({ getAccessToken, refreshAccessToken });
 * const { data } = await ml.get('/items', { params: { ids: 'MLB123,MLB456' } });
 *
 * // 2) POST NÃO-idempotente (garantir que não repita)
 * await ml.post(`/messages/packs/${packId}/sellers/${sellerId}`, payload, {
 *   params: { tag: 'post_sale' },
 *   idempotent: false // redundante (padrão), mas deixa a intenção explícita
 * });
 *
 * // 3) Sobrescrever timeout para uma chamada específica
 * await ml.get('/users/me', { timeout: 25_000 });
 *
 * // 4) Forçar retry num método custom idempotente (ex.: DELETE com idempotency-key)
 * await ml.delete(`/resource/${id}`, {
 *   headers: { 'Idempotency-Key': opId },
 *   idempotent: true
 * });
 *
 * // 5) Respeitar Retry-After automaticamente (sem precisar codar sleeps na app)
 * // Se a API responder 429 ou 503 com Retry-After, o cliente aguarda e tenta de novo.
 *
 * ============================================================================
 */

export function createMLClient({
  baseURL = process.env.BASE_API_URL,
  timeout = 15_000,
  maxRetries = 4,
  getAccessToken,       // () => string | Promise<string>
  refreshAccessToken,   // () => Promise<string> (deve persistir tokens)
  onTokenUpdated        // opcional: (newAccess, newRefresh, expiresAtMs) => void
} = {}) {
  if (typeof getAccessToken !== 'function') {
    throw new Error('createMLClient: getAccessToken é obrigatório');
  }
  if (typeof refreshAccessToken !== 'function') {
    throw new Error('createMLClient: refreshAccessToken é obrigatório');
  }

  const IDEMPOTENT = new Set(['get', 'head', 'options']);

  const instance = axios.create({
    baseURL,
    timeout,
    // Só 2xx é "sucesso"; todo o resto cai no fluxo de erro/interceptor
    validateStatus: s => s >= 200 && s < 300,
  });

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const parseRetryAfterMs = (headers) => {
    const ra = headers?.['retry-after'] ?? headers?.['Retry-After'];
    if (!ra) return null;
    const n = Number(ra);
    if (!Number.isNaN(n)) return Math.max(0, n * 1000); // segundos
    const d = new Date(ra).getTime();
    if (!Number.isNaN(d)) {
      const delta = d - Date.now();
      return delta > 0 ? delta : 0;
    }
    return null;
    // Obs: se vier um formato estranho, ignoramos e usamos backoff padrão.
  };

  const isNetworkOrTimeout = (err) =>
    err?.code === 'ECONNABORTED' || String(err?.message || '').toLowerCase().includes('network');

  // ----- REQUEST -----
  instance.interceptors.request.use(async (cfg) => {
    cfg.metadata = cfg.metadata || {};
    cfg.metadata.retryCount = cfg.metadata.retryCount || 0;
    cfg.metadata.didRefresh = cfg.metadata.didRefresh || false;

    // Idempotência: por padrão só para métodos "seguros"
    if (cfg.idempotent === undefined) {
      cfg.idempotent = IDEMPOTENT.has(String(cfg.method || 'get').toLowerCase());
    }

    // Token atual
    const access = await getAccessToken();
    if (access) {
      cfg.headers = cfg.headers || {};
      // Evita sobrescrever Authorization custom se o chamador já passou manualmente
      if (!('Authorization' in cfg.headers)) {
        cfg.headers.Authorization = `Bearer ${access}`;
      }
    }

    return cfg;
  });

  // ----- RESPONSE (erro) -----
  instance.interceptors.response.use(
    res => res,
    async (err) => {
      const cfg = err.config || {};
      const status = err.response?.status;
      const code = err.code;
      const retriableStatus = status === 429 || (status >= 500 && status <= 599);
      const retriable = retriableStatus || isNetworkOrTimeout(err);

      // 401 → tenta refresh (uma única vez por request)
      if (status === 401 && !cfg.metadata?.didRefresh) {
        try {
          cfg.metadata.didRefresh = true;
          const newAccess = await refreshAccessToken();
          if (newAccess && typeof onTokenUpdated === 'function') {
            // onTokenUpdated é opcional; a sua função de refresh deve persistir tokens
            onTokenUpdated(newAccess, null, null);
          }
          cfg.headers = cfg.headers || {};
          cfg.headers.Authorization = `Bearer ${newAccess}`;
          return instance(cfg);
        } catch {
          // se o refresh falhar, propaga o 401 original
        }
      }

      // Retries só se for erro transitório E a chamada for idempotente
      if (retriable && cfg.idempotent) {
        const count = Number(cfg.metadata?.retryCount || 0);
        if (count < maxRetries) {
          cfg.metadata.retryCount = count + 1;

          // Honra Retry-After quando houver
          const retryAfterMs = parseRetryAfterMs(err.response?.headers || {});
          if (retryAfterMs != null) {
            await sleep(retryAfterMs);
            return instance(cfg);
          }

          // Backoff exponencial com jitter
          // Sequência base ~ 500ms, 1000ms, 2000ms, 4000ms (capped)
          const base = Math.min(500 * Math.pow(2, count), 4000);
          const jitter = Math.floor(Math.random() * 250);
          await sleep(base + jitter);
          return instance(cfg);
        }
      }

      // Sem retry → propaga
      throw err;
    }
  );

  return instance;
}

export default createMLClient;
