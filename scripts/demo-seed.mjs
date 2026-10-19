#!/usr/bin/env node
/**
 * Fills a server with a handful of example documents, including one with several versions.
 * Used for screenshots and for trying the reader:  ARTIFACTS_URL=… ARTIFACTS_TOKEN=… node scripts/demo-seed.mjs
 */
import { readFile } from 'node:fs/promises'

const base = (process.env.ARTIFACTS_URL || 'http://localhost:8080').replace(/\/$/, '')
const token = process.env.ARTIFACTS_TOKEN || ''
const dir = new URL('./demo/', import.meta.url)

async function publish(body) {
  const response = await fetch(`${base}/api/v1/artifacts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ new: true, ...body }),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(data)}`)
  return data
}

const text = (name) => readFile(new URL(name, dir), 'utf8')

const search = await publish({ markdown: (await text('search-architecture.md')).replace('- [x] Move synonym', '- [ ] Move synonym'), title: 'Search service architecture', description: 'Gateway, index and ranking; two proposed changes', tags: ['architecture', 'search'], task: 'PROJ-311', author: 'Grace', session: 'conv-8f2a' })
await publish({ slug: search.artifact.slug, markdown: await text('search-architecture.md'), title: 'Search service architecture', note: 'synonym expansion moved into the index', author: 'Grace' })
await publish({ markdown: await text('onboarding-plan.md'), title: 'Onboarding plan for new engineers', description: 'The first two weeks, day by day', tags: ['people', 'handbook'], author: 'Linus' })
await publish({ markdown: await text('rate-limits.md'), title: 'API rate limits proposal', description: 'Per-token limits instead of one global limit', tags: ['api', 'proposal'], task: 'PROJ-298', author: 'Margaret' })
await publish({ markdown: await text('release-notes.md'), title: 'Release notes 2.8', tags: ['release'], author: 'release-bot' })
const incident = await publish({ html: (await text('checkout-incident.html')).replace(/<h2>What we changed[\s\S]*$/, ''), title: 'Checkout latency incident, 14 March', description: 'A leaked connection pool slowed EU checkout for 38 minutes', tags: ['incident', 'payments', 'postmortem'], task: 'PROJ-342', link: 'https://git.example.com/shop/payments/-/merge_requests/918', author: 'Ada', session: 'conv-31c7' })
await publish({ slug: incident.artifact.slug, html: await text('checkout-incident.html'), title: 'Checkout latency incident, 14 March', note: 'added the changes and the quote from the review', author: 'Ada' })
await publish({ slug: incident.artifact.slug, html: await text('checkout-incident.html'), title: 'Checkout latency incident, 14 March', note: 'timeline checked against the deploy log', author: 'Ada' })
console.log(incident.artifact.slug)
