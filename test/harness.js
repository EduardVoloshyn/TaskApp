/**
 * A ~70-line test harness. No dependencies, so the suite runs in two places with no
 * install: `jsc -m test/run.js` in the terminal, and test/index.html in any browser.
 */

const registered = []

/** @param {string} name @param {() => void} fn */
export function test(name, fn) {
  registered.push({ name, fn })
}

export class AssertionError extends Error {}

function fail(message) {
  throw new AssertionError(message)
}

export function ok(condition, detail = '') {
  if (!condition) fail(`expected truthy${detail ? ` — ${detail}` : ''}`)
}

export function eq(actual, expected, detail = '') {
  if (!deepEqual(actual, expected)) {
    fail(`expected ${show(expected)} but got ${show(actual)}${detail ? ` — ${detail}` : ''}`)
  }
}

export function close(actual, expected, epsilon = 1e-9, detail = '') {
  if (!(Math.abs(actual - expected) <= epsilon)) {
    fail(`expected ~${expected} but got ${actual}${detail ? ` — ${detail}` : ''}`)
  }
}

export function throws(fn, detail = '') {
  try {
    fn()
  } catch {
    return
  }
  fail(`expected a throw${detail ? ` — ${detail}` : ''}`)
}

function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null) return false
  if (typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) => deepEqual(a[k], b[k]))
}

function show(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Runs everything registered. Returns results; printing is the caller's job.
 *
 * Async, and each test is awaited: a sync test returns undefined, which await passes
 * straight through, and a rejected async test is recorded as a failure rather than
 * going nowhere.
 *
 * Sequential rather than parallel: tests share the stub DOM and a global fetch, so
 * running them concurrently would have them tread on each other.
 *
 * @returns {Promise<{results: {name: string, passed: boolean, message: string}[],
 *                    passed: number, failed: number}>}
 */
export async function run() {
  const results = []

  for (const { name, fn } of registered) {
    try {
      await fn()
      results.push({ name, passed: true, message: '' })
    } catch (err) {
      results.push({ name, passed: false, message: err && err.message ? err.message : String(err) })
    }
  }

  return {
    results,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
  }
}
