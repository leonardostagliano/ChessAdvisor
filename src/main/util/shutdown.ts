/** Run independent cleanup together, once; a blocked child process must not delay exit indefinitely. */
export class ShutdownCoordinator {
  private readonly tasks: Array<() => void | Promise<unknown>> = []
  private pending: Promise<void> | undefined

  register(task: () => void | Promise<unknown>): void {
    this.tasks.push(task)
  }

  run(timeoutMs = 3000): Promise<void> {
    if (this.pending) return this.pending
    this.pending = new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, timeoutMs)
      void Promise.allSettled(this.tasks.map((task) => Promise.resolve().then(task))).then(() => {
        clearTimeout(timeout)
        resolve()
      })
    })
    return this.pending
  }
}

/** Process-wide coordinator: Codex, Stockfish and the autosave register here. */
export const shutdown = new ShutdownCoordinator()
