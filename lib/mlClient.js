// lib/mlClient.js
// Cliente HTTP com Bearer automático, refresh em 401, retry com backoff e suporte a Retry-After.
// ESM. Depende apenas de axios.
//
// Uso básico:
//   import { createMLClient } from "./lib/mlClient.js";
//   const ml = createMLClient({
//     baseURL: process.env.ML_API_BASE || "https://api.mercadolibre.com",
//     getAccessToken: async () => tokens.access_token,
//     refreshAccessToken: async () => {/* retorna string ou { access_token, refresh_token, expires_in } */},
//     onTokenUpdated: (access, refresh, expiresAtMs) => { /* persistir tokens */ },
//   });
//   const r = await ml.get("/users/me");

import axios from "axios";
import crypto from "crypto";

/** Espera em milissegundos. */
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/** Converte header Retry-After em milissegundos. Aceita segundos ou data HTTP. */
export function parseRetryAfterMs(headers = {}) {
  const h = headers["retry-after"] ?? headers["Retry-After"];
  if (h == null) return null;
  const s = String(h).trim();
  // valor em segundos
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  // data HTTP
  const t = Date.parse(s);
  if (!Number.isNaN(t)) {
    const now = Date.now();
    const delta = t - now;
    return delta > 0 ? delta : 0;
  }
  return null;
}

/** Erro de rede ou timeout comum em axios. */
function isNetworkOrTimeout(err) {
  const code = err?.code || "";
  const msg = String(err?.message || "").toLowerCase();
  return (
    code === "ECONNABORTED" ||
    code === "ECONNRESET" ||
    code === "ERR_NETWORK" ||
    msg.includes("network")
  );
}

/** Backoff exponencial simples com jitter. */
function calcBackoffMs(tryIndex, baseMs, capMs) {
  // tryIndex 0 é a primeira repetição
  const expo = Math.min(capMs, baseMs * Math.pow(2, tryIndex));
  // jitter aleatório até 250 ms
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(expo + jitter, capMs);
}

/** Métodos idempotentes por padrão. */
function isIdempotentDefault(method, cfg) {
  const m = String(method || "").toUpperCase();
  if (cfg && cfg.idempotent === true) return true; // o chamador garante idempotência
  return m === "GET" || m === "HEAD" || m === "OPTIONS";
}

/**
 * Cria cliente axios com:
 * - Bearer automático por getAccessToken
 * - Refresh único em 401 por refreshAccessToken
 * - Retry com backoff para 5xx, 429, 408 e erros de rede
 * - Suporte a Retry-After com teto maxRetryAfterMs
 *
 * @param {Object} opts
 * @param {string} [opts.baseURL] Base da API. Padrão: process.env.ML_API_BASE ou https://api.mercadolibre.com
 * @param {number} [opts.timeout] Timeout por requisição em ms. Padrão: 15000
 * @param {number} [opts.maxRetries] Número máximo de tentativas adicionais. Padrão: 4
 * @param {number} [opts.backoffBaseMs] Base do backoff exponencial. Padrão: 300
 * @param {number} [opts.backoffCapMs] Teto do backoff exponencial. Padrão: 5000
 * @param {number} [opts.maxRetryAfterMs] Teto para Retry-After, se presente. Opcional.
 * @param {function(): Promise<string>} opts.getAccessToken Função para obter o access token atual.
 * @param {function(): Promise<string|{access_token:string,refresh_token?:string,expires_in?:number}>} opts.refreshAccessToken Função para renovar o token em 401.
 * @param {function(string, string|null, number|null):void} [opts.onTokenUpdated] Callback ao atualizar token. Recebe (access, refresh, expiresAtMs).
 * @param {function(string, any): boolean} [opts.isIdempotent] Decide idempotência por método e config. Padrão: GET, HEAD, OPTIONS ou cfg.idempotent=true.
 * @param {function(any): boolean} [opts.shouldRetry] Predicado extra para decidir retry. Recebe o erro e deve retornar boolean.
 * @param {Object} [opts.logger] Logger opcional { debug, info, warn, error }.
 * @param {string} [opts.userAgent] User-Agent padrão. Padrão: `${APP_NAME}/${APP_VERSION}` ou PersonaOS/dev
 */
export function createMLClient({
  baseURL = process.env.ML_API_BASE || "https://api.mercadolibre.com",
  timeout = 15000,
  maxRetries = 4,
  backoffBaseMs = 300,
  backoffCapMs = 5000,
  maxRetryAfterMs,
  getAccessToken,
  refreshAccessToken,
  onTokenUpdated,
  isIdempotent = isIdempotentDefault,
  shouldRetry,
  logger = console,
  userAgent = `${process.env.APP_NAME || "PersonaOS"}/${process.env.APP_VERSION || "dev"}`
} = {}) {
  if (typeof getAccessToken !== "function") {
    throw new Error("createMLClient: getAccessToken é obrigatório");
  }
  if (typeof refreshAccessToken !== "function") {
    throw new Error("createMLClient: refreshAccessToken é obrigatório");
  }

  const instance = axios.create({
    baseURL,
    timeout
  });

  // Interceptor de request: injeta Authorization e User-Agent.
  instance.interceptors.request.use(async (cfg) => {
    cfg = cfg || {};
    cfg.headers = cfg.headers || {};
    // Metadata para controle de tentativa e refresh.
    cfg.metadata = cfg.metadata || { retried: 0, didRefresh: false, startedAt: Date.now() };

    // ID único da requisição para auditoria
    if (!cfg.metadata.requestId) {
      cfg.metadata.requestId = crypto.randomUUID();
    }
    if (!cfg.headers["X-Request-Id"]) {
      cfg.headers["X-Request-Id"] = cfg.metadata.requestId;
    }
    logger?.debug?.(
      `→ ${String(cfg.method || "GET").toUpperCase()} ${cfg.url} [${cfg.metadata.requestId}]`
    );

    // User-Agent padrão, se ausente.
    if (!cfg.headers["User-Agent"]) {
      cfg.headers["User-Agent"] = userAgent;
    }

    // Bearer atual.
    const current = await getAccessToken();
    if (current && !cfg.headers.Authorization) {
      cfg.headers.Authorization = `Bearer ${current}`;
    }

    return cfg;
  });

  // Interceptor de resposta: sucesso direto.
  instance.interceptors.response.use(
    (res) => {
      const cfg = res.config || {};
      const reqId = res.headers?.["x-request-id"] || cfg.metadata?.requestId;
      logger?.debug?.(
        `← ${String(cfg.method || "GET").toUpperCase()} ${cfg.url} ${res.status} [${reqId}]`
      );
      return res;
    },
    async (err) => {
      const cfg = err?.config;
      if (!cfg) throw err;

      cfg.metadata = cfg.metadata || { retried: 0, didRefresh: false };
      const status = err?.response?.status ?? null;

      // 1) 401: tentar refresh uma única vez
      if (status === 401 && !cfg.metadata.didRefresh) {
        try {
          cfg.metadata.didRefresh = true;
          const refreshed = await refreshAccessToken();
          const access =
            typeof refreshed === "string" ? refreshed : refreshed?.access_token;

          if (!access) throw new Error("refreshAccessToken não retornou access_token");

          // Notifica atualização de token
          if (typeof onTokenUpdated === "function") {
            const newRefresh =
              typeof refreshed === "object" ? refreshed.refresh_token ?? null : null;
            const expiresAtMs =
              typeof refreshed === "object" && refreshed.expires_in
                ? Date.now() + Number(refreshed.expires_in) * 1000
                : null;
            try {
              onTokenUpdated(access, newRefresh, expiresAtMs);
            } catch (e) {
              logger?.warn?.("onTokenUpdated lançou erro", e);
            }
          }

          // Reemite com novo Bearer
          cfg.headers = cfg.headers || {};
          cfg.headers.Authorization = `Bearer ${access}`;
          return instance(cfg);
        } catch (e) {
          // Falha no refresh. Propaga o 401 original.
          return Promise.reject(err);
        }
      }

      // 2) Condição de retry para 5xx, 429, 408 e erros de rede.
      const method = cfg.method || "GET";
      const reqId = err.response?.headers?.["x-request-id"] || cfg.metadata?.requestId;
      const retriableStatus =
        status === 429 ||
        status === 408 ||
        (status != null && status >= 500 && status <= 599);

      const transient = retriableStatus || isNetworkOrTimeout(err);
      const allowedByCustom = typeof shouldRetry === "function" ? !!shouldRetry(err) : true;

      if (transient && allowedByCustom && cfg.metadata.retried < maxRetries && isIdempotent(method, cfg)) {
        let delayMs = null;

        // Honra Retry-After, quando presente
        const retryAfterMsRaw = parseRetryAfterMs(err.response?.headers || {});
        if (retryAfterMsRaw != null) {
          delayMs = typeof maxRetryAfterMs === "number"
            ? Math.min(retryAfterMsRaw, Math.max(0, maxRetryAfterMs))
            : retryAfterMsRaw;
        } else {
          // Backoff exponencial com jitter
          delayMs = calcBackoffMs(cfg.metadata.retried, backoffBaseMs, backoffCapMs);
        }

        cfg.metadata.retried += 1;
        logger?.warn?.(
          `Retry ${cfg.metadata.retried}/${maxRetries} em ${method.toUpperCase()} ${cfg.url} em ${delayMs}ms [${reqId}]`
        );

        await sleep(delayMs);
        return instance(cfg);
      }

      // 3) Sem retry: loga e propaga erro
      logger?.error?.(
        `Falha em ${method.toUpperCase()} ${cfg.url} [${reqId}] após ${cfg.metadata.retried} retries`,
        err
      );
      throw err;
    }
  );

  return instance;
}

export default createMLClient;
