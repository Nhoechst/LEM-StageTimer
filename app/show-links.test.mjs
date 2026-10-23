import test from 'node:test';
import assert from 'node:assert/strict';
import { showLink, readShowLink } from './lib/show-links.js';

test('show links preserve current scheme, host, port, install path and query', () => {
  for (const base of [
    'https://timers.example.com/',
    'http://localhost:8080/timer/',
    'https://example.com/events/index.html?tenant=one#/control/old',
  ]) {
    for (const view of ['control', 'display', 'dsm', 'dsm-preview', 'chroma']) {
      const id = 'show / #?% ü';
      const link = showLink(base, view, id);
      const source = new URL(base);
      const target = new URL(link);
      assert.equal(target.origin, source.origin);
      assert.equal(target.pathname, source.pathname);
      assert.equal(target.search, source.search);
      assert.deepEqual(readShowLink(target.hash), { view, id });
    }
  }
});

test('invalid show hashes do not crash navigation', () => {
  for (const hash of ['', '#/', '#/control/', '#/other/id', '#/display/%zz', '#/display/a/b']) {
    assert.equal(readShowLink(hash), null);
  }
});
