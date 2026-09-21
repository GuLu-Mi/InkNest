import type { Page } from '@playwright/test'
/** Test-owned numeric accounting; weak membership never retains component/view/DOM instances. */
export async function installSurfaceProbe(page: Page) {
  await page.evaluate(() => {
    const counts = { listeners: {} as Record<string, number>, timers: 0, previewMounted: 0, previewUnmounted: 0, editorCreated: 0, editorDestroyed: 0 }
    const memberships = new WeakMap<EventTarget, Map<string, WeakSet<object>>>()
    const add = EventTarget.prototype.addEventListener; const remove = EventTarget.prototype.removeEventListener
    const category = (target: EventTarget, type: string) => target === window && ['resize', 'keydown', 'pointermove', 'beforeunload'].includes(type) ? `window:${type}` : target === document && type === 'keydown' ? 'document:keydown' : target instanceof Element && target.matches('.document-stage, .cm-scroller, .cm-content') && ['scroll', 'compositionstart', 'compositionend'].includes(type) ? `${target.classList.contains('document-stage') ? 'stage' : 'editor'}:${type}` : ''
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      const key = category(this, type)
      if (key && listener) { let map = memberships.get(this); if (!map) memberships.set(this, map = new Map()); let set = map.get(key); if (!set) map.set(key, set = new WeakSet()); if (!set.has(listener)) { set.add(listener); counts.listeners[key] = (counts.listeners[key] ?? 0) + 1 } }
      add.call(this, type, listener, options)
    }
    EventTarget.prototype.removeEventListener = function (type, listener, options) {
      const key = category(this, type); const set = memberships.get(this)?.get(key)
      if (listener && set?.has(listener)) { set.delete(listener); counts.listeners[key]!-- }
      remove.call(this, type, listener, options)
    }
    const pending = new Set<number>(); const timeout = window.setTimeout; const clear = window.clearTimeout
    window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
      const id = timeout(() => { pending.delete(id); counts.timers = pending.size; if (typeof callback === 'function') callback(...args) }, delay)
      pending.add(id); counts.timers = pending.size; return id
    }) as typeof window.setTimeout
    window.clearTimeout = id => { pending.delete(id!); counts.timers = pending.size; clear(id) }
    type Instance = { $options: { __name?: string } }
    const app = Reflect.get(document.querySelector('#app')!, '__vue_app__') as { mixin: (hooks: { mounted(this: Instance): void; unmounted(this: Instance): void }) => void }
    app.mixin({ mounted() { if (this.$options.__name === 'PreviewPane') counts.previewMounted++ }, unmounted() { if (this.$options.__name === 'PreviewPane') counts.previewUnmounted++ } })
    const views = new WeakSet<object>(); let patched = false
    Reflect.set(window, 'surfaceProbe', { counts, trackEditor: () => {
      const content = document.querySelector('.cm-content'); if (!content) return
      const view = Reflect.get(content, 'cmTile')?.root.view as { destroy(): void; constructor: { prototype: { destroy(): void } } }
      if (!views.has(view)) { views.add(view); counts.editorCreated++ }
      if (!patched) { const proto = view.constructor.prototype; const destroy = proto.destroy; proto.destroy = function () { if (views.delete(this)) counts.editorDestroyed++; destroy.call(this) }; patched = true }
    } })
  })
}
export const trackEditor = (page: Page) => page.evaluate(() => Reflect.get(window, 'surfaceProbe').trackEditor())
export const surfaceMetrics = (page: Page) => page.evaluate(() => {
  const counters = Reflect.get(window, 'surfaceProbe').counts as { listeners: Record<string, number>; timers: number; previewMounted: number; previewUnmounted: number; editorCreated: number; editorDestroyed: number }
  return { ...counters, listeners: { ...counters.listeners }, editorAlive: counters.editorCreated - counters.editorDestroyed, previewAlive: counters.previewMounted - counters.previewUnmounted, editorDOM: document.querySelectorAll('.cm-editor').length, previewDOM: document.querySelectorAll('.preview').length }
})

export async function globalListenerCounts(page: Page) {
  const cdp = await page.context().newCDPSession(page)
  const result: Record<string, number> = {}
  try {
    for (const expression of ['window', 'document']) {
      const { result: object } = await cdp.send('Runtime.evaluate', { expression, objectGroup: 'surface-listener-count' })
      const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: object.objectId! })
      for (const listener of listeners) { const key = `${expression}:${listener.type}:${listener.useCapture}`; result[key] = (result[key] ?? 0) + 1 }
    }
    return result
  } finally { await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'surface-listener-count' }); await cdp.detach() }
}
