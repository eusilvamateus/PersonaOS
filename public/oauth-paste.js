(function () {
  'use strict';

  const $ = sel => document.querySelector(sel);

  function setHint(msg, ok = false) {
    const h = $('#hint');
    if (!h) return;
    h.textContent = msg || '';
    h.style.color = ok ? 'var(--success-400, #4ade80)' : '';
  }

  // Parser robusto: aceita URL completa, apenas query (?code=...&state=...), ou texto solto contendo code/state
  function parseCodeStateFrom(text) {
    if (!text) return {};
    const src = String(text).trim();

    // Caso o usuário cole apenas a query
    if (src.startsWith('?code=') || src.startsWith('code=')) {
      try {
        const u = new URL('http://local/' + src.replace(/^\?/, ''));
        return { code: u.searchParams.get('code') || '', state: u.searchParams.get('state') || '' };
      } catch { /* continua no fallback regex */ }
    }

    // Tenta como URL completa
    try {
      const u = new URL(src);
      const code = u.searchParams.get('code') || '';
      const state = u.searchParams.get('state') || '';
      if (code || state) return { code, state };
    } catch { /* não é URL válida */ }

    // Fallback: regexs tolerantes
    const codeMatch  = src.match(/(?:^|[?&#\s]|code[:=\s])code[:=]?\s*([^&#\s]+)/i) || src.match(/(?:^|[?&])code=([^&#\s]+)/i);
    const stateMatch = src.match(/(?:^|[?&#\s]|state[:=\s])state[:=]?\s*([^&#\s]+)/i) || src.match(/(?:^|[?&])state=([^&#\s]+)/i);
    return {
      code:  codeMatch  ? decodeURIComponent(codeMatch[1])  : '',
      state: stateMatch ? decodeURIComponent(stateMatch[1]) : ''
    };
  }

  async function pasteFromClipboard() {
    try {
      if (!navigator.clipboard || !navigator.clipboard.readText) {
        throw new Error('Clipboard API indisponível neste navegador');
      }
      const txt = await navigator.clipboard.readText();
      if (!txt) {
        setHint('Área de transferência vazia. Cole manualmente (Ctrl+V).');
        return;
      }
      const input = $('#fullUrl');
      if (input) input.value = txt.trim();
      extractFromInput(); // já tenta extrair automaticamente
      setHint('Conteúdo colado da área de transferência.', true);
    } catch (err) {
      setHint('Não foi possível ler a área de transferência. Cole manualmente (Ctrl+V).');
    }
  }

  function extractFromInput() {
    const full = $('#fullUrl')?.value?.trim() || '';
    const codeCur = $('#code')?.value?.trim() || '';
    const stateCur = $('#state')?.value?.trim() || '';
    const source = full || (codeCur || stateCur ? `code=${codeCur}&state=${stateCur}` : '');

    const { code, state } = parseCodeStateFrom(source);

    if (code)  $('#code').value  = code;
    if (state) $('#state').value = state;

    if (code && state) {
      setHint('Dados extraídos com sucesso.', true);
      $('#code').focus();
    } else if (code || state) {
      setHint('Extraí parcialmente. Verifique os campos.');
    } else {
      setHint('Não encontrei code/state. Verifique o link ou cole a query completa (?code=...&state=...).');
    }
  }

  function wireEvents() {
    const pasteBtn = $('#pasteBtn');
    const extractBtn = $('#extractBtn');
    const fullUrl = $('#fullUrl');
    const form = $('#pasteForm');

    pasteBtn && pasteBtn.addEventListener('click', pasteFromClipboard);
    extractBtn && extractBtn.addEventListener('click', extractFromInput);

    // Auto-extrai quando o usuário COLA (evento paste) no campo
    fullUrl && fullUrl.addEventListener('paste', () => {
      setTimeout(extractFromInput, 0);
    });

    // Também tenta extrair quando o usuário digitar um link com ?code=&state=
    fullUrl && fullUrl.addEventListener('input', (e) => {
      const v = e.target.value || '';
      if (v.includes('code=') && v.includes('state=')) {
        extractFromInput();
      } else {
        setHint('');
      }
    });

    // Validação do form (não envia se faltar algo)
    form && form.addEventListener('submit', (e) => {
      const code = $('#code').value.trim();
      const state = $('#state').value.trim();
      if (!code || !state) {
        e.preventDefault();
        setHint('Preencha os dois campos: code e state.');
      }
    });
  }

  // Como o script está com "defer", o DOM já estará disponível aqui:
  document.addEventListener('DOMContentLoaded', wireEvents);
})();
