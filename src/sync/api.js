/**
 * Talks to the Apps Script Web App (apps-script/README.md).
 *
 * Two things about this endpoint that are easy to get wrong:
 *
 *  1. **Every response is HTTP 200.** Apps Script cannot set a meaningful status, so
 *     failures arrive as `{ ok: false, code }` in the body. Checking `res.ok` proves
 *     nothing — we check the body.
 *  2. **Every value comes back as a string.** The Sheet stringifies everything, so
 *     coercion below is mandatory, not tidying.
 *
 * Nothing waits on this: the cached copy is already on screen.
 */

/** Every Apps Script Web App lives under this prefix; only the id varies. */
const EXEC_PREFIX = 'https://script.google.com/macros/s/'
const EXEC_SUFFIX = '/exec'

/**
 * Builds the endpoint from a deployment id.
 *
 * The id is the only part the owner has to supply — the rest is fixed by Google, and
 * asking for the whole URL invited the two mistakes that actually happen: pasting the
 * `/dev` URL, which always demands a login, or dropping the `/exec` suffix.
 *
 * @param {{ deploymentId?: string }} creds
 * @returns {string}
 */
export function execUrl(creds) {
  return `${EXEC_PREFIX}${String(creds?.deploymentId ?? '').trim()}${EXEC_SUFFIX}`
}

/**
 * Accepts either a bare id or a pasted URL, and returns the id.
 *
 * Pasting the whole URL is the obvious thing to do out of habit, and silently failing
 * on it would be a poor first run.
 *
 * @param {string} input
 * @returns {string}
 */
export function parseDeploymentId(input) {
  const text = String(input ?? '').trim()
  if (!text) return ''

  const match = text.match(/\/macros\/s\/([^/\s?]+)/)
  if (match) return match[1]

  // Not a URL: take it as an id, minus anything that clearly is not part of one.
  return text.replace(/^\/+|\/+$/g, '').replace(/\/(exec|dev)$/, '')
}

export class ApiError extends Error {
  /** @param {string} message @param {string} code */
  constructor(message, code) {
    super(message)
    this.name = 'ApiError'
    this.code = code
  }
}

/**
 * @param {{ deploymentId: string, secret: string }} creds
 * @param {AbortSignal} [signal]
 */
export async function fetchBoard(creds, signal) {
  const url = `${execUrl(creds)}?action=board&secret=${encodeURIComponent(creds.secret)}`

  let res
  try {
    res = await fetch(url, { method: 'GET', redirect: 'follow', signal })
  } catch {
    // A CORS rejection is indistinguishable from being offline: both surface as an
    // opaque TypeError with no status.
    throw new ApiError(
      'Немає з’єднання. Перевірте адресу та доступ «Anyone» у розгортанні.',
      'network',
    )
  }

  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    // A dead or renamed deployment answers with Google's own HTML error page, which
    // is a different problem from a malformed response and deserves saying so.
    throw new ApiError(
      res.status === 404
        ? 'Розгортання не знайдено. Ймовірно, змінився Deployment ID — візьміть новий у Manage deployments.'
        : `Відповідь не JSON (HTTP ${res.status}). Схоже, ID розгортання неправильний.`,
      res.status === 404 ? 'not_found' : 'not_json',
    )
  }

  if (body.ok !== true) throw errorFor(body)

  return {
    tasks: (body.tasks || []).map(toTask),
    statuses: (body.statuses || []).map(toStatus),
    categories: (body.categories || []).map(toCategory),
    priorities: (body.priorities || []).map(toPriority),
    owners: (body.owners || []).map(toOwner),
    settings: body.settings || {},
    hash: body.hash || '',
    fetchedAt: Date.now(),
    schemaVersion: body.schema_version ? String(body.schema_version) : '',
    sheetVersion: body.sheet_version ? String(body.sheet_version) : '',
    migrationNeeded: Boolean(body.migration_needed),
  }
}

/**
 * Turns an API failure into something that says what to do about it.
 *
 * @param {{ ok?: boolean, code?: string, message?: string, errors?: string[] }} body
 */
function errorFor(body) {
  const code = body.code || 'unknown'

  if (code === 'unauthorized') {
    return new ApiError(
      'Секрет не збігається з тим, що в скрипті (SHARED_SECRET). ' +
        'Перевірте його в Apps Script і не забудьте опублікувати нову версію.',
      code,
    )
  }
  if (code === 'invalid') {
    return new ApiError(`Недійсні дані: ${(body.errors || []).join('; ')}`, code)
  }
  return new ApiError(body.message || `Помилка: ${code}`, code)
}

function toTask(raw) {
  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? ''),
    color: String(raw.color ?? ''),
    icon: raw.icon ? String(raw.icon) : '',
    status_id: raw.status_id ? String(raw.status_id) : '',
    category_id: raw.category_id ? String(raw.category_id) : '',
    priority_id: raw.priority_id ? String(raw.priority_id) : '',
    owner_id: raw.owner_id ? String(raw.owner_id) : '',
    due_date: raw.due_date ? String(raw.due_date) : '',
    notes: raw.notes ? String(raw.notes) : '',
  }
}

function toStatus(raw) {
  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? ''),
    color: String(raw.color ?? 'slate'),
    icon: raw.icon ? String(raw.icon) : '',
  }
}

function toCategory(raw) {
  return { id: String(raw.id ?? ''), name: String(raw.name ?? '') }
}

function toPriority(raw) {
  return { id: String(raw.id ?? ''), name: String(raw.name ?? ''), color: String(raw.color ?? 'slate') }
}

function toOwner(raw) {
  return { id: String(raw.id ?? ''), name: String(raw.name ?? '') }
}

/**
 * Replaces the whole board. Sends the hash from the last read; the API rejects the
 * write if the Sheet has moved on since — which is what catches the owner editing the
 * Sheet by hand.
 *
 * @param {{ deploymentId: string, secret: string }} creds
 * @param {{ hash: string, tasks: any[], statuses: any[], categories: any[],
 *           priorities: any[], owners: any[], settings: Object }} payload
 * @returns {Promise<{ hash: string, written: Object }>}
 */
export async function saveBoard(creds, payload) {
  let res
  try {
    res = await fetch(execUrl(creds), {
      method: 'POST',
      // text/plain is required, not sloppiness: it is CORS-safelisted, so the browser
      // skips the preflight OPTIONS that Apps Script cannot answer. The body is JSON.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      redirect: 'follow',
      body: JSON.stringify({
        secret: creds.secret,
        action: 'save',
        hash: payload.hash,
        tasks: payload.tasks,
        statuses: payload.statuses,
        categories: payload.categories,
        priorities: payload.priorities,
        owners: payload.owners,
        settings: payload.settings,
      }),
    })
  } catch {
    throw new ApiError('Немає з’єднання. Зміни збережено локально.', 'network')
  }

  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new ApiError(`Відповідь не JSON (HTTP ${res.status}).`, 'not_json')
  }

  if (body.ok !== true) {
    if (body.code === 'stale') {
      throw new ApiError('Таблицю змінено деінде. Оновіть і повторіть.', 'stale')
    }
    throw errorFor(body)
  }

  return { hash: body.hash, written: body.written }
}
