import assert from 'node:assert/strict';
import test from 'node:test';
import { mapGeminiToolToParsedCmdType, parseGeminiStreamLine } from './events.js';

test('parseGeminiStreamLine ignores non-json prelude lines and parses known events', () => {
  assert.equal(parseGeminiStreamLine('Loaded cached credentials.'), null);
  assert.deepEqual(parseGeminiStreamLine('{"type":"init","session_id":"abc123","model":"gemini-3-pro-preview"}'), {
    type: 'init',
    session_id: 'abc123',
    model: 'gemini-3-pro-preview',
  });
  assert.deepEqual(parseGeminiStreamLine('{"type":"message","role":"assistant","content":"hello","delta":true}'), {
    type: 'message',
    role: 'assistant',
    content: 'hello',
    delta: true,
  });
  assert.deepEqual(parseGeminiStreamLine('{"type":"result","status":"error","error":{"message":"No capacity available for model gemini-3.1-pro-preview on the server"}}'), {
    type: 'result',
    status: 'error',
    error: { message: 'No capacity available for model gemini-3.1-pro-preview on the server' },
  });
});

test('mapGeminiToolToParsedCmdType normalizes common gemini tool names', () => {
  assert.equal(mapGeminiToolToParsedCmdType('read_file'), 'read');
  assert.equal(mapGeminiToolToParsedCmdType('search_files'), 'search');
  assert.equal(mapGeminiToolToParsedCmdType('edit_file'), 'edit');
  assert.equal(mapGeminiToolToParsedCmdType('unknown_tool'), 'run');
});
