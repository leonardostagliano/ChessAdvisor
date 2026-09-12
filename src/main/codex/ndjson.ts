const LF = 0x0a
const EMPTY = Buffer.alloc(0)

/** Hard cap on a single NDJSON line; longer lines are dropped, never buffered. */
const MAX_LINE_BYTES = 8 * 1024 * 1024

/**
 * Incremental NDJSON reader for the Codex app-server transport.
 *
 * One JSON object per line, UTF-8, `\n` terminated (`\r\n` tolerated). Chunks may split a
 * line anywhere, including in the middle of a multi-byte character, so the accumulation
 * buffer stays binary until a full line is available.
 *
 * A line that does not parse as JSON is skipped and reported through `onDrop`; a line longer
 * than {@link maxLineBytes} is discarded without buffering and the reader resynchronises on
 * the next newline.
 */
export class NdjsonParser {
  readonly maxLineBytes = MAX_LINE_BYTES

  private buffer: Buffer = EMPTY
  /** True while the remainder of an oversized line is being skipped. */
  private dropping = false
  private droppedBytes = 0

  constructor(
    private readonly onMessage: (m: unknown) => void,
    private readonly onDrop?: (bytes: number) => void
  ) {}

  push(chunk: Buffer | string): void {
    const incoming = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    if (incoming.length === 0) return
    this.buffer = this.buffer.length === 0 ? incoming : Buffer.concat([this.buffer, incoming])

    let start = 0
    for (;;) {
      const nl = this.buffer.indexOf(LF, start)
      if (nl === -1) break
      const line = this.buffer.subarray(start, nl)
      start = nl + 1
      if (this.dropping) {
        this.droppedBytes += line.length
        this.dropping = false
        this.report()
        continue
      }
      this.handleLine(line)
    }

    this.buffer = start === 0 ? this.buffer : this.buffer.subarray(start)

    if (this.dropping) {
      // Still inside an oversized line: nothing worth keeping.
      this.droppedBytes += this.buffer.length
      this.buffer = EMPTY
    } else if (this.buffer.length > this.maxLineBytes) {
      this.droppedBytes += this.buffer.length
      this.buffer = EMPTY
      this.dropping = true
    }
  }

  private handleLine(line: Buffer): void {
    let end = line.length
    while (end > 0 && line[end - 1] === 0x0d) end -= 1
    if (end === 0) return
    const text = line.subarray(0, end).toString('utf8')
    if (text.trim().length === 0) return
    let message: unknown
    try {
      message = JSON.parse(text)
    } catch {
      this.droppedBytes += end
      this.report()
      return
    }
    this.onMessage(message)
  }

  private report(): void {
    const bytes = this.droppedBytes
    this.droppedBytes = 0
    this.onDrop?.(bytes)
  }
}
