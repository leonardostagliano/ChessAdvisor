import { describe, expect, it } from 'vitest'
import { ShutdownCoordinator } from './shutdown'

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('ShutdownCoordinator', () => {
  it('runs every registered task once, even across repeated run() calls', async () => {
    const coordinator = new ShutdownCoordinator()
    let calls = 0
    coordinator.register(() => {
      calls += 1
    })
    coordinator.register(async () => {
      calls += 1
      await delay(1)
    })

    await Promise.all([coordinator.run(50), coordinator.run(50)])
    await coordinator.run(50)

    expect(calls).toBe(2)
  })

  it('resolves within the timeout even when a task never settles', async () => {
    const coordinator = new ShutdownCoordinator()
    coordinator.register(() => new Promise<void>(() => {}))
    const started = Date.now()

    await coordinator.run(30)

    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('does not reject when a task throws', async () => {
    const coordinator = new ShutdownCoordinator()
    let ran = false
    coordinator.register(() => {
      throw new Error('boom')
    })
    coordinator.register(() => {
      ran = true
    })

    await expect(coordinator.run(50)).resolves.toBeUndefined()
    expect(ran).toBe(true)
  })
})
