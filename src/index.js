#!/usr/bin/env node

const fs = require('fs');
const { execSync } = require('child_process');

function parseArgs(argv) {
  const args = { logFile: '', repo: '', token: '', prNumber: '' };

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (current === '--log-file') args.logFile = argv[i + 1] || '';
    if (current === '--repo') args.repo = argv[i + 1] || '';
    if (current === '--github-token') args.token = argv[i + 1] || '';
    if (current === '--pr-number') args.prNumber = argv[i + 1] || '';
    if (current === '--help' || current === '-h') args.help = true;
  }

  return args;
}

function getEnvironmentOverrides(args) {
  return {
    logFile: args.logFile || process.env['INPUT_LOG-FILE'] || process.env.LOG_FILE || '',
    repo: args.repo || process.env.INPUT_REPO || process.env.GITHUB_REPOSITORY || '',
    token: args.token || process.env['INPUT_GITHUB-TOKEN'] || process.env.GITHUB_TOKEN || '',
    prNumber: args.prNumber || process.env['INPUT_PR-NUMBER'] || process.env.PR_NUMBER || '',
  };
}

function stripAnsi(value) {
  return String(value || '').replace(/\u001b\[[0-9;]*m/g, '');
}

function findFailurePattern(lines) {
  const patterns = [
    /AssertionError/i,
    /Expected.*Received|expected.*got|expected.*but.*got/i,
    /TypeError/i,
    /ReferenceError/i,
    /Cannot read properties/i,
    /status 4\d\d|status 5\d\d|401|403|500/i,
    /timeout|timed out/i,
    /failed.*test|FAIL.*test/i,
    /mock.*response|response.*changed|contract.*changed/i,
  ];

  const matches = [];
  lines.forEach((line) => {
    const clean = stripAnsi(line).trim();
    if (patterns.some((pattern) => pattern.test(clean))) {
      matches.push(clean);
    }
  });

  return Array.from(new Set(matches)).slice(0, 12);
}

function extractTestNames(lines) {
  const names = new Set();
  lines.forEach((line) => {
    const match = line.match(/([A-Za-z0-9_./-]+\.(?:test|spec)\.[jt]s[x]?)/i);
    if (match) names.add(match[1]);
  });
  return Array.from(names).slice(0, 8);
}

function getRecentCommitSummary() {
  try {
    const output = execSync('git log "--pretty=format:%h %s" -n 5', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return output
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  } catch (error) {
    return [];
  }
}

function buildLikelyCause(lines, commitSummary = []) {
  const text = stripAnsi(lines.join('\n')).toLowerCase();
  const recentHints = commitSummary.join(' ').toLowerCase();

  if (/auth|login|token|jwt|session/.test(text) && /response|payload|mock|role/.test(text)) {
    const commitName = commitSummary.find((entry) => /auth|session|payload|role/i.test(entry)) || commitSummary[0];
    const commitContext = commitName ? ` in commit ${commitName.split(' ')[0]}` : '';
    return `The authentication response contract appears to have changed${commitContext}. Tests still expect the old payload shape, especially around the user role or token fields.`;
  }

  if (/status 4\d\d|401|403|invalid.*token|unauthorized/.test(text)) {
    return 'The request is failing because authentication or permissions no longer match the expected API behavior.';
  }

  if (/typeerror|cannot read properties|undefined/.test(text)) {
    return 'A runtime value is undefined or the object shape no longer matches what the code expects.';
  }

  if (/assertionerror|expected.*got|expected.*but.*got/.test(text)) {
    const commitName = commitSummary.find((entry) => /response|payload|mock|api|auth/i.test(entry)) || commitSummary[0];
    const commitContext = commitName ? ` Recent work such as ${commitName} likely changed the contract.` : ' Recent work likely changed the contract.';
    return `The code output no longer matches the test expectation${commitContext} This usually means a mock, API payload, or returned value changed.`;
  }

  if (recentHints.includes('auth') || recentHints.includes('session') || recentHints.includes('payload')) {
    return 'A recent change in auth or data-shape logic likely introduced the regression, and the tests have not been updated to match it yet.';
  }

  return 'The failing tests point to a contract or behavior change in recent code. The likely issue is a mismatch between expected output and actual runtime behavior.';
}

function buildSuggestedFix(lines) {
  const text = stripAnsi(lines.join('\n')).toLowerCase();
  const testNames = extractTestNames(lines);
  const fileName = testNames[0] || 'auth.test.ts';

  if (/auth|login|token|jwt|session/.test(text) && /response|payload|mock|role/.test(text)) {
    return `Update the mocked auth payload in ${fileName} to match the current API contract and verify the expected role/token fields before rerunning the suite.`;
  }

  if (/assertionerror|expected.*got|expected.*but.*got/.test(text)) {
    return 'Check the assertion message, compare the actual runtime payload with the expected contract, and align the mock or output accordingly.';
  }

  if (/status 4\d\d|401|403|unauthorized/i.test(text)) {
    return 'Verify the auth headers, refresh flow, and any mocked login response before adjusting retry logic or error handling.';
  }

  return 'Inspect the first failing test, compare the expected value and actual value, and patch the contract or mock to reflect the intended behavior.';
}

function buildPatchSuggestion(lines) {
  const text = stripAnsi(lines.join('\n'));
  const expectedMatch = text.match(/Expected:\s*[\s\S]*?role\s*:\s*['\"]([^'\"]+)['\"]/i);
  const receivedMatch = text.match(/Received:\s*[\s\S]*?role\s*:\s*['\"]([^'\"]+)['\"]/i);

  if (expectedMatch && receivedMatch) {
    const expectedValue = expectedMatch[1];
    const receivedValue = receivedMatch[1];
    return [
      'Patch suggestion:',
      '```diff',
      `-  role: '${receivedValue}'`,
      `+  role: '${expectedValue}'`,
      '```',
    ].join('\n');
  }

  return [
    'Patch suggestion:',
    '```diff',
    "-  // align mock or payload with the real API response",
    "+  // update the expected output to match the current contract",
    '```',
  ].join('\n');
}

function buildCommitSection(commitSummary) {
  if (!Array.isArray(commitSummary) || commitSummary.length === 0) {
    return 'Recent commits: no commit metadata was available in this environment.';
  }

  const lines = ['Recent commits:'];
  commitSummary.slice(0, 5).forEach((entry) => {
    lines.push(`- ${entry}`);
  });
  return lines.join('\n');
}

async function fetchPrCommitSummary({ repo, token, prNumber }) {
  if (!repo || !token || !prNumber) {
    return [];
  }

  const [owner, name] = repo.split('/');
  if (!owner || !name) {
    return [];
  }

  try {
    const response = await fetch(`https://api.github.com/repos/${owner}/${name}/pulls/${prNumber}/commits`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ci-failure-investigator',
      },
    });

    if (!response.ok) {
      return [];
    }

    const commits = await response.json();
    return commits.map((commit) => `${commit.sha.slice(0, 7)} ${String(commit.commit.message).split('\n')[0]}`);
  } catch (error) {
    return [];
  }
}

async function buildLLMExplanation({ log, commitSummary = [] }) {
  const apiKey = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY;
  if (!apiKey) {
    return null;
  }

  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const prompt = [
    'You are a CI failure investigator for software teams.',
    'Explain the root cause in plain English for a developer.',
    'Keep it brief, specific, and actionable.',
    'Highlight the likely contract change or failing behavior.',
    '',
    'Recent commit hints:',
    commitSummary.slice(0, 5).join('\n') || 'No recent commit metadata.',
    '',
    'Failure log:',
    stripAnsi(log).slice(0, 8000),
  ].join('\n');

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'You are a senior software engineer helping debug failed CI pipelines.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.2,
      }),
    });

    if (!response.ok) {
      return null;
    }

    const payload = await response.json();
    return payload?.choices?.[0]?.message?.content?.trim() || null;
  } catch (error) {
    return null;
  }
}

function summarizeFailure({ log, commitSummary = [], llmSummary = null }) {
  const lines = stripAnsi(log).split(/\r?\n/);
  const failedTests = [...extractTestNames(lines), ...findFailurePattern(lines)].slice(0, 8);
  const likelyCause = llmSummary || buildLikelyCause(lines, commitSummary);
  const suggestedFix = buildSuggestedFix(lines);
  const commitSection = buildCommitSection(commitSummary);
  const patchSuggestion = buildPatchSuggestion(lines);

  const sections = [
    '## 🔎 CI Failure Investigator',
    '',
    `Build failed: ${Math.max(failedTests.length || 1, 1)} test(s).`,
    '',
    `Likely cause: ${likelyCause}`,
    '',
    commitSection,
    '',
    'Relevant signals:',
    ...failedTests.map((entry) => `- ${entry}`),
    '',
    `Suggested fix: ${suggestedFix}`,
    '',
    patchSuggestion,
    '',
    '---',
    'This summary was generated automatically from the failing build log.',
  ];

  if (llmSummary) {
    sections.splice(4, 0, '', 'LLM-assisted explanation:', llmSummary, '');
  }

  return sections.join('\n');
}

function createGitHubCommentPayload(markdown) {
  return { body: markdown };
}

async function postCommentToPr({ repo, token, prNumber, markdown }) {
  if (!repo || !token || !prNumber) return false;

  const [owner, name] = repo.split('/');
  if (!owner || !name) return false;

  const response = await fetch(`https://api.github.com/repos/${owner}/${name}/issues/${prNumber}/comments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ci-failure-investigator',
    },
    body: JSON.stringify(createGitHubCommentPayload(markdown)),
  });

  if (!response.ok) {
    const payload = await response.text();
    throw new Error(`GitHub API comment failed: ${response.status} ${payload}`);
  }

  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = getEnvironmentOverrides(args);

  if (args.help || !config.logFile) {
    console.log('Usage: node src/index.js --log-file path/to/failure.log [--repo owner/repo] [--pr-number 123] [--github-token TOKEN]');
    process.exit(args.help ? 0 : 1);
  }

  const logText = fs.readFileSync(config.logFile, 'utf8');
  let commitSummary = getRecentCommitSummary();

  if (config.repo && config.token && config.prNumber) {
    commitSummary = await fetchPrCommitSummary({
      repo: config.repo,
      token: config.token,
      prNumber: config.prNumber,
    });
  }

  const llmSummary = await buildLLMExplanation({
    log: logText,
    commitSummary,
  });

  const markdown = summarizeFailure({
    log: logText,
    commitSummary,
    llmSummary,
  });

  console.log(markdown);

  if (config.repo && config.token && config.prNumber) {
    try {
      await postCommentToPr({
        repo: config.repo,
        token: config.token,
        prNumber: config.prNumber,
        markdown,
      });
      console.log('\nPR comment posted successfully.');
    } catch (error) {
      console.error('\nUnable to post PR comment:', error.message);
      process.exitCode = 1;
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Investigation failed:', error.message);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  getEnvironmentOverrides,
  summarizeFailure,
  buildLikelyCause,
  buildSuggestedFix,
  buildPatchSuggestion,
  buildLLMExplanation,
  getRecentCommitSummary,
  fetchPrCommitSummary,
  postCommentToPr,
};
