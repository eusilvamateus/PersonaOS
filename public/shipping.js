// public/shipping.js
const $ = s => document.querySelector(s);

$('#calcBtn')?.addEventListener('click', async () => {
  const payload = {
    zip_from: $('#zipFrom')?.value || '',
    zip_to: $('#zipTo')?.value || '',
    weight: $('#weight')?.value || '',
    dimensions: $('#dimensions')?.value || ''
  };
  $('#calcOut').textContent = 'Calculando...';
  try {
    const r = await fetch('/api/shipping/calc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await r.json();
    $('#calcOut').textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    $('#calcOut').textContent = String(err);
  }
});
