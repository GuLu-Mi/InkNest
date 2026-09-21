import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PresentationController } from '../../src/main/presentation-controller'
import type { AppEvent, PresentationRequest } from '../../src/shared/contracts'
class NativeWindow extends EventEmitter {
  fullscreen = false; destroyed = false; calls: boolean[] = []
  isFullScreen() { return this.fullscreen }
  isDestroyed() { return this.destroyed }
  setFullScreen(value: boolean) { this.calls.push(value) }
  confirm(value: boolean) { this.fullscreen = value; this.emit(value ? 'enter-full-screen' : 'leave-full-screen') }
}
const ref = { docId: '11111111-1111-1111-1111-111111111111', epoch: '22222222-2222-2222-2222-222222222222' }
const request = (enabled: boolean, id = 1): PresentationRequest => ({ requestId: `33333333-3333-3333-3333-${String(id).padStart(12, '0')}`, ref, enabled })
function fixture(fullscreen = false) {
  const window = new NativeWindow(); window.fullscreen = fullscreen
  const events: AppEvent[] = []; let live = true; let blocked = false
  const controller = new PresentationController(window, value => live && value.docId === ref.docId && value.epoch === ref.epoch, () => blocked, event => events.push(event))
  return { window, events, controller, invalidate: () => { live = false }, block: () => { blocked = true } }
}
afterEach(() => vi.useRealTimers())
describe('native presentation convergence', () => {
  it('accepts asynchronously and confirms only the actual native event', () => {
    const f = fixture(); expect(f.controller.set(request(true)).status).toBe('ok'); expect(f.events).toEqual([])
    expect(f.window.calls).toEqual([true]); f.window.confirm(true)
    expect(f.events).toEqual([{ type: 'presentation-state', ...request(true), fullscreen: true }]); f.controller.dispose()
  })
  it('rapid exit beats a late enter event and stale replay cannot reopen', () => {
    const f = fixture(); f.controller.set(request(true)); f.controller.set(request(false, 2)); f.window.confirm(true)
    expect(f.window.calls.at(-1)).toBe(false); expect(f.events.every(event => event.type === 'presentation-state' && !event.enabled)).toBe(true)
    f.window.confirm(false); f.controller.set(request(true)); expect(f.window.calls.at(-1)).toBe(false); f.controller.dispose()
  })
  it('preserves preexisting system fullscreen on presentation exit', () => {
    const f = fixture(true); f.controller.set(request(true)); f.controller.set(request(false, 2))
    expect(f.window.calls).toEqual([]); expect(f.events.at(-1)).toEqual({ type: 'presentation-state', ...request(false, 2), fullscreen: true }); f.controller.dispose()
  })
  it('system fullscreen departure exits presentation without forcing reentry', () => {
    const f = fixture(); f.controller.set(request(true)); f.window.confirm(true); f.window.confirm(false)
    expect(f.events.at(-1)).toEqual({ type: 'presentation-state', ...request(false), fullscreen: false }); expect(f.window.calls).toEqual([true]); f.controller.dispose()
  })
  it('rejects invalid and blocked entry but accepts the owned old ref for exit', () => {
    const f = fixture(); f.block(); expect(f.controller.set(request(true)).status).toBe('error'); f.controller.dispose()
    const g = fixture(); g.controller.set(request(true)); g.window.confirm(true); g.invalidate()
    expect(g.controller.set(request(false, 2)).status).toBe('ok'); g.window.confirm(false)
    expect(g.controller.set(request(true, 3))).toMatchObject({ status: 'error', error: { code: 'STALE_SESSION' } }); g.controller.dispose()
  })
  it('does not confirm entry for a ref invalidated during native transition', () => {
    const f = fixture(); f.controller.set(request(true)); f.invalidate(); f.window.confirm(true)
    expect(f.events.at(-1)).toMatchObject({ enabled: false }); expect(f.window.calls.at(-1)).toBe(false); f.controller.dispose()
  })
  it('watchdog fails entry at ten seconds and repairs a late native enter', () => {
    vi.useFakeTimers(); const f = fixture(); f.controller.set(request(true)); vi.advanceTimersByTime(9999); expect(f.events).toEqual([])
    vi.advanceTimersByTime(1); expect(f.events.at(-1)).toMatchObject({ enabled: false, fullscreen: false })
    f.window.confirm(true); expect(f.window.calls.at(-1)).toBe(false); f.window.confirm(false)
    expect(f.events.every(event => event.type === 'presentation-state' && !event.enabled)).toBe(true); f.controller.dispose()
  })
  it('watchdog confirms actual native state if the event was lost', () => {
    vi.useFakeTimers(); const f = fixture(); f.controller.set(request(true)); f.window.fullscreen = true; vi.advanceTimersByTime(10000)
    expect(f.events.at(-1)).toMatchObject({ enabled: true, fullscreen: true }); f.controller.dispose()
  })
  it('exit timeout releases presentation UI and late native exit stays disabled', () => {
    vi.useFakeTimers(); const f = fixture(); f.controller.set(request(true)); f.window.confirm(true); f.controller.set(request(false, 2)); vi.advanceTimersByTime(10000)
    expect(f.events.at(-1)).toMatchObject({ enabled: false, fullscreen: true }); f.window.confirm(false); expect(f.events.at(-1)).toMatchObject({ enabled: false, fullscreen: false }); f.controller.dispose()
  })
  it('destroyed windows remove listeners/timers and cannot accept requests', () => {
    vi.useFakeTimers(); const f = fixture(); f.controller.set(request(true)); f.window.destroyed = true; f.window.emit('closed'); vi.advanceTimersByTime(10000)
    expect(f.events).toEqual([]); expect(f.window.listenerCount('enter-full-screen')).toBe(0); expect(f.controller.set(request(false, 2)).status).toBe('cancelled')
  })
})
it('ordinary system fullscreen remains independent after a settled presentation exit', () => {
  const f = fixture(); f.controller.set(request(true)); f.window.confirm(true); f.controller.set(request(false, 2)); f.window.confirm(false)
  const calls = f.window.calls.length; f.window.confirm(true); expect(f.window.calls).toHaveLength(calls); f.controller.dispose()
})
it('a dialog admitted during native entry cancels presentation on confirmation', () => {
  const f = fixture(); f.controller.set(request(true)); f.block(); f.window.confirm(true)
  expect(f.events.at(-1)).toMatchObject({ enabled: false }); expect(f.window.calls.at(-1)).toBe(false); f.controller.dispose()
})
it('native failure while repairing a late enter cannot throw out of the event listener', () => {
  const f = fixture(); f.controller.set(request(true)); f.controller.set(request(false, 2)); f.window.setFullScreen = () => { throw new Error('native failure') }
  expect(() => f.window.confirm(true)).not.toThrow(); expect(f.events.at(-1)).toMatchObject({ enabled: false, fullscreen: true }); f.controller.dispose()
})
it('lifecycle recheck exits an active presentation when its owning epoch is released', () => {
  const f = fixture(); f.controller.set(request(true)); f.window.confirm(true); f.invalidate(); f.controller.checkSource()
  expect(f.events.at(-1)).toMatchObject({ enabled: false }); expect(f.window.calls.at(-1)).toBe(false); f.controller.dispose()
})
