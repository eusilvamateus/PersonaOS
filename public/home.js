// public/home.js
(function () {
  'use strict';
  const $ = s => document.querySelector(s);

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function variantFromType(type) {
    if (type === 'success' || type === 'ok')   return 'ok';
    if (type === 'error'   || type === 'danger') return 'warn';
    if (type === 'info')   return 'info';
    return 'muted';
  }

  function ensureToastStack() {
    let stack = $('.toast-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.className = 'toast-stack';
      document.body.appendChild(stack);
    }
    return stack;
  }

  function renderToast(flash, autoCloseMs = 4500) {
    const stack = ensureToastStack();
    const variant = variantFromType(flash.type);
    const title = variant === 'ok' ? 'Sucesso'
                 : variant === 'warn' ? 'Atenção'
                 : 'Status';

    const toast = document.createElement('section');
    toast.className = 'toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');

    toast.innerHTML = `
      <div class="toast-header">
        <span class="badge-status ${variant}"></span>
        <strong>${title}</strong>
      </div>
      <div class="toast-body">
        <p style="margin:0">${escapeHtml(flash.message || '')}</p>
      </div>
      <div class="toast-footer">
        <button type="button" class="btn" data-close>Fechar</button>
      </div>
    `;

    stack.appendChild(toast);

    const close = () => { try { toast.remove(); } catch {} };
    toast.querySelector('[data-close]')?.addEventListener('click', close);
    if (autoCloseMs > 0) setTimeout(close, autoCloseMs);
  }

  async function fetchFlashAndShow() {
    try {
      const r = await fetch('/api/flash', { cache: 'no-store' });
      if (!r.ok) return;
      const flash = await r.json();
      if (flash && flash.message) renderToast(flash);
    } catch { /* ignore */ }
  }

  document.addEventListener('DOMContentLoaded', fetchFlashAndShow);
})();
