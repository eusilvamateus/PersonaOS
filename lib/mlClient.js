// lib/mlClient.js
import axios from 'axios';

/**
 * Cria um cliente Axios para Mercado Livre com:
 * - Authorization: Bearer <token> injetado a cada request
 * - Timeout padrão
 * - Retries com backoff exponencial e jitter para 5xx, 429 e timeouts
 * - Respeita Retry-After quando presente
 * - Refresh automático em 401 uma vez
 *
 * Requer callbacks para obter e renovar tokens a partir da sua sessão.
 */
export function createMLClient({
  baseURL = process.env.BASE_API_URL,
  timeout = 15_000,
  maxRetries = 4,
  getAccessToken,          // () => string
  refreshAccessToken,      // () => Promise<string>  retorna novo access_token
  onTokenUpdated           // opcional: (newAccess, newRefresh, expiresAtMs) => void
} = {}) {
  const instance = axios.create({ baseURL, timeout, validateStatus: s => s >= 200 && s < 300 });
  const IDEMPOTENT = new Set(['get', 'head', 'options']);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const parseRetryAfterMs = headers => {
    const v = headers?.['retry-after'];
    if (!v) return 0;
    const asInt = Number(v);
    if (!Number.isNaN(asInt)) return asInt * 1000;
    const asDate = Date.parse(v);
    if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
    return 0;
  };

  instance.interceptors.request.use(cfg => {
    const token = getAccessToken?.();
    if (token) {
      cfg.headers = cfg.headers || {};
      cfg.headers.Authorization = `Bearer ${token}`;
    }
    cfg.metadata = cfg.metadata || {};
    cfg.metadata.retryCount = cfg.metadata.retryCount || 0;
    cfg.metadata.didRefresh = cfg.metadata.didRefresh || false;
    // flag idempotente: true por padrão em métodos seguros
    if (cfg.idempotent === undefined) {
      cfg.idempotent = IDEMPOTENT.has(String(cfg.method || 'get').toLowerCase());
    }
    return cfg;
  });

  instance.interceptors.response.use(
    res => res,
    async err => {
      const cfg = err.config || {};
      const status = err.response?.status;
      const code = err.code; // Ex.: 'ECONNABORTED' para timeout
      const retriable =
        status === 429 ||
        (status >= 500 && status < 600) ||
        code === 'ECONNABORTED' ||
        !err.response; // falha de rede

      // 401: tenta um refresh uma única vez
      if (status === 401 && !cfg.metadata?.didRefresh && typeof refreshAccessToken === 'function') {
        try {
          cfg.metadata.didRefresh = true;
          const newAccess = await refreshAccessToken();
          if (onTokenUpdated && typeof onTokenUpdated === 'function') {
            // onTokenUpdated deve ser chamado dentro do seu refreshAccessToken real
            // Este if existe apenas para compatibilidade
            onTokenUpdated(newAccess, null, null);
          }
          cfg.headers = cfg.headers || {};
          cfg.headers.Authorization = `Bearer ${newAccess}`;
          return instance(cfg);
        } catch {
          // se o refresh falhar, propaga o erro original 401
        }
      }

      // retries seguros para erros transitórios
      if (retriable && cfg.idempotent) {
        const count = (cfg.metadata.retryCount || 0);
        if (count < maxRetries) {
          cfg.metadata.retryCount = count + 1;

          // prioridade para Retry-After quando presente
          const ra = parseRetryAfterMs(err.response?.headers);
          if (ra > 0) {
            await sleep(ra);
          } else {
            // backoff exponencial com jitter
            const base = Math.min(10_000, 300 * 2 ** count); // 300ms, 600ms, 1200ms, 2400ms, cap 10s
            const jitter = Math.floor(Math.random() * 250);
            await sleep(base + jitter);
          }
          return instance(cfg);
        }
      }

      // sem retry: propaga erro
      throw err;
    }
  );

  return instance;
}
