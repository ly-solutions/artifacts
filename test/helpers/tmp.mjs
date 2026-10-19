import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'artifacts-test-'))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}
