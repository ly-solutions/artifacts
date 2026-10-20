/**
 * Helpers for plugin packages (`import … from '@ly-solutions/artifacts/plugin'`).
 *
 * A plugin does not need this module at run time: the same helpers are on the
 * `api` object its register() receives. Import from here in a plugin's own
 * tests, or when a plugin package depends on @ly-solutions/artifacts anyway.
 */
export { ApiError } from './service.mjs'
export { EVENTS, PLUGIN_API_VERSION, WIDGET_RE, isApiErrorLike, parseAttributes } from './plugins.mjs'
export { escapeHtml, htmlToText, isValidSlug, markdownToText } from './text.mjs'

/**
 * Identity helper that documents intent and keeps editors' type inference:
 * `export default definePlugin((api) => { … })`.
 */
export const definePlugin = (register) => {
  if (typeof register !== 'function') throw new TypeError('definePlugin needs the register(api) function')
  return register
}
