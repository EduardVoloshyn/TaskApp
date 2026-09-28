/**
 * Runs an async task, never twice at once.
 *
 * The save path needs this. A write to Apps Script takes a few seconds, so an edit made
 * during one issues a second POST while the first is still running — and both carry the
 * *same* content hash. Two failure modes follow, neither obviously self-inflicted:
 *
 *   - the second waits on `LockService` and gives up as `locked`
 *   - the first succeeds, moves the sheet's hash on, and the second is rejected `stale`
 *
 * Calls arriving while a run is in progress are collapsed into a single follow-up. A
 * flag rather than a queue, because the payload is always the whole board: one later
 * run covers every edit made during the first, however many there were.
 *
 * @param {(...args: any[]) => Promise<any>} task
 * @param {{ onRerun?: () => void }} [options] called once, after a successful run that
 *   had calls collapsed into it. Not called after a failure: the UI offers a retry, and
 *   repeating a doomed request automatically would just hammer the endpoint.
 * @returns {(...args: any[]) => Promise<any>}
 */
export function singleFlight(task, { onRerun } = {}) {
  let running = false
  let queued = false

  return async function invoke(...args) {
    if (running) {
      queued = true
      return undefined
    }

    running = true
    let succeeded = false
    try {
      const result = await task(...args)
      succeeded = true
      return result
    } finally {
      running = false
      // Cleared even on failure, so a rejected run cannot leave a rerun armed
      // indefinitely, waiting for some unrelated later success to fire it.
      const hadQueued = queued
      queued = false
      if (hadQueued && succeeded) onRerun?.()
    }
  }
}
