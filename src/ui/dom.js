/**
 * The smallest useful DOM helper. No framework: at board scale a full re-render costs
 * nothing, so there is no diffing to justify and no dependency to maintain.
 *
 * @param {string} tag
 * @param {string} [className]
 * @param {Object<string,string>} [style]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
export function el(tag, className, style, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (style) for (const key of Object.keys(style)) node.style.setProperty(key, style[key])
  // textContent, never innerHTML — task names come from a spreadsheet a human types
  // into, and must never be parsed as markup.
  if (text != null) node.textContent = text
  return node
}

/** @param {HTMLElement} parent @param {...(Node|null|undefined|false)} children */
export function append(parent, ...children) {
  for (const child of children) if (child) parent.appendChild(child)
  return parent
}

/** Replaces everything inside a container. */
export function clear(node) {
  node.textContent = ''
  return node
}
