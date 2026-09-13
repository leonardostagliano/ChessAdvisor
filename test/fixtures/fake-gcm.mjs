// Stand-in for git-credential-manager.exe used by the updater credential tests.
// Reads the `get` request on stdin and prints credential fields, exactly like GCM.
// Env knobs: FAKE_GCM_HANG=1 never answers, FAKE_GCM_EXIT_CODE=<n> fails,
// FAKE_GCM_OUTPUT=<text> replaces the printed fields.

const chunks = []

if (process.env.FAKE_GCM_HANG === '1') {
  // Stay alive until the parent kills the process, as a browser login would.
  setInterval(() => {}, 1000)
}

process.stdin.on('data', (chunk) => chunks.push(chunk))
process.stdin.on('end', () => {
  if (process.env.FAKE_GCM_HANG === '1') return
  const code = Number(process.env.FAKE_GCM_EXIT_CODE ?? 0)
  if (code !== 0) process.exit(code)
  const output =
    process.env.FAKE_GCM_OUTPUT ??
    'protocol=https\nhost=github.com\nusername=octocat\npassword=gho_fake_token_123\n'
  process.stdout.write(output, () => process.exit(0))
})
