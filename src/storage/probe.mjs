/**
 * Checks how a store evaluates conditional writes, one at a time and overlapping.
 *
 * The overlapping part bypasses the driver's per-key lock on purpose: it measures the
 * store, not the driver. A store passes when exactly one of N simultaneous
 * `If-None-Match: *` creates and exactly one of N simultaneous `If-Match` updates win.
 */
import { randomBytes } from 'node:crypto'

import { ConflictError } from './index.mjs'

const settle = async (writes) => {
  const results = await Promise.allSettled(writes)
  const failed = results.find((r) => r.status === 'rejected' && !(r.reason instanceof ConflictError))
  if (failed) throw failed.reason
  return results.filter((r) => r.status === 'fulfilled').length
}

export async function probePreconditions(storage, { parallel = 8 } = {}) {
  const raw = typeof storage.putNow === 'function' ? storage.putNow.bind(storage) : storage.put.bind(storage)
  const base = `system/probe-${randomBytes(6).toString('hex')}`
  const keys = [`${base}/sequential.txt`, `${base}/concurrent.txt`]
  const put = (key, text, options) => raw(key, Buffer.from(text), { contentType: 'text/plain', ...options })
  try {
    // One at a time: a second create and a stale update must both be refused.
    const first = await put(keys[0], 'a', { ifNoneMatch: '*' })
    const secondCreate = await settle([put(keys[0], 'b', { ifNoneMatch: '*' })])
    await put(keys[0], 'c', { ifMatch: first.etag }).catch(() => {})
    const staleUpdate = await settle([put(keys[0], 'd', { ifMatch: first.etag })])
    const sequential = secondCreate === 0 && staleUpdate === 0

    // Overlapping: exactly one writer may win each round.
    const creates = await settle(Array.from({ length: parallel }, (_, i) => put(keys[1], `create ${i}`, { ifNoneMatch: '*' })))
    const current = await storage.head(keys[1])
    const updates = current ? await settle(Array.from({ length: parallel }, (_, i) => put(keys[1], `update ${i}`, { ifMatch: current.etag }))) : 0
    return { sequential, parallel, creates, updates, atomic: sequential && creates === 1 && updates === 1 }
  } finally {
    for (const key of keys) await storage.delete(key).catch(() => {})
  }
}
