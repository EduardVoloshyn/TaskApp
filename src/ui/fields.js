import { PALETTE } from '../model/refs.js'
import { progressBounds, progressForStatus, toPercent } from '../model/tasks.js'
import { append, el } from './dom.js'
import { progressBand } from './progress-bar.js'

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
 * @param {(token: string) => void} [onChange] so a collapsed trigger can follow along
 * @returns {{ node: HTMLElement, value: () => string }}
 */
export function colourField(selected, onChange) {
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
      onChange?.(colour)
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
 * @param {(icon: string) => void} [onChange] so a collapsed trigger can follow along
 * @returns {{ node: HTMLElement, value: () => string }}
 */
export function iconField(selected, choices = [], onChange) {
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
      onChange?.(icon)
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

/**
 * A whole-percent spinner over a fraction.
 *
 * The model stores 0..1 (so a Status's start and a task's progress share one unit), but
 * nobody wants to type 0.45 — so this shows 45 and converts at the edge. `bounds` are
 * inclusive whole percents; the value is clamped on the way out as well as constrained
 * in the markup, because `min`/`max` on a number input are advisory in several browsers.
 *
 * @param {number} fraction
 * @param {{ min?: number, max?: number }} [bounds]
 * @returns {{ node: HTMLInputElement, value: () => number, setBounds: (b: Object) => void,
 *            set: (fraction: number) => void }}
 */
export function percentField(fraction, bounds = {}) {
  let min = bounds.min ?? 0
  let max = bounds.max ?? 100

  const node = /** @type {HTMLInputElement} */ (el('input', 'percent-input'))
  node.type = 'number'
  node.step = '1'
  node.autocomplete = 'off'

  const clamp = (percent) => Math.min(max, Math.max(min, Math.round(Number(percent) || 0)))

  const paint = (percent) => {
    node.min = String(min)
    node.max = String(max)
    node.value = String(clamp(percent))
  }
  paint(Math.round((Number(fraction) || 0) * 100))

  node.addEventListener('blur', () => paint(node.value))

  return {
    node,
    value: () => clamp(node.value) / 100,
    setBounds: (next) => {
      min = next.min ?? 0
      max = next.max ?? 100
      paint(node.value)
    },
    set: (next) => paint(Math.round((Number(next) || 0) * 100)),
  }
}

/**
 * The task's progress: a slider over the Status stages, coloured by them.
 *
 * The slider spans the whole 0..100 so it shares one coordinate space with the painted
 * track; the current stage's limit is applied in the input handler instead of through
 * min/max. Narrowing min/max to the stage instead looks equivalent and is not — the
 * thumb would then travel the full width across a fraction of the scale, and drift
 * badly away from the fill it is supposed to sit on.
 *
 * Changing status snaps the value to that stage's start, which is why `setStatus` is
 * part of the returned handle rather than the caller poking at the node.
 *
 * @param {number} fraction 0..1
 * @param {ReadonlyArray<{id: string, name: string, color: string, start_percent?: number}>} statuses
 * @param {string} statusId
 * @returns {{ node: HTMLElement, value: () => number, setStatus: (id: string) => void }}
 */
export function progressField(fraction, statuses = [], statusId = '') {
  let current = statusId
  let percent = toPercent(fraction)

  const root = el('div', 'progress')

  const caption = el('div', 'progress__caption')
  const stage = el('span', 'progress__stage')
  const value = el('span', 'progress__value')
  append(
    caption,
    el('span', undefined, undefined, 'Поточний прогрес виконання: '),
    stage,
    el('span', undefined, undefined, ' '),
    value,
  )

  const track = el('div', 'progress__track')
  const band = progressBand(statuses)

  const range = /** @type {HTMLInputElement} */ (el('input', 'progress__range'))
  range.type = 'range'
  range.min = '0'
  range.max = '100'
  range.step = '1'
  // No visible <label>: the caption above carries the meaning for sighted users.
  range.setAttribute('aria-label', 'Прогрес виконання, відсоток')
  append(track, band.node, range)

  const ticks = el('div', 'progress__ticks')
  const tickNodes = tickPlacements(statuses).map((t) => {
    const node = el('div', 'progress__tick', t.style, `${t.at} %`)
    append(ticks, node)
    return { id: t.id, node }
  })

  function paint() {
    const bounds = progressBounds(statuses, current)
    percent = Math.min(bounds.max, Math.max(bounds.min, percent))

    range.value = String(percent)
    range.setAttribute('aria-valuetext', `${percent} %`)
    band.setPercent(percent)
    value.textContent = `${percent} %`

    const status = statuses.find((s) => s.id === current)
    stage.textContent = status ? status.name : 'без статусу'
    root.className = `progress${status && PALETTE.includes(status.color) ? ` progress--${status.color}` : ''}`

    for (const tick of tickNodes) {
      tick.node.className = `progress__tick${tick.id === current ? ' progress__tick--on' : ''}`
    }
  }

  range.addEventListener('input', () => {
    percent = Number(range.value)
    paint()
  })

  append(root, caption, track, ticks)
  paint()

  return {
    node: root,
    value: () => percent / 100,
    setStatus: (id) => {
      current = id
      percent = toPercent(progressForStatus(statuses, id))
      paint()
    },
  }
}

/**
 * Which stage starts get a printed number, and how each one is anchored.
 *
 * Labels are centred on their boundary, clamped at both ends so they cannot spill out
 * of the track, and dropped when they would land on top of the previous one — stages
 * can start a few percent apart (95 and 100 collided into "95 %100"), and two numbers
 * sharing the same pixels is worse than one number missing.
 */
export function tickPlacements(statuses, minGap = 10) {
  const out = []
  let lastAt = -Infinity

  statuses.forEach((s) => {
    const at = toPercent(s.start_percent)
    if (at - lastAt < minGap) return
    lastAt = at

    if (at <= 5) out.push({ id: s.id, at, style: { left: '0' } })
    else if (at >= 95) out.push({ id: s.id, at, style: { right: '0' } })
    else out.push({ id: s.id, at, style: { left: `${at}%`, transform: 'translateX(-50%)' } })
  })

  return out
}

/**
 * A picker folded behind a button that shows what is currently chosen.
 *
 * Native `<details>`, so it opens by keyboard and needs no JS to toggle. The colour
 * swatches and the 33-button emoji grid together ran to ~120px of a 610px dialog and
 * are the two things changed least often — collapsed, they cost one line.
 *
 * `face` is the caller's to fill and refill: only it knows how to say "Бурштиновий"
 * or draw the chosen glyph.
 *
 * @param {string} label
 * @param {HTMLElement} panel the full picker, shown when open
 * @param {{ onOpen?: () => void }} [options] fires when this one opens, so a sibling
 *   picker can close itself — two popovers over the same form overlap.
 * @returns {{ node: HTMLElement, face: HTMLElement, close: () => void,
 *             describe: (text: string) => void }}
 */
export function pickerField(label, panel, { onOpen } = {}) {
  const details = el('details', 'picker')
  const summary = el('summary', 'picker__trigger')
  const face = el('span', 'picker__face')

  append(summary, face, el('span', 'picker__chev'))
  append(details, summary, append(el('div', 'picker__panel'), panel))

  // A div, not the <label> field() uses: a label wrapping a <summary> swallows the
  // click that should open it.
  const node = append(el('div', 'field'), el('span', undefined, undefined, label), details)

  details.addEventListener('toggle', () => { if (details.open) onOpen?.() })

  return {
    node,
    face,
    close: () => { details.open = false },
    // The colour trigger is a bare dot, so the choice has to be said out loud
    // somewhere for anything that is not looking at it.
    describe: (text) => {
      summary.setAttribute('aria-label', `${label}: ${text}`)
      summary.title = text
    },
  }
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
