const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeFailure } = require('../src/index.js');

test('summarizeFailure extracts likely root cause and recent commit hints', () => {
  const log = `
    FAIL src/auth/auth.test.ts
    Expected: { role: 'admin' }
    Received: { role: 'member' }
    Error: AssertionError: expected "member" to equal "admin"
  `;

  const result = summarizeFailure({
    log,
    commitSummary: ['a81f2 rename auth payload', 'c91b1 add session refresh'],
  });

  assert.match(result, /Likely cause:/i);
  assert.match(result, /auth/i);
  assert.match(result, /a81f2/i);
  assert.match(result, /Suggested fix:/i);
});

test('summarizeFailure includes a patch suggestion block when the failure looks like a contract mismatch', () => {
  const log = `
    FAIL src/auth/auth.test.ts
    Expected: { role: 'admin' }
    Received: { role: 'member' }
    Error: AssertionError: expected "member" to equal "admin"
  `;

  const result = summarizeFailure({
    log,
    commitSummary: ['a81f2 rename auth payload'],
  });

  assert.match(result, /Patch suggestion:/i);
  assert.match(result, /role: 'admin'|role: 'member'/i);
});

test('summarizeFailure includes an optional LLM-assisted explanation', () => {
  const log = `
    FAIL src/auth/auth.test.ts
    Expected: { role: 'admin' }
    Received: { role: 'member' }
    Error: AssertionError: expected "member" to equal "admin"
  `;

  const result = summarizeFailure({
    log,
    commitSummary: ['a81f2 rename auth payload'],
    llmSummary: 'The auth API now returns member instead of admin, so the mock is stale.',
  });

  assert.match(result, /LLM-assisted explanation:/i);
  assert.match(result, /member instead of admin/i);
});
