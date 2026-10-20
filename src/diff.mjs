/**
 * Line diff between two versions, without dependencies.
 *
 * Myers' O(ND) algorithm on the lines left after trimming the common prefix
 * and suffix (which is most of a document in a typical edit). The trace it
 * keeps for backtracking grows with the square of the number of changed
 * lines, so it stops at DIFF_MAX_EDITS and answers with an approximate diff
 * instead: the changed middle as one removed and one added run. An answer
 * that is coarse but always there beats a refusal for a reader's "what
 * changed" button.
 */

export const DIFF_MAX_EDITS = 2000

/** Lines of a text; a final newline does not make an extra empty line. */
export function splitLines(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  if (lines.length && lines.at(-1) === '') lines.pop()
  return lines
}

/** Edit script between two line arrays: `[{kind: 'same'|'removed'|'added', text}]` and whether it is approximate. */
export function diffLines(a, b, { maxEdits = DIFF_MAX_EDITS } = {}) {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1
    endB -= 1
  }
  const head = a.slice(0, start).map((text) => ({ kind: 'same', text }))
  const tail = a.slice(endA).map((text) => ({ kind: 'same', text }))
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  const middle = myers(midA, midB, maxEdits)
  if (middle) return { blocks: [...head, ...middle, ...tail], approximate: false }
  const coarse = [...midA.map((text) => ({ kind: 'removed', text })), ...midB.map((text) => ({ kind: 'added', text }))]
  return { blocks: [...head, ...coarse, ...tail], approximate: true }
}

function myers(a, b, maxEdits) {
  const n = a.length
  const m = b.length
  if (n === 0) return b.map((text) => ({ kind: 'added', text }))
  if (m === 0) return a.map((text) => ({ kind: 'removed', text }))
  const max = Math.min(n + m, maxEdits)
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  // trace[d] holds the furthest x on every diagonal k in [-d, d] after step d.
  const trace = []
  let found = -1
  for (let d = 0; d <= max && found < 0; d += 1) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x += 1
        y += 1
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        found = d
        break
      }
    }
    if (found < 0) trace.push(v.slice(offset - d, offset + d + 1))
  }
  if (found < 0) return null

  const out = []
  let x = n
  let y = m
  for (let d = found; d > 0; d -= 1) {
    const previous = trace[d - 1]
    const at = (k) => previous[k + d - 1]
    const k = x - y
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1))
    const prevK = down ? k + 1 : k - 1
    const prevX = at(prevK)
    const moveX = down ? prevX : prevX + 1
    while (x > moveX) {
      out.push({ kind: 'same', text: a[x - 1] })
      x -= 1
      y -= 1
    }
    if (down) {
      out.push({ kind: 'added', text: b[y - 1] })
      y -= 1
    } else {
      out.push({ kind: 'removed', text: a[x - 1] })
      x -= 1
    }
  }
  while (x > 0 && y > 0) {
    out.push({ kind: 'same', text: a[x - 1] })
    x -= 1
    y -= 1
  }
  return out.reverse()
}

/** `{blocks, stats, approximate}` for two texts. */
export function diffTexts(fromText, toText, options) {
  const { blocks, approximate } = diffLines(splitLines(fromText), splitLines(toText), options)
  const stats = { added: 0, removed: 0, same: 0 }
  for (const block of blocks) stats[block.kind] += 1
  return { blocks, stats, approximate }
}

/** Classic unified diff (`diff -u`) of an edit script, with `context` unchanged lines around each change. */
export function unifiedDiff(blocks, { fromLabel = 'a', toLabel = 'b', context = 3 } = {}) {
  const lines = [`--- ${fromLabel}`, `+++ ${toLabel}`]
  // Line numbers of each block in the old and the new text.
  const numbered = []
  let oldLine = 1
  let newLine = 1
  for (const block of blocks) {
    numbered.push({ ...block, oldLine, newLine })
    if (block.kind !== 'added') oldLine += 1
    if (block.kind !== 'removed') newLine += 1
  }
  const changed = numbered.map((block, index) => (block.kind === 'same' ? -1 : index)).filter((index) => index >= 0)
  if (!changed.length) return ''
  let i = 0
  while (i < changed.length) {
    const first = changed[i]
    let last = first
    // Changes closer than two contexts apart share a hunk.
    while (i + 1 < changed.length && changed[i + 1] - last <= context * 2 + 1) {
      i += 1
      last = changed[i]
    }
    i += 1
    const from = Math.max(0, first - context)
    const to = Math.min(numbered.length - 1, last + context)
    const hunk = numbered.slice(from, to + 1)
    const oldCount = hunk.filter((block) => block.kind !== 'added').length
    const newCount = hunk.filter((block) => block.kind !== 'removed').length
    // An empty side is numbered by the line before it, as diff -u does.
    const oldStart = oldCount ? hunk.find((block) => block.kind !== 'added').oldLine : hunk[0].oldLine - 1
    const newStart = newCount ? hunk.find((block) => block.kind !== 'removed').newLine : hunk[0].newLine - 1
    lines.push(`@@ -${oldStart}${oldCount === 1 ? '' : `,${oldCount}`} +${newStart}${newCount === 1 ? '' : `,${newCount}`} @@`)
    for (const block of hunk) lines.push(`${block.kind === 'same' ? ' ' : block.kind === 'added' ? '+' : '-'}${block.text}`)
  }
  return `${lines.join('\n')}\n`
}
