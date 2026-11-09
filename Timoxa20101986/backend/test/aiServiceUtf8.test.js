import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeCompletionChunks } from '../src/services/aiService.js';

test('OpenRouter response retains Cyrillic across arbitrary network chunk boundaries', () => {
  const body = JSON.stringify({ choices: [{ message: { content: 'Привет Дарья, у вас более 1000 закрытых вакансий.' } }] });
  const bytes = Buffer.from(body, 'utf8');
  for (let cut = 1; cut < bytes.length; cut++) {
    assert.equal(decodeCompletionChunks([bytes.subarray(0, cut), bytes.subarray(cut)]), body);
  }
});

test('invalid UTF-8 fails instead of leaking replacement characters into a DM', () => {
  assert.throws(() => decodeCompletionChunks([Buffer.from([0xc3, 0x28])]), /encoded|valid|UTF-8/i);
});
