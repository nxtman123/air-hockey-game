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
    let cancelled = false

    const logo = new Image()
    logo.src = '/assets/tos-mark.svg'

    // Created once per mount (not per render) so store() is called a single time.
    const broadcast = createBroadcaster()

    const start = () => {
      if (cancelled) return
      controller = createAirHockey(canvas, logo, broadcast)
      observer = new ResizeObserver(() => controller?.resize())
      observer.observe(wrap)
      // Dev-only hook so MCP dom_eval can drive/verify match flow without touch.
      ;(window as unknown as { __airHockey?: AirHockeyController }).__airHockey = controller
    }

    // The canvas text fonts (Orbitron, Inter) are loaded via a Google Fonts <link> in
    // index.html, but a font file is only fetched lazily when a DOM element uses it — and
    // a canvas ctx.font assignment does NOT trigger that fetch. So on a fresh device the
    // canvas would draw in the fallback sans-serif forever. Explicitly request the exact
    // families/weights airHockey.ts draws with so the browser downloads them. Never block
    // forever: if the CDN is slow/unreachable the game still starts (with the fallback).
    const loadCanvasFonts = (): Promise<unknown> => {
      const fonts = (document as Document & { fonts?: FontFaceSet }).fonts
      if (!fonts?.load) return Promise.resolve()
      const want = ["700 1em 'Orbitron'", "600 1em 'Inter'"]
      const all = Promise.all(want.map((f) => fonts.load(f).catch(() => {})))
      const timeout = new Promise((r) => setTimeout(r, 3000))
      return Promise.race([all, timeout])
    }

    // Wait for the logo so the first frame includes it (errors still start the game).
    const logoReady = new Promise<void>((resolve) => {
      if (logo.complete) resolve()
      else {
        logo.onload = () => resolve()
        logo.onerror = () => resolve()
      }
    })

    Promise.all([logoReady, loadCanvasFonts()]).then(start)

    return () => {
      cancelled = true
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
