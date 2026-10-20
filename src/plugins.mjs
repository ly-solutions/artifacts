/**
 * Plugins: code an operator adds at start (ARTIFACTS_PLUGINS) to extend the
 * server without forking it. A plugin is an ES module whose default export (or
 * `register` export) is called once with the plugin API:
 *
 *   export default function register(api) {
 *     api.addWidget('github-issue', { phase: 'publish', render: ({ ref }) => `<a …>${api.html.escape(ref)}</a>` })
 *     api.addRoute('GET', '/api/v1/x/my-plugin/status', () => ({ ok: true }))
 *     api.onPublish((draft) => { … })
 *     api.onRead((page) => page.html)
 *     api.on('artifact.published', (event) => { … })
 *   }
 *
 * The contract is documented in docs/plugins.md; PLUGIN_API_VERSION changes
 * only when it breaks. Plugins run in the server process with its rights:
 * load only code you trust.
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { ApiError } from './service.mjs'
import { decodeEntities, escapeHtml, isValidSlug } from './text.mjs'

export const PLUGIN_API_VERSION = 1

/** A plugin that cannot be loaded or registered: the server refuses to start rather than run without it. */
export class PluginError extends Error {}

/** Widget types the built-in renderer owns. */
const RESERVED_WIDGETS = new Set(['kpi'])
const WIDGET_TYPE_RE = /^[a-z][a-z0-9-]{0,63}$/
const MAX_WIDGETS_PER_DOCUMENT = 200
const ROUTE_PREFIXES = ['/x/', '/api/v1/x/', '/a/:slug/x/']
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
const ROUTE_AUTH = ['none', 'read', 'write', 'share']
export const EVENTS = ['artifact.published', 'artifact.updated', 'artifact.meta', 'artifact.shared', 'artifact.unshared', 'artifact.deleted']

/** `<artifact-widget type="…" ref="…">optional body</artifact-widget>` or the self-closing form. */
export const WIDGET_RE = /<artifact-widget\b((?:[^>"']|"[^"]*"|'[^']*')*?)(?:\/>|>([\s\S]*?)<\/artifact-widget\s*>)/gi

/** Attributes of a tag as an object; values are entity-decoded, bare attributes are "". */
export function parseAttributes(text) {
  const out = {}
  const re = /([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`/]+)))?/g
  for (const match of String(text ?? '').matchAll(re)) {
    const name = match[1].toLowerCase()
    if (!(name in out)) out[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '')
  }
  return out
}

/** An error with an HTTP status and a code: thrown by hooks and routes, answered as `{error: code, hint}`. */
export const isApiErrorLike = (error) => Boolean(error) && Number.isInteger(error.status) && error.status >= 400 && error.status < 600 && typeof error.code === 'string'

function withTimeout(promise, ms, what) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** Turns `/a/:slug/x/:name` into a matcher. */
function compileRoute(path) {
  const keys = []
  const source = path
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        keys.push(segment.slice(1))
        return '([^/]+)'
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('/')
  return { re: new RegExp(`^${source}$`), keys }
}

/**
 * Imports plugin modules. A path (starting with `.`, `/` or `file:`) is resolved against `cwd`;
 * anything else is a package name, resolved from the server's own node_modules.
 */
export async function loadPluginModules(specs = [], { cwd = process.cwd() } = {}) {
  const loaded = []
  for (const spec of specs) {
    const target = spec.startsWith('file:') ? spec : /^[./]|^[A-Za-z]:[\\/]/.test(spec) ? pathToFileURL(resolve(cwd, spec)).href : spec
    let module
    try {
      module = await import(target)
    } catch (error) {
      throw new PluginError(`plugin "${spec}" could not be loaded: ${error.message}`, { cause: error })
    }
    loaded.push({ spec, module })
  }
  return loaded
}

/** Normalises what a plugin module exports into `{name, register}`. */
function pluginEntry(item, index) {
  if (typeof item === 'function') return { name: item.pluginName ?? item.name ?? `plugin-${index + 1}`, register: item }
  const module = item?.module ?? item
  const spec = item?.spec
  const candidate = module?.default ?? module
  const register = typeof candidate === 'function' ? candidate : typeof candidate?.register === 'function' ? candidate.register.bind(candidate) : typeof module?.register === 'function' ? module.register : null
  if (!register) throw new PluginError(`plugin ${spec ? `"${spec}" ` : ''}exports neither a default function nor register()`)
  const name = module?.name ?? candidate?.name ?? (typeof candidate === 'function' && candidate.name !== 'register' && candidate.name !== 'default' ? candidate.name : null) ?? spec ?? `plugin-${index + 1}`
  return { name: String(name), register, apiVersion: module?.apiVersion ?? candidate?.apiVersion }
}

export class PluginHost {
  constructor({ log = () => {}, widgetTimeoutMs = 5000 } = {}) {
    this.log = log
    this.widgetTimeoutMs = widgetTimeoutMs
    this.widgets = new Map()
    this.routes = []
    this.publishHooks = []
    this.readHooks = []
    this.listeners = []
    this.loaded = []
  }

  get empty() {
    return !this.widgets.size && !this.routes.length && !this.publishHooks.length && !this.readHooks.length && !this.listeners.length
  }

  /** Calls each plugin's register(api), in order. Any error stops the start: a half-loaded plugin is worse than none. */
  async register(items, { config, service } = {}) {
    this.artifacts = service ? artifactsFacade(service) : null
    for (const [index, item] of (items ?? []).entries()) {
      const entry = pluginEntry(item, index)
      if (entry.apiVersion !== undefined && entry.apiVersion !== PLUGIN_API_VERSION) {
        throw new PluginError(`plugin "${entry.name}" needs plugin API ${entry.apiVersion}, this server provides ${PLUGIN_API_VERSION}`)
      }
      const before = { widgets: this.widgets.size, routes: this.routes.length }
      try {
        await entry.register(this.api(entry.name, { config, service }))
      } catch (error) {
        throw new PluginError(`plugin "${entry.name}" failed to register: ${error.message}`, { cause: error })
      }
      this.loaded.push(entry.name)
      this.log('info', 'plugin loaded', { plugin: entry.name, widgets: this.widgets.size - before.widgets, routes: this.routes.length - before.routes })
    }
    return this
  }

  /** The object a plugin's register() receives. */
  api(plugin, { config, service }) {
    const log = (level, msg, extra = {}) => this.log(level, msg, { plugin, ...extra })
    const fn = (value, what) => {
      if (typeof value !== 'function') throw new TypeError(`${what} needs a function`)
      return value
    }
    return Object.freeze({
      version: PLUGIN_API_VERSION,
      name: plugin,
      config,
      log,
      artifacts: this.artifacts ?? null,
      service,
      html: Object.freeze({ escape: escapeHtml, parseAttributes }),
      error: (status, code, hint) => new ApiError(status, code, hint ? { hint } : {}),
      addWidget: (type, spec) => {
        const widget = typeof spec === 'function' ? { render: spec } : { ...spec }
        if (!WIDGET_TYPE_RE.test(String(type))) throw new Error(`widget type "${type}": lowercase letters, digits and dashes`)
        if (RESERVED_WIDGETS.has(type)) throw new Error(`widget type "${type}" is built in`)
        if (this.widgets.has(type)) throw new Error(`widget type "${type}" is already registered by plugin "${this.widgets.get(type).plugin}"`)
        fn(widget.render, `addWidget("${type}")`)
        const phase = widget.phase ?? 'read'
        if (!['publish', 'read'].includes(phase)) throw new Error(`widget "${type}": phase must be "publish" or "read"`)
        this.widgets.set(type, { render: widget.render, phase, plugin })
      },
      addRoute: (method, path, handler, { auth = 'read' } = {}) => {
        const verb = String(method).toUpperCase()
        if (!METHODS.includes(verb)) throw new Error(`route method must be one of ${METHODS.join(', ')}`)
        if (typeof path !== 'string' || !ROUTE_PREFIXES.some((prefix) => path.startsWith(prefix)) || path.includes('//') || /[?#]/.test(path)) {
          throw new Error(`route "${path}": plugin routes live under ${ROUTE_PREFIXES.join(', ')}, so they never shadow a built-in route`)
        }
        if (!ROUTE_AUTH.includes(auth)) throw new Error(`route "${path}": auth must be one of ${ROUTE_AUTH.join(', ')}`)
        if (this.routes.some((route) => route.method === verb && route.path === path)) throw new Error(`route ${verb} ${path} is already registered`)
        this.routes.push({ method: verb, path, auth, handler: fn(handler, `addRoute(${verb} ${path})`), plugin, ...compileRoute(path) })
      },
      onPublish: (hook) => this.publishHooks.push({ hook: fn(hook, 'onPublish'), plugin }),
      onRead: (hook) => this.readHooks.push({ hook: fn(hook, 'onRead'), plugin }),
      on: (event, listener) => {
        if (event !== '*' && !EVENTS.includes(event)) throw new Error(`unknown event "${event}"; one of ${EVENTS.join(', ')} or "*"`)
        this.listeners.push({ event, listener: fn(listener, `on("${event}")`), plugin })
      },
    })
  }

  hasWidgets(phase) {
    for (const widget of this.widgets.values()) if (widget.phase === phase) return true
    return false
  }

  /**
   * Replaces widget placeholders with what their renderer returns. At publish only `publish` widgets
   * render (into the stored HTML); at read time `read` widgets render, and so do `publish` widgets still
   * left as placeholders (a Markdown-only version, a version published before the plugin was added).
   * A renderer that returns null, throws or times out leaves the placeholder as it was (an unknown
   * element to a browser, so its body shows as a fallback).
   */
  async renderWidgets(html, context) {
    const phases = context.phase === 'read' ? ['read', 'publish'] : [context.phase]
    if (typeof html !== 'string' || !html.includes('<artifact-widget') || !phases.some((phase) => this.hasWidgets(phase))) return html
    const matches = [...html.matchAll(WIDGET_RE)].slice(0, MAX_WIDGETS_PER_DOCUMENT)
    const rendered = await Promise.all(
      matches.map(async (match) => {
        const attrs = parseAttributes(match[1])
        const widget = this.widgets.get(attrs.type)
        if (!widget || !phases.includes(widget.phase)) return null
        try {
          const out = await withTimeout(Promise.resolve(widget.render({ ...context, type: attrs.type, ref: attrs.ref ?? null, attrs, body: match[2] ?? '' })), this.widgetTimeoutMs, `widget "${attrs.type}"`)
          return typeof out === 'string' ? out : null
        } catch (error) {
          this.log('warn', 'widget failed, placeholder kept', { plugin: widget.plugin, type: attrs.type, slug: context.slug, error: error.message })
          return null
        }
      }),
    )
    let out = ''
    let last = 0
    matches.forEach((match, index) => {
      out += html.slice(last, match.index) + (rendered[index] ?? match[0])
      last = match.index + match[0].length
    })
    return out + html.slice(last)
  }

  /** Publish hooks change the draft in place or throw to refuse (an error with status and code becomes the answer). */
  async runPublishHooks(draft, context) {
    for (const { hook, plugin } of this.publishHooks) {
      try {
        await hook(draft, context)
      } catch (error) {
        if (isApiErrorLike(error)) throw error
        this.log('error', 'publish hook failed', { plugin, error: error.message })
        throw new ApiError(500, 'plugin_error', { hint: `plugin "${plugin}" failed while publishing; see the server log` })
      }
    }
  }

  /** Read hooks get `{html}` and may return a replacement string. */
  async runReadHooks(page, context) {
    let html = page.html
    for (const { hook, plugin } of this.readHooks) {
      try {
        const out = await hook({ ...page, html }, context)
        if (typeof out === 'string') html = out
      } catch (error) {
        this.log('warn', 'read hook failed, page served without it', { plugin, error: error.message })
      }
    }
    return html
  }

  /** Fire-and-forget delivery of a change event; a failing listener only logs. */
  emit(event, payload) {
    for (const { event: wanted, listener, plugin } of this.listeners) {
      if (wanted !== '*' && wanted !== event) continue
      Promise.resolve()
        .then(() => listener(payload))
        .catch((error) => this.log('warn', 'event listener failed', { plugin, event, error: error.message }))
    }
  }

  matchRoute(method, path) {
    for (const route of this.routes) {
      if (route.method !== method) continue
      const match = route.re.exec(path)
      if (!match) continue
      const params = {}
      try {
        route.keys.forEach((key, index) => {
          params[key] = decodeURIComponent(match[index + 1])
        })
      } catch {
        return null
      }
      if (route.keys.includes('slug') && !isValidSlug(params.slug)) return null
      return { route, params }
    }
    return null
  }
}

/** The stable, read-only slice of the service that plugins use. */
export function artifactsFacade(service) {
  return Object.freeze({
    /** The artifact object (as the API presents it, with versions), or null. */
    async get(slug) {
      const found = await service.store.getManifest(slug)
      return found ? service.present(found.meta, { versions: true }) : null
    },
    /** Same query and answer as GET /api/v1/artifacts. */
    list: (query = {}) => service.search({ limit: 50, offset: 0, ...query }),
    /** `{n, id, html?, markdown?}` of a version (latest by default); throws a 404 error when missing. */
    async content(slug, ref) {
      const content = await service.readContent(slug, ref)
      return { n: content.n, id: content.version.id, html: content.html, markdown: content.markdown }
    },
    diff: (slug, options) => service.diff(slug, options),
    viewUrl: (slug) => service.viewUrl(slug),
  })
}
