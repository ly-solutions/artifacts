/**
 * Example plugin: issue chips.
 *
 *   <artifact-widget type="github-issue" ref="ly-solutions/artifacts#12" title="Pagination"></artifact-widget>
 *
 * becomes a link chip to the issue when the document is published (phase "publish": the chip is stored in
 * the version, so it reads the same forever). No network calls: the chip shows the reference and an optional
 * title attribute. A plugin that wants live data (state, assignee) would fetch it in a "read" widget and
 * cache it.
 *
 * It also adds one route, GET /api/v1/x/github-issue/link?ref=owner/repo#12, that answers the URL for a
 * reference, to show how routes work.
 *
 * Run it: ARTIFACTS_PLUGINS=./examples/plugins/github-issue/index.mjs artifacts serve
 * Settings: GITHUB_ISSUE_BASE_URL (default https://github.com) for GitHub Enterprise or a Gitea/Forgejo host.
 */

export const name = 'github-issue'
export const apiVersion = 1

const REF = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d{1,9})$/

const ICON =
  '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z"/></svg>'

export default function register(api) {
  const base = (process.env.GITHUB_ISSUE_BASE_URL || 'https://github.com').replace(/\/$/, '')
  const issueUrl = (ref) => {
    const match = REF.exec(String(ref ?? '').trim())
    return match ? `${base}/${match[1]}/${match[2]}/issues/${match[3]}` : null
  }

  api.addWidget('github-issue', {
    phase: 'publish',
    render({ ref, attrs }) {
      const url = issueUrl(ref)
      if (!url) return null // not a reference: keep the placeholder, its body shows as written
      const label = attrs.title ? `${ref} · ${attrs.title}` : ref
      return `<a class="artifact-chip" href="${api.html.escape(url)}" target="_blank" rel="noopener noreferrer">${ICON}<span>${api.html.escape(label)}</span></a>`
    },
  })

  api.addRoute('GET', '/api/v1/x/github-issue/link', ({ query }) => {
    const url = issueUrl(query.get('ref'))
    if (!url) throw api.error(400, 'invalid', 'ref: owner/repo#number')
    return { ref: query.get('ref'), url }
  })
}
