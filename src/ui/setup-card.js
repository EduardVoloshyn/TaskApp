import { append, el } from './dom.js'
import { ICON, actionButton } from './buttons.js'
import { isClientId, parseSpreadsheetId } from '../sync/sheets.js'

/**
 * First run on each device: which Sheet, and which OAuth client to reach it with.
 *
 * Neither value is a secret — the OAuth client id is a public identifier restricted by
 * its authorised origins, and the spreadsheet id is useless without access to the Sheet
 * itself. Access is granted by signing in, and is exactly the Sheet's own Google
 * sharing settings. Both are still kept on the device rather than in the repo, so one
 * published build does not point every visitor at one person's board.
 *
 * The submit button doubles as the sign-in trigger: granting an OAuth token opens a
 * popup, and browsers only allow that from a real click.
 *
 * @param {{ onConnect: (creds: { clientId: string, spreadsheetId: string }) => void,
 *           busy?: boolean, error?: string }} props
 * @returns {HTMLElement}
 */
export function setupCard({ onConnect, busy = false, error }) {
  const form = el('form', 'card')

  const sheetField = el('label', 'field')
  append(sheetField, el('span', undefined, undefined, 'Таблиця Google Sheets'))
  const sheetInput = el('input')
  sheetInput.type = 'text'
  sheetInput.placeholder = 'https://docs.google.com/spreadsheets/d/…'
  sheetInput.autocapitalize = 'off'
  sheetInput.autocomplete = 'off'
  sheetInput.spellcheck = false
  append(sheetField, sheetInput)
  append(sheetField, el('span', 'field__hint', undefined, 'Вставте адресу таблиці або лише її ID.'))

  const clientField = el('label', 'field')
  append(clientField, el('span', undefined, undefined, 'OAuth client ID'))
  const clientInput = el('input')
  clientInput.type = 'text'
  clientInput.placeholder = '…apps.googleusercontent.com'
  clientInput.autocapitalize = 'off'
  clientInput.autocomplete = 'off'
  clientInput.spellcheck = false
  append(clientField, clientInput)
  append(
    clientField,
    el('span', 'field__hint', undefined, 'Google Cloud → Credentials → OAuth client ID (Web application).'),
  )

  const submit = actionButton({
    icon: ICON.save,
    label: busy ? 'Підключення…' : 'Підключити Google',
    kind: 'primary',
    type: 'submit',
  })

  const read = () => ({
    clientId: clientInput.value.trim(),
    spreadsheetId: parseSpreadsheetId(sheetInput.value),
  })

  const validate = () => {
    const { clientId, spreadsheetId } = read()
    submit.disabled = busy || !spreadsheetId || !isClientId(clientId)
  }
  validate()
  sheetInput.addEventListener('input', validate)
  clientInput.addEventListener('input', validate)

  form.addEventListener('submit', (e) => {
    e.preventDefault()
    if (!submit.disabled) onConnect(read())
  })

  append(
    form,
    el('h2', undefined, undefined, 'Дошка завдань'),
    el('p', undefined, undefined, 'Налаштування зберігаються лише на цьому пристрої.'),
    sheetField,
    clientField,
    error && el('div', 'notice', undefined, error),
    submit,
  )

  return append(el('div', 'centred'), form)
}
