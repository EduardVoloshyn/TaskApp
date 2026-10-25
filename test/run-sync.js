/**
 * The request-path suite, run in its own process.
 *
 * It installs a working `fetch`, a granted OAuth token and a `crypto.subtle` stub —
 * all global. The DOM suites boot the real `src/app.js`, which would then happily sync
 * against those stubs mid-run and replace the board under the assertions. Separate
 * processes is the honest fix; shared-global cleanup was not.
 *
 * `jsc -m test/run-sync.js`
 */
import './sync.test.js'
import { run } from './harness.js'

const { results, passed, failed } = await run()

for (const r of results) {
  print(`  ${r.passed ? 'PASS' : 'FAIL'}  ${r.name}`)
  if (!r.passed) print(`        ${r.message}`)
}

print('')
print(failed === 0 ? `ALL PASS — ${passed} tests` : `${failed} FAILED, ${passed} passed`)
