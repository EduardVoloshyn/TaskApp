import { eq, ok, test } from './harness.js'
import {
  ORPHAN_CATEGORY_ID,
  ORPHAN_PRIORITY_ID,
  buildBoard,
  clampProgress,
  createTask,
  deleteTask,
  duplicateTask,
  findTask,
  fromPercent,
  isTaskCompleted,
  isUsableTask,
  partitionUsable,
  progressBounds,
  progressForStatus,
  toPercent,
  updateTask,
} from '../src/model/tasks.js'
import { tickPlacements } from '../src/ui/fields.js'

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


const stages = [
  { id: 's1', name: 'To do', color: 'slate' },
  { id: 's2', name: 'Doing', color: 'blue' },
  { id: 's3', name: 'Done', color: 'green' },
]

test('isTaskCompleted is true when the task matches the last status', () => {
  const task = createTask({ id: 't1', name: 'T', status_id: 's3' })
  eq(isTaskCompleted(task, stages), true)
})

test('isTaskCompleted is false when the task matches a non-last status', () => {
  const task = createTask({ id: 't1', name: 'T', status_id: 's2' })
  eq(isTaskCompleted(task, stages), false)
})

test('isTaskCompleted is false when the task has no status', () => {
  const task = createTask({ id: 't1', name: 'T' })
  eq(isTaskCompleted(task, stages), false)
})

test('isTaskCompleted is false when the task names a deleted/unknown status', () => {
  const task = createTask({ id: 't1', name: 'T', status_id: 'gone' })
  eq(isTaskCompleted(task, stages), false)
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

/* ---------------------------------------------------------------- progress ---- */

// Ordered stages, as the Settings list holds them: order IS the sequence.
const STAGES = [
  { id: 's1', name: 'Взято в роботу', start_percent: 0 },
  { id: 's2', name: 'В процессі', start_percent: 0.25 },
  { id: 's3', name: 'Майже Закінчено', start_percent: 0.75 },
  { id: 's4', name: 'Завершено', start_percent: 0.9 },
]

test('toPercent/fromPercent round-trip a whole percent', () => {
  eq(toPercent(0.45), 45)
  eq(fromPercent(45), 0.45)
  eq(toPercent(fromPercent(7)), 7)
})

test('toPercent clamps out-of-range and junk to 0..100', () => {
  eq(toPercent(1.5), 100)
  eq(toPercent(-1), 0)
  eq(toPercent(undefined), 0)
  eq(toPercent('nonsense'), 0)
})

test('a middle status runs from its own start to just below the next', () => {
  const { min, max } = progressBounds(STAGES, 's2')
  eq(min, 25)
  eq(max, 74, 'must stop one percent short of the next stage, which starts at 75')
})

test('the last status is the only one that can reach 100', () => {
  const { min, max } = progressBounds(STAGES, 's4')
  eq(min, 90)
  eq(max, 100)
})

test('the first status starts at its own value, not implicitly at zero', () => {
  const shifted = [{ id: 'a', start_percent: 0.1 }, { id: 'b', start_percent: 0.5 }]
  eq(progressBounds(shifted, 'a').min, 10)
})

test('no status, or a deleted one, leaves progress unconstrained', () => {
  eq(progressBounds(STAGES, '').max, 100)
  eq(progressBounds(STAGES, 'gone').min, 0)
  eq(progressBounds([], 's1').max, 100)
})

test('an out-of-order sequence collapses rather than inverting', () => {
  // Someone set a later stage lower than an earlier one in Settings.
  const broken = [{ id: 'a', start_percent: 0.8 }, { id: 'b', start_percent: 0.2 }]
  const { min, max } = progressBounds(broken, 'a')
  eq(min, 80)
  eq(max, 80, 'max must never fall below min')
})

test('progressForStatus gives the stage its start value', () => {
  eq(progressForStatus(STAGES, 's3'), 0.75)
  eq(progressForStatus(STAGES, 'gone'), 0, 'an unknown status cannot imply progress')
})

test('clampProgress pulls a value into its stage', () => {
  eq(clampProgress(0.05, STAGES, 's2'), 0.25, 'below the stage start')
  eq(clampProgress(0.99, STAGES, 's2'), 0.74, 'at or past the next stage')
  eq(clampProgress(0.5, STAGES, 's2'), 0.5, 'already inside the stage')
  eq(clampProgress(1, STAGES, 's4'), 1, 'the last stage may reach 100%')
})

test('createTask and updateTask carry progress as a clamped fraction', () => {
  eq(createTask({ name: 'x' }).progress_percent, 0)
  eq(createTask({ name: 'x', progress_percent: 0.4 }).progress_percent, 0.4)
  eq(createTask({ name: 'x', progress_percent: 5 }).progress_percent, 1, 'out of range must clamp')

  const list = [createTask({ id: 't1', name: 'x' })]
  eq(updateTask(list, 't1', { progress_percent: 0.6 })[0].progress_percent, 0.6)
  eq(updateTask(list, 't1', { name: 'y' })[0].progress_percent, 0, 'untouched by unrelated edits')
})

test('duplicating a task carries its progress over', () => {
  const original = createTask({ name: 'x', progress_percent: 0.33 })
  eq(duplicateTask(original).progress_percent, 0.33)
})


/* ------------------------------------------------------------- tick layout ---- */

const at = (starts) => starts.map((s, i) => ({ id: 's' + i, start_percent: s / 100 }))

test('tick labels are centred, and clamped at both ends so they cannot spill out', () => {
  const ticks = tickPlacements(at([0, 50, 100]))
  eq(ticks[0].style.left, '0', 'a tick at the very start anchors to the left edge')
  eq(ticks[1].style.transform, 'translateX(-50%)')
  eq(ticks[2].style.right, '0', 'a tick at the very end anchors to the right edge')
})

test('a tick too close to the previous one is dropped rather than overlapping it', () => {
  // The real case: stages at 95 and 100 rendered as "95 %100".
  eq(tickPlacements(at([10, 20, 95, 100])).map((t) => t.at).join(','), '10,20,95')
})

test('well-spaced stages all keep their tick', () => {
  eq(tickPlacements(at([0, 25, 75, 90])).map((t) => t.at).join(','), '0,25,75,90')
})
