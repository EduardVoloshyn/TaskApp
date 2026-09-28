import {
  createTask,
  deleteTask,
  duplicateTask,
  findTask,
  newId,
  partitionUsable,
  updateTask,
} from './model/tasks.js'
import { ICON_CHOICES, createRef, deleteRef, findRef, moveRef, updateRef } from './model/refs.js'
import { ApiError, fetchBoard, saveBoard } from './sync/api.js'
import { hardReset, resetRequested } from './sync/reset.js'
import { REQUIRED_SCHEMA_VERSION, isSchemaOutdated } from './version.js'
import { singleFlight } from './sync/single-flight.js'
import {
  clearCredentials,
  clearPending,
  loadCredentials,
  loadPending,
  loadPrefs,
  loadSnapshot,
  saveCredentials,
  savePending,
  savePrefs,
  saveSnapshot,
} from './sync/storage.js'
import { append, clear, el } from './ui/dom.js'
import { ICON, actionButton } from './ui/buttons.js'
import { aboutPanel } from './ui/about-panel.js'
import { board } from './ui/board.js'
import { filterBar } from './ui/filter-bar.js'
import { refPanel } from './ui/ref-panel.js'
import { refSheet } from './ui/ref-sheet.js'
import { settingsMenu } from './ui/settings-menu.js'
import { setupCard } from './ui/setup-card.js'
import { taskDialog } from './ui/task-dialog.js'

/**
 * The whole application. State is a plain object and every change re-renders the tree
 * from scratch — at board scale that is imperceptible, and it removes any need for
 * diffing or a framework.
 */

/** Writes are batched: a burst of edits should cost one save, not one each. */
const SAVE_DEBOUNCE_MS = 1200

/** Per-entity configuration for the four generic reference-list editors. */
const REF_CONFIG = {
  categories: { title: 'Категорії', emptyHint: 'Поки немає жодної категорії.', withColor: false, withIcon: false },
  owners: { title: 'Виконавці', emptyHint: 'Поки немає жодного виконавця.', withColor: false, withIcon: false },
  priorities: { title: 'Пріоритети', emptyHint: 'Поки немає жодного пріоритету.', withColor: true, withIcon: false },
  statuses: { title: 'Статуси', emptyHint: 'Поки немає жодного статусу.', withColor: true, withIcon: true },
}

const state = {
  credentials: loadCredentials(),
  /** Read synchronously, so the very first paint already has data. */
  snapshot: sanitizeCached(loadSnapshot()),
  prefs: withDefaults(loadPrefs()),
  /** @type {{ status: 'idle'|'loading'|'saving'|'ok'|'error', message?: string, code?: string }} */
  sync: { status: 'idle' },
  /**
   * A newly created task that is on screen but NOT yet part of the saved board. It is
   * committed only when the dialog is confirmed, so a half-typed task is never sent to
   * the API.
   */
  draftTask: null,
  /** Open modal count, so a background error cannot shout over a dialog. */
  dialogs: 0,
  /** Local edits not yet confirmed by the server. */
  dirty: Boolean(loadPending()),
}

/**
 * Drops tasks the API could never accept from the *cached* copy.
 *
 * Without this, one unusable task wedges the app permanently: every save is rejected,
 * the pending payload is retried on every open, and no refresh ever runs. Only the
 * local cache is cleaned — data fetched from the Sheet is left alone so a hand-edited
 * row is reported rather than quietly deleted.
 */
function sanitizeCached(snapshot) {
  if (!snapshot) return snapshot
  const { usable, dropped } = partitionUsable(snapshot.tasks)
  if (dropped.length === 0) return snapshot

  clearPending()
  const cleaned = { ...snapshot, tasks: usable }
  saveSnapshot(cleaned)
  return cleaned
}

function withDefaults(prefs) {
  return {
    // Off by default on every device: reading is what this app is for, editing is
    // deliberate. A local UI flag, not a security boundary.
    editingEnabled: prefs.editingEnabled ?? false,
    theme: prefs.theme ?? 'system',
    hiddenOwners: prefs.hiddenOwners ?? [],
    hiddenStatuses: prefs.hiddenStatuses ?? [],
  }
}

function todayIso() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function setState(patch) {
  Object.assign(state, patch)
  render()
}

/* ------------------------------------------------------------------- data ---- */

function currentTasks() {
  return state.snapshot ? state.snapshot.tasks : []
}

function displayTasks() {
  return state.draftTask ? [...currentTasks(), state.draftTask] : currentTasks()
}

function categories() { return state.snapshot?.categories ?? [] }
function priorities() { return state.snapshot?.priorities ?? [] }
function owners() { return state.snapshot?.owners ?? [] }
function statuses() { return state.snapshot?.statuses ?? [] }

function ownerById() { return new Map(owners().map((o) => [o.id, o])) }

function hiddenOwnerSet() { return new Set(state.prefs.hiddenOwners) }
function hiddenStatusSet() { return new Set(state.prefs.hiddenStatuses) }

/** A task with no owner/status is never hidden by a filter — only a known id can be. */
function visibleTasks(tasks, hiddenOwners, hiddenStatuses) {
  return tasks.filter(
    (t) =>
      (!t.owner_id || !hiddenOwners.has(t.owner_id)) &&
      (!t.status_id || !hiddenStatuses.has(t.status_id)),
  )
}

function countBy(tasks, field) {
  const counts = {}
  for (const t of tasks) if (t[field]) counts[t[field]] = (counts[t[field]] ?? 0) + 1
  return counts
}

function setHiddenOwners(hidden) {
  const prefs = { ...state.prefs, hiddenOwners: [...hidden] }
  savePrefs(prefs)
  setState({ prefs })
}

function setHiddenStatuses(hidden) {
  const prefs = { ...state.prefs, hiddenStatuses: [...hidden] }
  savePrefs(prefs)
  setState({ prefs })
}

/**
 * Commits an edit: local first, saved in the background. The UI never waits on the
 * network.
 */
function applyPatch(patch) {
  if (!state.snapshot) {
    setState({ sync: { status: 'error', message: 'Спочатку завантажте дошку.' } })
    return
  }
  const snapshot = { ...state.snapshot, ...patch }
  saveSnapshot(snapshot)
  setState({ snapshot, dirty: true })
  scheduleSave()
}

/* -------------------------------------------------------------------- sync ---- */

let saveTimer = 0

function scheduleSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => flushSave().catch(() => {}), SAVE_DEBOUNCE_MS)
}

/**
 * Sends the whole board. Wrapped in `singleFlight`, so overlapping edits cannot put
 * two writes on the wire carrying the same hash.
 */
const flushSave = singleFlight(
  async () => {
    if (!state.credentials || !state.snapshot) return

    const payload = {
      hash: state.snapshot.hash,
      tasks: state.snapshot.tasks,
      statuses: state.snapshot.statuses,
      categories: state.snapshot.categories,
      priorities: state.snapshot.priorities,
      owners: state.snapshot.owners,
      settings: state.snapshot.settings,
    }

    // Persisted *before* the request, so an edit survives the tab closing mid-save.
    savePending(payload)
    setState({ sync: { status: 'saving' } })

    try {
      const result = await saveBoard(state.credentials, payload)
      const snapshot = { ...state.snapshot, hash: result.hash }
      saveSnapshot(snapshot)
      clearPending()
      setState({ snapshot, dirty: false, sync: { status: 'ok' } })
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'unknown'
      const message = err instanceof ApiError ? err.message : 'Не вдалося зберегти'
      setState({ sync: { status: 'error', message, code } })
      throw err
    }
  },
  { onRerun: () => scheduleSave() },
)

/** Re-reads to pick up the current hash, then re-sends the local edits. */
async function retryAfterStale() {
  if (!state.credentials || !state.snapshot) return
  setState({ sync: { status: 'saving' } })
  let fresh
  try {
    fresh = await fetchBoard(state.credentials)
  } catch (err) {
    const message = err instanceof ApiError ? err.message : 'Не вдалося оновити'
    setState({ sync: { status: 'error', message, code: 'network' } })
    return
  }
  setState({ snapshot: { ...state.snapshot, hash: fresh.hash } })
  await flushSave().catch(() => {})
}

/** Throws away local edits and takes whatever the Sheet says. */
async function discardLocal() {
  clearPending()
  setState({ dirty: false, draftTask: null, sync: { status: 'loading' } })
  await refresh()
}

async function refresh() {
  if (!state.credentials) return
  setState({ sync: { status: 'loading' } })
  try {
    const snapshot = await fetchBoard(state.credentials)
    saveSnapshot(snapshot)
    setState({ snapshot, sync: { status: 'ok' } })
  } catch (err) {
    const message = err instanceof ApiError ? err.message : 'Невідома помилка'
    setState({ sync: { status: 'error', message, code: 'network' } })
  }
}

/* ---------------------------------------------------------------- dialogs ---- */

function openDialog(node) {
  document.body.appendChild(node)
  state.dialogs += 1
  node.showModal()
  node.addEventListener('close', () => {
    state.dialogs = Math.max(0, state.dialogs - 1)
    node.remove()
  })
}

function openTaskDialog(id, { isNew = false } = {}) {
  const task = findTask(displayTasks(), id)
  if (!task) return

  openDialog(
    taskDialog({
      task,
      isNew,
      statuses: statuses(),
      categories: categories(),
      priorities: priorities(),
      owners: owners(),
      onSave: (values) => {
        if (isNew) {
          const committed = updateTask([state.draftTask], id, values)[0]
          state.draftTask = null
          applyPatch({ tasks: [...currentTasks(), committed] })
        } else {
          applyPatch({ tasks: updateTask(currentTasks(), id, values) })
        }
      },
      onDelete: () => {
        if (isNew) setState({ draftTask: null })
        else applyPatch({ tasks: deleteTask(currentTasks(), id) })
      },
      onDuplicate: isNew
        ? undefined
        : () => {
            const copy = duplicateTask(task)
            applyPatch({ tasks: [...currentTasks(), copy] })
            openTaskDialog(copy.id)
          },
      onClose: () => {
        if (isNew && state.draftTask?.id === id) setState({ draftTask: null })
        else render()
      },
    }),
  )
}

function onCreateTaskAt({ categoryId, priorityId }) {
  const created = createTask({ name: '', category_id: categoryId, priority_id: priorityId })
  setState({ draftTask: created })
  openTaskDialog(created.id, { isNew: true })
}

function onAddTask() {
  onCreateTaskAt({ categoryId: '', priorityId: '' })
}

/* ----------------------------------------------------- reference editors ---- */

function openRefPanel(kind) {
  const config = REF_CONFIG[kind]
  const items = state.snapshot?.[kind] ?? []

  openDialog(
    refPanel({
      title: config.title,
      items,
      emptyHint: config.emptyHint,
      renderRow: (item) => renderRefRow(kind, item),
      onEdit: (item) => openRefSheet(kind, item, { isNew: false }),
      onCreate: () => openRefSheet(kind, {}, { isNew: true }),
      onReorder: (item, direction) => {
        const existing = state.snapshot?.[kind] ?? []
        applyPatch({ [kind]: moveRef(existing, item.id, direction) })
        openRefPanel(kind)
      },
      onClose: () => render(),
    }),
  )
}

function renderRefRow(kind, item) {
  const config = REF_CONFIG[kind]
  if (!config.withColor) {
    return { nodes: [refRowText(item.name)] }
  }
  return {
    modifier: item.color || 'slate',
    nodes: [config.withIcon && item.icon ? refRowIcon(item.icon) : null, refRowText(item.name)].filter(Boolean),
  }
}

function refRowText(text) {
  const span = document.createElement('span')
  span.className = 'ref-list__title'
  span.textContent = text
  return span
}

function refRowIcon(icon) {
  const span = document.createElement('span')
  span.className = 'ref-list__icon'
  span.textContent = icon
  return span
}

function openRefSheet(kind, item, { isNew }) {
  const config = REF_CONFIG[kind]

  openDialog(
    refSheet({
      title: isNew ? `Новий запис — ${config.title}` : `Редагування — ${config.title}`,
      item,
      isNew,
      withColor: config.withColor,
      withIcon: config.withIcon,
      iconChoices: ICON_CHOICES,
      onSave: (values) => {
        const existing = state.snapshot?.[kind] ?? []
        applyPatch({
          [kind]: isNew || !values.id
            ? createRef(existing, { ...values, id: values.id ?? newId() })
            : updateRef(existing, values.id, values),
        })
      },
      onDelete: isNew
        ? undefined
        : () => {
            const existing = state.snapshot?.[kind] ?? []
            applyPatch({ [kind]: deleteRef(existing, item.id) })
          },
      // Back to the list, not back to the board — adding several categories/owners/
      // priorities/statuses in a row should not require reopening Settings each time.
      onClose: () => openRefPanel(kind),
    }),
  )
}

/* ----------------------------------------------------------------- toolbar ---- */

function toolbar() {
  const bar = el('div', 'app__bar')
  const editable = state.prefs.editingEnabled

  // Filters live in the same row as the title (not a dedicated row below) so the board
  // gets that vertical space back; on a narrow viewport app__bar's own flex-wrap just
  // drops them to a second line.
  const tasks = displayTasks()
  const hiddenOwners = hiddenOwnerSet()
  const hiddenStatuses = hiddenStatusSet()
  const ownerBar = filterBar({
    items: owners(),
    hidden: hiddenOwners,
    counts: countBy(tasks, 'owner_id'),
    onToggle: (id) => setHiddenOwners(toggleHidden(hiddenOwners, id)),
    onShowAll: () => setHiddenOwners([]),
  })
  const statusBar = filterBar({
    items: statuses(),
    hidden: hiddenStatuses,
    counts: countBy(tasks, 'status_id'),
    onToggle: (id) => setHiddenStatuses(toggleHidden(hiddenStatuses, id)),
    onShowAll: () => setHiddenStatuses([]),
  })
  // Only between the two groups when both actually render — no dangling line before an
  // empty one.
  const filters = append(
    el('div', 'app__filters'),
    ownerBar,
    ownerBar && statusBar && el('span', 'app__divider'),
    statusBar,
  )

  const refreshButton = button(ICON.reload, 'Оновити', () => void refresh())
  refreshButton.disabled = state.sync.status === 'loading' || !state.credentials

  const editButton = button(
    editable ? '🔒' : '✏️',
    editable ? 'Завершити редагування' : 'Редагувати',
    () => setEditing(!editable),
  )
  editButton.disabled = !state.snapshot

  const addButton = actionButton({ icon: ICON.add, label: 'Завдання', kind: 'accent', onClick: onAddTask })
  addButton.disabled = !state.snapshot

  const settingsButton = button('⚙', 'Налаштування', () =>
    openDialog(
      settingsMenu({
        prefs: state.prefs,
        onChange: (patch) => {
          const prefs = { ...state.prefs, ...patch }
          savePrefs(prefs)
          applyTheme(prefs)
          setState({ prefs })
        },
        onClearLocal: () => void discardLocal(),
        onResetApp: () => void hardReset({ data: false }),
        onForgetCredentials: () => {
          clearCredentials()
          setState({ credentials: null })
        },
        onManageCategories: () => openRefPanel('categories'),
        onManageOwners: () => openRefPanel('owners'),
        onManagePriorities: () => openRefPanel('priorities'),
        onManageStatuses: () => openRefPanel('statuses'),
        onClose: () => render(),
      }),
    ),
  )

  const aboutButton = button('?', 'Про застосунок', () => openDialog(aboutPanel({ onClose: () => render() })))
  aboutButton.className = 'app__button app__button--glyph'

  return append(
    bar,
    el('h1', 'app__title', undefined, 'Дошка завдань'),
    el('span', 'app__divider'),
    filters,
    el('span', 'app__spacer'),
    el('span', `app__status${busy() ? ' app__status--busy' : ''}`, undefined, statusText()),
    editable && addButton,
    editButton,
    refreshButton,
    settingsButton,
    aboutButton,
  )
}

function button(label, title, onClick) {
  const node = el('button', 'app__button', undefined, label)
  node.type = 'button'
  node.title = title
  node.addEventListener('click', onClick)
  return node
}

function statusText() {
  if (state.sync.status === 'saving') return 'Збереження…'
  if (state.sync.status === 'loading') return 'Синхронізація…'
  if (state.dirty) return 'Не збережено'
  if (state.sync.status === 'error') return 'Немає з’єднання'
  if (!state.snapshot) return 'Немає даних'
  const mins = Math.floor((Date.now() - state.snapshot.fetchedAt) / 60000)
  if (mins < 1) return 'Щойно оновлено'
  if (mins < 60) return `${mins} хв тому`
  return `${Math.floor(mins / 60)} год тому`
}

/* ------------------------------------------------------------------ render ---- */

function applyTheme(prefs) {
  const root = document.documentElement
  if (prefs.theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', prefs.theme)
}

function render() {
  const root = document.getElementById('root')
  if (!root) throw new Error('#root missing from index.html')
  clear(root)

  if (!state.credentials) {
    append(
      root,
      setupCard({
        error: state.sync.status === 'error' ? state.sync.message : undefined,
        onSave: (creds) => {
          saveCredentials(creds)
          setState({ credentials: creds })
          void refresh()
        },
      }),
    )
    return
  }

  const hiddenOwners = hiddenOwnerSet()
  const hiddenStatuses = hiddenStatusSet()
  const tasks = displayTasks()
  const filtered = visibleTasks(tasks, hiddenOwners, hiddenStatuses)
  const editable = state.prefs.editingEnabled && Boolean(state.snapshot)

  const app = el('div', 'app')
  append(app, toolbar())

  const editingNow = state.dialogs > 0 || state.draftTask !== null

  if (isSchemaOutdated(state.snapshot) && !editingNow) {
    append(app, schemaNotice())
  }

  if (state.sync.status === 'error' && !editingNow) {
    append(app, errorNotice())
  }

  const scroll = el('div', 'app__scroll')
  if (!state.snapshot) {
    append(scroll, el('p', 'sheet__hint', undefined, 'Завантаження…'))
  } else if (categories().length === 0 && priorities().length === 0 && tasks.length === 0) {
    append(
      scroll,
      el(
        'p',
        'sheet__hint',
        undefined,
        'Поки немає жодної категорії чи пріоритету. Додайте їх через «⚙ Налаштування».',
      ),
    )
  } else {
    append(
      scroll,
      board({
        tasks: filtered,
        categories: categories(),
        priorities: priorities(),
        statuses: statuses(),
        ownerById: ownerById(),
        editing: editable,
        todayIso: todayIso(),
        onOpenTask: (id) => openTaskDialog(id),
        onCreateTask: onCreateTaskAt,
      }),
    )
  }
  append(app, scroll)
  append(root, app)
}

function toggleHidden(hidden, id) {
  const next = new Set(hidden)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

function setEditing(enabled) {
  const prefs = { ...state.prefs, editingEnabled: enabled }
  savePrefs(prefs)
  setState(enabled ? { prefs } : { prefs, draftTask: null })
}

function busy() {
  return state.sync.status === 'loading' || state.sync.status === 'saving'
}

/**
 * The Sheet hasn't been migrated to the schema this build expects — code was deployed
 * (or this PWA build shipped) ahead of running `migrate()` in the Apps Script editor.
 * Shown persistently rather than folded into errorNotice(): it isn't a sync failure,
 * the board still loads, but some fields may not read/write correctly until fixed.
 */
function schemaNotice() {
  const notice = el('div', 'notice notice--warning')
  const actual = state.snapshot?.sheetVersion || state.snapshot?.schemaVersion || '?'
  append(
    notice,
    el(
      'span',
      undefined,
      undefined,
      `⚠️ Схема даних застаріла (таблиця: v${actual}, потрібно: v${REQUIRED_SCHEMA_VERSION}). ` +
        'Виконайте migrate() в редакторі Apps Script.',
    ),
  )
  return notice
}

function errorNotice() {
  const notice = el('div', 'notice')
  append(notice, el('span', undefined, undefined, state.sync.message))

  if (state.sync.code === 'stale') {
    append(
      notice,
      el('span', 'app__spacer'),
      button('Перезаписати', 'Надіслати мої зміни поверх', () => void retryAfterStale()),
      button('Відкинути мої зміни', 'Взяти версію з таблиці', () => void discardLocal()),
    )
  } else if (state.sync.code === 'invalid') {
    append(
      notice,
      el('span', 'app__spacer'),
      button('Відкинути мої зміни', 'Взяти версію з таблиці', () => void discardLocal()),
    )
  } else if (state.dirty) {
    append(
      notice,
      el('span', 'app__spacer'),
      button('Повторити', 'Спробувати ще раз', () => void flushSave().catch(() => {})),
    )
  }

  return notice
}

/* -------------------------------------------------------------------- boot ---- */

// Handled first: if the app is wedged, nothing after this point is trustworthy.
const requestedReset = resetRequested()
if (requestedReset) {
  void hardReset({ data: requestedReset === 'all' })
}

applyTheme(state.prefs)

// Offline and installability, in production only. A service worker cannot register on
// the plain-HTTP LAN address used for device testing anyway.
const IS_LOCALHOST = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)

if ('serviceWorker' in navigator) {
  if (IS_LOCALHOST) {
    // Development: no service worker at all. A cache-first worker on localhost means
    // edits appear one reload late.
    navigator.serviceWorker
      .getRegistrations()
      .then((registrations) => registrations.forEach((r) => r.unregister()))
      .catch(() => {})
    if (typeof caches !== 'undefined') {
      caches.keys().then((keys) => keys.forEach((k) => caches.delete(k))).catch(() => {})
    }
  } else if (location.protocol === 'https:') {
    let reloading = false
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return
      reloading = true
      location.reload()
    })

    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('./sw.js', { updateViaCache: 'none' })
        .then((registration) => registration.update())
        .catch(() => {
          // Not fatal: without it the app still works, just online-only.
        })
    })
  }
}

// Poll on focus: Sheets pushes nothing, so this is the only way a change made on
// another device arrives.
window.addEventListener('focus', () => {
  if (state.credentials && !state.dirty) void refresh()
})

if (!requestedReset) {
  render()
}

if (state.credentials && !requestedReset) {
  // A save interrupted by the app closing is retried before anything else, so the
  // local edit is not silently lost.
  if (loadPending() && state.dirty) flushSave().catch(() => {})
  else void refresh()
}
