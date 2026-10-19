/** IPv4/IPv6 CIDR matching for the trusted-proxy mode. */
import { isIPv4, isIPv6 } from 'node:net'

const v4Value = (text) => text.split('.').reduce((acc, part) => (acc << 8n) + BigInt(Number(part)), 0n)

function v6Value(text) {
  const embedded = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (embedded) {
    const v4 = v4Value(embedded[2])
    text = `${embedded[1]}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`
  }
  const halves = text.split('::')
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const zeros = halves.length === 2 ? 8 - left.length - right.length : 0
  const groups = [...left, ...Array(zeros).fill('0'), ...right]
  return groups.reduce((acc, group) => (acc << 16n) + BigInt(parseInt(group, 16)), 0n)
}

export function parseIp(ip) {
  let text = String(ip ?? '').trim()
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1)
  text = text.replace(/%.*$/, '')
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(text)
  if (mapped) text = mapped[1]
  if (isIPv4(text)) return { version: 4, value: v4Value(text), bits: 32 }
  if (isIPv6(text)) return { version: 6, value: v6Value(text), bits: 128 }
  return null
}

export function parseCidr(cidr) {
  const [ip, prefix] = String(cidr).split('/')
  const parsed = parseIp(ip)
  if (!parsed) throw new Error(`invalid CIDR: ${cidr}`)
  const length = prefix === undefined ? parsed.bits : Number(prefix)
  if (!Number.isInteger(length) || length < 0 || length > parsed.bits) throw new Error(`invalid CIDR prefix: ${cidr}`)
  return { ...parsed, length }
}

export function ipInCidrs(ip, cidrs) {
  const addr = parseIp(ip)
  if (!addr) return false
  return cidrs.some((range) => {
    if (range.version !== addr.version) return false
    const shift = BigInt(range.bits - range.length)
    return addr.value >> shift === range.value >> shift
  })
}
