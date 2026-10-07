import { eq, ok, test } from './harness.js'
import { installDom } from './dom-stub.js'

/*
 * Boots the real src/app.js against the stub DOM.
 *
 * Nothing else covers this: the model tests exercise pure logic, and the render tests
 * build components in isolation. An exception thrown at module scope in app.js — or a
 * toolbar that quietly stops rendering a control — would pass every other test and
 * still leave a blank or wrong screen.
 *
 * It runs last and installs its own DOM, because importing app.js has side effects
 * (it renders immediately and registers timers).
 */

const store = {
  'taskapp.credentials': JSON.stringify({ deploymentId: 'AKfyTEST', secret: 's' }),
  'taskapp.snapshot': JSON.stringify({
    tasks: [
      { id: 'a', name: 'Написати звіт', status_id: 's1', category_id: 'c1', priority_id: 'p1', owner_id: 'o1', due_date: '', notes: '' },
      { id: 'b', name: 'Полити квіти', status_id: '', category_id: '', priority_id: '', owner_id: '', due_date: '', notes: '' },
      { id: 'c', name: 'Завершений звіт', status_id: 's2', category_id: '', priority_id: '', owner_id: '', due_date: '', notes: '' },
    ],
    statuses: [
      { id: 's1', name: 'У роботі', color: 'blue', icon: '🔧' },
      { id: 's2', name: 'Завершено', color: 'green', icon: '✅' },
    ],
    categories: [{ id: 'c1', name: 'Робота' }],
    priorities: [{ id: 'p1', name: 'Високий' }],
    owners: [{ id: 'o1', name: 'Едуард' }],
    settings: {},
    hash: 'h',
    fetchedAt: 1,
  }),
}

const { root } = installDom({ store })
await import('../src/app.js')

const labels = () => root.findAll('app__button').map((b) => b.textContent)

test('the app boots and renders a toolbar and board rather than throwing', () => {
  ok(root.find('app__bar'), 'no toolbar — the setup card or an exception instead')
  ok(root.find('board'), 'no board rendered')
})

test('the board renders the cached tasks, not an empty state', () => {
  eq(root.findAll('task-card').length, 2)
})

test('a task with no category/priority lands in the orphan row and column', () => {
  ok(root.findAll('board__row-label').some((n) => n.textContent === 'Без категорії'))
  ok(root.findAll('board__col-label').some((n) => n.textContent === 'Без пріоритету'))
})

test('editing is off by default, so the button offers the pencil', () => {
  eq(labels().includes('✏️'), true, `toolbar was ${labels().join(' ')}`)
  eq(labels().includes('🔒'), false, 'showing the lock while already view-only')
})

test('view-only mode hides the add-task button', () => {
  eq(labels().some((l) => l.includes('Завдання')), false, 'add button offered while editing is off')
})

test('turning editing on reveals the add-task button and flips the toggle', () => {
  const pencil = root.findAll('app__button').find((b) => b.textContent === '✏️')
  ok(pencil, 'no pencil to click')
  pencil.dispatch('click', {})

  const after = labels()
  eq(after.includes('🔒'), true, `toolbar was ${after.join(' ')}`)
  eq(after.some((l) => l.includes('Завдання')), true, 'add-task button did not appear')
})

test('turning it off again returns to view-only', () => {
  const lock = root.findAll('app__button').find((b) => b.textContent === '🔒')
  lock.dispatch('click', {})
  eq(labels().includes('✏️'), true, `toolbar was ${labels().join(' ')}`)
})

test('the owner and status filter chips render, beside their counts', () => {
  const chips = root.findAll('chip-toggle')
  ok(chips.some((c) => c.textContent.includes('Едуард')), 'owner filter missing')
  ok(chips.some((c) => c.textContent.includes('У роботі')), 'status filter missing')
})

test('hiding the owner filters that task out, and leaves the unassigned task visible', () => {
  eq(root.findAll('task-card').length, 2)

  const eduard = root.findAll('chip-toggle').find((c) => c.textContent.includes('Едуард'))
  ok(eduard, 'no Едуард chip')
  eduard.dispatch('click', {})

  // 'Написати звіт' has owner_id o1 and goes; 'Полити квіти' has no owner and stays.
  eq(root.findAll('task-card').length, 1, 'wrong number of cards after hiding')
})

test('the hidden toggle reads as off, and "show all" appears', () => {
  eq(root.findAll('chip-toggle--off').length, 1)
  eq(root.findAll('chip-toggle--all').length, 1)
})

test('"show all" restores everything', () => {
  root.find('chip-toggle--all').dispatch('click', {})
  eq(root.findAll('task-card').length, 2)
  eq(root.findAll('chip-toggle--off').length, 0)
})

test('the toolbar ends with the ? button, in view-only and editing alike', () => {
  eq(labels().at(-1), '?', `toolbar was ${labels().join(' ')}`)
  const pencil = root.findAll('app__button').find((b) => b.textContent === '✏️')
  if (pencil) pencil.dispatch('click', {})
  eq(labels().at(-1), '?', 'the ? moved when editing was enabled')
})

/* -------------------------------------------------------------- completed ---- */

test('a completed task is hidden from the board by default', () => {
  eq(root.findAll('task-card').some((c) => c.textContent.includes('Завершений звіт')), false)
})

test('the "Показати завершено" chip renders, off by default', () => {
  const chip = root.findAll('chip-toggle').find((c) => c.textContent.includes('Показати завершено'))
  ok(chip, 'completed-toggle chip missing')
  eq(chip.className.includes('chip-toggle--on'), false)
})

test('turning the completed toggle on reveals the completed task, collapsed', () => {
  const chip = root.findAll('chip-toggle').find((c) => c.textContent.includes('Показати завершено'))
  chip.dispatch('click', {})

  const card = root.findAll('task-card').find((c) => c.textContent.includes('Завершений звіт'))
  ok(card, 'completed task did not appear after toggling on')
  ok(card.className.includes('task-card--completed'))
  eq(card.find('task-card__status-row'), null)
})

test('turning the completed toggle back off hides it again', () => {
  const chip = root.findAll('chip-toggle').find((c) => c.textContent.includes('Показати завершено'))
  chip.dispatch('click', {})
  eq(root.findAll('task-card').some((c) => c.textContent.includes('Завершений звіт')), false)
})
