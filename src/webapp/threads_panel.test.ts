import assert from 'node:assert/strict';
import test from 'node:test';
import { renderThreadsPanelHtml } from './threads_panel.js';

test('threads web app html defines a fixed 7:3 action grid', () => {
  const html = renderThreadsPanelHtml();
  assert.match(html, /grid-template-columns:\s*7fr 3fr/);
  assert.match(html, /kind:\s*'threads-panel'/);
  assert.match(html, /sendAction\('rename_start'/);
});
