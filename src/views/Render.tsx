/**
 * Render view — the display content shown on physical signage devices.
 *
 * Before planning OR editing this view, invoke `skill(name: "design")` — it is
 * the source of truth for UI scaling, rem usage, title-safe zone, portrait /
 * landscape patterns, and the signage / kiosk / web references. Do not rely
 * on this file's comments alone.
 *
 * This is a pared-down template — no theme system, no entrance animations,
 * no prebuilt layout building blocks. Content is hardcoded here; edit the
 * JSX directly to change what the render shows.
 *
 * Adaptive knob wired below: `density` (full / comfortable / compact /
 * minimal). Use it to shed elements or reflow as space shrinks.
 */

import { useUiAspectRatio } from '@telemetryos/sdk/react'
import './Render.css'

type Density = 'full' | 'comfortable' | 'compact' | 'minimal'

function getDensity(aspectRatio: number): Density {
  const isPortrait = aspectRatio < 1
  const pressure = isPortrait ? 1.2 : 1
  if (pressure < 1.4) return 'full'
  if (pressure < 1.8) return 'comfortable'
  if (pressure < 2.3) return 'compact'
  return 'minimal'
}

export function Render() {
  const aspectRatio = useUiAspectRatio()
  const density = getDensity(aspectRatio)

  return (
    <div className={`render render--${density}`}>
      {/* ── Welcome content (replace with your app) ─────────────────────── */}

      <img src="/assets/telemetryos-wordmark.svg" alt="TelemetryOS" className="render__logo" />

      <div className="render__hero">
        {density !== 'minimal' && (
          <div className="render__hero-title">Welcome to TelemetryOS SDK</div>
        )}
      </div>

      <div className="render__docs-information">
        {density === 'full' && (
          <>
            <div className="render__docs-information-title">
              To get started, edit the Render.tsx file
            </div>
            <div className="render__docs-information-text">
              Visit our documentation on building applications to learn more
            </div>
          </>
        )}
      </div>
    </div>
  )
}
