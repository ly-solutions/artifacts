import { mentionsAgent, personId } from './comments.mjs'

/**
 * Tells the harnessly hub about a comment: a new thread or a reply. Fire-and-forget like the webhook:
 * the answer to the person is never held back, a failure goes to the log. Empty url: nothing is sent.
 */
export function sendCommentEvent(service, { event, slug, thread, message, principal }) {
  const { url, secret } = service.config.hubEvents ?? {}
  if (!url) return
  void (async () => {
    try {
      const { meta } = await service.get(slug)
      const anchor = thread.anchor ?? {}
      const label = anchor.kind === 'text' ? anchor.quote : anchor.kind === 'element' ? anchor.label : null
      const agent = message.author?.kind === 'agent'
      const body = JSON.stringify({
        kind: 'doc',
        event,
        slug,
        title: meta.title,
        thread: { id: thread.id, anchor: { label: label || null } },
        message: {
          id: message.id,
          text: message.text,
          author: message.author?.name ?? '',
          authorEmail: (!agent && principal?.email) || null,
          authorKind: agent ? 'agent' : 'person',
          authorId: (!agent && principal && personId(principal)) || '',
          mentions: mentionsAgent(message.text) ? [{ name: 'harnessly', agent: true }] : [],
        },
      })
      const headers = { 'content-type': 'application/json' }
      if (secret) headers['X-Boards-Webhook-Secret'] = secret
      const response = await service.fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(5000) })
      if (!response.ok) service.log('warn', 'hub events answered with an error', { event, status: response.status })
    } catch (error) {
      service.log('warn', 'hub events failed', { event, error: error.message })
    }
  })()
}
