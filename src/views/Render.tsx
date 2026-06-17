/**
 * Render view — full-screen two-player Air Hockey game.
 *
 * The whole experience lives on a single <canvas> driven by `createAirHockey`
 * (matter-js physics + multi-touch input + canvas rendering). This view just
 * mounts the canvas, loads the center TOS logo, wires a ResizeObserver, and
 * tears the controller down on unmount.
 *
 * Interactive kiosk view (see skill: design/kiosk) — touch input, no UI-scale
 * slider. We intentionally use a pixel-space canvas sized to the viewport rather
 * than rem/DOM layout, since this is a real-time game.
 */

import { useEffect, useRef } from 'react'
import { createAirHockey, type AirHockeyController } from '../game/airHockey'
import { createBroadcaster } from '../game/broadcast'
import './Render.css'

export function Render() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return

    let controller: AirHockeyController | undefined
    let observer: ResizeObserver | undefined

    const logo = new Image()
    logo.src = '/assets/tos-mark.svg'

    // Created once per mount (not per render) so store() is called a single time.
    const broadcast = createBroadcaster()

    const start = () => {
      controller = createAirHockey(canvas, logo, broadcast)
      observer = new ResizeObserver(() => controller?.resize())
      observer.observe(wrap)
      // Dev-only hook so MCP dom_eval can drive/verify match flow without touch.
      ;(window as unknown as { __airHockey?: AirHockeyController }).__airHockey = controller
    }

    // Wait for the logo so the first frame includes it (errors still start the game).
    if (logo.complete) start()
    else {
      logo.onload = start
      logo.onerror = start
    }

    return () => {
      observer?.disconnect()
      controller?.destroy()
      delete (window as unknown as { __airHockey?: AirHockeyController }).__airHockey
    }
  }, [])

  return (
    <div className="render render--game" ref={wrapRef}>
      <canvas ref={canvasRef} className="air-hockey-canvas" />
    </div>
  )
}
