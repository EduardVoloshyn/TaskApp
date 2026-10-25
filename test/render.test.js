import { eq, ok, test } from './harness.js'
import { installDom } from './dom-stub.js'

installDom()

const { board } = await import('../src/ui/board.js')
const { taskCard, shortDate } = await import('../src/ui/task-card.js')
const { refPanel } = await import('../src/ui/ref-panel.js')
const { filterBar } = await import('../src/ui/filter-bar.js')
const { taskDialog } = await import('../src/ui/task-dialog.js')
const { refSheet } = await import('../src/ui/ref-sheet.js')
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

test('taskCard draws the progress strip as its first line', () => {
  const statuses = [
    { id: 's1', name: 'To do', color: 'slate', start_percent: 0 },
    { id: 's2', name: 'Doing', color: 'blue', start_percent: 0.3 },
    { id: 's3', name: 'Done', color: 'green', start_percent: 0.9 },
  ]
  const task = createTask({ id: 't1', name: 'T', status_id: 's2', progress_percent: 0.45 })
  const node = taskCard(task, { statuses, todayIso: '2026-01-01' })

  const strip = node.find('task-card__progress')
  ok(strip, 'no progress strip on the card')
  eq(node.children[0], strip, 'the strip must be the first line, above the heading')

  const fill = strip.findAll('progress__segments').find((s) => s.className.includes('--fill'))
  eq(fill.styleProps['--progress-clip'], '55%', 'the fill must match the task\u2019s own percent')
})

test('the card strip places bands exactly where the dialog slider does', () => {
  const statuses = [
    { id: 's1', name: 'To do', color: 'slate', start_percent: 0.1 },
    { id: 's2', name: 'Done', color: 'green', start_percent: 0.6 },
  ]
  const node = taskCard(createTask({ id: 't1', name: 'T', status_id: 's1' }), { statuses, todayIso: '2026-01-01' })
  const segs = node.find('task-card__progress').findAll('progress__segments')[0].findAll('progress__seg')
  eq(segs.map((s) => s.styleProps.left).join(','), '10%,60%')
})

test('the card strip shows the same two layers as the dialog slider', () => {
  const statuses = [
    { id: 's1', name: 'To do', color: 'green', start_percent: 0 },
    { id: 's2', name: 'Done', color: 'green', start_percent: 0.6 },
  ]
  const card = taskCard(createTask({ id: 't1', name: 'T', status_id: 's1' }), { statuses, todayIso: '2026-01-01' })
  eq(card.find('task-card__progress').findAll('progress__segments').length, 2, 'pale bands plus fill')

  const dialog = taskDialog({
    task: createTask({ id: 't1', name: 'T', category_id: 'c1', priority_id: 'p1', status_id: 's1' }),
    isNew: false, statuses, categories: refCategories, priorities: refPriorities, owners: [],
    onSave: () => {},
  })
  eq(dialog.find('progress__band').findAll('progress__segments').length, 2, 'the two must match')
})

test('taskCard still draws a strip when no statuses are defined', () => {
  const node = taskCard(createTask({ id: 't1', name: 'T' }), { statuses: [], todayIso: '2026-01-01' })
  ok(node.find('task-card__progress'), 'an empty board should show an empty track, not nothing')
  eq(node.find('task-card__progress').findAll('progress__segments')[0].findAll('progress__seg').length, 1)
})

test('a task with no progress shows an empty strip', () => {
  const statuses = [{ id: 's1', name: 'To do', color: 'slate', start_percent: 0 }]
  const node = taskCard(createTask({ id: 't1', name: 'T' }), { statuses, todayIso: '2026-01-01' })
  const fill = node.find('task-card__progress').findAll('progress__segments').find((s) => s.className.includes('--fill'))
  eq(fill.styleProps['--progress-clip'], '100%')
})

test('taskCard collapses to a single struck-through line when the task is completed', () => {
  const statuses = [
    { id: 's1', name: 'To do', color: 'slate' },
    { id: 's2', name: 'Done', color: 'green' },
  ]
  const task = createTask({ id: 't1', name: 'Buy milk', status_id: 's2', due_date: '2020-01-01', notes: 'x' })
  const node = taskCard(task, { statuses, owner: { name: 'X' }, todayIso: '2026-01-01' })
  ok(node.className.includes('task-card--completed'), `got "${node.className}"`)
  ok(node.find('task-card__name').className.includes('task-card__name--done'))
  eq(node.find('task-card__meta-row'), null)
  eq(node.find('task-card__progress'), null, 'a done card is one line — no strip either')
})

test('taskCard does not collapse a task on a non-last status', () => {
  const statuses = [
    { id: 's1', name: 'To do', color: 'slate' },
    { id: 's2', name: 'Done', color: 'green' },
  ]
  const task = createTask({ id: 't1', name: 'T', status_id: 's1' })
  const node = taskCard(task, { statuses, todayIso: '2026-01-01' })
  eq(node.className.includes('task-card--completed'), false)
  ok(node.find('task-card__progress'))
})

test('a long name is clamped visually but kept whole in the tooltip', () => {
  const long = 'НОВІ конкурси Каталог з датами (InfomatrixUk Bennington) і ще трохи тексту'
  const node = taskCard(createTask({ id: 't1', name: long }), { statuses: [], todayIso: '2026-10-25' })
  // The clamp itself is CSS (-webkit-line-clamp); what must hold here is that nothing
  // truncates the underlying text, so the title still carries all of it.
  eq(node.title, long)
  eq(node.find('task-card__name').textContent, long)
})

test('the due date drops the parts that carry no information', () => {
  eq(shortDate('2026-10-22', '2026-10-25'), '22.10', 'same year: day and month only')
  eq(shortDate('2027-01-09', '2026-10-25'), '09.01.27', 'another year has to say so')
  eq(shortDate('', '2026-10-25'), '', 'no date, nothing to shorten')
  eq(shortDate('next tuesday', '2026-10-25'), 'next tuesday', 'the Sheet is hand-editable — pass it through')
})

test('the card shows the short date but keeps the full one in its tooltip', () => {
  const task = createTask({ id: 't1', name: 'T', due_date: '2026-10-22' })
  const node = taskCard(task, { statuses: [], todayIso: '2026-10-25' })
  eq(node.find('task-card__due').textContent, '22.10')
  eq(node.find('task-card__due').title, '2026-10-22')
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

test('refPanel delete icon asks for confirmation, then deletes', () => {
  let deleted = null
  globalThis.confirm = () => true
  const dialog = refPanel({
    title: 'Категорії',
    items: [{ id: 'c1', name: 'Робота' }],
    emptyHint: 'x',
    renderRow: () => ({ nodes: [] }),
    onEdit: () => {},
    onCreate: () => {},
    onDelete: (item) => { deleted = item.id },
  })
  dialog.find('ref-list__delete').dispatch('click', {})
  eq(deleted, 'c1')
})

test('refPanel delete icon does nothing when confirmation is declined', () => {
  let deleted = null
  globalThis.confirm = () => false
  const dialog = refPanel({
    title: 'Категорії',
    items: [{ id: 'c1', name: 'Робота' }],
    emptyHint: 'x',
    renderRow: () => ({ nodes: [] }),
    onEdit: () => {},
    onCreate: () => {},
    onDelete: (item) => { deleted = item.id },
  })
  dialog.find('ref-list__delete').dispatch('click', {})
  eq(deleted, null)
  globalThis.confirm = () => true // restore the default for every test after this one
})

/* ---------------------------------------------------------------- filter-bar ---- */

test('filterBar tints a chip by the item\'s own colour, when it has one', () => {
  const bar = filterBar({
    items: [{ id: 's1', name: 'У роботі', color: 'blue' }, { id: 'o1', name: 'Едуард' }],
    hidden: new Set(),
    counts: {},
    onToggle: () => {},
    onShowAll: () => {},
  })
  const chips = bar.findAll('chip-toggle')
  ok(chips[0].className.includes('chip-toggle--blue'), `got "${chips[0].className}"`)
  eq(chips[1].className.includes('chip-toggle--blue'), false, 'an item with no colour must not get a modifier')
})

test('filterBar falls back to no colour modifier for an unknown token', () => {
  const bar = filterBar({
    items: [{ id: 's1', name: 'X', color: 'not-a-colour' }],
    hidden: new Set(),
    counts: {},
    onToggle: () => {},
    onShowAll: () => {},
  })
  const chip = bar.find('chip-toggle')
  eq(/chip-toggle--[a-z]+/.test(chip.className.replace('chip-toggle--off', '')), false, `got "${chip.className}"`)
})

test('filterBar keeps the --off modifier alongside a colour modifier when hidden', () => {
  const bar = filterBar({
    items: [{ id: 's1', name: 'У роботі', color: 'blue' }],
    hidden: new Set(['s1']),
    counts: {},
    onToggle: () => {},
    onShowAll: () => {},
  })
  const chip = bar.find('chip-toggle')
  ok(chip.className.includes('chip-toggle--off'))
  ok(chip.className.includes('chip-toggle--blue'))
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

/* ------------------------------------------------------------ folded pickers ---- */

const pickerFaces = (dialog) => dialog.findAll('picker__face').map((f) => f.textContent)

test('the colour and emoji pickers start folded, showing the current choice', () => {
  const task = createTask({ id: 't1', name: 'T', category_id: 'c1', priority_id: 'p1', color: 'amber', icon: '🦜' })
  const dialog = taskDialog({
    task, isNew: false, statuses: [], categories: refCategories, priorities: refPriorities, owners: [],
    onSave: () => {},
  })

  const folded = dialog.findAll('picker')
  eq(folded.length, 2, 'colour and emoji')
  ok(folded.every((p) => !p.open), 'both must start closed, or nothing is saved')

  // The colour trigger is a bare dot: the name would wrap it onto a second line at a
  // third of the dialog's width. It has to stay announceable, hence the label.
  const dot = dialog.find('picker__dot')
  ok(dot.className.includes('swatch--amber'), `dot was "${dot.className}"`)
  eq(dialog.findAll('picker__trigger')[0].title, 'Бурштиновий')
  ok(pickerFaces(dialog)[1].includes('🦜'), `emoji face was "${pickerFaces(dialog)[1]}"`)

  // Folded or not, the real pickers are present and still drive the saved value.
  ok(dialog.find('swatches'), 'the swatch row is in the panel, not removed')
  ok(dialog.find('icons'), 'the emoji grid is in the panel, not removed')
})

test('a task with no emoji says so rather than showing an empty button', () => {
  const task = createTask({ id: 't1', name: 'T', category_id: 'c1', priority_id: 'p1' })
  const dialog = taskDialog({
    task, isNew: false, statuses: [], categories: refCategories, priorities: refPriorities, owners: [],
    onSave: () => {},
  })
  ok(pickerFaces(dialog)[1].includes('без емодзі'), pickerFaces(dialog)[1])
})

test('picking a colour updates the folded face and still saves', () => {
  const task = createTask({ id: 't1', name: 'T', category_id: 'c1', priority_id: 'p1', color: 'amber' })
  let saved = null
  const dialog = taskDialog({
    task, isNew: false, statuses: [], categories: refCategories, priorities: refPriorities, owners: [],
    onSave: (values) => { saved = values },
  })

  const green = dialog.findAll('swatch').find((s) => s.className.includes('swatch--green'))
  green.dispatch('click', {})
  ok(dialog.find('picker__dot').className.includes('swatch--green'), dialog.find('picker__dot').className)
  eq(dialog.findAll('picker__trigger')[0].title, 'Зелений', 'the label must follow the choice')

  dialog.find('sheet__form').dispatch('submit', { preventDefault: () => {} })
  eq(saved.color, 'green')
})

test('opening one picker closes the other', () => {
  const task = createTask({ id: 't1', name: 'T', category_id: 'c1', priority_id: 'p1' })
  const dialog = taskDialog({
    task, isNew: false, statuses: [], categories: refCategories, priorities: refPriorities, owners: [],
    onSave: () => {},
  })
  const [colour, emoji] = dialog.findAll('picker')

  colour.open = true
  colour.dispatch('toggle', {})
  emoji.open = true
  emoji.dispatch('toggle', {})

  eq(colour.open, false, 'both panels float over the form — two at once would overlap')
  ok(emoji.open)
})

test('the due date sits in the pickers row, not on a line of its own', () => {
  const task = createTask({ id: 't1', name: 'T', category_id: 'c1', priority_id: 'p1', due_date: '2026-10-22' })
  const dialog = taskDialog({
    task, isNew: false, statuses: [], categories: refCategories, priorities: refPriorities, owners: [],
    onSave: () => {},
  })
  const firstRow = dialog.findAll('sheet__row')[0]
  eq(firstRow.findAll('picker').length, 2)
  ok(firstRow.textContent.includes('Термін'), 'the date field shares the row with the two pickers')
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

/* ------------------------------------------------------------------ progress ---- */

const refStages = [
  { id: 's1', name: 'Взято в роботу', start_percent: 0 },
  { id: 's2', name: 'В процессі', start_percent: 0.25 },
  { id: 's3', name: 'Завершено', start_percent: 0.9 },
]

const slider = (dialog) => dialog.find('progress__range')
const caption = (dialog) => dialog.find('progress__caption').textContent
const fillSegments = (dialog) => dialog.findAll('progress__segments').find((n) => n.className.includes('--fill'))

const openTask = (task, onSave = () => {}) =>
  taskDialog({
    task, isNew: false,
    statuses: refStages, categories: refCategories, priorities: refPriorities, owners: [],
    onSave,
  })

const drag = (dialog, percent) => {
  const input = slider(dialog)
  input.value = String(percent)
  input.dispatch('input', {})
  return input
}

test('the progress caption names the stage and the whole percent', () => {
  const task = createTask({ id: 't1', name: 'T', category_id: 'c1', priority_id: 'p1', status_id: 's2', progress_percent: 0.4 })
  const text = caption(openTask(task))
  ok(text.includes('В процессі'), `caption was "${text}"`)
  ok(text.includes('40 %'), `caption was "${text}"`)
})

test('the slider spans the whole 0..100, not just the stage', () => {
  // Narrowing min/max to the stage is the bug that made the thumb drift off the fill:
  // the thumb would cross the full track while the fill only crossed part of the scale.
  const task = createTask({ id: 't1', name: 'T', category_id: 'c1', priority_id: 'p1', status_id: 's2' })
  const input = slider(openTask(task))
  eq(input.min, '0')
  eq(input.max, '100')
})

test('dragging inside the stage is kept as-is', () => {
  const task = createTask({ id: 't1', name: 'T', category_id: 'c1', priority_id: 'p1', status_id: 's2' })
  const dialog = openTask(task)
  drag(dialog, 60)
  ok(caption(dialog).includes('60 %'), caption(dialog))
})

test('dragging past the next stage clamps to one below it', () => {
  const task = createTask({ id: 't1', name: 'T', category_id: 'c1', priority_id: 'p1', status_id: 's2' })
  const dialog = openTask(task)
  // s3 starts at 90, so В процессі tops out at 89.
  eq(drag(dialog, 99).value, '89')
  ok(caption(dialog).includes('89 %'), caption(dialog))
})

test('dragging below the stage start clamps up to it', () => {
  const task = createTask({ id: 't1', name: 'T', category_id: 'c1', priority_id: 'p1', status_id: 's2' })
  eq(drag(openTask(task), 3).value, '25')
})

test('only the last stage can reach 100', () => {
  const last = createTask({ id: 't1', name: 'T', category_id: 'c1', priority_id: 'p1', status_id: 's3' })
  eq(drag(openTask(last), 100).value, '100')
})

test('changing status snaps progress to that stage start', () => {
  const task = createTask({ id: 't1', name: 'T', category_id: 'c1', priority_id: 'p1', status_id: 's1' })
  const dialog = openTask(task)
  eq(slider(dialog).value, '0')

  const status = dialog.findAll('sheet__select')[0]
  status.value = 's2'
  status.dispatch('change', {})

  eq(slider(dialog).value, '25')
  ok(caption(dialog).includes('В процессі'), caption(dialog))
})

test('the fill is clipped, not resized, so segment boundaries hold still', () => {
  const task = createTask({ id: 't1', name: 'T', category_id: 'c1', priority_id: 'p1', status_id: 's2', progress_percent: 0.4 })
  const dialog = openTask(task)
  eq(fillSegments(dialog).styleProps['--progress-clip'], '60%')
  drag(dialog, 70)
  eq(fillSegments(dialog).styleProps['--progress-clip'], '30%')
})

test('one segment per stage, placed at the percent it starts on', () => {
  const task = createTask({ id: 't1', name: 'T', category_id: 'c1', priority_id: 'p1', status_id: 's1' })
  const segs = openTask(task).findAll('progress__segments')[0].findAll('progress__seg')
  // refStages start at 0 / 25 / 90.
  eq(segs.map((s) => s.styleProps.left).join(','), '0%,25%,90%')
  eq(segs.map((s) => s.styleProps.width).join(','), 'calc(25% - 2px),calc(65% - 2px),calc(10% - 2px)')
})

test('a board whose first stage starts above zero is not shifted left', () => {
  // The flex layout packed from the left and ignored the first start, so every band
  // sat 10 points early and the track ended 10 points short.
  const late = [
    { id: 'a', name: 'А', color: 'amber', start_percent: 0.1 },
    { id: 'b', name: 'Б', color: 'green', start_percent: 0.2 },
  ]
  const dialog = taskDialog({
    task: createTask({ id: 't1', name: 'T', category_id: 'c1', priority_id: 'p1', status_id: 'a' }),
    isNew: false, statuses: late, categories: refCategories, priorities: refPriorities, owners: [],
    onSave: () => {},
  })
  const segs = dialog.findAll('progress__segments')[0].findAll('progress__seg')
  eq(segs[0].styleProps.left, '10%', 'the first band must start where its stage does')
  eq(segs[1].styleProps.width, 'calc(80% - 2px)', 'the last band must run to 100')
})

test('a zero-width stage draws no band', () => {
  const touching = [
    { id: 'a', name: 'А', color: 'amber', start_percent: 0.5 },
    { id: 'b', name: 'Б', color: 'green', start_percent: 0.5 },
  ]
  const dialog = taskDialog({
    task: createTask({ id: 't1', name: 'T', category_id: 'c1', priority_id: 'p1', status_id: 'a' }),
    isNew: false, statuses: touching, categories: refCategories, priorities: refPriorities, owners: [],
    onSave: () => {},
  })
  eq(dialog.findAll('progress__segments')[0].findAll('progress__seg').length, 1)
})

test('the progress field saves back as a fraction', () => {
  const task = createTask({ id: 't1', name: 'T', category_id: 'c1', priority_id: 'p1', status_id: 's2' })
  let saved = null
  const dialog = openTask(task, (values) => { saved = values })
  drag(dialog, 55)
  dialog.find('sheet__form').dispatch('submit', { preventDefault: () => {} })
  eq(saved.progress_percent, 0.55)
})

test('a task with no status gets the full range and says so', () => {
  const task = createTask({ id: 't1', name: 'T', category_id: 'c1', priority_id: 'p1' })
  const dialog = openTask(task)
  ok(caption(dialog).includes('без статусу'), caption(dialog))
  eq(drag(dialog, 97).value, '97', 'nothing bounds a task that is in no stage')
})

test('refSheet offers Start % for statuses and returns it as a fraction', () => {
  let saved = null
  const sheet = refSheet({
    title: 'Статус', item: { id: 's1', name: 'В процессі', start_percent: 0.25 },
    isNew: false, withColor: true, withIcon: true, withPercent: true, iconChoices: [],
    onSave: (values) => { saved = values },
  })
  const input = sheet.find('percent-input')
  eq(input.value, '25', 'the stored fraction should display as a whole percent')

  input.value = '60'
  sheet.find('sheet__form').dispatch('submit', { preventDefault: () => {} })
  eq(saved.start_percent, 0.6)
})

test('refSheet omits Start % for dictionaries that have no stages', () => {
  const sheet = refSheet({
    title: 'Категорія', item: { id: 'c1', name: 'Робота' }, isNew: false, onSave: () => {},
  })
  eq(sheet.find('percent-input'), null, 'only stages carry a start percent')
})
