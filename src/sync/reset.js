/*
 * Recovery from a wedged client.
 *
 * A cache-first service worker can serve a broken version of the app indefinitely —
 * including a version whose own recovery code never runs, because the worker is what
 * hands out the code. That deadlock is why this lives in a URL parameter as well as a
 * button: a URL still works when the app itself will not load.
 *
 *   ?reset       clear the service worker and its caches, keep your data
 *   ?reset=all   the above, plus credentials, cached board and preferences
 */

const APP_KEYS = [
  'taskapp.credentials',
  'taskapp.snapshot',
  'taskapp.pending',
  'taskapp.prefs',
]

/** @returns {null | 'cache' | 'all'} */
export function resetRequested() {
  if (typeof location === 'undefined') return null
  const value = new URLSearchParams(location.search).get('reset')
  if (value === null) return null
  return value === 'all' ? 'all' : 'cache'
}

/**
 * Tears down the client and reloads. Always resolves — a failure here must not leave
 * the user with no way out.
 *
 * @param {{ data?: boolean }} [options] also wipe stored data
 */
export async function hardReset(options = {}) {
  try {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations()
      await Promise.all(registrations.map((r) => r.unregister()))
    }
  } catch {
    /* keep going: the caches matter more than the registration */
  }

  try {
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys()
      await Promise.all(keys.map((k) => caches.delete(k)))
    }
  } catch {
    /* ignore */
  }

  if (options.data) {
    for (const key of APP_KEYS) {
      try {
        localStorage.removeItem(key)
      } catch {
        /* ignore */
      }
    }
  }

  // Reload without the parameter, so a bookmark cannot wipe things on every visit.
  const url = new URL(location.href)
  url.searchParams.delete('reset')
  location.replace(url.toString())
}
