import { append, el } from './dom.js'

/*
 * Dialog action buttons.
 *
 * Every one carries an emoji and a label. Icon-only would be a smaller target for
 * irreversible actions in a Ukrainian UI, and 🗑 versus ⧉ at 14px is not a distinction
 * worth betting a delete on.
 *
 * Defined in one place so the same action looks the same everywhere — the task dialog,
 * the reference-list editors and settings all draw from here.
 */

export const ICON = {
  save: '✅',
  cancel: '❌',
  delete: '🗑️',
  add: '➕',
  edit: '✏️',
  duplicate: '⧉',
  close: '❌',
  reload: '🔄',
  reset: '🧹',
  forget: '🔑',
}

/**
 * @param {{ icon: string, label: string, title?: string, kind?: 'primary'|'danger',
 *           type?: 'button'|'submit', onClick?: () => void }} spec
 * @returns {HTMLButtonElement}
 */
export function actionButton({ icon, label, title, kind, type = 'button', onClick }) {
  const node = /** @type {HTMLButtonElement} */ (
    el('button', `app__button${kind ? ` app__button--${kind}` : ''}`)
  )
  node.type = type
  if (title) node.title = title

  append(
    node,
    // aria-hidden: the label already says what this does, so a screen reader announcing
    // "wastebasket Видалити" is noise.
    ariaHidden(el('span', 'app__button-icon', undefined, icon)),
    el('span', undefined, undefined, label),
  )

  if (onClick) node.addEventListener('click', onClick)
  return node
}

function ariaHidden(node) {
  node.setAttribute('aria-hidden', 'true')
  return node
}
