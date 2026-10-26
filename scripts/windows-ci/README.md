# Windows CI path gate

The `test (windows-latest)` job runs in three cases:

- every day at 07:17 UTC on `dev` (`cron: '17 7 * * *'`)
- a manual `workflow_dispatch`
- a pull request whose diff matches `.github/windows-paths.txt`

Pushes do not run it. A nightly Test Suite run skips the Ubuntu jobs, so the
run conclusion is the Windows result. `test (ubuntu-latest)` stays the required
check and still runs on every push and pull request.

## Classifier

```bash
bun scripts/windows-ci/windows-paths.ts --base <base-sha> --head <head-sha>
bun scripts/windows-ci/windows-paths.ts --base <base-sha> --head <head-sha> --patterns .github/windows-paths.txt
```

Stdout is exactly one line: `run_windows=true` or `run_windows=false`. The same
base and head always print the same bytes. The default pattern file is
`.github/windows-paths.txt`.

`loadWindowsPathPatterns` drops blank lines and full-line `#` comments.
`shouldRunWindows` normalizes changed paths to forward slashes, returns false
for an empty change list, and matches with `Bun.Glob`. A pattern that ends in
`/**` also matches a direct child.

## Fail closed

Missing `--base` or `--head`, a git error, an unreadable pattern file, or a
pattern file with no usable globs prints `run_windows=true` and exits 0.
Diagnostics go to stderr only. The gate must not skip Windows because the
classifier itself failed.

## Path list

`.github/windows-paths.txt` is one glob per line. A `#` line is a comment.
Every glob has a comment above it that says why that path runs on Windows.

When you add code that runs on a Windows host, add a justified glob in the
same change. The coverage test runs the production `win32` search and fails
if a listed file matches no pattern. Do not widen the list to test files to
silence that test; exclude tests in the test instead.

## skipOnWindows

New Windows-only skips go through `skipOnWindows`. It returns
`process.platform === 'win32'`. It throws when `reason` is shorter than 20
characters or `followUp` is not `thinmansoftware/bdc-harness#<n>` or
`thinmansoftware/bdc-xo#<n>`.

```typescript
test.skipIf(
  skipOnWindows({
    reason: 'Windows file lock prevents cleanup of the temp directory',
    followUp: 'thinmansoftware/bdc-harness#1200',
  })
)('example', () => {});
```

File the follow-up issue before adding the skip. Do not add a bare
`skipIf(isWindows)` or `skipIf(win32)`.

## Nightly gate

After merge, this count reaches 10 only when the ten most recent scheduled
Test Suite runs on `dev` succeeded. A failed night restarts the count.

```bash
gh run list --repo thinmansoftware/bdc-harness --workflow test.yml --branch dev --event schedule --limit 10 --json conclusion --jq '[.[]|select(.conclusion=="success")]|length'
```
