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

/**
 * Which Sheet, and which OAuth client to reach it with.
 *
 * Neither is a secret — the client id is a public identifier restricted by its
 * authorised origins, and the spreadsheet id is inert without access to the Sheet. They
 * live here rather than in the repo so one published build does not point every visitor
 * at one person's board. The access token itself is never stored; see src/sync/sheets.js.
 *
 * @returns {{ clientId: string, spreadsheetId: string } | null}
 */
export function loadCredentials() {
  const c = read(KEY_CREDS)
  if (!c || !c.clientId || !c.spreadsheetId) return null
  return { clientId: String(c.clientId), spreadsheetId: String(c.spreadsheetId) }
}

/** @param {{ clientId: string, spreadsheetId: string }} c */
export function saveCredentials(c) {
  write(KEY_CREDS, {
    clientId: String(c.clientId ?? '').trim(),
    spreadsheetId: String(c.spreadsheetId ?? '').trim(),
  })
}

export function clearCredentials() {
  try {
    localStorage.removeItem(KEY_CREDS)
  } catch {
    /* ignore */
  }
}

/**
 * @returns {{ tasks: any[], statuses: any[], categories: any[], priorities: any[],
 *             owners: any[], settings: Object, digests: Object<string,string>,
 *             fetchedAt: number } | null}
 */
export function loadSnapshot() {
  const s = read(KEY_SNAPSHOT)
  return s && Array.isArray(s.tasks) ? s : null
}

export function saveSnapshot(s) {
  write(KEY_SNAPSHOT, s)
}

/*
 * A save is fast now, but not instant, and a tab can close inside that window. The
 * pending payload is persisted before the request goes out and cleared only once the
 * write is confirmed, so an edit survives the app being closed mid-save.
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
