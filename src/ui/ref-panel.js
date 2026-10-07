import { append, el } from './dom.js'
import { ICON, actionButton } from './buttons.js'

/*
 * A generic reference-list editor: Categories, Owners, Priorities and Statuses all show
 * the same shape (a list, an edit button per row, an "add new" action) so one function
 * serves all four instead of four near-duplicate panels.
 *
 * Clicking a row opens it for editing directly — unlike ScheduleApp's templates panel,
 * these lists have no separate "pick to place" action, they are pure management.
 *
 * Each row also gets ▲/▼ reorder buttons (disabled at the boundaries). Order is
 * semantic for Categories/Priorities (board row/column order); for Owners/Statuses it
 * is cosmetic, but all four dictionaries sort the same way for consistency.
 *
 * @param {{ title: string,
 *           items: Array<{id: string, name: string}>,
 *           emptyHint: string,
 *           renderRow: (item: Object) => { modifier?: string, nodes: HTMLElement[] },
 *           onEdit: (item: Object) => void,
 *           onCreate: () => void,
 *           onReorder?: (item: Object, direction: 'up'|'down') => void,
 *           onDelete?: (item: Object) => void,
 *           onClose?: () => void }} props
 * @returns {HTMLDialogElement}
 */
export function refPanel({ title, items, emptyHint, renderRow, onEdit, onCreate, onReorder, onDelete, onClose }) {
  const dialog = /** @type {HTMLDialogElement} */ (el('dialog', 'sheet'))
  const body = el('div', 'sheet__form')

  append(body, el('h2', 'sheet__heading', undefined, title))

  if (items.length === 0) {
    append(body, el('p', 'sheet__hint', undefined, emptyHint))
  }

  const list = el('div', 'ref-list')
  items.forEach((item, index) => {
    const row = el('div', 'ref-list__row')
    const { modifier, nodes } = renderRow(item)

    const up = el('button', 'app__button ref-list__move', undefined, '↑')
    up.type = 'button'
    up.title = 'Перемістити вгору'
    up.disabled = index === 0
    up.addEventListener('click', () => {
      onReorder?.(item, 'up')
      dialog.close()
    })

    const down = el('button', 'app__button ref-list__move', undefined, '↓')
    down.type = 'button'
    down.title = 'Перемістити вниз'
    down.disabled = index === items.length - 1
    down.addEventListener('click', () => {
      onReorder?.(item, 'down')
      dialog.close()
    })

    const pick = el('button', `ref-list__pick${modifier ? ` ref-list__pick--${modifier}` : ''}`)
    pick.type = 'button'
    pick.title = `Редагувати «${item.name}»`
    append(pick, ...nodes)
    pick.addEventListener('click', () => {
      onEdit(item)
      dialog.close()
    })

    const edit = el('button', 'app__button ref-list__edit', undefined, ICON.edit)
    edit.type = 'button'
    edit.title = `Редагувати «${item.name}»`
    edit.addEventListener('click', () => {
      onEdit(item)
      dialog.close()
    })

    // A direct delete, not just reachable via the item editor — confirm() is the only
    // friction left against an accidental click, so it stays even though the edit-sheet
    // delete button has none (that one's already behind a deliberate navigation step).
    const del = el('button', 'app__button app__button--danger ref-list__delete', undefined, ICON.delete)
    del.type = 'button'
    del.title = `Видалити «${item.name}»`
    del.addEventListener('click', () => {
      if (!confirm(`Видалити «${item.name}»?`)) return
      onDelete?.(item)
      dialog.close()
    })

    append(row, append(el('div', 'ref-list__moves'), up, down), pick, edit, del)
    append(list, row)
  })
  append(body, list)

  append(
    body,
    append(
      el('div', 'sheet__actions'),
      actionButton({
        icon: ICON.add,
        label: 'Додати',
        kind: 'primary',
        onClick: () => {
          onCreate()
          dialog.close()
        },
      }),
      actionButton({ icon: ICON.close, label: 'Закрити', onClick: () => dialog.close() }),
    ),
  )

  dialog.addEventListener('close', () => onClose?.())
  append(dialog, body)
  return dialog
}
