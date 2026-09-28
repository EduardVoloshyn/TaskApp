/*
 * localStorage, not IndexedDB. The whole board is a few KB, and synchronous reads
 * mean the first paint already has data — no loading state on open.
 *
 * Credentials live here and only here: never in the repo, never in the deployed files,
 * because a static bundle is readable by anyone who loads it.
 */

const KEY_CREDS = 'taskapp.credentials'
const KEY_SNAPSHOT = 'taskapp.snapshot'
const KEY_PENDING = 'taskapp.pending'
const KEY_PREFS = 'taskapp.prefs'

/** @param {string} key */
function read(key) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    // Private browsing, or a corrupt value. Treat as absent rather than crashing.
    return null
  }
}

/** @param {string} key @param {unknown} value */
function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* quota or private mode — the app still works, it just won't remember */
  }
}

/** @returns {{ deploymentId: string, secret: string } | null} */
export function loadCredentials() {
  const c = read(KEY_CREDS)
  if (!c || !c.secret || !c.deploymentId) return null
  return { deploymentId: String(c.deploymentId), secret: String(c.secret) }
}

/** @param {{ deploymentId: string, secret: string }} c */
export function saveCredentials(c) {
  write(KEY_CREDS, {
    deploymentId: String(c.deploymentId).trim(),
    secret: String(c.secret).trim(),
  })
}

export function clearCredentials() {
  try {
    localStorage.removeItem(KEY_CREDS)
  } catch {
    /* ignore */
  }
}

/** @returns {{ tasks: any[], statuses: any[], categories: any[], priorities: any[], owners: any[], settings: Object, hash: string, fetchedAt: number } | null} */
export function loadSnapshot() {
  const s = read(KEY_SNAPSHOT)
  return s && Array.isArray(s.tasks) ? s : null
}

export function saveSnapshot(s) {
  write(KEY_SNAPSHOT, s)
}

/*
 * A write takes a few seconds against Apps Script — ample time to close the tab
 * mid-save. The pending payload is therefore persisted before the request goes out
 * and cleared only once the server confirms, so a save survives the app being closed.
 */

export function loadPending() {
  return read(KEY_PENDING)
}

export function savePending(payload) {
  write(KEY_PENDING, payload)
}

export function clearPending() {
  try {
    localStorage.removeItem(KEY_PENDING)
  } catch {
    /* ignore */
  }
}

/** Device-local preferences: editing flag, theme, hidden-filter sets. */
export function loadPrefs() {
  return read(KEY_PREFS) || {}
}

export function savePrefs(prefs) {
  write(KEY_PREFS, prefs)
}
