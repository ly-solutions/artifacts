/**
 * AWS Signature Version 4 for S3, header-based, unsigned nothing: the payload
 * hash is always computed. Small enough to read in one sitting, which is the
 * reason it exists instead of a 3 MB SDK.
 */
import { createHash, createHmac } from 'node:crypto'

export const sha256Hex = (data) => createHash('sha256').update(data).digest('hex')
const hmac = (key, data) => createHmac('sha256', key).update(data).digest()

/** RFC 3986 encoding as S3 expects it; `/` is kept in paths. */
export function uriEncode(value, keepSlash = false) {
  let out = ''
  for (const byte of Buffer.from(String(value), 'utf8')) {
    const ch = String.fromCharCode(byte)
    if (/[A-Za-z0-9\-._~]/.test(ch) || (keepSlash && ch === '/')) out += ch
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return out
}

export function amzDate(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

/**
 * Returns the headers to send: the input headers plus host, x-amz-date,
 * x-amz-content-sha256, optional x-amz-security-token and authorization.
 */
export function signRequest({ method, url, headers = {}, body, region, accessKeyId, secretAccessKey, sessionToken, service = 's3', now = new Date() }) {
  const target = new URL(url)
  const date = amzDate(now)
  const day = date.slice(0, 8)
  const payloadHash = sha256Hex(body ?? '')

  const all = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()]))
  all.host = target.host
  all['x-amz-date'] = date
  all['x-amz-content-sha256'] = payloadHash
  if (sessionToken) all['x-amz-security-token'] = sessionToken

  const signedNames = Object.keys(all).sort()
  const canonicalHeaders = signedNames.map((name) => `${name}:${all[name].replace(/\s+/g, ' ')}\n`).join('')
  const query = [...target.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
  // The URL is already encoded by the caller; decode and re-encode to get the canonical form once.
  const path = target.pathname
    .split('/')
    .map((segment) => uriEncode(decodeURIComponent(segment)))
    .join('/')

  const canonicalRequest = [method, path || '/', query, canonicalHeaders, signedNames.join(';'), payloadHash].join('\n')
  const scope = `${day}/${region}/${service}/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, sha256Hex(canonicalRequest)].join('\n')
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), service), 'aws4_request')
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')

  all.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedNames.join(';')}, Signature=${signature}`
  delete all.host
  return all
}
