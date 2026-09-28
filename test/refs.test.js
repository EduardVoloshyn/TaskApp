import { eq, test } from './harness.js'
import { createRef, deleteRef, findRef, moveRef, updateRef } from '../src/model/refs.js'

/*
 * The generic reference-list CRUD, exercised against shapes for all four entities
 * (Categories/Owners/Priorities are name-only; Statuses also carry color/icon).
 */

test('createRef appends and fills in an id when absent', () => {
  const list = createRef([{ id: 'a', name: 'A' }], { name: 'B' })
  eq(list.length, 2)
  eq(list[1].name, 'B')
  eq(typeof list[1].id, 'string')
  eq(list[1].id.length > 0, true)
})

test('createRef preserves order — new items go last', () => {
  const list = createRef([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], { id: 'c', name: 'C' })
  eq(list.map((i) => i.id), ['a', 'b', 'c'])
})

test('updateRef replaces fields in place without reordering', () => {
  const list = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }]
  const updated = updateRef(list, 'b', { name: 'B2' })
  eq(updated.map((i) => i.name), ['A', 'B2', 'C'])
})

test('updateRef never changes the id, even if the patch tries to', () => {
  const list = [{ id: 'a', name: 'A' }]
  const updated = updateRef(list, 'a', { id: 'hijack', name: 'A2' })
  eq(updated[0].id, 'a')
})

test('updateRef merges Status color/icon fields', () => {
  const list = [{ id: 's1', name: 'Todo', color: 'slate', icon: '' }]
  const updated = updateRef(list, 's1', { color: 'blue', icon: '📌' })
  eq(updated[0], { id: 's1', name: 'Todo', color: 'blue', icon: '📌' })
})

test('deleteRef removes only the named item, preserving the rest’s order', () => {
  const list = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }]
  eq(deleteRef(list, 'b').map((i) => i.id), ['a', 'c'])
})

test('findRef finds by id', () => {
  const list = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
  eq(findRef(list, 'b').name, 'B')
  eq(findRef(list, 'missing'), undefined)
})

/* --------------------------------------------------------------- moveRef ---- */

test('moveRef swaps an item up with its neighbour', () => {
  const list = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }]
  eq(moveRef(list, 'b', 'up').map((i) => i.id), ['b', 'a', 'c'])
})

test('moveRef swaps an item down with its neighbour', () => {
  const list = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }]
  eq(moveRef(list, 'b', 'down').map((i) => i.id), ['a', 'c', 'b'])
})

test('moveRef is a no-op at the top edge', () => {
  const list = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
  eq(moveRef(list, 'a', 'up').map((i) => i.id), ['a', 'b'])
})

test('moveRef is a no-op at the bottom edge', () => {
  const list = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
  eq(moveRef(list, 'b', 'down').map((i) => i.id), ['a', 'b'])
})

test('moveRef is a no-op for an unknown id', () => {
  const list = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
  eq(moveRef(list, 'missing', 'up'), list)
})

test('moveRef does not mutate the input array', () => {
  const list = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
  moveRef(list, 'b', 'up')
  eq(list.map((i) => i.id), ['a', 'b'], 'the original array was reordered in place')
})
