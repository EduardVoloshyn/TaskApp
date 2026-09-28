import { PALETTE } from '../model/refs.js'
import { append, el } from './dom.js'

/*
 * Form controls shared by the task dialog and the reference-list editors.
 *
 * Each builder returns `{ node, value() }` — the caller lays the node out and reads the
 * value on submit, so these hold their own state without a framework.
 */

/**
 * A row of palette swatches. Colour is always a token, never a free value.
 *
 * @param {string} selected
 * @returns {{ node: HTMLElement, value: () => string }}
 */
export function colourField(selected) {
  let colour = PALETTE.includes(selected) ? selected : 'slate'

  const node = el('div', 'swatches')
  const buttons = PALETTE.map((token) => {
    const button = el('button', `swatch swatch--${token}${token === colour ? ' swatch--on' : ''}`)
    button.type = 'button'
    button.title = token
    button.addEventListener('click', () => {
      colour = token
      for (const other of buttons) other.classList.remove('swatch--on')
      button.classList.add('swatch--on')
    })
    return button
  })
  append(node, ...buttons)

  return { node, value: () => colour }
}

/**
 * Borderless emoji buttons, plus a clear option.
 *
 * @param {string} selected
 * @param {string[]} choices
 * @returns {{ node: HTMLElement, value: () => string }}
 */
export function iconField(selected, choices = []) {
  let icon = selected ?? ''
  const buttons = []
  const node = el('div', 'icons')

  const clear = el(
    'button',
    `icons__pick icons__none${icon ? '' : ' icons__pick--on'}`,
    undefined,
    '—',
  )
  clear.type = 'button'
  clear.title = 'Без емодзі'
  buttons.push(clear)
  append(node, clear)

  // An icon set before the offered list changed must still be offered, or editing
  // anything else about the row would quietly strip it.
  const offered = !icon || choices.includes(icon) ? choices : [icon, ...choices]

  for (const choice of offered) {
    const pick = el(
      'button',
      `icons__pick${choice === icon ? ' icons__pick--on' : ''}`,
      undefined,
      choice,
    )
    pick.type = 'button'
    pick.dataset.icon = choice
    buttons.push(pick)
    append(node, pick)
  }

  for (const button of buttons) {
    button.addEventListener('click', () => {
      icon = button.dataset.icon ?? ''
      for (const other of buttons) other.classList.remove('icons__pick--on')
      button.classList.add('icons__pick--on')
    })
  }

  return { node, value: () => icon }
}

/**
 * A plain select over a reference list (Status/Category/Priority/Owner), with a "none"
 * option and orphan-value injection: if the current value names an id no longer in the
 * list, it is offered anyway so saving never silently reassigns it.
 *
 * `required: true` omits the "none" option entirely (Category/Priority are mandatory on
 * a task) — with nothing pre-selected, the browser falls back to the first real option,
 * so the field is never left blank once at least one option exists.
 *
 * @param {string | undefined} selected
 * @param {{ id: string, name: string }[]} options
 * @param {string} [noneLabel]
 * @param {{ required?: boolean }} [opts]
 * @returns {{ node: HTMLSelectElement, value: () => string }}
 */
export function refSelectField(selected, options = [], noneLabel = '— немає —', { required = false } = {}) {
  const node = /** @type {HTMLSelectElement} */ (el('select', 'sheet__select'))
  node.required = required

  if (!required) {
    const none = el('option', undefined, undefined, noneLabel)
    none.value = ''
    if (!selected) none.selected = true
    append(node, none)
  }

  let matched = false
  for (const option of options) {
    const opt = el('option', undefined, undefined, option.name)
    opt.value = option.id
    if (option.id === selected) {
      opt.selected = true
      matched = true
    }
    append(node, opt)
  }

  if (selected && !matched) {
    const orphan = el('option', undefined, undefined, `${selected} (немає в списку)`)
    orphan.value = selected
    orphan.selected = true
    append(node, orphan)
  }

  return { node, value: () => node.value }
}

/** @param {string} label @param {HTMLElement} control */
export function field(label, control) {
  const wrap = el('label', 'field')
  append(wrap, el('span', undefined, undefined, label), control)
  return wrap
}

export function row(...children) {
  return append(el('div', 'sheet__row'), ...children)
}

export function textInput(type, value) {
  const node = el('input')
  node.type = type
  node.value = value ?? ''
  node.autocomplete = 'off'
  return node
}

export function dateField(value) {
  return textInput('date', value)
}

export function textArea(value) {
  const node = el('textarea', 'sheet__textarea')
  node.value = value ?? ''
  return node
}
