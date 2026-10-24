/*
 * The backend. The browser talks to the Sheets REST API v4 directly — there is no
 * server, no Apps Script, and no second transport to stay compatible with.
 *
 * Why no Apps Script: its Web App layer intermittently never answers. Server-side
 * executions completed in 5–6s when a request reached them, but a large share of
 * requests hung until the client timeout with no execution logged at all, stalling at
 * the `/exec -> 302 -> echo?user_content_key=...` delivery hop. Reproduced in Incognito,
 * on plain reads, after a quota reset. See ADR-0007.
 *
 * Shape of a sync, both directions:
 *
 *   read   1 request   values:batchGet over every tab
 *   save   2 requests  batchGet (conflict check) + batchUpdate (changed tabs only)
 *          3rd only when a tab shrank and its leftover rows need clearing
 *
 * Two properties worth knowing:
 *
 *  - **No lock.** The conflict check is read-hash-compare-then-write, so a window
 *    exists between check and write. This app has one writer (ADR-0004); the content
 *    hash is there to catch the Sheet being hand-edited, not to arbitrate a race.
 *  - **No server-side validation.** The task dialog enforces the required fields.
 */

import { COLS, TABS, rowsToSettings, settingsToRows, sortTasks } from './schema.js'
import { REQUIRED_SCHEMA_VERSION } from '../version.js'

const API_ROOT = 'https://sheets.googleapis.com/v4/spreadsheets'
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets'

/* Direct API calls answer in a few hundred ms; a request still running after this is
 * not slow, it is lost. Apps Script needed 25s, which only made a hang hurt longer. */
const TIMEOUT_MS = 15000

/** Renew the token this long before it expires, whenever a click gives us the chance. */
const RENEW_BEFORE_MS = 10 * 60 * 1000

/** And if a renewal fails, wait this long before letting another click try again. */
const RENEW_COOLDOWN_MS = 60 * 1000

export class ApiError extends Error {
  /** @param {string} message @param {string} code */
  constructor(message, code) {
    super(message)
    this.name = 'ApiError'
    this.code = code
  }
}

/* ------------------------------------------------------------------ input ---- */

/** Accepts the Sheet's full URL or a bare id — pasting the URL is the obvious move. */
export function parseSpreadsheetId(input) {
  const text = String(input ?? '').trim()
  if (!text) return ''
  const match = text.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)
  return match ? match[1] : text.replace(/^\/+|\/+$/g, '')
}

/** An OAuth client id is public, not a secret, but it must at least look like one. */
export function isClientId(value) {
  return /\.apps\.googleusercontent\.com$/.test(String(value ?? '').trim())
}

/* ------------------------------------------------------------------- auth ---- */

/*
 * The access token lives here and nowhere else. It is a bearer credential with write
 * access to the Sheet, it expires in an hour, and localStorage would hand it to
 * anything that can read this origin.
 */
let accessToken = ''
let expiresAt = 0
let tokenClient = null
let tokenClientId = ''
let renewing = false
let lastRenewAt = 0

function gisReady() {
  return typeof google !== 'undefined' && Boolean(google.accounts?.oauth2)
}

export function isConnected() {
  return Boolean(accessToken) && Date.now() < expiresAt
}

function clientFor(clientId) {
  if (!gisReady()) {
    throw new ApiError('Google-скрипт входу не завантажився. Перевірте з’єднання.', 'needs_signin')
  }
  // Rebuilt if the id changed, so switching accounts in Settings actually takes effect.
  if (!tokenClient || tokenClientId !== clientId) {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: () => {},
    })
    tokenClientId = clientId
  }
  return tokenClient
}

/**
 * @param {string} clientId
 * @param {boolean} consent true on a first connect, to force the grant screen
 * @returns {Promise<string>}
 */
function requestToken(clientId, consent) {
  return new Promise((resolve, reject) => {
    let client
    try {
      client = clientFor(clientId)
    } catch (err) {
      reject(err)
      return
    }

    client.callback = (response) => {
      if (response.error || !response.access_token) {
        reject(new ApiError('Потрібен вхід у Google.', 'needs_signin'))
        return
      }
      accessToken = response.access_token
      // A minute of slack, so a token cannot expire mid-request.
      expiresAt = Date.now() + (Number(response.expires_in || 3600) - 60) * 1000
      resolve(accessToken)
    }
    client.error_callback = () => reject(new ApiError('Потрібен вхід у Google.', 'needs_signin'))

    try {
      client.requestAccessToken({ prompt: consent ? 'consent' : '' })
    } catch {
      reject(new ApiError('Потрібен вхід у Google.', 'needs_signin'))
    }
  })
}

/** From a real click in Settings or the setup card, so it may show the grant screen. */
export function connect(clientId) {
  return requestToken(clientId, !isConnected())
}

export function disconnect() {
  const stale = accessToken
  accessToken = ''
  expiresAt = 0
  tokenClient = null
  tokenClientId = ''
  if (stale && gisReady()) google.accounts.oauth2.revoke(stale, () => {})
}

/**
 * Renews the token early, riding on a click the user already made.
 *
 * Renewal opens a popup, and browsers only allow that from a user gesture — which a
 * debounced background save does not have. Without this, every token expiry surfaced as
 * a failed save and a "sign in" button. Called from a document-level click listener, it
 * means the token is almost always fresh by the time a save needs it, and the grant
 * screen stays hidden because the grant already exists.
 */
export function touchAuth(clientId) {
  if (!clientId || !gisReady() || renewing) return

  // Only ever RENEWS an existing grant. Acquiring the FIRST token must stay an
  // explicit act: doing it from here meant that whenever we had no token — including
  // right after a failure cleared it — every single click reopened the Google account
  // chooser, which is unusable.
  if (!accessToken) return
  if (Date.now() < expiresAt - RENEW_BEFORE_MS) return
  // A failed renewal must not retry on the very next click.
  if (Date.now() - lastRenewAt < RENEW_COOLDOWN_MS) return

  renewing = true
  lastRenewAt = Date.now()
  requestToken(clientId, false)
    .catch(() => {
      /* Best effort. A save asks properly, via the banner's sign-in button. */
    })
    .finally(() => {
      renewing = false
    })
}

/* -------------------------------------------------------------- transport ---- */

async function call(url, init = {}) {
  if (!isConnected()) throw new ApiError('Потрібен вхід у Google.', 'needs_signin')

  const controller = typeof AbortController === 'undefined' ? null : new AbortController()
  const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : 0

  let res
  try {
    res = await fetch(url, {
      ...init,
      signal: controller?.signal,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${accessToken}` },
    })
  } catch (err) {
    if (err?.name === 'AbortError') throw new ApiError('Сервер не відповідає. Спробуйте ще раз.', 'timeout')
    throw new ApiError('Немає з’єднання з Google Sheets.', 'network')
  } finally {
    if (timer) clearTimeout(timer)
  }

  // 401 means the token is bad — drop it and ask for a new one. 403 does NOT: the
  // token is fine, the account simply is not allowed to do this. Clearing it and
  // demanding a re-login just loops the account chooser without fixing anything,
  // because the real cause is the Sheets API being disabled or the Sheet not being
  // shared with the signed-in account.
  if (res.status === 401) {
    accessToken = ''
    expiresAt = 0
    throw new ApiError('Термін дії доступу минув. Увійдіть у Google ще раз.', 'needs_signin')
  }

  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new ApiError(`Відповідь не JSON (HTTP ${res.status}).`, 'not_json')
  }

  if (res.status === 403) {
    // Google's own message names the cause; prefixing it with the two things it
    // actually turns out to be saves a round of guessing.
    throw new ApiError(
      'Google відмовив у доступі. Перевірте, що Sheets API увімкнено в проєкті та що ' +
        `таблицею поділилися з обліковим записом, у який ви увійшли. (${body?.error?.message || '403'})`,
      'forbidden',
    )
  }

  if (!res.ok) {
    throw new ApiError(
      body?.error?.message || `Помилка Google Sheets (HTTP ${res.status})`,
      res.status === 404 ? 'not_found' : 'sheets_error',
    )
  }
  return body
}

/* ------------------------------------------------------------------- read ---- */

/**
 * Raw 2D values -> row objects, mapped by header NAME, never by position.
 *
 * Mapping by name is what makes a column insert safe: it can never shift one field's
 * data into another. It also makes adding a column free — one the Sheet lacks reads as
 * empty, and appears on the next write. Tolerant of ragged rows, since the API drops
 * trailing blank cells.
 */
export function rowsFromValues(values, cols) {
  if (!values || values.length < 1) return []

  const width = values[0].length
  const header = values[0].map((h) => String(h ?? '').trim())

  const indexOf = {}
  for (const col of cols) indexOf[col] = header.indexOf(col)

  // No recognisable header: fall back to position rather than reading the tab as empty,
  // which would look exactly like the data having been deleted.
  if (indexOf[cols[0]] === -1) cols.forEach((col, i) => { indexOf[col] = i < width ? i : -1 })

  const rows = []
  for (let r = 1; r < values.length; r++) {
    const row = values[r]
    const out = {}
    let empty = true
    for (const col of cols) {
      const at = indexOf[col]
      const raw = at >= 0 && at < width ? row[at] : ''
      out[col] = raw === null || raw === undefined ? '' : String(raw).trim()
      if (out[col] !== '') empty = false
    }
    if (!empty) rows.push(out) // skip blank rows left behind by hand-editing
  }
  return rows
}

/* ------------------------------------------------------------------- hash ---- */

/**
 * One canonical string per tab, in the tab's own written row order.
 *
 * Deliberately order-SENSITIVE, unlike the Apps Script version this replaces, which
 * sorted reference lists by id before hashing. That sort meant reordering categories by
 * hand in the Sheet produced an identical hash and was silently overwritten — and row
 * order is the board's row/column order, so it is real data. One order-sensitive
 * canonical form now serves both jobs: conflict detection, and deciding which tabs
 * actually need writing.
 */
export function tabCanon(rows, cols) {
  if (!rows || !rows.length) return ''
  return rows
    .map((r) => cols.map((c) => (r[c] === null || r[c] === undefined ? '' : String(r[c]))).join(''))
    .join('')
}

function canonByTab(rowsByTab) {
  const out = {}
  for (const tab of TABS) out[tab] = tabCanon(rowsByTab[tab], COLS[tab])
  return out
}

/** `meta` is excluded: it carries updated_at, which changes on every save by design. */
function boardCanonical(canons) {
  return TABS.filter((t) => t !== 'meta').map((t) => `${t}${canons[t]}`).join('')
}

async function hashOf(canons) {
  const bytes = new TextEncoder().encode(boardCanonical(canons))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/* ------------------------------------------------------------------ board ---- */

async function readAll(creds) {
  const ranges = TABS.map((t) => `ranges=${encodeURIComponent(t)}`).join('&')
  const body = await call(
    `${API_ROOT}/${encodeURIComponent(creds.spreadsheetId)}/values:batchGet` +
      `?${ranges}&valueRenderOption=UNFORMATTED_VALUE`,
  )

  const valueRanges = body.valueRanges || []
  const rowsByTab = {}
  const heights = {}
  TABS.forEach((tab, i) => {
    const values = valueRanges[i]?.values || []
    heights[tab] = values.length
    rowsByTab[tab] = rowsFromValues(values, COLS[tab])
  })
  return { rowsByTab, heights, canons: canonByTab(rowsByTab) }
}

/** @param {{ spreadsheetId: string }} creds */
export async function fetchBoard(creds) {
  const { rowsByTab, canons } = await readAll(creds)
  const meta = rowsToSettings(rowsByTab.meta)

  // A blank colour cell becomes the palette default here rather than in five render
  // paths; everything downstream may assume a status/priority has one.
  const withColour = (rows) => rows.map((r) => (r.color ? r : { ...r, color: 'slate' }))

  return {
    tasks: rowsByTab.tasks,
    statuses: withColour(rowsByTab.statuses),
    categories: rowsByTab.categories,
    priorities: withColour(rowsByTab.priorities),
    owners: rowsByTab.owners,
    settings: rowsToSettings(rowsByTab.settings),
    hash: await hashOf(canons),
    fetchedAt: Date.now(),
    sheetVersion: meta.schema_version ? String(meta.schema_version) : '',
  }
}

/* ------------------------------------------------------------------ write ---- */

/**
 * Replaces the board, guarded by the content hash, writing only the tabs that differ.
 *
 * Writes first and clears leftover rows second. A failure between the two leaves stale
 * rows below the real data, which the next save tidies; the reverse order would risk a
 * failure between clear and write leaving the Sheet truncated.
 *
 * @param {{ spreadsheetId: string }} creds
 * @param {{ hash: string, tasks: any[], statuses: any[], categories: any[],
 *           priorities: any[], owners: any[], settings: Object }} payload
 */
export async function saveBoard(creds, payload) {
  const current = await readAll(creds)

  if (payload.hash !== (await hashOf(current.canons))) {
    throw new ApiError('Таблицю змінено деінде. Оновіть і повторіть.', 'stale')
  }

  // Only tasks are reordered, to a deterministic order. categories/priorities/statuses
  // keep the order the client holds: that order is the board's layout and the status
  // progression, not a display nicety.
  const outgoing = {
    tasks: sortTasks(payload.tasks || []),
    statuses: payload.statuses || [],
    categories: payload.categories || [],
    priorities: payload.priorities || [],
    owners: payload.owners || [],
    settings: settingsToRows(payload.settings),
    meta: [{ key: 'schema_version', value: REQUIRED_SCHEMA_VERSION }, { key: 'updated_at', value: '' }],
  }

  const nextCanons = canonByTab(outgoing)
  const changed = TABS.filter((tab) => tab !== 'meta' && nextCanons[tab] !== current.canons[tab])

  // updated_at is stamped only when something actually changed, so a no-op save stays
  // a no-op rather than dirtying the Sheet's own modified time.
  if (changed.length) {
    outgoing.meta[1].value = new Date().toISOString()
    changed.push('meta')

    await call(`${API_ROOT}/${encodeURIComponent(creds.spreadsheetId)}/values:batchUpdate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // RAW, so Sheets stores "2026-01-01" as the string it is instead of reading it as
      // a date. This is what setNumberFormat('@') used to buy.
      body: JSON.stringify({
        valueInputOption: 'RAW',
        data: changed.map((tab) => ({
          range: `${tab}!A1`,
          values: [COLS[tab], ...outgoing[tab].map((row) => COLS[tab].map((c) => (row[c] == null ? '' : String(row[c]))))],
        })),
      }),
    })

    const stale = tailRangesToClear(current.heights, outgoing, changed)
    if (stale.length) {
      await call(`${API_ROOT}/${encodeURIComponent(creds.spreadsheetId)}/values:batchClear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ranges: stale }),
      })
    }
  }

  return { hash: await hashOf(nextCanons), written: changed }
}

/**
 * Rows a shrunken tab left behind, as A1 ranges.
 *
 * Exported for tests: too few ranges strands deleted tasks on the Sheet, too many wipes
 * live ones.
 *
 * @param {Object<string, number>} heights row counts before the write, header included
 * @param {Object<string, any[]>} outgoing rows being written, header excluded
 * @param {string[]} tabs only the tabs actually written
 */
export function tailRangesToClear(heights, outgoing, tabs) {
  const ranges = []
  for (const tab of tabs) {
    const before = heights[tab] || 0
    const after = outgoing[tab].length + 1 // + header row
    if (before > after) ranges.push(`${tab}!A${after + 1}:Z${before}`)
  }
  return ranges
}
