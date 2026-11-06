const { summarizeFailure } = require('../src/index.js');

const log = [
  'FAIL src/auth/auth.test.ts',
  'Expected: { role: "admin" }',
  'Received: { role: "member" }',
  'Error: AssertionError: expected "member" to equal "admin"',
].join('\n');

console.log(
  summarizeFailure({
    log,
    commitSummary: ['a81f2 rename auth payload'],
    llmSummary: 'The auth API now returns member instead of admin, so the mock is stale.',
  })
);
