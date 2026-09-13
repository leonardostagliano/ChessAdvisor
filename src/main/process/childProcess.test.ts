import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { ManagedProcess, type ManagedProcessOptions } from './childProcess'

const FIXTURE = fileURLToPath(new URL('../../../test/fixtures/child-echo.mjs', import.meta.url))

interface Harness {
  proc: ManagedProcess
  lines: string[]
  exits: Array<{ code: number | null; restarting: boolean }>
  waitFor(predicate: (lines: string[]) => boolean, label: string): Promise<void>
}

const started: ManagedProcess[] = []

function harness(options: Partial<ManagedProcessOptions> = {}): Harness {
  const lines: string[] = []
  const exits: Array<{ code: number | null; restarting: boolean }> = []
  let notify: (() => void) | null = null
  const proc = new ManagedProcess({
    name: 'echo',
    exe: process.execPath,
    args: [FIXTURE],
    onLine: (line) => {
      lines.push(line)
      notify?.()
    },
    onExit: (code, restarting) => {
      exits.push({ code, restarting })
      notify?.()
    },
    ...options
  })
  started.push(proc)
  const waitFor = (predicate: (l: string[]) => boolean, label: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        notify = null
        reject(new Error(`timed out waiting for ${label}; saw ${JSON.stringify(lines.slice(-5))}`))
      }, 10_000)
      const check = (): void => {
        if (!predicate(lines)) return
        clearTimeout(timer)
        notify = null
        resolve()
      }
      notify = check
      check()
    })
  return { proc, lines, exits, waitFor }
}

afterEach(async () => {
  while (started.length) await started.pop()?.shutdown(200)
})

describe('ManagedProcess', () => {
  it('starts the child and reports its pid', async () => {
    const h = harness()
    await h.proc.start()
    expect(h.proc.pid).toBeTypeOf('number')
    expect(h.proc.alive).toBe(true)
    await h.waitFor((l) => l.includes('ready'), 'the ready line')
  })

  it('reassembles lines split across chunks and splits chunks holding many lines', async () => {
    const h = harness()
    await h.proc.start()
    await h.waitFor((l) => l.includes('ready'), 'the ready line')

    expect(h.proc.write('alpha\nbeta\n')).toBe(true)
    await h.waitFor((l) => l.includes('echo:alpha') && l.includes('echo:beta'), 'both echoed lines')

    h.proc.write('big 300000\n')
    await h.waitFor((l) => l.some((line) => line.length === 300_000), 'the large single line')
    expect(h.lines.filter((line) => line.length === 300_000)).toHaveLength(1)
  })

  it('drops a line larger than the 8 MB limit without breaking the stream', async () => {
    const h = harness()
    await h.proc.start()
    await h.waitFor((l) => l.includes('ready'), 'the ready line')

    h.proc.write(`big ${9 * 1024 * 1024}\n`)
    h.proc.write('after\n')
    await h.waitFor((l) => l.includes('echo:after'), 'the line after the oversized one')
    expect(h.lines.some((line) => line.length > 8 * 1024 * 1024)).toBe(false)
  })

  it('restarts on an unexpected exit, honouring the backoff, until maxAttempts', async () => {
    const h = harness({ restart: { maxAttempts: 2, backoffMs: [20, 20] } })
    await h.proc.start()
    await h.waitFor((l) => l.filter((x) => x === 'ready').length === 1, 'the first ready line')
    const firstPid = h.proc.pid

    h.proc.write('exit 3\n')
    await h.waitFor(
      (l) => l.filter((x) => x === 'ready').length === 2,
      'the ready line of the first restart'
    )
    expect(h.exits[0]).toEqual({ code: 3, restarting: true })
    expect(h.proc.pid).not.toBe(firstPid)

    h.proc.write('exit 4\n')
    await h.waitFor(
      (l) => l.filter((x) => x === 'ready').length === 3,
      'the ready line of the second restart'
    )
    expect(h.exits[1]).toEqual({ code: 4, restarting: true })

    h.proc.write('exit 5\n')
    await h.waitFor(() => h.exits.length === 3, 'the final exit')
    expect(h.exits[2]).toEqual({ code: 5, restarting: false })
    expect(h.proc.alive).toBe(false)
    expect(h.lines.filter((x) => x === 'ready')).toHaveLength(3)
  })

  it('never restarts after shutdown and refuses writes once the child is gone', async () => {
    const h = harness({ restart: { maxAttempts: 3, backoffMs: [10, 10, 10] } })
    await h.proc.start()
    await h.waitFor((l) => l.includes('ready'), 'the ready line')

    await h.proc.shutdown(500)

    expect(h.proc.alive).toBe(false)
    expect(h.proc.write('alpha\n')).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(h.lines.filter((x) => x === 'ready')).toHaveLength(1)
    expect(h.exits.every((e) => e.restarting === false)).toBe(true)
  })

  it('rejects start() when the executable does not exist', async () => {
    const proc = new ManagedProcess({
      name: 'missing',
      exe: 'C:/definitely/not/here.exe',
      args: []
    })
    await expect(proc.start()).rejects.toThrow()
    expect(proc.alive).toBe(false)
  })
})
