#!/usr/bin/env node
/**
 * Waits until an S3 endpoint really serves the bucket the tests use: creates it if missing, then
 * writes (with If-None-Match, so conditional writes are checked too), reads and deletes a probe
 * object. A health endpoint answering is not enough; the first bucket call can still fail.
 *   ARTIFACTS_TEST_S3_ENDPOINT=… ARTIFACTS_TEST_S3_BUCKET=… ARTIFACTS_TEST_S3_ACCESS_KEY_ID=… \
 *   ARTIFACTS_TEST_S3_SECRET_ACCESS_KEY=… node scripts/wait-for-s3.mjs [timeout-seconds]
 */
import { S3Storage } from '../src/storage/s3.mjs'

const timeout = Number(process.argv[2] ?? 60) * 1000
const storage = new S3Storage({
  endpoint: process.env.ARTIFACTS_TEST_S3_ENDPOINT,
  bucket: process.env.ARTIFACTS_TEST_S3_BUCKET ?? 'artifacts-test',
  region: process.env.ARTIFACTS_TEST_S3_REGION ?? 'us-east-1',
  accessKeyId: process.env.ARTIFACTS_TEST_S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.ARTIFACTS_TEST_S3_SECRET_ACCESS_KEY,
})

const started = Date.now()
for (let attempt = 1; ; attempt += 1) {
  try {
    await storage.ensureBucket()
    const key = `readiness/${process.pid}-${attempt}.txt`
    await storage.put(key, Buffer.from('ok'), { ifNoneMatch: '*' })
    const got = await storage.get(key)
    if (got?.body.toString() !== 'ok') throw new Error('probe object did not read back')
    await storage.delete(key)
    console.log(`S3 ready after ${((Date.now() - started) / 1000).toFixed(1)} s (attempt ${attempt})`)
    break
  } catch (error) {
    if (Date.now() - started > timeout) {
      console.error(`S3 not ready after ${timeout / 1000} s: ${error.message}`)
      process.exit(1)
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}
