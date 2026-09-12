import { describe, expect, it, vi } from 'vitest'
import { NdjsonParser } from './ndjson'

describe('NdjsonParser', () => {
  it('emits one message per line', () => {
    const seen: unknown[] = []
    const parser = new NdjsonParser((m) => seen.push(m))
    parser.push('{"a":1}\n{"b":2}\n')
    expect(seen).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('reassembles a message split across chunks', () => {
    const seen: unknown[] = []
    const parser = new NdjsonParser((m) => seen.push(m))
    parser.push('{"id":1,"met')
    expect(seen).toEqual([])
    parser.push('hod":"initialize"}')
    expect(seen).toEqual([])
    parser.push('\n')
    expect(seen).toEqual([{ id: 1, method: 'initialize' }])
  })

  it('reassembles a multi-byte character split across chunks', () => {
    const seen: unknown[] = []
    const parser = new NdjsonParser((m) => seen.push(m))
    const line = Buffer.from('{"text":"più"}\n', 'utf8')
    // Split in the middle of the two-byte 'ù'.
    const cut = line.indexOf(Buffer.from('ù', 'utf8')[0]!)
    parser.push(line.subarray(0, cut + 1))
    parser.push(line.subarray(cut + 1))
    expect(seen).toEqual([{ text: 'più' }])
  })

  it('strips CR from CRLF framing', () => {
    const seen: unknown[] = []
    const parser = new NdjsonParser((m) => seen.push(m))
    parser.push('{"a":1}\r\n{"b":2}\r\n')
    expect(seen).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('ignores empty and whitespace-only lines', () => {
    const seen: unknown[] = []
    const onDrop = vi.fn()
    const parser = new NdjsonParser((m) => seen.push(m), onDrop)
    parser.push('\n\r\n   \n{"a":1}\n')
    expect(seen).toEqual([{ a: 1 }])
    expect(onDrop).not.toHaveBeenCalled()
  })

  it('skips an invalid JSON line and reports the dropped bytes', () => {
    const seen: unknown[] = []
    const onDrop = vi.fn()
    const parser = new NdjsonParser((m) => seen.push(m), onDrop)
    parser.push('not json\n{"a":1}\n')
    expect(seen).toEqual([{ a: 1 }])
    expect(onDrop).toHaveBeenCalledTimes(1)
    expect(onDrop).toHaveBeenCalledWith('not json'.length)
  })

  it('exposes an 8 MB line limit', () => {
    const parser = new NdjsonParser(() => {})
    expect(parser.maxLineBytes).toBe(8 * 1024 * 1024)
  })

  it('drops an oversized line and resynchronises on the next one', () => {
    const seen: unknown[] = []
    const onDrop = vi.fn()
    const parser = new NdjsonParser((m) => seen.push(m), onDrop)
    const huge = 'x'.repeat(parser.maxLineBytes + 10)
    parser.push(huge)
    expect(onDrop).not.toHaveBeenCalled()
    parser.push('more-of-the-same')
    parser.push('\n{"a":1}\n')
    expect(seen).toEqual([{ a: 1 }])
    expect(onDrop).toHaveBeenCalledTimes(1)
    expect(onDrop.mock.calls[0]![0]).toBe(huge.length + 'more-of-the-same'.length)
  })
})
