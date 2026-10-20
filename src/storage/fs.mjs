/**
 * Filesystem driver: one file per key under a root directory.
 *
 * Meant for development and single-replica installs. Writes go to a temporary
 * file and are renamed into place, so a reader never sees half a document.
 * Conditional writes are serialised per key inside this process; two processes
 * sharing the directory are not coordinated, which is why the Helm chart only
 * allows the fs driver with one replica.
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'

import { assertKey, ConflictError } from './index.mjs'
import { KeyedLock } from './lock.mjs'

const etagOf = (st) => `"${st.size.toString(16)}-${st.mtimeNs.toString(16)}"`

export class FsStorage {
  constructor({ dir }) {
    if (!dir) throw new Error('fs storage needs a directory (ARTIFACTS_DATA_DIR)')
    this.name = 'fs'
    this.root = dir
    this.locks = new KeyedLock()
  }

  path(key) {
    return join(this.root, ...assertKey(key).split('/'))
  }

  async head(key) {
    try {
      const st = await stat(this.path(key), { bigint: true })
      if (!st.isFile()) return null
      return { etag: etagOf(st), size: Number(st.size), modified: new Date(Number(st.mtimeMs)) }
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
      throw error
    }
  }

  async get(key) {
    const path = this.path(key)
    try {
      // Stat and read can interleave with a rename; retry until both see the same file.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const before = await stat(path, { bigint: true })
        const body = await readFile(path)
        const after = await stat(path, { bigint: true })
        if (before.mtimeNs === after.mtimeNs && before.ino === after.ino) {
          return { body, etag: etagOf(after), contentType: undefined, modified: new Date(Number(after.mtimeMs)) }
        }
      }
      throw new Error(`file keeps changing while read: ${key}`)
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
      throw error
    }
  }

  async put(key, body, { ifMatch, ifNoneMatch } = {}) {
    return this.withLock(key, async () => {
      const path = this.path(key)
      if (ifMatch !== undefined || ifNoneMatch !== undefined) {
        const current = await this.head(key)
        if (ifNoneMatch === '*' && current) throw new ConflictError(`${key} already exists`)
        if (ifMatch !== undefined && (!current || current.etag !== ifMatch)) throw new ConflictError(`${key} changed`)
      }
      await mkdir(dirname(path), { recursive: true })
      const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`
      const handle = await open(tmp, 'w')
      try {
        await handle.writeFile(body)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(tmp, path)
      const st = await stat(path, { bigint: true })
      return { etag: etagOf(st) }
    })
  }

  async delete(key) {
    await this.withLock(key, () => rm(this.path(key), { force: true }))
  }

  async *list(prefix = '') {
    const base = prefix ? this.path(prefix.replace(/\/$/, '')) : this.root
    const keys = []
    const walk = async (dir) => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return
        throw error
      }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) await walk(full)
        else if (entry.isFile() && !entry.name.endsWith('.tmp')) keys.push(relative(this.root, full).split(sep).join('/'))
      }
    }
    await walk(base)
    keys.sort()
    for (const key of keys) {
      if (!key.startsWith(prefix)) continue
      const info = await this.head(key)
      if (info) yield { key, ...info }
    }
  }

  async check() {
    await mkdir(this.root, { recursive: true })
    const probe = join(this.root, `.probe-${createHash('sha1').update(String(process.pid)).digest('hex').slice(0, 8)}`)
    const handle = await open(probe, 'w')
    await handle.close()
    await rm(probe, { force: true })
  }

  withLock(key, fn) {
    return this.locks.run(key, fn)
  }

}
