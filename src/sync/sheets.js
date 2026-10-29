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
 *   save   0 requests  when no tab actually differs
 *          2 requests  batchGet of just the changed tabs (conflict check), then
 *                      batchUpdate of those same tabs
 *          3 requests  plus batchClear, when a tab shrank and left orphaned rows
 *
 * Two properties worth knowing:
 *
 *  - **No lock.** The conflict check is read-compare-then-write, so a window exists
 *    between check and write. This app has one writer (ADR-0004); the digests are
 *    there to catch the Sheet being hand-edited, not to arbitrate a race.
 *  - **No server-side validation.** The task dialog enforces the required fields.
 */

import { COLS, TABS, rowsToSettings, settingsToRows, sortTasks } from './schema.js'
import { REQUIRED_SCHEMA_VERSION } from '../version.js'
import { toFraction } from '../model/tasks.js'

const API_ROOT = 'https://sheets.googleapis.com/v4/spreadsheets'
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets'

/* Direct API calls answer in a few hundred ms; a request still running after this is
 * not slow, it is lost. Apps Script needed 25s, which only made a hang hurt longer. */
const TIMEOUT_MS = 15000

/** Renew the token this long before it expires, whenever a click gives us the chance. */
const RENEW_BEFORE_MS = 10 * 60 * 1000

/** And if a renewal fails, wait this long before letting another click try again. */
const RENEW_COOLDOWN_MS = 60 * 1000

/** How long to wait for the Google script tag, which loads async. */
const GIS_WAIT_MS = 4000

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
 * Asks Google for an access token.
 *
 * Always `prompt: ''`, never `'consent'`. Empty means "reuse the grant I already
 * have", and Google still shows the grant screen by itself the first time, or after
 * the grant is revoked — so forcing consent buys nothing and costs the screen on
 * every single sign-in. That is what made the grant window keep reappearing: the
 * token is memory-only, so every reload needed a new one, and every one of those
 * re-asked for permission already given.
 *
 * @param {string} clientId
 * @returns {Promise<string>}
 */
function requestToken(clientId) {
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
        reject(authError(response.error))
        return
      }
      accessToken = response.access_token
      // A minute of slack, so a token cannot expire mid-request.
      expiresAt = Date.now() + (Number(response.expires_in || 3600) - 60) * 1000
      resolve(accessToken)
    }
    client.error_callback = (err) => reject(authError(err?.type))

    try {
      client.requestAccessToken({ prompt: '' })
    } catch (err) {
      reject(authError(err?.message))
    }
  })
}

/**
 * Google's own reason for refusing, turned into something actionable.
 *
 * Every auth failure used to throw one string, which made four unrelated problems
 * look identical: an account that is not permitted, an origin missing from the OAuth
 * client, a popup the browser blocked, and the Google script never loading. Telling
 * them apart meant reading raw OAuth parameters off Google's error page.
 *
 * `access_denied` deliberately does NOT get code `needs_signin`: signing in again
 * cannot fix it, and offering that button would send the user in a circle.
 *
 * @param {string} [reason] Google's error string, where it gave one
 */
function authError(reason) {
  if (reason === 'access_denied') {
    return new ApiError(
      'Google не дозволив доступ цьому акаунту. Додайте його в Test users у Google Cloud ' +
        '(console.cloud.google.com/auth/audience) і поділіться таблицею з ним як Редактор.',
      'access_denied',
    )
  }

  // Closing the popup is a decision, not a fault; a blocked one just needs a click.
  if (reason === 'popup_closed_by_user' || reason === 'popup_failed_to_open') {
    return new ApiError('Потрібен вхід у Google.', 'needs_signin')
  }

  // Anything unrecognised keeps Google's wording, so it is at least searchable —
  // same approach as the Sheets 403 below.
  return new ApiError(
    reason ? `Потрібен вхід у Google. (${reason})` : 'Потрібен вхід у Google.',
    'needs_signin',
  )
}

/**
 * From a real click in Settings or the setup card, so a popup is allowed. Google
 * decides whether any screen is needed: none when the grant stands, the account
 * chooser when several accounts are signed in, the grant screen only when there is
 * genuinely nothing to reuse.
 */
export function connect(clientId) {
  return requestToken(clientId)
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
  requestToken(clientId)
    .catch(() => {
      /* Best effort. A save asks properly, via the banner's sign-in button. */
    })
    .finally(() => {
      renewing = false
    })
}

/** Resolves once the async-loaded Google script is usable, or false if it never is. */
async function gisWhenReady() {
  if (gisReady()) return true
  const deadline = Date.now() + GIS_WAIT_MS
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    if (gisReady()) return true
  }
  return false
}

/**
 * Produces a usable token, silently re-establishing one when we have none.
 *
 * The token is deliberately memory-only, so every page reload starts without one.
 * Without this, a reload greeted the user with a sign-in banner before the board had
 * even tried to load. `prompt: ''` reuses the grant already given, so normally nothing
 * is shown; if the browser blocks it for want of a user gesture, this fails as
 * `needs_signin` and the banner's button takes over.
 *
 * Rate-limited by the same cooldown as touchAuth, so one failure cannot become one
 * popup attempt per request.
 */
async function token(clientId) {
  if (isConnected()) return accessToken
  if (!clientId) throw new ApiError('Потрібен вхід у Google.', 'needs_signin')
  if (renewing || Date.now() - lastRenewAt < RENEW_COOLDOWN_MS) {
    throw new ApiError('Потрібен вхід у Google.', 'needs_signin')
  }
  if (!(await gisWhenReady())) {
    throw new ApiError('Google-скрипт входу не завантажився. Перевірте з’єднання.', 'needs_signin')
  }

  renewing = true
  lastRenewAt = Date.now()
  try {
    return await requestToken(clientId)
  } finally {
    renewing = false
  }
}

/* -------------------------------------------------------------- transport ---- */

async function call(creds, url, init = {}) {
  const bearer = await token(creds.clientId)

  const controller = typeof AbortController === 'undefined' ? null : new AbortController()
  const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : 0

  let res
  try {
    res = await fetch(url, {
      ...init,
      signal: controller?.signal,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${bearer}` },
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

/* ---------------------------------------------------------------- digests ---- */

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

/** Tabs whose content is compared for conflicts. `meta` carries updated_at, which
 *  changes on every save by design, so it is never part of the comparison. */
const DATA_TABS = TABS.filter((tab) => tab !== 'meta')

async function digest(text) {
  if (text === '') return ''
  const bytes = new TextEncoder().encode(text)
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * A fingerprint per tab, rather than one for the whole board.
 *
 * This is what lets a save read and compare only the tabs it is about to write: a task
 * edit no longer has to prove that `owners` is untouched. Digested rather than kept as
 * the raw canonical strings, because these are persisted in the snapshot and the raw
 * form would be a verbatim second copy of the entire board.
 *
 * @param {Object<string, any[]>} rowsByTab rows per tab, in their written order
 * @returns {Promise<Object<string, string>>}
 */
export async function tabDigests(rowsByTab) {
  const out = {}
  await Promise.all(
    DATA_TABS.map(async (tab) => {
      out[tab] = await digest(tabCanon(rowsByTab[tab], COLS[tab]))
    }),
  )
  return out
}

/** Tabs where `b` differs from `a`. Absent on either side counts as different. */
export function changedTabs(a, b) {
  return DATA_TABS.filter((tab) => (a?.[tab] ?? null) !== (b?.[tab] ?? null))
}

/**
 * Shapes the client's board into exactly the rows that will be written.
 *
 * Must run before digesting: `tasks` is reordered on the way out, so digesting the
 * unsorted client array would never match what the next read returns.
 */
function toRows(payload) {
  return {
    tasks: sortTasks(payload.tasks || []),
    statuses: payload.statuses || [],
    categories: payload.categories || [],
    priorities: payload.priorities || [],
    owners: payload.owners || [],
    settings: settingsToRows(payload.settings),
  }
}

/* ------------------------------------------------------------------ board ---- */

/**
 * @param {{ spreadsheetId: string }} creds
 * @param {string[]} [tabs] which tabs to fetch; all of them by default
 */
async function read(creds, tabs = TABS) {
  const ranges = tabs.map((t) => `ranges=${encodeURIComponent(t)}`).join('&')
  const body = await call(
    creds,
    `${API_ROOT}/${encodeURIComponent(creds.spreadsheetId)}/values:batchGet` +
      `?${ranges}&valueRenderOption=UNFORMATTED_VALUE`,
  )

  const valueRanges = body.valueRanges || []
  const rowsByTab = {}
  const heights = {}
  tabs.forEach((tab, i) => {
    const values = valueRanges[i]?.values || []
    heights[tab] = values.length
    rowsByTab[tab] = rowsFromValues(values, COLS[tab])
  })
  return { rowsByTab, heights }
}

/** @param {{ spreadsheetId: string }} creds */
export async function fetchBoard(creds) {
  const { rowsByTab } = await read(creds)
  const meta = rowsToSettings(rowsByTab.meta)

  // Defaults applied here rather than in five render paths; everything downstream may
  // assume a status/priority has a colour and that the percent fields are numbers.
  // rowsFromValues stringifies every cell, so the fractions arrive as text.
  const withColour = (rows) => rows.map((r) => (r.color ? r : { ...r, color: 'slate' }))
  const withFraction = (rows, key) => rows.map((r) => ({ ...r, [key]: toFraction(r[key]) }))

  return {
    tasks: withFraction(rowsByTab.tasks, 'progress_percent'),
    statuses: withFraction(withColour(rowsByTab.statuses), 'start_percent'),
    categories: rowsByTab.categories,
    priorities: withColour(rowsByTab.priorities),
    owners: rowsByTab.owners,
    settings: rowsToSettings(rowsByTab.settings),
    digests: await tabDigests(rowsByTab),
    fetchedAt: Date.now(),
    sheetVersion: meta.schema_version ? String(meta.schema_version) : '',
  }
}

/* ------------------------------------------------------------------ write ---- */

/**
 * Writes only the tabs that actually changed, and reads back only those same tabs to
 * check for a conflict first.
 *
 * Three cost tiers, which is the point of the per-tab digests:
 *
 *   nothing changed    0 requests  (an untouched dialog closed with Save, an undone
 *                                   reorder — previously still cost a full round trip)
 *   a task edited      2 requests  (read `tasks` + `meta`, write `tasks` + `meta`)
 *   a tab shrank       3 requests  (the above, plus clearing the orphaned rows)
 *
 * Writes before clearing: a failure in between leaves stale rows below the real data,
 * which the next save tidies, where the reverse order could truncate the Sheet.
 *
 * @param {{ spreadsheetId: string }} creds
 * @param {{ digests: Object<string,string>, tasks: any[], statuses: any[],
 *           categories: any[], priorities: any[], owners: any[], settings: Object }} payload
 *   `digests` is the board as it stood on the Sheet at the last read or write.
 */
export async function saveBoard(creds, payload) {
  const outgoing = toRows(payload)
  const next = await tabDigests(outgoing)
  const changed = changedTabs(payload.digests, next)

  // Nothing to send. Worth the check: every dialog Save goes through here, including
  // the ones where the user changed their mind and changed it back.
  if (!changed.length) return { digests: payload.digests, written: [] }

  // Only the tabs being written have to be proven untouched. A hand-edit to `owners`
  // is no longer a reason to reject a task save.
  const current = await read(creds, [...changed, 'meta'])
  const onSheet = await tabDigests(current.rowsByTab)
  const conflicts = changed.filter((tab) => onSheet[tab] !== payload.digests?.[tab])
  if (conflicts.length) {
    throw new ApiError('Таблицю змінено деінде. Оновіть і повторіть.', 'stale')
  }

  outgoing.meta = [
    { key: 'schema_version', value: REQUIRED_SCHEMA_VERSION },
    { key: 'updated_at', value: new Date().toISOString() },
  ]
  const writing = [...changed, 'meta']

  await call(creds, `${API_ROOT}/${encodeURIComponent(creds.spreadsheetId)}/values:batchUpdate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // RAW, so Sheets stores "2026-01-01" as the string it is instead of reading it as
    // a date. This is what setNumberFormat('@') used to buy.
    body: JSON.stringify({
      valueInputOption: 'RAW',
      data: writing.map((tab) => ({
        range: `${tab}!A1`,
        values: [COLS[tab], ...outgoing[tab].map((row) => COLS[tab].map((c) => (row[c] == null ? '' : String(row[c]))))],
      })),
    }),
  })

  const stale = tailRangesToClear(current.heights, outgoing, writing)
  if (stale.length) {
    await call(creds, `${API_ROOT}/${encodeURIComponent(creds.spreadsheetId)}/values:batchClear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ranges: stale }),
    })
  }

  return { digests: { ...payload.digests, ...next }, written: changed }
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
