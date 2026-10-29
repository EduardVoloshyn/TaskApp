import { eq, ok, test } from './harness.js'

/*
 * Exercises the actual request path — the one thing the other suites never touch.
 *
 * This exists because a release shipped with `call()` invoking a `token()` that had
 * been deleted: every pure test passed, because nothing ever ran a request. Stubbing
 * fetch and the two browser APIs the module needs is enough to catch that class of
 * bug, plus the URL shapes and the conflict logic.
 *
 * The digest stub is not a real SHA-256 and does not need to be: the code only ever
 * compares digests it produced itself.
 */

const { connect, fetchBoard, saveBoard } = await import('../src/sync/sheets.js')

const CREDS = { clientId: 'test.apps.googleusercontent.com', spreadsheetId: 'SHEET1' }

/** Rows as the API returns them: header first, everything stringly typed. */
const sheet = () => ({
  tasks: [
    ['id', 'name', 'color', 'icon', 'status_id', 'category_id', 'priority_id', 'owner_id', 'due_date', 'notes', 'progress_percent'],
    ['t1', 'Написати звіт', 'blue', '', 's1', 'c1', 'p1', '', '', '', '0.25'],
  ],
  statuses: [['id', 'name', 'color', 'icon', 'start_percent'], ['s1', 'В процессі', 'blue', '', '0.25']],
  categories: [['id', 'name'], ['c1', 'Робота']],
  priorities: [['id', 'name', 'color'], ['p1', 'Високий', 'red']],
  owners: [['id', 'name']],
  settings: [['key', 'value']],
  meta: [['key', 'value'], ['schema_version', '4']],
})

let calls = []
let tabs = sheet()
let prompts = []
// Set to make the stubbed Google refuse, the way it does for a real account that
// is not on the Test users list.
let authResponse = null

/*
 * Installed per test rather than at import time: these are global, and the other
 * suites must not inherit a working fetch or a granted token from this one.
 */
function install() {
  calls = []
  tabs = sheet()
  prompts = []
  authResponse = null

  globalThis.TextEncoder = class {
    encode(text) {
      return { text }
    }
  }

  // Not a real SHA-256, and it does not need to be: the code only ever compares
  // digests against others it produced itself.
  globalThis.crypto = {
    subtle: {
      digest: async (_algo, bytes) => {
        let h = 0
        for (const ch of String(bytes.text)) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0
        return new Uint8Array([(h >>> 24) & 255, (h >>> 16) & 255, (h >>> 8) & 255, h & 255])
      },
    },
  }

  // A grant already in place, so the module never reaches for a popup.
  globalThis.google = {
    accounts: {
      oauth2: {
        initTokenClient: (config) => ({
          ...config,
          requestAccessToken(options) {
            prompts.push(options?.prompt)
            if (authResponse) this.callback(authResponse)
            else this.callback({ access_token: 'test-token', expires_in: 3600 })
          },
        }),
        revoke: () => {},
      },
    },
  }
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null
    calls.push({ url, method: init.method || 'GET', body })
    const ranges = [...url.matchAll(/ranges=([^&]+)/g)].map((m) => decodeURIComponent(m[1]))
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ valueRanges: ranges.map((r) => ({ values: tabs[r] })) }),
    }
  }
}

const requests = () => calls.map((c) => `${c.method} ${c.url.split('/').pop().split('?')[0]}`)

install()
await connect(CREDS.clientId)

/* ----------------------------------------------------------------- read ---- */

test('fetchBoard reads every tab in exactly one request', async () => {
  install()
  await fetchBoard(CREDS)
  eq(calls.length, 1, `expected one batchGet, got ${requests().join(', ')}`)
  ok(calls[0].url.includes('values:batchGet'))
  eq(calls[0].method, 'GET')
})

test('fetchBoard returns typed rows, with percents as numbers', async () => {
  install()
  const board = await fetchBoard(CREDS)
  eq(board.tasks.length, 1)
  eq(board.tasks[0].name, 'Написати звіт')
  eq(board.tasks[0].progress_percent, 0.25, 'the fraction must arrive as a number, not "0.25"')
  eq(board.statuses[0].start_percent, 0.25)
  eq(board.sheetVersion, '4')
  ok(board.digests.tasks, 'a digest per tab is what later saves compare against')
})

/* ---------------------------------------------------------------- write ---- */

test('an unchanged board costs zero requests', async () => {
  install()
  const board = await fetchBoard(CREDS)
  install()
  const result = await saveBoard(CREDS, board)
  eq(calls.length, 0, `a no-op save must not touch the network, sent ${requests().join(', ')}`)
  eq(result.written.length, 0)
})

test('editing a task reads back and writes only that tab, plus meta', async () => {
  install()
  const board = await fetchBoard(CREDS)
  install()
  await saveBoard(CREDS, { ...board, tasks: [{ ...board.tasks[0], name: 'Змінено' }] })

  eq(calls.length, 2, `expected a read then a write, got ${requests().join(', ')}`)
  const read = [...calls[0].url.matchAll(/ranges=([^&]+)/g)].map((m) => decodeURIComponent(m[1]))
  eq(read.sort().join(','), 'meta,tasks', 'the dictionaries must not be re-read')

  eq(calls[1].method, 'POST')
  ok(calls[1].url.includes('values:batchUpdate'))
  eq(calls[1].body.valueInputOption, 'RAW', 'anything else lets Sheets reinterpret dates')
  eq(calls[1].body.data.map((d) => d.range.split('!')[0]).sort().join(','), 'meta,tasks')
})

test('a write sends the header row followed by the data', async () => {
  install()
  const board = await fetchBoard(CREDS)
  install()
  await saveBoard(CREDS, { ...board, owners: [{ id: 'o1', name: 'Едуард' }] })

  const owners = calls[1].body.data.find((d) => d.range.startsWith('owners'))
  eq(owners.values[0].join(','), 'id,name', 'the header must be rewritten every time')
  eq(owners.values[1].join(','), 'o1,Едуард')
})

test('a shrunken tab gets its orphaned rows cleared, in a third request', async () => {
  install()
  const board = await fetchBoard(CREDS)
  install()
  await saveBoard(CREDS, { ...board, tasks: [] })

  eq(calls.length, 3, `expected read, write, clear — got ${requests().join(', ')}`)
  ok(calls[2].url.includes('values:batchClear'))
  eq(calls[2].body.ranges[0], 'tasks!A2:Z2', 'only the row the deleted task occupied')
})

test('a change made on the Sheet since the last read is refused as stale', async () => {
  install()
  const board = await fetchBoard(CREDS)

  install()
  tabs.tasks[1][1] = 'Хтось редагував вручну'
  let error = null
  try {
    await saveBoard(CREDS, { ...board, tasks: [{ ...board.tasks[0], name: 'Моя зміна' }] })
  } catch (err) {
    error = err
  }
  ok(error, 'a concurrent hand-edit must not be silently overwritten')
  eq(error.code, 'stale')
  eq(calls.length, 1, 'it must fail on the read, before writing anything')
})

test('a hand-edit to an unrelated tab does not block the save', async () => {
  install()
  const board = await fetchBoard(CREDS)

  install()
  tabs.owners = [['id', 'name'], ['o9', 'Хтось новий']]
  await saveBoard(CREDS, { ...board, tasks: [{ ...board.tasks[0], name: 'Моя зміна' }] })
  eq(calls.length, 2, 'owners is not being written, so its state is irrelevant')
})


/* ----------------------------------------------------------------- auth ---- */

test('signing in never forces the consent screen', async () => {
  install()
  await connect(CREDS.clientId)
  // `prompt: 'consent'` re-asks for permission already granted, and the token is
  // memory-only — so every reload would show the grant window again.
  eq(prompts.at(-1), '', `asked with prompt "${prompts.at(-1)}"`)
})

test('an account Google refuses is told why, and not offered a pointless re-login', async () => {
  install()
  authResponse = { error: 'access_denied' }

  let failure = null
  try {
    await connect(CREDS.clientId)
  } catch (err) {
    failure = err
  }

  ok(failure, 'a refused grant must reject, not resolve')
  // Not needs_signin: signing in again with the same account fails identically, so the
  // banner must offer "another account" instead.
  eq(failure.code, 'access_denied')
  ok(failure.message.includes('Test users'), `message was "${failure.message}"`)
})

test("an unrecognised refusal keeps Google's own wording", async () => {
  install()
  authResponse = { error: 'some_future_reason' }

  let failure = null
  try {
    await connect(CREDS.clientId)
  } catch (err) {
    failure = err
  }

  eq(failure.code, 'needs_signin', 'unknown reasons stay retryable')
  ok(failure.message.includes('some_future_reason'), `swallowed it: "${failure.message}"`)
})
