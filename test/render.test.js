import { eq, ok, test } from './harness.js'
import { installDom } from './dom-stub.js'

installDom()

const { board } = await import('../src/ui/board.js')
const { taskCard } = await import('../src/ui/task-card.js')
const { refPanel } = await import('../src/ui/ref-panel.js')
const { taskDialog } = await import('../src/ui/task-dialog.js')
const { createTask } = await import('../src/model/tasks.js')

/* ---------------------------------------------------------------- task-card ---- */

test('taskCard falls back to slate when its own colour is unknown', () => {
  const task = createTask({ id: 't1', name: 'T', color: 'not-a-colour' })
  const node = taskCard(task, { todayIso: '2026-01-01' })
  ok(node.className.includes('task-card--slate'), `got "${node.className}"`)
})

test('taskCard renders the icon then a literal space then the name', () => {
  const task = createTask({ id: 't1', name: 'Buy milk', icon: '📌' })
  const node = taskCard(task, { todayIso: '2026-01-01' })
  const heading = node.find('task-card__heading')
  ok(heading, 'no heading rendered')
  eq(heading.textContent, '📌 Buy milk')
})

test('taskCard renders no status bar when no statuses are defined', () => {
  const task = createTask({ id: 't1', name: 'T' })
  const node = taskCard(task, { statuses: [], todayIso: '2026-01-01' })
  eq(node.find('task-card__status-bar'), null)
})

test('taskCard fills status boxes up to the task\'s current stage', () => {
  const statuses = [
    { id: 's1', name: 'To do', color: 'slate' },
    { id: 's2', name: 'Doing', color: 'blue' },
    { id: 's3', name: 'Done', color: 'green' },
  ]
  const task = createTask({ id: 't1', name: 'T', status_id: 's2' })
  const node = taskCard(task, { statuses, todayIso: '2026-01-01' })
  const boxes = node.findAll('task-card__status-box')
  eq(boxes.length, 3, 'one box per defined status')
  eq(boxes.filter((b) => b.className.includes('task-card__status-box--filled')).length, 2)
})

test('taskCard leaves every status box empty when the task has no status', () => {
  const statuses = [{ id: 's1', name: 'To do', color: 'slate' }, { id: 's2', name: 'Done', color: 'green' }]
  const task = createTask({ id: 't1', name: 'T' })
  const node = taskCard(task, { statuses, todayIso: '2026-01-01' })
  const filled = node.findAll('task-card__status-box--filled')
  eq(filled.length, 0)
})

test('taskCard marks a past due date as overdue', () => {
  const task = createTask({ id: 't1', name: 'T', due_date: '2020-01-01' })
  const node = taskCard(task, { todayIso: '2026-01-01' })
  ok(node.find('task-card__due--overdue'), 'overdue class missing')
})

test('taskCard does not mark a future due date as overdue', () => {
  const task = createTask({ id: 't1', name: 'T', due_date: '2099-01-01' })
  const node = taskCard(task, { todayIso: '2026-01-01' })
  eq(node.find('task-card__due--overdue'), null)
})

test('taskCard shows a notes indicator only when notes are present', () => {
  const withNotes = taskCard(createTask({ id: 't1', name: 'T', notes: 'hi' }), { todayIso: '2026-01-01' })
  const without = taskCard(createTask({ id: 't2', name: 'T' }), { todayIso: '2026-01-01' })
  ok(withNotes.find('task-card__notes'))
  eq(without.find('task-card__notes'), null)
})

/* -------------------------------------------------------------------- board ---- */

const categories = [{ id: 'c1', name: 'Робота' }]
const priorities = [{ id: 'p1', name: 'Високий' }]

test('board renders one card per task, in the right cell', () => {
  const task = createTask({ id: 't1', name: 'T', category_id: 'c1', priority_id: 'p1' })
  const node = board({
    tasks: [task], categories, priorities,
    statuses: [], ownerById: new Map(),
    editing: false, todayIso: '2026-01-01',
    onOpenTask: () => {}, onCreateTask: () => {},
  })
  eq(node.findAll('task-card').length, 1)
})

test('board omits the orphan row/column when nothing is orphaned', () => {
  const task = createTask({ id: 't1', name: 'T', category_id: 'c1', priority_id: 'p1' })
  const node = board({
    tasks: [task], categories, priorities,
    statuses: [], ownerById: new Map(),
    editing: false, todayIso: '2026-01-01',
    onOpenTask: () => {}, onCreateTask: () => {},
  })
  const rowLabels = node.findAll('board__row-label').map((n) => n.textContent)
  const colLabels = node.findAll('board__col-label').map((n) => n.textContent)
  eq(rowLabels.includes('Без категорії'), false, rowLabels.join(', '))
  eq(colLabels.includes('Без пріоритету'), false, colLabels.join(', '))
})

test('board includes an orphan row and column label once a task needs one', () => {
  const orphanTask = createTask({ id: 't2', name: 'T2' }) // no category_id/priority_id
  const node = board({
    tasks: [orphanTask], categories, priorities,
    statuses: [], ownerById: new Map(),
    editing: false, todayIso: '2026-01-01',
    onOpenTask: () => {}, onCreateTask: () => {},
  })
  const rowLabels = node.findAll('board__row-label').map((n) => n.textContent)
  const colLabels = node.findAll('board__col-label').map((n) => n.textContent)
  ok(rowLabels.includes('Без категорії'), rowLabels.join(', '))
  ok(colLabels.includes('Без пріоритету'), colLabels.join(', '))
})

test('a priority with a colour tints its column header', () => {
  const colouredPriorities = [{ id: 'p1', name: 'Високий', color: 'red' }]
  const task = createTask({ id: 't1', name: 'T', category_id: 'c1', priority_id: 'p1' })
  const node = board({
    tasks: [task], categories, priorities: colouredPriorities,
    statuses: [], ownerById: new Map(),
    editing: false, todayIso: '2026-01-01',
    onOpenTask: () => {}, onCreateTask: () => {},
  })
  const label = node.findAll('board__col-label').find((n) => n.textContent === 'Високий')
  ok(label.className.includes('board__col-label--red'), `got "${label.className}"`)
})

test('clicking a card opens it, when editing is on', () => {
  const task = createTask({ id: 't1', name: 'T', category_id: 'c1', priority_id: 'p1' })
  let opened = null
  const node = board({
    tasks: [task], categories, priorities,
    statuses: [], ownerById: new Map(),
    editing: true, todayIso: '2026-01-01',
    onOpenTask: (id) => { opened = id }, onCreateTask: () => {},
  })
  node.dispatch('click', { target: node.find('task-card') })
  eq(opened, 't1')
})

/* ----------------------------------------------------------------- ref-panel ---- */

test('refPanel shows the empty hint when there are no items', () => {
  const dialog = refPanel({
    title: 'Категорії', items: [], emptyHint: 'Поки порожньо.',
    renderRow: () => ({ nodes: [] }), onEdit: () => {}, onCreate: () => {},
  })
  ok(dialog.textContent.includes('Поки порожньо.'))
})

test('refPanel renders one row per item and opens it on click', () => {
  let edited = null
  const dialog = refPanel({
    title: 'Категорії',
    items: [{ id: 'c1', name: 'Робота' }],
    emptyHint: 'x',
    renderRow: (item) => ({ nodes: [] }),
    onEdit: (item) => { edited = item.id },
    onCreate: () => {},
  })
  eq(dialog.findAll('ref-list__row').length, 1)
  dialog.find('ref-list__pick').dispatch('click', {})
  eq(edited, 'c1')
})

test('refPanel disables ▲ on the first row and ▼ on the last, and reports the direction', () => {
  let reordered = null
  const dialog = refPanel({
    title: 'Категорії',
    items: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    emptyHint: 'x',
    renderRow: () => ({ nodes: [] }),
    onEdit: () => {},
    onCreate: () => {},
    onReorder: (item, direction) => { reordered = `${item.id}:${direction}` },
  })
  const rows = dialog.findAll('ref-list__row')
  const moves = (row) => row.findAll('ref-list__move')

  ok(moves(rows[0])[0].disabled, 'first row should not be able to move up')
  ok(moves(rows[1])[1].disabled, 'last row should not be able to move down')

  moves(rows[0])[1].dispatch('click', {}) // row A, move down
  eq(reordered, 'a:down')
})

/* ---------------------------------------------------------------- task-dialog ---- */

const refCategories = [{ id: 'c1', name: 'Робота' }]
const refPriorities = [{ id: 'p1', name: 'Високий' }]

test('taskDialog blocks save without a category and a priority', () => {
  const task = createTask({ id: 't1', name: 'T' }) // no category_id/priority_id
  const dialog = taskDialog({
    task, isNew: true,
    statuses: [], categories: [], priorities: [], owners: [],
    onSave: () => {},
  })
  const save = dialog.findAll('app__button').find((b) => b.textContent.includes('Зберегти'))
  ok(save.disabled, 'save should be disabled with no categories/priorities to choose from')
})

test('taskDialog defaults to the first category/priority and allows saving', () => {
  const task = createTask({ id: 't1', name: 'T' }) // no category_id/priority_id set
  let saved = null
  const dialog = taskDialog({
    task, isNew: true,
    statuses: [], categories: refCategories, priorities: refPriorities, owners: [],
    onSave: (values) => { saved = values },
  })
  const save = dialog.findAll('app__button').find((b) => b.textContent.includes('Зберегти'))
  eq(save.disabled, false, 'a lone category/priority should be selected by default')

  dialog.find('sheet__form').dispatch('submit', { preventDefault: () => {} })
  eq(saved.category_id, 'c1')
  eq(saved.priority_id, 'p1')
})

test('taskDialog offers Duplicate for an existing task, not a new one', () => {
  const task = createTask({ id: 't1', name: 'T', category_id: 'c1', priority_id: 'p1' })
  let duplicated = false

  const existing = taskDialog({
    task, isNew: false,
    statuses: [], categories: refCategories, priorities: refPriorities, owners: [],
    onSave: () => {}, onDuplicate: () => { duplicated = true },
  })
  const duplicateButton = existing.findAll('app__button').find((b) => b.textContent.includes('Дублювати'))
  ok(duplicateButton, 'no Duplicate button for an existing task')
  duplicateButton.dispatch('click', {})
  eq(duplicated, true)

  const fresh = taskDialog({
    task, isNew: true,
    statuses: [], categories: refCategories, priorities: refPriorities, owners: [],
    onSave: () => {}, onDuplicate: () => {},
  })
  eq(fresh.findAll('app__button').some((b) => b.textContent.includes('Дублювати')), false, 'a new task has nothing to duplicate yet')
})
