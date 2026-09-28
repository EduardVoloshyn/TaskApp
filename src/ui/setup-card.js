import { append, el } from './dom.js'
import { ICON, actionButton } from './buttons.js'
import { parseDeploymentId } from '../sync/api.js'

/**
 * First run on each device. The deployment id and secret are stored locally and never
 * shipped with the app, because it is served from a public static host.
 *
 * @param {{ onSave: (creds: { deploymentId: string, secret: string }) => void,
 *           error?: string }} props
 * @returns {HTMLElement}
 */
export function setupCard({ onSave, error }) {
  const form = el('form', 'card')

  const idField = el('label', 'field')
  append(idField, el('span', undefined, undefined, 'Deployment ID'))
  const idInput = el('input')
  idInput.type = 'text'
  idInput.placeholder = 'AKfycb…'
  idInput.autocapitalize = 'off'
  idInput.autocomplete = 'off'
  idInput.spellcheck = false
  append(idField, idInput)
  append(
    idField,
    el(
      'span',
      'field__hint',
      undefined,
      'Apps Script → Deploy → Manage deployments. Можна вставити і повну адресу.',
    ),
  )

  const secretField = el('label', 'field')
  append(secretField, el('span', undefined, undefined, 'Секрет'))
  const secretInput = el('input')
  secretInput.type = 'password'
  secretInput.autocomplete = 'off'
  append(secretField, secretInput)

  const submit = actionButton({
    icon: ICON.save, label: 'Зберегти', kind: 'primary', type: 'submit',
  })
  submit.disabled = true

  // Accepts a pasted URL too, so the id is what gets stored either way.
  const readId = () => parseDeploymentId(idInput.value)

  const validate = () => {
    submit.disabled = !(readId() && secretInput.value.trim())
  }
  idInput.addEventListener('input', validate)
  secretInput.addEventListener('input', validate)

  form.addEventListener('submit', (e) => {
    e.preventDefault()
    if (!submit.disabled) onSave({ deploymentId: readId(), secret: secretInput.value.trim() })
  })

  append(
    form,
    el('h2', undefined, undefined, 'Дошка завдань'),
    el('p', undefined, undefined, 'ID розгортання і секрет зберігаються лише на цьому пристрої.'),
    idField,
    secretField,
    error && el('div', 'notice', undefined, error),
    submit,
  )

  return append(el('div', 'centred'), form)
}
