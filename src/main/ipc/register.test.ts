import { parseIpcError } from '@shared/ipcError'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GameError } from '../game/gameSession'
import type { AnalysisManager } from '../analysis/register'
import type { GameManager } from '../game/gameManager'
import type { GameStore } from '../store/gameStore'

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>

const bus = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }))

vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.0.0',
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    isPackaged: false
  },
  shell: { openExternal: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    removeHandler: (channel: string) => bus.handlers.delete(channel),
    handle: (channel: string, fn: Handler) => bus.handlers.set(channel, fn)
  }
}))

const { handle, IpcError, registerGamesIpc, serializeError } = await import('./register')

/**
 * Electron keeps only name/message/stack of a rejection: this is what actually reaches the
 * renderer, so a test that skips this step would not prove the payload survives the trip.
 */
async function invoke(channel: string): Promise<Error> {
  try {
    await bus.handlers.get(channel)!(null)
    throw new Error('the handler was expected to reject')
  } catch (error) {
    const thrown = error as Error
    return new Error(`Error invoking remote method '${channel}': ${thrown.name}: ${thrown.message}`)
  }
}

async function invokeOk(channel: string, ...args: unknown[]): Promise<unknown> {
  return bus.handlers.get(channel)!(null, ...args)
}

describe('the IPC error contract', () => {
  beforeEach(() => {
    bus.handlers.clear()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  it('carries the code and the structured payload of a GameError to the renderer', async () => {
    handle('test:modelGone', async () => {
      throw new GameError(
        'MODEL_UNAVAILABLE',
        'the model ghost-1 is no longer available',
        'gpt-6-astra'
      )
    })

    expect(parseIpcError(await invoke('test:modelGone'))).toEqual({
      code: 'MODEL_UNAVAILABLE',
      message: 'the model ghost-1 is no longer available',
      data: { suggested: 'gpt-6-astra' }
    })
  })

  it('carries the code alone when the failure has nothing structured to add', async () => {
    handle('test:notYourTurn', async () => {
      throw new GameError('NOT_YOUR_TURN', 'it is not your turn')
    })

    expect(parseIpcError(await invoke('test:notYourTurn'))).toEqual({
      code: 'NOT_YOUR_TURN',
      message: 'it is not your turn',
      data: {}
    })
  })

  it('keeps `code: message` as the IpcError text when there is no payload', () => {
    expect(new IpcError('E_BAD_URL', 'unsupported protocol').message).toBe(
      'E_BAD_URL: unsupported protocol'
    )
  })

  it('serializes a plain error without inventing a payload', () => {
    expect(serializeError(new Error('boom'))).toEqual({ code: 'E_UNEXPECTED', message: 'boom' })
    expect(serializeError('boom')).toEqual({ code: 'E_UNEXPECTED', message: 'boom' })
  })
})

describe('games:delete lifecycle', () => {
  beforeEach(() => bus.handlers.clear())

  it('cancels stale analysis before deletion and reconciles derived data afterwards', async () => {
    const order: string[] = []
    const games = {
      delete: vi.fn(async (id: string) => {
        order.push(`delete:${id}`)
      })
    } as unknown as GameStore
    const analysis = {
      cancel: vi.fn((id: string) => order.push(`cancel:${id}`))
    } as unknown as AnalysisManager
    const game = {
      session: () => ({ discardIfCurrent: (id: string) => { order.push(`discard:${id}`) } })
    } as unknown as GameManager
    registerGamesIpc({
      games,
      analysis,
      game,
      onGameDeleting: (id) => order.push(`deleting:${id}`),
      onGameDeleted: async (id) => order.push(`deleted:${id}`)
    } as never)

    await invokeOk('games:delete', 'game-1')

    expect(order).toEqual(['cancel:game-1', 'deleting:game-1', 'discard:game-1', 'delete:game-1', 'deleted:game-1'])
  })
})
