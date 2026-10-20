/**
 * Per-key write lock inside one process.
 *
 * Some S3-compatible stores check If-Match / If-None-Match correctly one request at a
 * time but not when two requests for the same key arrive together: both pass. Holding
 * this lock around every conditional write makes them reach the store one by one, so
 * the store only ever sees sequential preconditions. It coordinates writers inside one
 * process only; see docs/storage.md for running more than one replica on such a store.
 */
export class KeyedLock {
  constructor() {
    this.tails = new Map()
  }

  async run(key, fn) {
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release
    const current = new Promise((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => current)
    this.tails.set(key, tail)
    await previous
    try {
      return await fn()
    } finally {
      release()
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }

  /** Keys with a write in flight or waiting; for tests. */
  get size() {
    return this.tails.size
  }
}
