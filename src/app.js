import {
  createTask,
  deleteTask,
  duplicateTask,
  findTask,
  isTaskCompleted,
  newId,
  partitionUsable,
  updateTask,
} from './model/tasks.js'
import { ICON_CHOICES, createRef, deleteRef, findRef, moveRef, updateRef } from './model/refs.js'
import {
  ApiError,
  connect as connectGoogle,
  disconnect as disconnectGoogle,
  fetchBoard,
  saveBoard,
  touchAuth,
} from './sync/sheets.js'
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
import { ICON } from './ui/buttons.js'
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
  statuses: { title: 'Статуси', emptyHint: 'Поки немає жодного статусу.', withColor: true, withIcon: true, withPercent: true },
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
    // Off by default: a completed row vanishing from the board the moment it's
    // finished is the whole point; opting back in is deliberate, per device.
    showCompleted: prefs.showCompleted ?? false,
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
function visibleTasks(tasks, hiddenOwners, hiddenStatuses, statusList, showCompleted) {
  return tasks.filter(
    (t) =>
      (!t.owner_id || !hiddenOwners.has(t.owner_id)) &&
      (!t.status_id || !hiddenStatuses.has(t.status_id)) &&
      (showCompleted || !isTaskCompleted(t, statusList)),
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

function setShowCompleted(showCompleted) {
  const prefs = { ...state.prefs, showCompleted }
  savePrefs(prefs)
  setState({ prefs })
}

async function signInToGoogle() {
  if (!state.credentials) return
  try {
    await connectGoogle(state.credentials.clientId)
    setState({ sync: { status: 'idle' } })
    // Same order as the boot sequence: an unsent edit is flushed first. Refreshing
    // while dirty would overwrite the local snapshot and take the unsaved edit with it.
    if (state.dirty) await flushSave().catch(() => {})
    else void refresh()
  } catch (err) {
    // Keep the real code: hardcoding needs_signin here would offer a sign-in button
    // for access_denied, which is the one case where signing in again cannot help.
    const message = err instanceof ApiError ? err.message : 'Не вдалося увійти в Google'
    const code = err instanceof ApiError ? err.code : 'needs_signin'
    setState({ sync: { status: 'error', message, code } })
  }
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
 * Hands the board to the sync layer, which works out which tabs actually differ and
 * sends only those — often none at all. Wrapped in `singleFlight`, so overlapping
 * edits cannot put two writes on the wire carrying the same digests.
 *
 * A snapshot from before per-tab digests existed has no `digests`, which would make
 * every tab look changed and overwrite the Sheet blindly. Refresh instead; it costs
 * one read, once.
 */
const flushSave = singleFlight(
  async () => {
    if (!state.credentials || !state.snapshot) return
    if (!state.snapshot.digests) {
      await refresh()
      return
    }

    const payload = {
      digests: state.snapshot.digests,
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
      // A save that wrote anything also stamped meta.schema_version, so reflect that
      // locally — otherwise the "schema outdated" banner lingers until the next read
      // and looks like the save failed to fix it.
      const snapshot = {
        ...state.snapshot,
        digests: result.digests,
        ...(result.written.length ? { sheetVersion: REQUIRED_SCHEMA_VERSION } : {}),
      }
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

/** Re-reads to pick up the Sheet's current digests, then re-sends the local edits. */
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
  setState({ snapshot: { ...state.snapshot, digests: fresh.digests } })
  await flushSave().catch(() => {})
}

/** Throws away local edits and takes whatever the Sheet says. */
async function discardLocal() {
  clearPending()
  setState({ dirty: false, draftTask: null, sync: { status: 'loading' } })
  await refresh()
}

/**
 * Wrapped in `singleFlight` for the same reason `flushSave` is: the initial boot fetch,
 * a window-focus refresh, and a manual click on the refresh button can all land within
 * milliseconds of each other, and without this they each fired their own concurrent GET
 * at the Sheets API — duplicate work, duplicate quota, and a later one can land before
 * an earlier one and hand the board a stale snapshot.
 */
const refresh = singleFlight(async ({ background = false } = {}) => {
  if (!state.credentials) return
  setState({ sync: { status: 'loading' } })
  try {
    const snapshot = await fetchBoard(state.credentials)
    saveSnapshot(snapshot)
    setState({ snapshot, sync: { status: 'ok' } })
  } catch (err) {
    // A heartbeat nobody asked for is not worth an error banner over the board: the
    // cached copy on screen is still usable and the status text already says how old it
    // is. A dropped background poll is not worth a red banner over a board that is
    // perfectly readable.
    if (background) {
      setState({ sync: { status: 'idle' } })
      return
    }
    // Keep the real code. Hardcoding 'network' here meant a needs_signin from the
    // Sheets API rendered as a plain "Повторити", which cannot fix a missing token.
    const message = err instanceof ApiError ? err.message : 'Невідома помилка'
    const code = err instanceof ApiError ? err.code : 'network'
    setState({ sync: { status: 'error', message, code } })
  }
}, { onRerun: () => void refresh({ background: true }) })

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
      // A duplicate is a draft, not a committed write — same as "add task": it only
      // reaches applyPatch (and the Sheet) if the user actually hits Save on it.
      // Saving it immediately here was the bug: it queued a real write the instant you
      // clicked Duplicate, with no way to back out, and a slow/stuck sync looked like
      // the duplicate itself had failed.
      onDuplicate: isNew
        ? undefined
        : () => {
            const copy = duplicateTask(task)
            setState({ draftTask: copy })
            openTaskDialog(copy.id, { isNew: true })
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
      onDelete: (item) => {
        const existing = state.snapshot?.[kind] ?? []
        applyPatch({ [kind]: deleteRef(existing, item.id) })
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
      withPercent: Boolean(config.withPercent),
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

function completedCount(tasks, statusList) {
  return tasks.filter((t) => isTaskCompleted(t, statusList)).length
}

/**
 * A single global on/off toggle, not an N-item list — doesn't go through filterBar().
 * Deliberately its own modifier (.chip-toggle--on), not .chip-toggle--off: that class
 * means "this item is hidden" for the owner/status chips, and reusing it here would
 * make every exact chip-toggle--off count elsewhere ambiguous about which chip it means.
 */
function completedToggleChip(on, count) {
  const chip = el('button', `chip-toggle${on ? ' chip-toggle--on' : ''}`)
  chip.type = 'button'
  chip.setAttribute('aria-pressed', String(on))
  chip.title = on ? 'Сховати завершені завдання' : 'Показати завершені завдання'
  chip.addEventListener('click', () => setShowCompleted(!on))
  append(
    chip,
    el('span', 'chip-toggle__name', undefined, 'Показати завершено'),
    el('span', `chip-toggle__count${on ? ' chip-toggle__count--active' : ''}`, undefined, String(count)),
  )
  return chip
}

function toolbar() {
  const bar = el('div', 'app__bar')
  const editable = state.prefs.editingEnabled
  // While a write is pending or in flight, every control that could start a new edit
  // or discard this one (refresh) is locked — see syncing()'s doc comment for why.
  const locked = syncing()

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
  // The last status is "completed" (see isTaskCompleted) and has its own dedicated
  // toggle ("Показати завершено") — filtering by it here would be redundant with that.
  const statusBar = filterBar({
    items: statuses().slice(0, -1),
    hidden: hiddenStatuses,
    counts: countBy(tasks, 'status_id'),
    onToggle: (id) => setHiddenStatuses(toggleHidden(hiddenStatuses, id)),
    onShowAll: () => setHiddenStatuses([]),
  })
  const completedChip = append(
    el('div', 'chips-bar'),
    completedToggleChip(state.prefs.showCompleted, completedCount(tasks, statuses())),
  )

  // A divider only between groups that actually render — no dangling line before the
  // first one or after the last.
  const filters = el('div', 'app__filters')
  for (const group of [ownerBar, statusBar, completedChip]) {
    if (!group) continue
    if (filters.children.length > 0) append(filters, el('span', 'app__divider'))
    append(filters, group)
  }

  const refreshButton = button(
    ICON.reload,
    locked ? 'Зачекайте, поки зміни збережуться' : 'Оновити',
    () => { if (!locked) void refresh() },
  )
  refreshButton.disabled = locked || !state.credentials

  const editButton = button(
    editable ? '🔒' : '✏️',
    editable ? 'Завершити редагування' : 'Редагувати',
    () => setEditing(!editable),
  )
  editButton.disabled = !state.snapshot

  // Icon-only, like the other toolbar buttons — "Завдання" as a label was the widest
  // thing in the bar for the least information (the icon alone already reads as "add").
  const addButton = button(ICON.add, 'Додати завдання', () => { if (!locked) onAddTask() })
  addButton.className = 'app__button app__button--accent app__button--glyph'
  addButton.disabled = !state.snapshot || locked
  if (locked) addButton.title = 'Зачекайте, поки зміни збережуться'

  // Settings itself stays reachable even mid-sync — it's the only in-app way to forget
  // credentials or reset the cache if a sync/save is stuck. Only the dictionary editors
  // inside it (which write to the Sheet) are locked; see settingsMenu's `locked` prop.
  const settingsButton = button('⚙', 'Налаштування', () => {
    openDialog(
      settingsMenu({
        prefs: state.prefs,
        locked,
        connected: Boolean(state.credentials),
        onConnectGoogle: () => void signInToGoogle(),
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
          disconnectGoogle()
          setState({ credentials: null })
        },
        onManageCategories: () => openRefPanel('categories'),
        onManageOwners: () => openRefPanel('owners'),
        onManagePriorities: () => openRefPanel('priorities'),
        onManageStatuses: () => openRefPanel('statuses'),
        onClose: () => render(),
      }),
    )
  })

  const aboutButton = button('?', 'Про застосунок', () => openDialog(aboutPanel({ onClose: () => render() })))
  aboutButton.className = 'app__button app__button--glyph'

  return append(
    bar,
    el('h1', 'app__title', undefined, 'Дошка завдань'),
    el('span', 'app__divider'),
    filters,
    el('span', 'app__spacer'),
    statusSpan(),
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
  if (state.sync.status === 'saving') return `${ICON.saving} Збереження`
  if (state.sync.status === 'loading') return `${ICON.reload} Синхронізація`
  if (state.dirty) return 'Не збережено'
  if (state.sync.status === 'error') return 'Немає з’єднання'
  if (!state.snapshot) return 'Немає даних'
  const mins = Math.floor((Date.now() - state.snapshot.fetchedAt) / 60000)
  if (mins < 1) return 'Щойно оновлено'
  if (mins < 60) return `${mins} хв тому`
  return `${Math.floor(mins / 60)} год тому`
}

function statusSpan() {
  const text = statusText()
  const classes = [
    'app__status',
    busy() ? 'app__status--busy' : '',
    busy() ? 'app__status--loading' : '',
    text === 'Щойно оновлено' ? 'app__status--fresh' : '',
  ].filter(Boolean).join(' ')
  return el('span', classes, undefined, text)
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
        busy: state.sync.status === 'loading',
        error: state.sync.status === 'error' ? state.sync.message : undefined,
        // Sign in BEFORE storing anything: a client id that cannot grant a token is
        // worth reporting on the spot, not persisting and failing on the next load.
        onConnect: async (creds) => {
          setState({ sync: { status: 'loading' } })
          try {
            await connectGoogle(creds.clientId)
          } catch (err) {
            const message = err instanceof ApiError ? err.message : 'Не вдалося увійти в Google'
            setState({ sync: { status: 'error', message, code: 'needs_signin' } })
            return
          }
          saveCredentials(creds)
          setState({ credentials: creds, sync: { status: 'idle' } })
          void refresh()
        },
      }),
    )
    return
  }

  const hiddenOwners = hiddenOwnerSet()
  const hiddenStatuses = hiddenStatusSet()
  const tasks = displayTasks()
  const filtered = visibleTasks(tasks, hiddenOwners, hiddenStatuses, statuses(), state.prefs.showCompleted)
  const editable = state.prefs.editingEnabled && Boolean(state.snapshot) && !syncing()

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
 * Not safe to start a new edit, or to refresh, while a write is in flight OR still
 * only queued (the 1.2s save debounce). That gap — `dirty` but not yet `busy` — is
 * exactly how a newly-added task used to get lost: add a task, then hit refresh before
 * the debounced save ever fires, and the fetch's snapshot silently overwrote the local
 * one, discarding the unsent task. Locking every mutating control until this is false
 * closes that window instead of relying on timing.
 */
function syncing() {
  return busy() || state.dirty
}

/**
 * The Sheet is still on an older schema than this build expects.
 *
 * Usually self-resolving: columns are mapped by header name and every save stamps
 * `meta.schema_version`, so the first write after an upgrade brings the Sheet forward.
 * It stays visible until then because a structural change (a renamed column, a new tab)
 * does need doing by hand — there is no migration runner any more.
 *
 * Shown persistently rather than folded into errorNotice(): it is not a sync failure,
 * the board still loads, but some fields may read blank until it clears.
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
        'Оновиться після першого збереження; якщо ні — змініть структуру таблиці вручну.',
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
  } else if (['needs_signin', 'forbidden', 'access_denied'].includes(state.sync.code)) {
    // needs_signin: the token expired and could not be renewed without a popup, which
    // only a real click may open — a tap fixes it. The other two mean this account is
    // not allowed, so the only move that helps is a different one.
    const blocked = state.sync.code !== 'needs_signin'
    append(
      notice,
      el('span', 'app__spacer'),
      button(
        blocked ? 'Інший акаунт' : 'Увійти в Google',
        blocked ? 'Увійти іншим акаунтом' : 'Відновити доступ до таблиці',
        () => void signInToGoogle(),
      ),
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

/*
 * Poll on focus: Sheets pushes nothing, so this is the only way a change made on
 * another device arrives.
 *
 * Throttled: a tab switch is not evidence that anything changed, and alt-tabbing a few
 * times should not fire a request each time for data that is seconds old. Once a minute
 * still picks up another device's edits long before anyone notices.
 */
const FOCUS_REFRESH_MIN_MS = 60000

/*
 * Renewing an OAuth token opens a popup, which browsers allow only from a user gesture
 * — and a debounced background save has none. Piggy-backing on any click keeps the
 * token fresh ahead of time, so a save rarely has to stop and ask.
 */
document.addEventListener('click', () => {
  if (state.credentials) touchAuth(state.credentials.clientId)
}, { capture: true, passive: true })

window.addEventListener('focus', () => {
  if (!state.credentials || syncing()) return
  if (Date.now() - (state.snapshot?.fetchedAt ?? 0) < FOCUS_REFRESH_MIN_MS) return
  void refresh({ background: true })
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
