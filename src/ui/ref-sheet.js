import { append, el } from './dom.js'
import { ICON, actionButton } from './buttons.js'
import { colourField, field, iconField, textInput } from './fields.js'

/*
 * A generic reference-item editor: Categories/Owners need only a name; Priorities also
 * need a colour; Statuses need both a colour and an icon. One dialog, configured per
 * entity via independent withColor/withIcon flags, instead of near-duplicate forms.
 *
 * @param {{ title: string,
 *           item: { id?: string, name?: string, color?: string, icon?: string },
 *           isNew: boolean,
 *           withColor?: boolean,
 *           withIcon?: boolean,
 *           iconChoices?: string[],
 *           onSave: (values: Object) => void,
 *           onDelete?: () => void,
 *           onClose?: () => void }} props
 * @returns {HTMLDialogElement}
 */
export function refSheet({ title, item, isNew, withColor = false, withIcon = false, iconChoices = [], onSave, onDelete, onClose }) {
  const dialog = /** @type {HTMLDialogElement} */ (el('dialog', 'sheet'))
  const form = el('form', 'sheet__form')

  const name = textInput('text', item.name ?? '')
  name.placeholder = 'Назва'
  name.className = 'sheet__title-input'

  const colour = withColor ? colourField(item.color ?? 'slate') : null
  const icon = withIcon ? iconField(item.icon ?? '', iconChoices) : null

  const save = actionButton({ icon: ICON.save, label: 'Зберегти', kind: 'primary', type: 'submit' })

  const validate = () => {
    save.disabled = name.value.trim().length === 0
  }
  name.addEventListener('input', validate)
  validate()

  form.addEventListener('submit', (e) => {
    e.preventDefault()
    if (save.disabled) return
    onSave({
      id: item.id,
      name: name.value.trim(),
      ...(withColor ? { color: colour.value() } : {}),
      ...(withIcon ? { icon: icon.value() } : {}),
    })
    dialog.close()
  })

  dialog.addEventListener('close', () => onClose?.())

  append(
    form,
    el('h2', 'sheet__heading', undefined, title),
    field('Назва', name),
    withColor ? field('Колір', colour.node) : null,
    withIcon ? field('Емодзі', icon.node) : null,
    append(
      el('div', 'sheet__actions'),
      save,
      actionButton({ icon: ICON.cancel, label: 'Скасувати', onClick: () => dialog.close() }),
      el('span', 'app__spacer'),
      !isNew &&
        onDelete &&
        actionButton({
          icon: ICON.delete,
          label: 'Видалити',
          kind: 'danger',
          onClick: () => {
            onDelete()
            dialog.close()
          },
        }),
    ),
  )

  append(dialog, form)
  return dialog
}
