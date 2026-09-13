import { describe, expect, it } from 'vitest'
import { encodeIpcErrorMessage, errorData, parseIpcError } from './ipcError'

/** How Electron re-creates a rejected `ipcMain.handle` on the renderer side. */
const overIpc = (name: string, message: string): Error => new Error(`Error invoking remote method 'game:resume': ${name}: ${message}`)

describe('encodeIpcErrorMessage', () => {
  it('writes `code: message` when there is nothing structured to carry', () => {
    expect(encodeIpcErrorMessage('GAME_NOT_FOUND', 'no game with id 42')).toBe('GAME_NOT_FOUND: no game with id 42')
    expect(encodeIpcErrorMessage('GAME_NOT_FOUND', 'no game with id 42', {})).toBe('GAME_NOT_FOUND: no game with id 42')
  })

  it('appends the payload behind the sentinel', () => {
    const message = encodeIpcErrorMessage('MODEL_UNAVAILABLE', 'the model ghost-1 is gone', { suggested: 'gpt-6-astra' })
    expect(message).toContain('MODEL_UNAVAILABLE: the model ghost-1 is gone')
    expect(message.endsWith('{"suggested":"gpt-6-astra"}')).toBe(true)
  })
})

describe('parseIpcError', () => {
  it('reads code, message and payload back through the Electron wrapper', () => {
    const encoded = encodeIpcErrorMessage('MODEL_UNAVAILABLE', 'the model ghost-1 is gone', { suggested: 'gpt-6-astra' })
    expect(parseIpcError(overIpc('IpcError', encoded))).toEqual({
      code: 'MODEL_UNAVAILABLE',
      message: 'the model ghost-1 is gone',
      data: { suggested: 'gpt-6-astra' }
    })
  })

  it('reads an error that never left the main process', () => {
    class GameError extends Error {
      readonly data = { suggested: 'gpt-6-astra' }
      constructor(readonly code: string) {
        super('the model ghost-1 is gone')
        this.name = 'GameError'
      }
    }
    expect(parseIpcError(new GameError('MODEL_UNAVAILABLE'))).toEqual({
      code: 'MODEL_UNAVAILABLE',
      message: 'the model ghost-1 is gone',
      data: { suggested: 'gpt-6-astra' }
    })
  })

  it('keeps the message intact when there is no payload', () => {
    expect(parseIpcError(overIpc('IpcError', encodeIpcErrorMessage('AI_THINKING', 'the opponent is still thinking')))).toEqual({
      code: 'AI_THINKING',
      message: 'the opponent is still thinking',
      data: {}
    })
  })

  it('falls back to E_UNEXPECTED on anything it cannot read', () => {
    expect(parseIpcError(new Error('something broke'))).toEqual({ code: 'E_UNEXPECTED', message: 'something broke', data: {} })
    expect(parseIpcError('plain string')).toEqual({ code: 'E_UNEXPECTED', message: 'plain string', data: {} })
    expect(parseIpcError(null)).toEqual({ code: 'E_UNEXPECTED', message: '', data: {} })
  })

  it('ignores a truncated or corrupt payload instead of throwing', () => {
    const broken = new Error(`MODEL_UNAVAILABLE: the model ghost-1 is gone [[ipcdata]]{"suggested":`)
    expect(parseIpcError(broken)).toEqual({ code: 'MODEL_UNAVAILABLE', message: 'the model ghost-1 is gone', data: {} })
  })
})

describe('errorData', () => {
  it('accepts only a plain object', () => {
    expect(errorData(Object.assign(new Error('x'), { data: { suggested: 'a' } }))).toEqual({ suggested: 'a' })
    expect(errorData(Object.assign(new Error('x'), { data: ['a'] }))).toBeUndefined()
    expect(errorData(new Error('x'))).toBeUndefined()
    expect(errorData(undefined)).toBeUndefined()
  })
})
