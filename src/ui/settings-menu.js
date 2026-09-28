import { append, el } from './dom.js'
import { ICON, actionButton } from './buttons.js'

/**
 * "Налаштування": device preferences on top (theme, reload, reset cache, forget
 * credentials — same live-commit-per-control pattern as ScheduleApp's settings panel),
 * then a divider, then the four reference-list editors. ScheduleApp has no
 * drill-down/sub-menu precedent, so opening an editor closes this dialog first — only
 * one native <dialog> is ever open at a time.
 *
 * @param {{ prefs: Object,
 *           onChange: (patch: Object) => void,
 *           onClearLocal: () => void,
 *           onResetApp: () => void,
 *           onForgetCredentials: () => void,
 *           onManageCategories: () => void,
 *           onManageOwners: () => void,
 *           onManagePriorities: () => void,
 *           onManageStatuses: () => void,
 *           onClose?: () => void }} props
 * @returns {HTMLDialogElement}
 */
export function settingsMenu({
  prefs,
  onChange,
  onClearLocal,
  onResetApp,
  onForgetCredentials,
  onManageCategories,
  onManageOwners,
  onManagePriorities,
  onManageStatuses,
  onClose,
}) {
  const dialog = /** @type {HTMLDialogElement} */ (el('dialog', 'sheet'))
  const body = el('div', 'sheet__form')

  append(body, el('h2', 'sheet__heading', undefined, 'Налаштування'))

  // --- theme -----------------------------------------------------------------
  const theme = el('select', 'sheet__select')
  for (const [value, label] of [['system', 'Як у системі'], ['light', 'Світла'], ['dark', 'Темна']]) {
    const option = el('option', undefined, undefined, label)
    option.value = value
    if ((prefs.theme || 'system') === value) option.selected = true
    append(theme, option)
  }
  theme.addEventListener('change', () => onChange({ theme: theme.value }))
  append(body, field('Тема', theme))

  const clearLocal = actionButton({
    icon: ICON.reload,
    label: 'Перезавантажити з таблиці',
    title: 'Стерти локальну копію і взяти дані з Google Sheet',
    onClick: () => {
      onClearLocal?.()
      dialog.close()
    },
  })

  const resetApp = actionButton({
    icon: ICON.reset,
    label: 'Скинути кеш застосунку',
    title: 'Прибрати service worker і кеш, потім перезавантажити',
    onClick: () => onResetApp?.(),
  })

  const forget = actionButton({
    icon: ICON.forget,
    label: 'Забути адресу і секрет',
    kind: 'danger',
    onClick: () => {
      onForgetCredentials()
      dialog.close()
    },
  })

  append(body, append(el('div', 'sheet__actions'), clearLocal, resetApp, el('span', 'app__spacer'), forget))

  append(body, el('hr', 'sheet__divider'))
  append(body, el('h3', 'about__heading', undefined, 'Довідники'))

  const manage = (label, onClick) =>
    actionButton({ icon: ICON.edit, label, onClick: () => { onClick(); dialog.close() } })

  append(
    body,
    append(
      el('div', 'sheet__actions'),
      manage('Категорії', onManageCategories),
      manage('Виконавці', onManageOwners),
      manage('Пріоритети', onManagePriorities),
      manage('Статуси', onManageStatuses),
    ),
  )

  append(
    body,
    append(
      el('div', 'sheet__actions'),
      actionButton({ icon: ICON.close, label: 'Закрити', onClick: () => dialog.close() }),
    ),
  )

  dialog.addEventListener('close', () => onClose?.())
  append(dialog, body)
  return dialog
}

function field(label, control) {
  const wrap = el('label', 'field')
  append(wrap, el('span', undefined, undefined, label), control)
  return wrap
}
