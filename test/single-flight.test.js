import { eq, ok, test } from './harness.js'
import { singleFlight } from '../src/sync/single-flight.js'

/*
 * The guard that stops two saves going out at once. Worth testing directly: the
 * failure it prevents surfaces as `locked` or `stale` from the backend, which reads
 * like a server fault rather than a client bug.
 *
 * These are async tests; the harness runs a returned promise to completion.
 */

const defer = () => {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

test('a single call runs the task and returns its value', async () => {
  const run = singleFlight(async (n) => n * 2)
  eq(await run(21), 42)
})

test('a call made during a run does not start a second one', async () => {
  let started = 0
  const gate = defer()
  const run = singleFlight(async () => {
    started += 1
    await gate.promise
  })

  const first = run()
  const second = run()
  const third = run()
  eq(started, 1, `${started} runs started`)

  gate.resolve()
  await Promise.all([first, second, third])
  eq(started, 1, 'a collapsed call started its own run')
})

test('collapsed calls trigger exactly one rerun, after success', async () => {
  let reruns = 0
  const gate = defer()
  const run = singleFlight(async () => { await gate.promise }, { onRerun: () => { reruns += 1 } })

  const first = run()
  await run()
  await run()
  eq(reruns, 0, 'rerun fired before the run finished')

  gate.resolve()
  await first
  eq(reruns, 1, `${reruns} reruns for three collapsed calls`)
})

test('no rerun when nothing was collapsed', async () => {
  let reruns = 0
  const run = singleFlight(async () => {}, { onRerun: () => { reruns += 1 } })
  await run()
  eq(reruns, 0)
})

test('a failed run does not trigger a rerun', async () => {
  // The UI offers a retry. Repeating a doomed request automatically would just hammer
  // the endpoint — and the likely cause, a stale hash, will not fix itself.
  let reruns = 0
  const gate = defer()
  const run = singleFlight(async () => { await gate.promise }, { onRerun: () => { reruns += 1 } })

  const first = run()
  await run()
  gate.reject(new Error('save failed'))

  let threw = false
  await first.catch(() => { threw = true })
  ok(threw, 'the failure was swallowed instead of propagating')
  eq(reruns, 0, 'a rerun was armed after a failure')
})

test('a failure does not leave the guard stuck', async () => {
  // If `running` were not cleared on the error path, every later save would be
  // silently dropped and the app would look like it had stopped saving.
  let started = 0
  const run = singleFlight(async () => {
    started += 1
    if (started === 1) throw new Error('first fails')
  })

  await run().catch(() => {})
  await run()
  eq(started, 2, 'the guard stayed latched after a failure')
})

test('a failure does not leave a rerun armed for the next success', async () => {
  let reruns = 0
  let attempt = 0
  const run = singleFlight(
    async () => {
      attempt += 1
      if (attempt === 1) {
        // collapse a call into this failing run
        await Promise.resolve()
        throw new Error('nope')
      }
    },
    { onRerun: () => { reruns += 1 } },
  )

  const failing = run()
  await run()
  await failing.catch(() => {})
  eq(reruns, 0)

  await run()
  eq(reruns, 0, 'a rerun left over from the failed run fired later')
})

test('runs are sequential across separate awaited calls', async () => {
  const order = []
  const run = singleFlight(async (label) => {
    order.push(`${label}:start`)
    await Promise.resolve()
    order.push(`${label}:end`)
  })

  await run('a')
  await run('b')
  eq(order, ['a:start', 'a:end', 'b:start', 'b:end'])
})
