# BuildFix AI

A GitHub Action that reads failed CI logs, explains the likely root cause in plain English, compares the failure against recent commit context, and posts a readable summary directly on the pull request.

This project is designed for teams that want a fast first-pass investigation tool for failing builds and flaky test suites.

## Why this exists

Developers lose time debugging CI failures because the signal is buried in logs, failed tests, and recent code changes. This action turns that noise into a readable developer summary.

## What it does

- Reads build and test logs from a failed job
- Identifies common failure patterns like assertion mismatches, auth contract changes, undefined values, and API regressions
- Checks recent commit context for likely regressions
- Suggests a concrete fix and a patch-style snippet
- Posts the result directly as a PR comment
- Optionally adds an AI-assisted explanation when an OpenAI-compatible API key is configured

## Example output

> ## 🔎 CI Failure Investigator
>
> Build failed: 3 test(s).
>
> Likely cause: The authentication response contract appears to have changed. Tests still expect the old payload shape, especially around the user role or token fields.
>
> Recent commits:
> - a81f2 rename auth payload
>
> Suggested fix: Update the mocked auth payload in src/auth/auth.test.ts to match the current API contract.
>
> Patch suggestion:
> ```diff
> -  role: 'member'
> +  role: 'admin'
> ```

## Marketplace-ready usage

Use this action in a workflow like this:

```yaml
name: CI Failure Investigator

on:
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write

    steps:
      - uses: actions/checkout@v4

      - name: Run tests
        shell: bash
        run: |
          set -o pipefail
          npm test 2>&1 | tee ci.log

      - name: Investigate failed CI
        if: ${{ failure() }}
        uses: kristinedzu/build-fix-ai@v1
        with:
          log-file: ci.log
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          OPENAI_MODEL: gpt-4o-mini
```

## Inputs

| Input | Required | Description |
| --- | --- | --- |
| `log-file` | Yes | The path to the failing build or test log |
| `github-token` | No | Token with `pull-requests: write`. Defaults to `github.token` |
| `repo` | No | Repository in `owner/repo` format. Defaults to the current repository |
| `pr-number` | No | Pull request number to comment on. Defaults to the current PR |

## Optional AI mode

If `OPENAI_API_KEY` is set, the action sends the failure log and recent commit hints to an OpenAI-compatible API to produce a more natural short explanation.

If the API key is missing, the action automatically falls back to a deterministic analysis engine.

## Local development

```bash
npm test
node scripts/demo-llm-summary.js
```

## Publishing as a marketplace action

1. Create a new GitHub repository for the action.
2. Ensure the repository contains the root-level `action.yml` file and `src/index.js`.
3. Commit and push the repo.
4. Create a release tag:

```bash
git tag v1
git push origin v1
```

5. Reference it from consumer repos as:

```yaml
- uses: kristinedzu/build-fix-ai@v1
```

## Project layout

- `action.yml` — marketplace action definition
- `src/index.js` — investigation logic
- `scripts/demo-llm-summary.js` — sample summary output
- `sample-data/failure.log` — sample failing log

## License

[MIT](LICENSE)
