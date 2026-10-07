/**
 * A minimal DOM, enough to run the app's render path under jsc.
 *
 * The point is to catch boot-time crashes headlessly: a blank screen on one device is
 * the worst failure this app can have, and neither the model tests nor a syntax check
 * would notice one. This is deliberately not a real DOM — it implements only what the
 * UI modules actually touch.
 */

class StubNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.parentNode = null
    this.dataset = {}
    this.classNameValue = ''
    this.listeners = {}
    this.styleProps = {}
    this.attributes = {}
    this.text = ''
    this.style = {
      setProperty: (k, v) => {
        this.styleProps[k] = v
      },
    }
    this.classList = {
      add: (c) => {
        if (!this.classNameValue.split(' ').includes(c)) this.classNameValue += ` ${c}`
      },
      remove: (c) => {
        this.classNameValue = this.classNameValue
          .split(' ')
          .filter((x) => x && x !== c)
          .join(' ')
      },
      contains: (c) => this.classNameValue.split(' ').includes(c),
    }
  }

  get className() {
    return this.classNameValue
  }
  set className(value) {
    this.classNameValue = value || ''
  }

  /** A <select> reports the value of its selected <option>. */
  get value() {
    if (this.tagName === 'SELECT') {
      const chosen = this.children.find((c) => c.selected) ?? this.children[0]
      return chosen ? chosen.valueProp ?? '' : ''
    }
    return this.valueProp ?? ''
  }
  set value(v) {
    this.valueProp = v == null ? '' : String(v)
    if (this.tagName === 'SELECT') {
      for (const child of this.children) child.selected = child.valueProp === this.valueProp
    }
  }

  get textContent() {
    return this.text || this.children.map((c) => c.textContent).join('')
  }
  set textContent(value) {
    this.children = []
    this.text = value == null ? '' : String(value)
  }

  appendChild(child) {
    child.parentNode = this
    this.children.push(child)
    this.text = ''
    return child
  }
  append(...nodes) {
    for (const n of nodes) this.appendChild(n)
  }
  remove() {
    if (!this.parentNode) return
    this.parentNode.children = this.parentNode.children.filter((c) => c !== this)
    this.parentNode = null
  }
  addEventListener(type, fn) {
    ;(this.listeners[type] ||= []).push(fn)
  }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn)
  }
  dispatch(type, event = {}) {
    for (const fn of this.listeners[type] || []) fn(event)
  }
  setAttribute(k, v) {
    this.attributes[k] = v
  }
  removeAttribute(k) {
    delete this.attributes[k]
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 100, bottom: 600, width: 100, height: 600 }
  }
  showModal() {
    this.open = true
  }
  close() {
    this.open = false
    this.dispatch('close')
  }
  /** Walks up looking for a class selector — the only form the board's click delegate uses. */
  closest(selector) {
    const wanted = selector.replace('.', '')
    let node = this
    while (node) {
      if (node.classNameValue && node.classNameValue.split(' ').includes(wanted)) return node
      node = node.parentNode
    }
    return null
  }

  /** Depth-first search by class, for assertions. */
  find(className) {
    if (this.classNameValue.split(' ').includes(className)) return this
    for (const child of this.children) {
      const hit = child.find(className)
      if (hit) return hit
    }
    return null
  }
  findAll(className, out = []) {
    if (this.classNameValue.split(' ').includes(className)) out.push(this)
    for (const child of this.children) child.findAll(className, out)
    return out
  }
}

/**
 * @param {{ store?: Object }} [options]
 * @returns {{ root: StubNode, store: Object }}
 */
export function installDom(options = {}) {
  const store = options.store || {}
  const root = new StubNode('div')
  root.id = 'root'

  const documentElement = new StubNode('html')
  const body = new StubNode('body')

  globalThis.document = {
    documentElement,
    body,
    getElementById: (id) => (id === 'root' ? root : null),
    createElement: (tag) => new StubNode(tag),
    createTextNode: (text) => {
      const node = new StubNode('#text')
      node.text = String(text)
      return node
    },
  }

  globalThis.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
  }

  globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = String(v)
    },
    removeItem: (k) => {
      delete store[k]
    },
  }

  // Enough of the browser globals that src/app.js can boot under jsc.
  globalThis.location = {
    href: 'http://localhost:8000/',
    protocol: 'http:',
    hostname: 'localhost',
    search: '',
    reload: () => {},
    replace: () => {},
  }
  globalThis.navigator = { userAgent: 'jsc-stub' }

  if (typeof globalThis.URLSearchParams !== 'function') {
    globalThis.URLSearchParams = class {
      constructor(query = '') {
        this.map = new Map()
        for (const pair of String(query).replace(/^\?/, '').split('&')) {
          if (!pair) continue
          const [k, v = ''] = pair.split('=')
          this.map.set(decodeURIComponent(k), decodeURIComponent(v))
        }
      }
      get(key) { return this.map.has(key) ? this.map.get(key) : null }
      delete(key) { this.map.delete(key) }
    }
  }
  if (typeof globalThis.URL !== 'function') {
    globalThis.URL = class {
      constructor(href) { this.href = String(href); this.searchParams = new URLSearchParams('') }
      toString() { return this.href }
    }
  }

  globalThis.matchMedia = () => ({ matches: false })
  // Defaults to confirming — a test that needs to simulate Cancel sets
  // `globalThis.confirm = () => false` directly before dispatching the click.
  globalThis.confirm = options.confirm ?? (() => true)
  globalThis.requestAnimationFrame = (fn) => fn()
  globalThis.cancelAnimationFrame = () => {}
  if (typeof globalThis.setTimeout !== 'function') globalThis.setTimeout = () => 0
  if (typeof globalThis.clearTimeout !== 'function') globalThis.clearTimeout = () => {}
  if (typeof globalThis.setInterval !== 'function') globalThis.setInterval = () => 0

  // Never let a test reach the network.
  globalThis.fetch = () => Promise.reject(new Error('fetch disabled in tests'))

  return { root, store }
}

export { StubNode }
