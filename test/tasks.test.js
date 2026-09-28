import { eq, ok, test } from './harness.js'
import {
  ORPHAN_CATEGORY_ID,
  ORPHAN_PRIORITY_ID,
  buildBoard,
  createTask,
  deleteTask,
  duplicateTask,
  findTask,
  isUsableTask,
  partitionUsable,
  statusProgress,
  updateTask,
} from '../src/model/tasks.js'

test('createTask trims the name and fills in an id', () => {
  const t = createTask({ name: '  Buy milk  ' })
  ok(t.id, 'no id generated')
  eq(t.name, 'Buy milk')
  eq(t.status_id, '')
  eq(t.due_date, '')
})

test('createTask keeps a given id', () => {
  const t = createTask({ id: 'fixed', name: 'x' })
  eq(t.id, 'fixed')
})

test('findTask finds by id', () => {
  const tasks = [createTask({ id: 'a', name: 'A' }), createTask({ id: 'b', name: 'B' })]
  eq(findTask(tasks, 'b').name, 'B')
  eq(findTask(tasks, 'missing'), undefined)
})

test('updateTask patches only the given fields', () => {
  const tasks = [createTask({ id: 'a', name: 'A', notes: 'n' })]
  const updated = updateTask(tasks, 'a', { name: 'A2' })
  eq(updated[0].name, 'A2')
  eq(updated[0].notes, 'n', 'untouched field was clobbered')
})

test('updateTask leaves other tasks alone', () => {
  const tasks = [createTask({ id: 'a', name: 'A' }), createTask({ id: 'b', name: 'B' })]
  const updated = updateTask(tasks, 'a', { name: 'A2' })
  eq(updated[1].name, 'B')
})

test('deleteTask removes only the named task', () => {
  const tasks = [createTask({ id: 'a', name: 'A' }), createTask({ id: 'b', name: 'B' })]
  eq(deleteTask(tasks, 'a').map((t) => t.id), ['b'])
})

test('duplicateTask copies every field but assigns a fresh id', () => {
  const task = createTask({ id: 'a', name: 'A', color: 'blue', icon: '📌', notes: 'n' })
  const copy = duplicateTask(task)
  ok(copy.id !== 'a', 'duplicate must get a new id')
  eq(copy.name, 'A')
  eq(copy.color, 'blue')
  eq(copy.icon, '📌')
  eq(copy.notes, 'n')
})

/* ---------------------------------------------------------------- statusProgress ---- */

const stages = [
  { id: 's1', name: 'To do', color: 'slate' },
  { id: 's2', name: 'Doing', color: 'blue' },
  { id: 's3', name: 'Done', color: 'green' },
]

test('statusProgress fills every stage up to and including the current one', () => {
  const task = createTask({ id: 't1', name: 'T', status_id: 's2' })
  const progress = statusProgress(stages, task)
  eq(progress.map((s) => s.filled), [true, true, false])
})

test('statusProgress fills nothing when the task has no status', () => {
  const task = createTask({ id: 't1', name: 'T' })
  const progress = statusProgress(stages, task)
  eq(progress.map((s) => s.filled), [false, false, false])
})

test('statusProgress fills nothing when the task names a deleted status', () => {
  const task = createTask({ id: 't1', name: 'T', status_id: 'gone' })
  const progress = statusProgress(stages, task)
  eq(progress.map((s) => s.filled), [false, false, false])
})

test('isUsableTask requires an id and a non-empty name', () => {
  eq(isUsableTask(createTask({ id: 'a', name: 'A' })), true)
  eq(isUsableTask({ id: 'a', name: '   ' }), false)
  eq(isUsableTask({ name: 'A' }), false, 'missing id must fail')
  eq(isUsableTask(null), false)
})

test('partitionUsable splits usable from unusable', () => {
  const good = createTask({ id: 'a', name: 'A' })
  const bad = { id: 'b', name: '' }
  const { usable, dropped } = partitionUsable([good, bad])
  eq(usable, [good])
  eq(dropped, [bad])
})

/* -------------------------------------------------------------------- board ---- */

const categories = [{ id: 'c1', name: 'Робота' }, { id: 'c2', name: 'Дім' }]
const priorities = [{ id: 'p1', name: 'Високий' }, { id: 'p2', name: 'Низький' }]

test('buildBoard has no orphan row/column when nothing is orphaned', () => {
  const { rows, cols } = buildBoard([], categories, priorities)
  eq(rows.length, 2, 'no tasks means no orphan row is needed')
  eq(cols.length, 2, 'no tasks means no orphan column is needed')
})

test('buildBoard adds an orphan row and column only once a task actually needs one', () => {
  const task = createTask({ id: 't1', name: 'T' }) // no category_id/priority_id
  const { rows, cols } = buildBoard([task], categories, priorities)
  eq(rows.length, 3, 'expected 2 categories + 1 orphan row')
  eq(cols.length, 3, 'expected 2 priorities + 1 orphan column')
  eq(rows.at(-1).id, ORPHAN_CATEGORY_ID)
  eq(cols.at(-1).id, ORPHAN_PRIORITY_ID)
})

test('buildBoard places a task in the cell matching its category and priority', () => {
  const task = createTask({ id: 't1', name: 'T', category_id: 'c1', priority_id: 'p1' })
  const { cellsByKey } = buildBoard([task], categories, priorities)
  eq(cellsByKey.get('c1|p1'), [task])
  eq(cellsByKey.get('c1|p2'), [])
})

test('a task with no category/priority lands in the orphan cell', () => {
  const task = createTask({ id: 't1', name: 'T' })
  const { cellsByKey } = buildBoard([task], categories, priorities)
  eq(cellsByKey.get(`${ORPHAN_CATEGORY_ID}|${ORPHAN_PRIORITY_ID}`), [task])
})

test('a task naming a deleted category still shows, in the orphan row', () => {
  // The category tab lost 'c-gone' since the task was created — never data loss.
  const task = createTask({ id: 't1', name: 'T', category_id: 'c-gone', priority_id: 'p1' })
  const { cellsByKey } = buildBoard([task], categories, priorities)
  eq(cellsByKey.get(`${ORPHAN_CATEGORY_ID}|p1`), [task])
})

test('a task naming a deleted priority still shows, in the orphan column', () => {
  const task = createTask({ id: 't1', name: 'T', category_id: 'c1', priority_id: 'p-gone' })
  const { cellsByKey } = buildBoard([task], categories, priorities)
  eq(cellsByKey.get(`c1|${ORPHAN_PRIORITY_ID}`), [task])
})

test('every category × priority combination gets a cell, even when empty', () => {
  const { cellsByKey } = buildBoard([], categories, priorities)
  eq(cellsByKey.size, categories.length * priorities.length)
  for (const value of cellsByKey.values()) eq(value, [])
})
