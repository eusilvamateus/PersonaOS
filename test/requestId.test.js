import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMLClient } from '../lib/mlClient.js';

// Dummy logger to silence output during tests
const nullLogger = { debug() {}, info() {}, warn() {}, error() {} };

test('mlClient envia X-Request-Id', async (t) => {
  const server = http.createServer((req, res) => {
    server.lastId = req.headers['x-request-id'];
    res.setHeader('Content-Type', 'application/json');
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  const client = createMLClient({
    baseURL,
    getAccessToken: async () => null,
    refreshAccessToken: async () => '',
    logger: nullLogger,
  });

  await client.get('/');

  assert.ok(server.lastId, 'deve enviar X-Request-Id');
  assert.match(server.lastId, /^[0-9a-f-]{36}$/i);

  await new Promise((resolve) => server.close(resolve));
});
