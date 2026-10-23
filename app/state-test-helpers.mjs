import assert from 'node:assert/strict';

export function assertState(actual, expected) {
  const { timerVersions, auth, ...state } = actual;
  if (auth) {
    assert.equal(typeof auth.configured, 'boolean');
    assert.equal(typeof auth.authorized, 'boolean');
  }
  if (actual.initialized) {
    assert.equal(typeof timerVersions, 'object');
    assert.deepEqual(Object.keys(timerVersions).sort(), actual.shows.map(show => show.id).sort());
    for (const version of Object.values(timerVersions)) {
      assert.equal(version.length, 4);
      assert.equal(typeof version[1], 'number');
    }
  }
  const { timerVersions: ignored, auth: ignoredAuth, ...expectedState } = expected;
  if (expectedState.settings) expectedState.settings = { ...expectedState.settings, pin: '' };
  assert.deepEqual(state, expected.initialized ? { templates: [], ...expectedState } : expectedState);
}
