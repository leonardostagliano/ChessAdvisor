#!/usr/bin/env node
// @ts-nocheck
/**
 * Runnable fake Codex app-server: NDJSON over stdin/stdout, no `jsonrpc` field, no network.
 *
 *   node test/fake-app-server.mjs
 *   {"id":1,"method":"initialize","params":{}}
 *
 * Environment switches (see test/fake-app-server-lib.mjs):
 *   FAKE_CODEX_LOGGED_OUT=1  `account/read` answers with `account: null`
 *   FAKE_CODEX_TOOL_ITEM=1   every turn also completes a `commandExecution` item
 *   FAKE_CODEX_FAIL_ONCE=1   the first turn ends with status `failed`
 */

import { createFakeServer } from './fake-app-server-lib.mjs'

const server = createFakeServer({
  send(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`)
  }
})

const MAX_LINE_BYTES = 8 * 1024 * 1024
let buffer = Buffer.alloc(0)
let dropping = false

function handleLine(line) {
  let end = line.length
  while (end > 0 && line[end - 1] === 0x0d) end -= 1
  if (end === 0) return
  const text = line.subarray(0, end).toString('utf8')
  if (text.trim().length === 0) return
  let message
  try {
    message = JSON.parse(text)
  } catch {
    process.stderr.write(`fake-app-server: skipped invalid JSON line (${end} bytes)\n`)
    return
  }
  server.receive(message)
}

process.stdin.on('data', (chunk) => {
  buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
  let start = 0
  for (;;) {
    const nl = buffer.indexOf(0x0a, start)
    if (nl === -1) break
    const line = buffer.subarray(start, nl)
    start = nl + 1
    if (dropping) {
      dropping = false
      continue
    }
    handleLine(line)
  }
  buffer = start === 0 ? buffer : buffer.subarray(start)
  if (dropping || buffer.length > MAX_LINE_BYTES) {
    if (!dropping) process.stderr.write('fake-app-server: dropped oversized line\n')
    dropping = true
    buffer = Buffer.alloc(0)
  }
})

process.stdin.on('end', () => {
  server.close()
  process.exit(0)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close()
    process.exit(0)
  })
}
