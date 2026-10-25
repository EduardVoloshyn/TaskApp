import { ICON_CHOICES } from '../model/refs.js'
import { append, el } from './dom.js'
import { ICON, actionButton } from './buttons.js'
import { colourField, dateField, field, iconField, progressField, refSelectField, row, textArea, textInput } from './fields.js'

/**
 * The task add/edit dialog.
 *
 * @param {{ task: Object, isNew: boolean,
 *           statuses: Array, categories: Array, priorities: Array, owners: Array,
 *           onSave: (values: Object) => void,
 *           onDelete?: () => void,
 *           onDuplicate?: () => void,
 *           onClose?: () => void }} props
 * @returns {HTMLDialogElement}
 */
export function taskDialog({
  task, isNew, statuses, categories, priorities, owners, onSave, onDelete, onDuplicate, onClose,
}) {
  const dialog = /** @type {HTMLDialogElement} */ (el('dialog', 'sheet'))
  const form = el('form', 'sheet__form')

  const name = textInput('text', task.name ?? '')
  name.placeholder = 'Назва завдання'
  name.className = 'sheet__title-input'

  // The task's own look — independent of its Status, which is shown below as a
  // progress bar rather than a colour.
  const colour = colourField(task.color || 'slate')
  const icon = iconField(task.icon ?? '', ICON_CHOICES)

  const status = refSelectField(task.status_id, statuses, '— без статусу —')
  const category = refSelectField(task.category_id, categories, undefined, { required: true })
  const priority = refSelectField(task.priority_id, priorities, undefined, { required: true })
  const owner = refSelectField(task.owner_id, owners, '— без виконавця —')
  const dueDate = dateField(task.due_date ?? '')
  const notes = textArea(task.notes ?? '')

  // Progress belongs to the chosen status: picking one snaps the value to that stage's
  // start, and the slider is then bounded by the stage — from its own start up to just
  // below the next status's, or to 100% for the last, the only stage that can read as
  // finished. The control draws its own caption, so it gets no field() label.
  const progress = progressField(task.progress_percent ?? 0, statuses, task.status_id)
  status.node.addEventListener('change', () => progress.setStatus(status.value()))

  const save = actionButton({ icon: ICON.save, label: 'Зберегти', kind: 'primary', type: 'submit' })

  // Category and priority are the board's two axes — a task without both has nowhere
  // to live, so saving is blocked until each has a real value (an empty select, only
  // possible when that dictionary has zero entries yet, correctly blocks too).
  const validate = () => {
    save.disabled = name.value.trim().length === 0 || !category.value() || !priority.value()
  }
  name.addEventListener('input', validate)
  category.node.addEventListener('change', validate)
  priority.node.addEventListener('change', validate)
  validate()

  form.addEventListener('submit', (e) => {
    e.preventDefault()
    if (save.disabled) return
    onSave({
      id: task.id,
      name: name.value,
      color: colour.value(),
      icon: icon.value(),
      status_id: status.value(),
      category_id: category.value(),
      priority_id: priority.value(),
      owner_id: owner.value(),
      due_date: dueDate.value,
      notes: notes.value,
      progress_percent: progress.value(),
    })
    dialog.close()
  })

  dialog.addEventListener('close', () => onClose?.())

  append(
    form,
    el('h2', 'sheet__heading', undefined, isNew ? 'Нове завдання' : 'Завдання'),
    field('Назва', name),
    field('Колір', colour.node),
    field('Емодзі', icon.node),
    row(field('Статус', status.node), field('Категорія *', category.node)),
    row(field('Пріоритет *', priority.node), field('Виконавець', owner.node)),
    progress.node,
    field('Термін виконання', dueDate),
    field('Нотатки', notes),
    append(
      el('div', 'sheet__actions'),
      save,
      actionButton({ icon: ICON.cancel, label: 'Скасувати', onClick: () => dialog.close() }),
      !isNew &&
        onDuplicate &&
        actionButton({
          icon: ICON.duplicate,
          label: 'Дублювати',
          onClick: () => {
            onDuplicate()
            dialog.close()
          },
        }),
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
