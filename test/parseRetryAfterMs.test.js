import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseRetryAfterMs } from '../lib/mlClient.js';

describe('parseRetryAfterMs', () => {
  it('converts numeric seconds', () => {
    const ms = parseRetryAfterMs({ 'Retry-After': '120' });
    assert.strictEqual(ms, 120000);
  });

  it('parses HTTP-date format', () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const ms = parseRetryAfterMs({ 'Retry-After': future });
    assert.ok(ms <= 5000 && ms > 0);
  });

  it('handles past dates as zero', () => {
    const past = new Date(Date.now() - 5000).toUTCString();
    const ms = parseRetryAfterMs({ 'Retry-After': past });
    assert.strictEqual(ms, 0);
  });
});
