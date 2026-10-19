import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { ipInCidrs, parseCidr } from '../src/auth/cidr.mjs'
import { loadConfig, parseDuration, validateConfig } from '../src/config.mjs'

describe('configuration', () => {
  it('refuses to start in token mode without a token', () => {
    const { errors } = validateConfig(loadConfig({ ARTIFACTS_STORAGE: 'fs' }))
    assert.ok(errors.some((e) => e.includes('ARTIFACTS_TOKEN')))
  })

  it('uses s3 when a bucket is set, a directory otherwise', () => {
    assert.equal(loadConfig({}).storage, 'fs')
    assert.equal(loadConfig({ ARTIFACTS_S3_BUCKET: 'bkt' }).storage, 's3')
    assert.equal(loadConfig({ ARTIFACTS_S3_CONDITIONAL_WRITES: 'off' }).s3.conditionalWrites, false)
    assert.equal(loadConfig({ ARTIFACTS_S3_CONDITIONAL_WRITES: 'auto' }).s3.conditionalWrites, true)
  })

  it('requires a bucket and credentials for s3', () => {
    const { errors } = validateConfig(loadConfig({ ARTIFACTS_STORAGE: 's3', ARTIFACTS_TOKEN: 'x'.repeat(32) }))
    assert.ok(errors.some((e) => e.includes('ARTIFACTS_S3_BUCKET')))
    assert.ok(errors.some((e) => e.includes('credentials')))
  })

  it('refuses an invalid bucket name at start', () => {
    const { errors } = validateConfig(loadConfig({ ARTIFACTS_S3_BUCKET: 'ci', AWS_ACCESS_KEY_ID: 'k', AWS_SECRET_ACCESS_KEY: 's', ARTIFACTS_TOKEN: 'x'.repeat(32) }))
    assert.ok(errors.some((e) => e.startsWith('ARTIFACTS_S3_BUCKET: bucket name "ci" must be 3 to 63')))
  })

  it('accepts AWS_* credentials and infers path-style for custom endpoints', () => {
    const config = loadConfig({ ARTIFACTS_S3_BUCKET: 'bkt', ARTIFACTS_S3_ENDPOINT: 'http://minio:9000', AWS_ACCESS_KEY_ID: 'k', AWS_SECRET_ACCESS_KEY: 's', ARTIFACTS_TOKEN: 'x'.repeat(32) })
    assert.equal(config.s3.forcePathStyle, true)
    assert.equal(config.s3.accessKeyId, 'k')
    assert.deepEqual(validateConfig(config).errors, [])
  })

  it('warns loudly about auth=none and checks OIDC settings', () => {
    assert.ok(validateConfig(loadConfig({ ARTIFACTS_STORAGE: 'fs', ARTIFACTS_AUTH: 'none' })).warnings.length)
    assert.ok(validateConfig(loadConfig({ ARTIFACTS_STORAGE: 'fs', ARTIFACTS_AUTH: 'oidc' })).errors.some((e) => e.includes('OIDC')))
    assert.ok(validateConfig(loadConfig({ ARTIFACTS_STORAGE: 'fs', ARTIFACTS_AUTH: 'magic' })).errors.length)
    assert.ok(validateConfig(loadConfig({ ARTIFACTS_STORAGE: 'fs', ARTIFACTS_TOKEN: 'short' })).errors.some((e) => e.includes('16')))
  })

  it('parses durations', () => {
    assert.equal(parseDuration('90'), 90)
    assert.equal(parseDuration('15m'), 900)
    assert.equal(parseDuration('7d'), 604800)
    assert.equal(parseDuration(''), undefined)
    assert.throws(() => parseDuration('soon'))
  })

  it('documents every variable the code reads', () => {
    const source = ['src/config.mjs'].map((file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')).join('\n')
    const docs = readFileSync(new URL('../docs/configuration.md', import.meta.url), 'utf8')
    const names = new Set(source.match(/ARTIFACTS_[A-Z0-9_]+/g))
    const missing = [...names].filter((name) => !docs.includes(`\`${name}\``))
    assert.deepEqual(missing, [])
  })
})

describe('CIDR matching', () => {
  it('matches IPv4, IPv6 and IPv4-mapped addresses', () => {
    const ranges = ['10.0.0.0/8', '192.168.1.0/24', 'fd00::/8', '::1/128'].map(parseCidr)
    assert.ok(ipInCidrs('10.1.2.3', ranges))
    assert.ok(ipInCidrs('::ffff:192.168.1.20', ranges))
    assert.ok(ipInCidrs('fd12:3456::1', ranges))
    assert.ok(ipInCidrs('::1', ranges))
    assert.equal(ipInCidrs('192.168.2.1', ranges), false)
    assert.equal(ipInCidrs('2001:db8::1', ranges), false)
    assert.equal(ipInCidrs('not-an-ip', ranges), false)
    assert.throws(() => parseCidr('10.0.0.0/40'))
  })
})
