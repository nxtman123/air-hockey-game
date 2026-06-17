/**
 * Broadcasts goal/win moments to OTHER TelemetryOS apps via the shared namespace store.
 *
 * Air Hockey is a publish-only producer: it writes each event to the `event` key in the
 * `air-hockey` shared namespace. Other apps subscribe and play a short animation:
 *
 *   store().shared('air-hockey').subscribe('event', (e) => playAnimation(e))
 *
 * The shared store does NOT re-notify subscribers when a value is byte-identical, so every
 * event carries a monotonic `seq` (and `at` timestamp) — two goals by the same team still
 * deliver. This is the only module that touches the SDK store; the game stays SDK-free.
 *
 * NOTE: `store()` must be memoized in React (not called every render). `createBroadcaster()`
 * captures the slice once, and Render creates the broadcaster a single time in its mount
 * effect — so `store()` runs exactly once per component lifetime.
 */

import { store } from '@telemetryos/sdk'
import type { GameEvent } from './airHockey'

export const BROADCAST_NAMESPACE = 'air-hockey'
export const BROADCAST_KEY = 'event'

export type BroadcastEvent = GameEvent & { seq: number; at: number }

export function createBroadcaster(namespace = BROADCAST_NAMESPACE): (e: GameEvent) => void {
  const slice = store().shared(namespace)
  let seq = 0
  return (e) => {
    seq += 1
    const payload: BroadcastEvent = { ...e, seq, at: Date.now() }
    // Fire-and-forget — a store hiccup must never break the game loop.
    slice.set(BROADCAST_KEY, payload).catch(() => {})
  }
}
