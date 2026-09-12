// Minimal child process used by childProcess.test.ts.
// Reads NDJSON-ish lines from stdin and echoes them back on stdout:
//   "<text>"      -> prints "echo:<text>"
//   "exit <code>" -> exits with <code>
//   "err <text>"  -> writes <text> to stderr
//   "big <n>"     -> prints a single line of <n> 'x' characters
process.stdin.setEncoding('utf8')

let buffer = ''

process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index = buffer.indexOf('\n')
  while (index >= 0) {
    const line = buffer.slice(0, index).replace(/\r$/, '')
    buffer = buffer.slice(index + 1)
    handle(line)
    index = buffer.indexOf('\n')
  }
})

process.stdin.on('end', () => process.exit(0))

function handle(line) {
  const exit = /^exit (\d+)$/.exec(line)
  if (exit) {
    process.exit(Number(exit[1]))
    return
  }
  const err = /^err (.*)$/.exec(line)
  if (err) {
    process.stderr.write(`${err[1]}\n`)
    return
  }
  const big = /^big (\d+)$/.exec(line)
  if (big) {
    process.stdout.write(`${'x'.repeat(Number(big[1]))}\n`)
    return
  }
  process.stdout.write(`echo:${line}\n`)
}

process.stdout.write('ready\n')
