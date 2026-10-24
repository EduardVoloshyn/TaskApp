import { eq, ok, test } from './harness.js'
import { COLS, settingsToRows, sortTasks } from '../src/sync/schema.js'
import { isClientId, parseSpreadsheetId, rowsFromValues, tabCanon, tailRangesToClear } from '../src/sync/sheets.js'

/*
 * The Sheets backend, minus the parts that need a browser.
 *
 * fetch, crypto.subtle and Google Identity Services do not exist in jsc, so auth and
 * the digest are out of reach here. What IS covered is everything deciding what gets
 * written and whether a write is judged a conflict — where a mistake corrupts the Sheet
 * silently instead of throwing.
 */

/* --------------------------------------------------------------- input ---- */

test('parseSpreadsheetId takes a pasted URL or a bare id', () => {
  eq(parseSpreadsheetId('https://docs.google.com/spreadsheets/d/1AbC-_9/edit#gid=0'), '1AbC-_9')
  eq(parseSpreadsheetId('  1AbC-_9  '), '1AbC-_9')
  eq(parseSpreadsheetId(''), '')
  eq(parseSpreadsheetId(null), '')
})

test('isClientId accepts a Google client id and rejects a stray paste', () => {
  ok(isClientId('123-abc.apps.googleusercontent.com'))
  ok(!isClientId('123-abc'))
  ok(!isClientId(''))
})

/* ------------------------------------------------------- rowsFromValues ---- */

test('rowsFromValues maps by header name, not position', () => {
  // Shuffled relative to COLS.categories, which is ['id', 'name'].
  const rows = rowsFromValues([['name', 'id'], ['Робота', 'c1']], COLS.categories)
  eq(rows.length, 1)
  eq(rows[0].id, 'c1', 'read the id out of the wrong column')
  eq(rows[0].name, 'Робота')
})

test('rowsFromValues tolerates ragged rows (the API drops trailing blanks)', () => {
  const rows = rowsFromValues([COLS.owners, ['o1']], COLS.owners)
  eq(rows[0].name, '', 'a missing trailing cell should read as empty, not undefined')
})

test('rowsFromValues skips blank rows left behind by hand-editing', () => {
  const rows = rowsFromValues([COLS.owners, ['', ''], ['o1', 'Едуард']], COLS.owners)
  eq(rows.length, 1)
  eq(rows[0].id, 'o1')
})

test('rowsFromValues falls back to positional columns for an unrecognisable header', () => {
  const rows = rowsFromValues([['колонка1', 'колонка2'], ['c1', 'Робота']], COLS.categories)
  eq(rows[0].id, 'c1', 'positional fallback should still recover the data')
  eq(rows[0].name, 'Робота')
})

test('rowsFromValues returns nothing for an empty or header-only tab', () => {
  eq(rowsFromValues([], COLS.owners).length, 0)
  eq(rowsFromValues(undefined, COLS.owners).length, 0)
  eq(rowsFromValues([COLS.owners], COLS.owners).length, 0)
})

/* --------------------------------------------------------------- order ---- */

test('sortTasks orders by due date, blanks last, then by name', () => {
  const sorted = sortTasks([
    { name: 'Б', due_date: '' },
    { name: 'В', due_date: '2026-01-02' },
    { name: 'А', due_date: '' },
    { name: 'Г', due_date: '2026-01-01' },
  ])
  eq(sorted.map((t) => t.name).join(''), 'ГВАБ')
})

test('sortTasks does not mutate its input', () => {
  const input = [{ name: 'Б', due_date: '' }, { name: 'А', due_date: '2026-01-01' }]
  sortTasks(input)
  eq(input[0].name, 'Б', 'the caller’s array was reordered in place')
})

test('settingsToRows sorts keys, so the hash cannot depend on object order', () => {
  eq(settingsToRows({ b: '2', a: '1' }).map((r) => r.key).join(','), 'a,b')
})

/* ---------------------------------------------------------------- canon ---- */

test('tabCanon is order-sensitive, so reordering a reference list is a real change', () => {
  const rows = [{ id: 'c1', name: 'A' }, { id: 'c2', name: 'B' }]
  const flipped = [...rows].reverse()
  ok(
    tabCanon(rows, COLS.categories) !== tabCanon(flipped, COLS.categories),
    'row order is the board’s row/column order — reordering must not hash the same',
  )
})

test('tabCanon changes when a field changes, and is stable when nothing does', () => {
  const rows = [{ id: 'o1', name: 'Едуард' }]
  eq(tabCanon(rows, COLS.owners), tabCanon([{ id: 'o1', name: 'Едуард' }], COLS.owners))
  ok(tabCanon(rows, COLS.owners) !== tabCanon([{ id: 'o1', name: 'Соня' }], COLS.owners))
})

test('tabCanon cannot be fooled by shifting text across adjacent columns', () => {
  // Without a separator, {id:'ab', name:'c'} and {id:'a', name:'bc'} would collide.
  ok(tabCanon([{ id: 'ab', name: 'c' }], COLS.owners) !== tabCanon([{ id: 'a', name: 'bc' }], COLS.owners))
})

test('tabCanon treats an empty tab as the empty string', () => {
  eq(tabCanon([], COLS.owners), '')
  eq(tabCanon(undefined, COLS.owners), '')
})

/* ----------------------------------------------------------- tail clear ---- */

test('tailRangesToClear clears only rows the new data no longer covers', () => {
  // 10 rows on the sheet (header + 9), 3 tasks written back (header + 3 = 4).
  const ranges = tailRangesToClear({ tasks: 10 }, { tasks: [{}, {}, {}] }, ['tasks'])
  eq(ranges.length, 1)
  eq(ranges[0], 'tasks!A5:Z10')
})

test('tailRangesToClear clears nothing when the board grew or held steady', () => {
  eq(tailRangesToClear({ tasks: 2 }, { tasks: [{}, {}, {}] }, ['tasks']).length, 0)
  eq(tailRangesToClear({ tasks: 4 }, { tasks: [{}, {}, {}] }, ['tasks']).length, 0)
})

test('tailRangesToClear ignores tabs that were not written', () => {
  const ranges = tailRangesToClear({ tasks: 10, owners: 10 }, { tasks: [], owners: [] }, ['tasks'])
  eq(ranges.length, 1, 'an untouched tab must never be cleared')
  ok(ranges[0].startsWith('tasks!'))
})
