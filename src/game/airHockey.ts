/**
 * Air Hockey — two-player, multi-touch, physics-driven game.
 *
 * Rendering and input live on a single full-viewport <canvas>; physics is run by
 * matter-js (zero-gravity top-down table). The rink is a rounded-corner white
 * "ice" sheet; everything outside the rink is black. Classic hockey line colors
 * (red center line + goal lines, blue zone lines) mark the ice. The two teams are
 * RED (Player 1) and BLUE (Player 2).
 *
 * Layout adapts to orientation:
 *   - landscape → goals on the LEFT (RED) and RIGHT (BLUE) edges, vertical center line
 *   - portrait  → goals on the BOTTOM (RED) and TOP (BLUE) edges, horizontal center line
 *
 * The scoreboard and countdown are rendered double-sided (rotated copies) so they
 * can be read from both ends of the rink. The puck is never auto-launched: at each
 * face-off it sits still inside the receiving player's half until a paddle strikes
 * it, and if it comes to rest it stays at rest. First to WIN_SCORE wins.
 */

import Matter from 'matter-js'

const { Engine, Bodies, Body, Composite, Events } = Matter

// ── Tunables ─────────────────────────────────────────────────────────────────
const WIN_SCORE = 3
const PHYS_DT = 1000 / 60 // fixed physics step (ms)
const COUNTDOWN_MS = 1500 // pre-play countdown (3 → 2 → 1)
const GOAL_CELEBRATION_MS = 2000 // "<TEAM> SCORES!" / win celebration hold (scrim + input lock)
const STUCK_MS = 2000 // re-face-off if the puck idles in the unreachable neutral band
const HOLD_RESET_MS = 2000 // hold a hidden dark-corner hot zone this long to reset to READY
const POWERUP_DELAY_MS = 3000 // goal-less live play before a power-up appears
const POWERUP_LIFETIME_MS = 8000 // a power-up fades if no paddle grabs it in time
const MAX_EXTRA_PUCKS = 2 // safety cap so the repeating "two pucks" power-up can't run away
const INVINCIBLE_SPEED_MULT = 1.7 // an invincible puck moves this much faster than the normal cap
const INVINCIBLE_MS = 2000 // how long an invincible-puck run lasts before reverting to normal
const BRICK_SHATTER_MS = 260 // a struck brick's shatter flash lingers this long, then is dropped

// Team / rink palette
const RED = '#e23b3b' // Player 1
const BLUE = '#2f6bff' // Player 2
const ICE_EDGE = '#cfdcef' // bluer near the rink edges (gradient)
const ICE_MID = '#dde8f5' // lighter toward the middle
const OUTSIDE = '#000000'
// washed-out (pastel) marking colors — full-opacity so overlapping strokes don't darken
const RED_LINE_WASH = '#e39aa1'
const BLUE_LINE_WASH = '#9fb0e8'
const PUCK_COLOR = '#101418'
const TOS_YELLOW = '#F7B435' // TelemetryOS brand yellow — the READY headline

type Phase = 'celebrating' | 'countdown' | 'playing' | 'gameover' | 'ready'

// which random power-up a center badge grants when collected
type PowerKind = 'two-pucks' | 'invincibility' | 'brick'

// one of the five curved bricks arched over an owner's crease (brick-breaker shield).
// `body` is a static rectangle (chord of the arc segment) for physics; the arc fields
// (cx,cy,r,a0,a1) drive the curved render. A puck hit flags it broken for a brief shatter.
interface Brick {
  owner: 0 | 1
  body: Matter.Body
  cx: number
  cy: number
  r: number
  a0: number
  a1: number
  broken: boolean
  brokenMs: number
}

interface Geo {
  W: number
  H: number
  portrait: boolean
  rBase: number
  // playfield (ice) rectangle
  left: number
  top: number
  right: number
  bottom: number
  pw: number
  ph: number
  cx: number
  cy: number
  cornerR: number
  puckR: number
  paddleR: number
  wall: number
  goalLen: number
}

interface Placement {
  x: number
  y: number
  angle: number
}

/** Announced to other apps (via the shared store) when a goal or win happens. */
export type GameEvent = {
  type: 'goal' | 'win'
  team: 'red' | 'blue' // scorer (goal) / winner (win)
  red: number
  blue: number
}

export interface AirHockeyController {
  resize(): void
  reset(): void
  destroy(): void
  getState(): {
    scores: [number, number]
    phase: Phase
    winner: number
    portrait: boolean
    phaseTimer: number
    celebrating: 0 | 1 | null
    holding: boolean
  }
  debugSetScore(p1: number, p2: number): void
  /** Dev/test helper: drive a real goal through the scoring path (so it broadcasts). */
  debugGoal(team: 0 | 1): void
  /** Dev/test helper: raise a team's brick-shield wall (the "brick" power-up effect). */
  debugBricks(team: 0 | 1): void
}

const clamp = (v: number, min: number, max: number) => (v < min ? min : v > max ? max : v)
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)
// fast decelerate / accelerate (no overshoot) — snappy "zoom" motion for the messages
const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t))
const easeInExpo = (t: number) => (t <= 0 ? 0 : Math.pow(2, 10 * (t - 1)))

function roundRectPath(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2)
  c.beginPath()
  c.moveTo(x + rr, y)
  c.arcTo(x + w, y, x + w, y + h, rr)
  c.arcTo(x + w, y + h, x, y + h, rr)
  c.arcTo(x, y + h, x, y, rr)
  c.arcTo(x, y, x + w, y, rr)
  c.closePath()
}

export function createAirHockey(
  canvas: HTMLCanvasElement,
  logo: HTMLImageElement,
  onEvent?: (e: GameEvent) => void,
): AirHockeyController {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D canvas context unavailable')

  const engine = Engine.create()
  engine.gravity.x = 0
  engine.gravity.y = 0

  let iceTexture: HTMLCanvasElement | null = null // cached scratchy-ice scuffs (rebuilt on resize)
  // Nothing in the rink moves, so the whole static composite (bg + ice + markings + creases +
  // scuffs + logo) is baked once per size and blitted each frame. The puck/paddle are pre-rendered
  // to sprites so their gradients + shadow-blur are computed once, not 3× per frame. All rebuilt
  // on resize via computeGeo().
  let staticLayer: HTMLCanvasElement | null = null
  let puckSprite: { canvas: HTMLCanvasElement; size: number } | null = null
  let powerUpSprite: { canvas: HTMLCanvasElement; size: number } | null = null // "two pucks" badge
  let invincibleSprite: { canvas: HTMLCanvasElement; size: number } | null = null // invincibility badge
  let bricksSprite: { canvas: HTMLCanvasElement; size: number } | null = null // "brick wall" badge
  const paddleSprites: ({ canvas: HTMLCanvasElement; size: number } | null)[] = [null, null]
  let geo: Geo = computeGeo()
  let puck: Matter.Body
  const extraPucks: Matter.Body[] = [] // transient pucks spawned by the "two pucks" power-up
  let paddles: Matter.Body[] = []

  const scores: [number, number] = [0, 0]
  let phase: Phase = 'countdown'
  let phaseTimer = COUNTDOWN_MS
  let phaseDuration = COUNTDOWN_MS // full length of the current countdown (for anim progress)
  let serveToward: 0 | 1 = 0 // half the puck is faced-off into (the receiver)
  let centerFaceoff = false // new game → puck dead center; after a goal → receiver's blue line
  let winner = -1
  let slowTimer = 0
  let puckMovedSinceFaceoff = false // a still, never-struck face-off puck is waiting, not stuck
  let goallessMs = 0 // accumulates during live play; at POWERUP_DELAY_MS a power-up appears
  // the badge: enters from a rink edge and drifts around the neutral zone (between the blue lines)
  let powerUp: { spawnMs: number; kind: PowerKind; x: number; y: number; vx: number; vy: number } | null = null
  // invincibility stage 1: an owner paddle is charged & glowing, waiting to strike the puck
  let charge: { owner: 0 | 1; sinceMs: number } | null = null
  // invincibility stage 2: a puck is mid-invincible-run (fast, glowing, phases through opponent)
  let invincible: { puck: Matter.Body; owner: 0 | 1; sinceMs: number } | null = null
  // the "brick" power-up's shield: up to five curved bricks arched over an owner's crease, each
  // broken by a single puck hit. Persists until smashed or the next face-off clears the board.
  let bricks: Brick[] = []
  const brickRemovals = new Set<Matter.Body>() // bricks a puck touched this step, removed after Engine.update

  // animation clocks (wall-clock ms, refreshed each frame)
  let nowMs = performance.now()
  let scoreFlash: { team: 0 | 1; startMs: number } | null = null // "<TEAM> SCORES!" celebration
  let winStartMs = 0 // when the win banner began (entrance anim)
  let readyStartMs = 0 // when the READY lobby began (entrance anim)
  const scorePulseAt: [number, number] = [-1e9, -1e9] // per-team scoreboard pop timestamps

  // paddle finger targets (null = released); one pointer owns one paddle
  const targets: (Matter.Vector | null)[] = [null, null]
  const pointerOwner = new Map<number, number>()
  // hidden hold-to-reset hot zones in the dark corners; one pointer per corner press
  const cornerHolds = new Map<number, { corner: number; startMs: number }>()

  // ── geometry ────────────────────────────────────────────────────────────────
  function computeGeo(): Geo {
    const dpr = window.devicePixelRatio || 1
    const W = canvas.clientWidth || 1
    const H = canvas.clientHeight || 1
    canvas.width = Math.max(1, Math.round(W * dpr))
    canvas.height = Math.max(1, Math.round(H * dpr))
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
    const rBase = Math.min(W, H)
    const portrait = H > W
    const margin = 0 // ice extends to the screen edges
    const left = margin
    const top = margin
    const right = W - margin
    const bottom = H - margin
    const pw = right - left
    const ph = bottom - top
    iceTexture = buildIceTexture(pw, ph, rBase) // regenerate scuffs for the new dimensions
    return {
      W,
      H,
      portrait,
      rBase,
      left,
      top,
      right,
      bottom,
      pw,
      ph,
      cx: (left + right) / 2,
      cy: (top + bottom) / 2,
      cornerR: rBase * 0.23,
      puckR: rBase * 0.03,
      paddleR: rBase * 0.058,
      wall: rBase * 0.045,
      goalLen: (portrait ? pw : ph) * 0.34,
    }
  }

  // Build a static "scratchy ice" texture once per size: many short, faint, randomly
  // angled scuffs (low-alpha white + faint blue-gray). Cached and composited each frame so
  // the scratches never flicker. Returns null if an offscreen context can't be created.
  function buildIceTexture(w: number, h: number, rBase: number): HTMLCanvasElement | null {
    const t = document.createElement('canvas')
    t.width = Math.max(1, Math.round(w))
    t.height = Math.max(1, Math.round(h))
    const tc = t.getContext('2d')
    if (!tc) return null
    tc.lineCap = 'round'
    const n = Math.round((w * h) / 175) // dense field of fine scuffs (scales with rink area)
    for (let i = 0; i < n; i++) {
      const x = Math.random() * w
      const y = Math.random() * h
      const ang = Math.random() * Math.PI * 2
      const len = rBase * (0.005 + Math.random() * 0.6) // short scratches
      tc.strokeStyle = 'rgba(96,124,168,0.05)'
      tc.lineWidth = Math.random() < 0.9 ? 0.5 : 0.9
      tc.beginPath()
      tc.moveTo(x, y)
      tc.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len)
      tc.stroke()
    }
    return t
  }

  // Bake the entire static rink (black background, ice gradient, painted markings, creases,
  // scuff texture, logo) into one offscreen canvas, rebuilt only on resize. draw() then blits
  // this once per frame instead of re-running the whole sequence every frame. The offscreen
  // canvas matches the backing store (W·dpr × H·dpr) and is scaled to logical coords so the
  // existing draw helpers work unchanged. Note: the scoreboard is NOT baked (its digits change
  // and pulse), so it now paints over the scuffs rather than under — imperceptible at 0.05 alpha.
  function buildStaticLayer(): HTMLCanvasElement | null {
    const { W, H, left, top, pw, ph, cornerR, portrait } = geo
    const dpr = window.devicePixelRatio || 1
    const s = document.createElement('canvas')
    s.width = Math.max(1, Math.round(W * dpr))
    s.height = Math.max(1, Math.round(H * dpr))
    const sc = s.getContext('2d')
    if (!sc) return null
    sc.setTransform(dpr, 0, 0, dpr, 0, 0)

    // everything outside the rink is black
    sc.fillStyle = OUTSIDE
    sc.fillRect(0, 0, W, H)

    // faintly-blue ice: subtle gradient, bluer at the edges, lighter toward the middle
    roundRectPath(sc, left, top, pw, ph, cornerR)
    const iceGrad = portrait
      ? sc.createLinearGradient(0, top, 0, top + ph)
      : sc.createLinearGradient(left, 0, left + pw, 0)
    iceGrad.addColorStop(0, ICE_EDGE)
    iceGrad.addColorStop(0.5, ICE_MID)
    iceGrad.addColorStop(1, ICE_EDGE)
    sc.fillStyle = iceGrad
    sc.fill()

    // markings + creases + scuffs + logo, clipped to the ice. Paint goes down first so the
    // scratchy scuffs ride OVER it — like real ice paint worn by skates.
    sc.save()
    roundRectPath(sc, left, top, pw, ph, cornerR)
    sc.clip()
    drawMarkings(sc)
    drawGoals(sc)
    if (iceTexture) sc.drawImage(iceTexture, left, top, pw, ph)
    drawLogo(sc)
    sc.restore()
    return s
  }

  // Pre-render a circular sprite (gradient/fill + soft drop shadow) once per size. The shadow
  // has no offset, only blur, so the sprite canvas is padded by the blur radius on every side
  // and the circle is drawn at its center. Built at device pixels for crispness; draw() blits
  // it scaled to its logical `size`, centered on the body position.
  function buildSprite(
    r: number,
    blur: number,
    paint: (sc: CanvasRenderingContext2D, cx: number, cy: number, r: number) => void,
  ): { canvas: HTMLCanvasElement; size: number } | null {
    const dpr = window.devicePixelRatio || 1
    const pad = blur + r * 0.15 // blur radius + a hair of slack so the shadow isn't clipped
    const size = (r + pad) * 2 // logical sprite dimension
    const cv = document.createElement('canvas')
    cv.width = Math.max(1, Math.round(size * dpr))
    cv.height = Math.max(1, Math.round(size * dpr))
    const sc = cv.getContext('2d')
    if (!sc) return null
    sc.setTransform(dpr, 0, 0, dpr, 0, 0)
    paint(sc, size / 2, size / 2, r)
    return { canvas: cv, size }
  }

  function buildSprites() {
    const { puckR, paddleR } = geo
    puckSprite = buildSprite(puckR, puckR * 0.6, (sc, cx, cy, r) => {
      sc.beginPath()
      sc.arc(cx, cy, r, 0, Math.PI * 2)
      sc.fillStyle = PUCK_COLOR
      sc.shadowColor = 'rgba(0,0,0,0.35)'
      sc.shadowBlur = r * 0.6
      sc.fill()
    })
    // "two pucks" power-up: a glowing yellow disc holding two small puck dots side by side
    powerUpSprite = buildSprite(powerUpRadius(), powerUpRadius() * 0.7, (sc, cx, cy, r) => {
      const grad = sc.createRadialGradient(cx, cy, r * 0.1, cx, cy, r)
      grad.addColorStop(0, '#ffe9b0')
      grad.addColorStop(0.6, TOS_YELLOW)
      grad.addColorStop(1, '#d8930f')
      sc.beginPath()
      sc.arc(cx, cy, r, 0, Math.PI * 2)
      sc.fillStyle = grad
      sc.shadowColor = 'rgba(247,180,53,0.85)'
      sc.shadowBlur = r * 0.8
      sc.fill()
      sc.shadowBlur = 0
      const dotR = r * 0.26
      const dx = r * 0.34
      for (const sign of [-1, 1] as const) {
        sc.beginPath()
        sc.arc(cx + sign * dx, cy, dotR, 0, Math.PI * 2)
        sc.fillStyle = PUCK_COLOR
        sc.fill()
      }
    })
    // invincibility power-up: the same glowing amber disc stamped with a white five-point star
    invincibleSprite = buildSprite(powerUpRadius(), powerUpRadius() * 0.7, (sc, cx, cy, r) => {
      const grad = sc.createRadialGradient(cx, cy, r * 0.1, cx, cy, r)
      grad.addColorStop(0, '#ffe9b0')
      grad.addColorStop(0.6, TOS_YELLOW)
      grad.addColorStop(1, '#d8930f')
      sc.beginPath()
      sc.arc(cx, cy, r, 0, Math.PI * 2)
      sc.fillStyle = grad
      sc.shadowColor = 'rgba(247,180,53,0.85)'
      sc.shadowBlur = r * 0.8
      sc.fill()
      sc.shadowBlur = 0
      const rO = r * 0.62 // outer star radius
      const rI = r * 0.26 // inner star radius
      sc.beginPath()
      for (let k = 0; k < 10; k++) {
        const rad = k % 2 === 0 ? rO : rI
        const a = -Math.PI / 2 + (k * Math.PI) / 5
        const px = cx + Math.cos(a) * rad
        const py = cy + Math.sin(a) * rad
        k === 0 ? sc.moveTo(px, py) : sc.lineTo(px, py)
      }
      sc.closePath()
      sc.fillStyle = '#ffffff'
      sc.fill()
    })
    // brick power-up: the same glowing amber disc stamped with a small dark brick-wall motif
    bricksSprite = buildSprite(powerUpRadius(), powerUpRadius() * 0.7, (sc, cx, cy, r) => {
      const grad = sc.createRadialGradient(cx, cy, r * 0.1, cx, cy, r)
      grad.addColorStop(0, '#ffe9b0')
      grad.addColorStop(0.6, TOS_YELLOW)
      grad.addColorStop(1, '#d8930f')
      sc.beginPath()
      sc.arc(cx, cy, r, 0, Math.PI * 2)
      sc.fillStyle = grad
      sc.shadowColor = 'rgba(247,180,53,0.85)'
      sc.shadowBlur = r * 0.8
      sc.fill()
      sc.shadowBlur = 0
      // a tidy little wall: three staggered rows of dark bricks with mortar gaps
      const bw = r * 0.44 // brick width
      const bh = r * 0.26 // brick height
      const gap = r * 0.07 // mortar gap
      const rows = 3
      sc.fillStyle = PUCK_COLOR
      for (let row = 0; row < rows; row++) {
        const y = cy + (row - (rows - 1) / 2) * (bh + gap) - bh / 2
        const offset = row % 2 === 0 ? 0 : (bw + gap) / 2 // brick-bond stagger
        for (let k = -1; k <= 1; k++) {
          const x = cx + k * (bw + gap) + offset - bw / 2
          // skip the brick that would overflow the disc on staggered rows
          if (Math.abs(x + bw / 2 - cx) > r * 0.78) continue
          sc.beginPath()
          roundRectPath(sc, x, y, bw, bh, bh * 0.18)
          sc.fill()
        }
      }
    })
    for (const i of [0, 1] as const) {
      const color = i === 0 ? RED : BLUE
      paddleSprites[i] = buildSprite(paddleR, paddleR * 0.4, (sc, cx, cy, r) => {
        sc.beginPath()
        sc.arc(cx, cy, r, 0, Math.PI * 2)
        const grad = sc.createRadialGradient(cx, cy, r * 0.2, cx, cy, r)
        grad.addColorStop(0, '#ffffff')
        grad.addColorStop(0.4, color)
        grad.addColorStop(1, color)
        sc.fillStyle = grad
        sc.shadowColor = 'rgba(0,0,0,0.35)'
        sc.shadowBlur = r * 0.4
        sc.fill()
        sc.beginPath()
        sc.arc(cx, cy, r * 0.42, 0, Math.PI * 2)
        sc.fillStyle = color
        sc.fill()
      })
    }
  }

  function homePos(i: number): Matter.Vector {
    const { left, right, top, bottom, cx, cy, pw, ph, portrait } = geo
    if (!portrait) return i === 0 ? { x: left + pw * 0.22, y: cy } : { x: right - pw * 0.22, y: cy }
    // portrait: P1 bottom, P2 top
    return i === 0 ? { x: cx, y: bottom - ph * 0.22 } : { x: cx, y: top + ph * 0.22 }
  }

  // post-goal face-off point: on the receiving player's blue line (reachable by them)
  function faceoffPoint(side: 0 | 1): Matter.Vector {
    const { pw, ph, cx, cy, portrait } = geo
    if (!portrait) return { x: side === 0 ? cx - pw * 0.17 : cx + pw * 0.17, y: cy }
    return { x: cx, y: side === 0 ? cy + ph * 0.17 : cy - ph * 0.17 }
  }

  // where the puck rests at the current face-off — recomputed from geo so it survives
  // a resize/buildWorld rebuild. Dead center for a new game, blue line after a goal.
  function faceoffSpot(): Matter.Vector {
    return centerFaceoff ? { x: geo.cx, y: geo.cy } : faceoffPoint(serveToward)
  }

  // restrict paddle i to its half (kept paddleR away from edges & center line)
  function clampToHalf(i: number, x: number, y: number): Matter.Vector {
    const { left, right, top, bottom, cx, cy, portrait, paddleR: r, cornerR } = geo
    let nx = x
    let ny = y
    if (!portrait) {
      ny = clamp(ny, top + r, bottom - r)
      nx = i === 0 ? clamp(nx, left + r, cx - r) : clamp(nx, cx + r, right - r)
    } else {
      nx = clamp(nx, left + r, right - r)
      ny = i === 0 ? clamp(ny, cy + r, bottom - r) : clamp(ny, top + r, cy - r)
    }
    // keep the paddle off the rounded corners (radial clamp to the ice arc)
    const corners: [number, number, number, number][] = [
      [left + cornerR, top + cornerR, -1, -1],
      [right - cornerR, top + cornerR, 1, -1],
      [right - cornerR, bottom - cornerR, 1, 1],
      [left + cornerR, bottom - cornerR, -1, 1],
    ]
    for (const [acx, acy, sx, sy] of corners) {
      if ((nx - acx) * sx > 0 && (ny - acy) * sy > 0) {
        const dx = nx - acx
        const dy = ny - acy
        const d = Math.hypot(dx, dy)
        const maxD = cornerR - r
        if (d > maxD && d > 0) {
          nx = acx + (dx / d) * maxD
          ny = acy + (dy / d) * maxD
        }
      }
    }
    return { x: nx, y: ny }
  }

  // which paddle owns a touch at (x,y)
  function halfAt(x: number, y: number): number {
    if (!geo.portrait) return x < geo.cx ? 0 : 1
    return y > geo.cy ? 0 : 1
  }

  // The four black corners (dark area outside the rounded ice arc). Each descriptor carries
  // the ice arc's center (acx,acy) + sweep (a0→a1) — reused from buildWorld's addCorner — the
  // screen corner vertex (scx,scy), and the quadrant sign (sx,sy) toward that screen corner.
  function corners() {
    const { left, right, top, bottom, cornerR } = geo
    const r = cornerR
    return [
      { acx: left + r, acy: top + r, a0: Math.PI, a1: Math.PI * 1.5, scx: left, scy: top, sx: -1, sy: -1 },
      { acx: right - r, acy: top + r, a0: Math.PI * 1.5, a1: Math.PI * 2, scx: right, scy: top, sx: 1, sy: -1 },
      { acx: right - r, acy: bottom - r, a0: 0, a1: Math.PI * 0.5, scx: right, scy: bottom, sx: 1, sy: 1 },
      { acx: left + r, acy: bottom - r, a0: Math.PI * 0.5, a1: Math.PI, scx: left, scy: bottom, sx: -1, sy: 1 },
    ]
  }

  // index of the dark corner zone containing (x,y), or -1. A point qualifies when it sits in
  // the corner's quadrant AND outside the ice arc (so only the black wedge counts, not the ice).
  function cornerAt(x: number, y: number): number {
    const cs = corners()
    for (let k = 0; k < cs.length; k++) {
      const { acx, acy, sx, sy } = cs[k]
      if ((x - acx) * sx > 0 && (y - acy) * sy > 0 && Math.hypot(x - acx, y - acy) > geo.cornerR) return k
    }
    return -1
  }

  // ── world construction ────────────────────────────────────────────────────
  function buildWorld() {
    Composite.clear(engine.world, false, true)
    // Composite.clear just wiped every body, brick walls included — drop their stale references
    // (a resize rebuilds the world from scratch without restoring shields).
    bricks = []
    brickRemovals.clear()
    const { left, right, top, bottom, pw, ph, cx, cy, wall: t, goalLen, cornerR } = geo
    const half = t / 2
    const walls: Matter.Body[] = []
    const addWall = (wx: number, wy: number, w: number, h: number) => {
      walls.push(Bodies.rectangle(wx, wy, w, h, { isStatic: true, restitution: 1, friction: 0 }))
    }

    // Approximate each rounded corner with thin tangent segments tracing the ice arc
    // (radius cornerR), so the puck/paddles bounce off the curved edge of the white ice
    // rather than travelling into the black corner box behind it.
    const CORNER_SEGS = 10
    const addCorner = (acx: number, acy: number, a0: number, a1: number) => {
      for (let k = 0; k < CORNER_SEGS; k++) {
        const s0 = a0 + ((a1 - a0) * k) / CORNER_SEGS
        const s1 = a0 + ((a1 - a0) * (k + 1)) / CORNER_SEGS
        const mid = (s0 + s1) / 2
        const chord = 2 * cornerR * Math.sin((s1 - s0) / 2)
        const rc = cornerR + half // inner face sits on the arc (radius cornerR)
        walls.push(
          Bodies.rectangle(acx + Math.cos(mid) * rc, acy + Math.sin(mid) * rc, chord + half, t, {
            isStatic: true,
            restitution: 1,
            friction: 0,
            angle: mid + Math.PI / 2,
          }),
        )
      }
    }
    addCorner(left + cornerR, top + cornerR, Math.PI, Math.PI * 1.5) // top-left
    addCorner(right - cornerR, top + cornerR, Math.PI * 1.5, Math.PI * 2) // top-right
    addCorner(right - cornerR, bottom - cornerR, 0, Math.PI * 0.5) // bottom-right
    addCorner(left + cornerR, bottom - cornerR, Math.PI * 0.5, Math.PI) // bottom-left

    if (!geo.portrait) {
      // top & bottom rails span between the corners
      const spanX = pw - cornerR * 2
      addWall(cx, top - half, spanX, t)
      addWall(cx, bottom + half, spanX, t)
      // left & right edges: corner → goal mouth → corner (goal mouth centered at cy)
      const segTop = cy - goalLen / 2 - (top + cornerR)
      const segBot = bottom - cornerR - (cy + goalLen / 2)
      const yTop = (top + cornerR + (cy - goalLen / 2)) / 2
      const yBot = (cy + goalLen / 2 + (bottom - cornerR)) / 2
      addWall(left - half, yTop, t, segTop)
      addWall(left - half, yBot, t, segBot)
      addWall(right + half, yTop, t, segTop)
      addWall(right + half, yBot, t, segBot)
    } else {
      // left & right rails span between the corners
      const spanY = ph - cornerR * 2
      addWall(left - half, cy, t, spanY)
      addWall(right + half, cy, t, spanY)
      // top & bottom edges: corner → goal mouth → corner (goal mouth centered at cx)
      const segL = cx - goalLen / 2 - (left + cornerR)
      const segR = right - cornerR - (cx + goalLen / 2)
      const xL = (left + cornerR + (cx - goalLen / 2)) / 2
      const xR = (cx + goalLen / 2 + (right - cornerR)) / 2
      addWall(xL, top - half, segL, t)
      addWall(xR, top - half, segR, t)
      addWall(xL, bottom + half, segL, t)
      addWall(xR, bottom + half, segR, t)
    }
    Composite.add(engine.world, walls)

    const fo = faceoffSpot()
    puck = makePuck(fo.x, fo.y)

    paddles = [0, 1].map((i) =>
      Bodies.circle(homePos(i).x, homePos(i).y, geo.paddleR, {
        restitution: 0.4,
        friction: 0,
        frictionAir: 0.2,
        density: 0.05, // heavy vs. puck so it barely recoils
      }),
    )
    Composite.add(engine.world, paddles)
  }

  // ── pucks & power-ups ─────────────────────────────────────────────────────────
  // A puck body — shared by the primary puck and any power-up-spawned extras so they
  // behave identically.
  function makePuck(x: number, y: number): Matter.Body {
    const b = Bodies.circle(x, y, geo.puckR, {
      restitution: 0.98,
      friction: 0,
      frictionStatic: 0,
      frictionAir: 0.006,
      density: 0.002,
    })
    Composite.add(engine.world, b)
    return b
  }

  // "Two pucks" power-up: launch a second puck in along the center line from a random end.
  function spawnExtraPuck() {
    if (extraPucks.length >= MAX_EXTRA_PUCKS) return
    const { left, right, top, bottom, cx, cy, puckR, portrait } = geo
    const inset = puckR * 2
    const speed = geo.rBase * 0.03 * 0.85 // just under the step() speed cap
    const fromStart = Math.random() < 0.5
    let pos: Matter.Vector
    let vel: Matter.Vector
    if (!portrait) {
      // vertical center line: enter from the top or bottom wall, shoot along it
      pos = fromStart ? { x: cx, y: top + inset } : { x: cx, y: bottom - inset }
      vel = { x: 0, y: fromStart ? speed : -speed }
    } else {
      // horizontal center line: enter from the left or right wall, shoot along it
      pos = fromStart ? { x: left + inset, y: cy } : { x: right - inset, y: cy }
      vel = { x: fromStart ? speed : -speed, y: 0 }
    }
    const b = makePuck(pos.x, pos.y)
    Body.setVelocity(b, vel)
    extraPucks.push(b)
  }

  function clearExtraPucks() {
    for (const b of extraPucks) Composite.remove(engine.world, b)
    extraPucks.length = 0
  }

  function powerUpRadius() {
    return geo.puckR * 1.6
  }

  // The neutral zone (between the two blue lines) the power-up drifts inside, inset by its radius
  // so the badge stays fully on-ice as it bounces. Landscape: a vertical band spanning top↔bottom;
  // portrait: a horizontal band spanning left↔right.
  function neutralZone() {
    const { left, right, top, bottom, cx, cy, pw, ph, portrait } = geo
    const r = powerUpRadius()
    if (!portrait) {
      return { minX: cx - pw * 0.17 + r, maxX: cx + pw * 0.17 - r, minY: top + r, maxY: bottom - r }
    }
    return { minX: left + r, maxX: right - r, minY: cy - ph * 0.17 + r, maxY: cy + ph * 0.17 - r }
  }

  // Choose a power-up kind uniformly (two-pucks falls back to another kind when extras are maxed),
  // then send it drifting in from a rink edge within the neutral zone at a gentle inward angle.
  function spawnPowerUp() {
    const kinds: PowerKind[] = ['two-pucks', 'invincibility', 'brick']
    let kind = kinds[Math.floor(Math.random() * kinds.length)]
    // two-pucks falls back to one of the other always-available kinds when extras are maxed
    if (kind === 'two-pucks' && extraPucks.length >= MAX_EXTRA_PUCKS) kind = Math.random() < 0.5 ? 'invincibility' : 'brick'
    const z = neutralZone()
    const speed = geo.rBase * 0.005 // slow float
    const a = (0.25 + Math.random() * 0.5) * Math.PI // inward heading, 45°–135° off the entry edge
    let x: number, y: number, vx: number, vy: number
    if (!geo.portrait) {
      // enter from the top or bottom rink edge, drift down/up into the band
      const fromTop = Math.random() < 0.5
      x = z.minX + Math.random() * (z.maxX - z.minX)
      y = fromTop ? z.minY : z.maxY
      vx = Math.cos(a) * speed
      vy = (fromTop ? 1 : -1) * Math.sin(a) * speed
    } else {
      // enter from the left or right rink edge, drift right/left into the band
      const fromLeft = Math.random() < 0.5
      y = z.minY + Math.random() * (z.maxY - z.minY)
      x = fromLeft ? z.minX : z.maxX
      vx = (fromLeft ? 1 : -1) * Math.sin(a) * speed
      vy = Math.cos(a) * speed
    }
    powerUp = { spawnMs: nowMs, kind, x, y, vx, vy }
  }

  // Stage 2: the charged owner has just struck `b`. Make it phase through the opponent paddle
  // (a shared negative collisionFilter.group disables that one pair while leaving walls + the
  // owner's paddle solid) and shove it off at the invincible speed in its post-hit direction.
  // The run lasts INVINCIBLE_MS (it bounces off walls during that window) then reverts to normal.
  function launchInvincible(b: Matter.Body, owner: 0 | 1) {
    invincible = { puck: b, owner, sinceMs: nowMs }
    b.collisionFilter.group = -1
    paddles[1 - owner].collisionFilter.group = -1
    const fast = geo.rBase * 0.03 * INVINCIBLE_SPEED_MULT
    let dx = b.velocity.x
    let dy = b.velocity.y
    let mag = Math.hypot(dx, dy)
    if (mag < 1e-3) {
      // degenerate (barely moving): shoot away from the striking paddle
      dx = b.position.x - paddles[owner].position.x
      dy = b.position.y - paddles[owner].position.y
      mag = Math.hypot(dx, dy) || 1
    }
    Body.setVelocity(b, { x: (dx / mag) * fast, y: (dy / mag) * fast })
    charge = null
  }

  // End an invincible-puck run: restore normal collision (puck ↔ opponent paddle) and speed cap.
  function endInvincible() {
    if (!invincible) return
    invincible.puck.collisionFilter.group = 0
    paddles[1 - invincible.owner].collisionFilter.group = 0
    invincible = null
  }

  // Drop the power-up and restart the goal-less clock so the next one is a full delay away
  // (never re-appears moments later).
  function clearPowerUp() {
    powerUp = null
    goallessMs = 0
  }

  // ── brick shield ─────────────────────────────────────────────────────────────
  // The crease arc an owner's bricks sit on — matches drawGoals()/paintCrease() exactly so the
  // physics wall and the painted crease share one source of truth. Returns the goal center, the
  // crease radius, and the half-circle sweep (a0→a1) that opens into the ice.
  function creaseGeom(owner: 0 | 1): { cx: number; cy: number; r: number; a0: number; a1: number } {
    const { left, right, top, bottom, cx, cy, goalLen } = geo
    const r = goalLen / 2
    const HALF = Math.PI / 2
    if (!geo.portrait) {
      return owner === 0
        ? { cx: left, cy, r, a0: -HALF, a1: HALF } // RED goal (left), opens right
        : { cx: right, cy, r, a0: HALF, a1: 3 * HALF } // BLUE goal (right), opens left
    }
    return owner === 0
      ? { cx, cy: bottom, r, a0: Math.PI, a1: 2 * Math.PI } // RED goal (bottom), opens up
      : { cx, cy: top, r, a0: 0, a1: Math.PI } // BLUE goal (top), opens down
  }

  // A static rectangle approximating one brick's arc segment: a chord tangent to the crease arc
  // at its mid-angle (same construction as buildWorld's addCorner). Tagged 'brick' so the
  // collision handler can spot a puck striking it.
  function makeBrickBody(cx: number, cy: number, r: number, a0: number, a1: number, thickness: number): Matter.Body {
    const mid = (a0 + a1) / 2
    const chord = 2 * r * Math.sin((a1 - a0) / 2)
    const b = Bodies.rectangle(cx + Math.cos(mid) * r, cy + Math.sin(mid) * r, chord, thickness, {
      isStatic: true,
      restitution: 1,
      friction: 0,
      angle: mid + Math.PI / 2,
    })
    b.label = 'brick'
    return b
  }

  // Raise the five-brick shield over `owner`'s crease (replacing any wall they already have).
  // The 180° crease sweep is split into five equal segments separated by small mortar gaps.
  function spawnBricks(owner: 0 | 1) {
    clearBricks(owner)
    const { cx, cy, r, a0, a1 } = creaseGeom(owner)
    const count = 5
    const span = a1 - a0
    const gap = span * 0.045 // mortar gap between bricks
    const seg = (span - gap * (count - 1)) / count
    const thickness = geo.rBase * 0.022
    for (let k = 0; k < count; k++) {
      const s0 = a0 + k * (seg + gap)
      const s1 = s0 + seg
      const body = makeBrickBody(cx, cy, r, s0, s1, thickness)
      Composite.add(engine.world, body)
      bricks.push({ owner, body, cx, cy, r, a0: s0, a1: s1, broken: false, brokenMs: 0 })
    }
  }

  // Remove brick bodies from the world and forget them. With no owner, clears every wall;
  // with an owner, clears just that player's (used before rebuilding their shield).
  function clearBricks(owner?: 0 | 1) {
    for (let k = bricks.length - 1; k >= 0; k--) {
      if (owner !== undefined && bricks[k].owner !== owner) continue
      brickRemovals.delete(bricks[k].body)
      Composite.remove(engine.world, bricks[k].body)
      bricks.splice(k, 1)
    }
  }

  // Any puck (primary, extra, or the invincible one) touching a brick queues it for removal.
  // We only flag here — the body is removed after Engine.update() so the bounce impulse for this
  // step still lands first (the brick-breaker "bounce then shatter" feel).
  function onBrickCollision(ev: Matter.IEventCollision<Matter.Engine>) {
    if (bricks.length === 0) return
    for (const pair of ev.pairs) {
      const a = pair.bodyA.parent
      const b = pair.bodyB.parent
      const brick = a.label === 'brick' ? a : b.label === 'brick' ? b : null
      if (!brick) continue
      const other = brick === a ? b : a
      if (other === puck || extraPucks.includes(other)) brickRemovals.add(brick)
    }
  }

  // ── match flow ──────────────────────────────────────────────────────────────
  // Face-off: drop the puck STILL. It only moves once struck. A new game faces off
  // dead center; post-goal (and re-drops) sit on the receiving player's blue line.
  function resetPuck(toward: 0 | 1, duration = COUNTDOWN_MS, center = false) {
    scoreFlash = null
    clearExtraPucks()
    clearPowerUp()
    clearBricks()
    endInvincible()
    charge = null
    serveToward = toward
    centerFaceoff = center
    Body.setPosition(puck, faceoffSpot())
    Body.setVelocity(puck, { x: 0, y: 0 })
    Body.setAngularVelocity(puck, 0)
    phase = 'countdown'
    phaseTimer = duration
    phaseDuration = duration
    slowTimer = 0
    puckMovedSinceFaceoff = false
  }

  function onGoal(scorer: number) {
    clearExtraPucks() // any goal returns the board to a single puck
    clearPowerUp()
    clearBricks()
    endInvincible()
    charge = null
    scores[scorer]++
    scorePulseAt[scorer] = nowMs // pop the scoreboard digit
    const team: 'red' | 'blue' = scorer === 0 ? 'red' : 'blue'
    if (scores[scorer] >= WIN_SCORE) {
      winner = scorer
      winStartMs = nowMs
      phase = 'gameover'
      Body.setPosition(puck, { x: geo.cx, y: geo.cy })
      Body.setVelocity(puck, { x: 0, y: 0 })
      // the winning goal broadcasts only "<TEAM> WINS!" — no redundant "SCORES!" first
      onEvent?.({ type: 'win', team, red: scores[0], blue: scores[1] })
    } else {
      onEvent?.({ type: 'goal', team, red: scores[0], blue: scores[1] })
      // hold the "<TEAM> SCORES!" celebration (scrim + frozen input); a fresh countdown
      // then runs before play resumes. Park the puck on the receiver's blue line.
      serveToward = (1 - scorer) as 0 | 1
      centerFaceoff = false
      Body.setPosition(puck, faceoffSpot())
      Body.setVelocity(puck, { x: 0, y: 0 })
      Body.setAngularVelocity(puck, 0)
      scoreFlash = { team: scorer as 0 | 1, startMs: nowMs }
      phase = 'celebrating'
      phaseTimer = GOAL_CELEBRATION_MS
      phaseDuration = GOAL_CELEBRATION_MS
      slowTimer = 0
      puckMovedSinceFaceoff = false
    }
  }

  // which team a puck at (x,y) scored for, or -1 if it hasn't crossed a goal line
  function goalScorerAt(x: number, y: number): number {
    const { left, right, top, bottom, cx, cy, goalLen, puckR } = geo
    if (!geo.portrait) {
      const inMouth = Math.abs(y - cy) < goalLen / 2
      if (x < left - puckR && inMouth) return 1 // into left (RED) goal → BLUE scores
      if (x > right + puckR && inMouth) return 0 // into right (BLUE) goal → RED scores
    } else {
      const inMouth = Math.abs(x - cx) < goalLen / 2
      if (y > bottom + puckR && inMouth) return 1 // into bottom (RED) goal → BLUE scores
      if (y < top - puckR && inMouth) return 0 // into top (BLUE) goal → RED scores
    }
    return -1
  }

  // a puck that has left the rink without scoring a valid goal
  function escapedRink(x: number, y: number): boolean {
    const { left, right, top, bottom, pw, ph } = geo
    return x < left - pw * 0.2 || x > right + pw * 0.2 || y < top - ph * 0.2 || y > bottom + ph * 0.2
  }

  function checkGoals() {
    // any puck (primary or extra) crossing a goal line scores; onGoal resets to a single puck
    const m = puck.position
    if (goalScorerAt(m.x, m.y) >= 0) {
      onGoal(goalScorerAt(m.x, m.y))
      return
    }
    for (let k = extraPucks.length - 1; k >= 0; k--) {
      const p = extraPucks[k].position
      const s = goalScorerAt(p.x, p.y)
      if (s >= 0) {
        onGoal(s)
        return
      }
      // a stray extra puck just disappears — no full face-off
      if (escapedRink(p.x, p.y)) {
        Composite.remove(engine.world, extraPucks[k])
        extraPucks.splice(k, 1)
      }
    }
    // failsafe: the primary puck escaped without a valid goal — face off again
    if (escapedRink(m.x, m.y)) resetPuck(serveToward)
  }

  // If the puck stalls in the central band that NO paddle can reach, gently re-face-off
  // it (still — never relaunched at speed). A stalled puck elsewhere is left for a player to hit.
  function checkStuck() {
    const sp = Math.hypot(puck.velocity.x, puck.velocity.y)
    const moveThresh = geo.rBase * 0.0025
    if (sp >= moveThresh) puckMovedSinceFaceoff = true
    if (!puckMovedSinceFaceoff) return // fresh face-off: waiting to be struck, not stuck
    const band = geo.paddleR + geo.puckR
    const inNeutral = !geo.portrait
      ? Math.abs(puck.position.x - geo.cx) < band
      : Math.abs(puck.position.y - geo.cy) < band
    if (sp < moveThresh && inNeutral) {
      slowTimer += PHYS_DT
      if (slowTimer > STUCK_MS) resetPuck(((serveToward + 1) % 2) as 0 | 1)
    } else {
      slowTimer = 0
    }
  }

  // Wipe the match back to 0–0 with paddles home and fingers released. Shared prelude for
  // both the READY lobby (reset) and an immediate restart (newMatch).
  function clearBoard() {
    clearExtraPucks()
    clearPowerUp()
    clearBricks()
    scores[0] = 0
    scores[1] = 0
    winner = -1
    paddles.forEach((p, i) => {
      Body.setPosition(p, homePos(i))
      Body.setVelocity(p, { x: 0, y: 0 })
    })
    targets[0] = null
    targets[1] = null
    scoreFlash = null
  }

  // Full reset to the READY lobby (first launch + secret hold-reset). Lands on a "READY /
  // Tap to play" screen — a tap then runs startGame(). Distinct from the post-win restart,
  // which counts down directly without passing through READY.
  function reset() {
    clearBoard()
    centerFaceoff = true
    Body.setPosition(puck, { x: geo.cx, y: geo.cy }) // puck dead center, waiting
    Body.setVelocity(puck, { x: 0, y: 0 })
    Body.setAngularVelocity(puck, 0)
    phase = 'ready'
    readyStartMs = nowMs
  }

  // Leave the READY lobby and begin a fresh centered countdown.
  function startGame() {
    resetPuck(serveToward, COUNTDOWN_MS, true)
  }

  // ── per-frame simulation ────────────────────────────────────────────────────
  function step() {
    // a held dark-corner hot zone that reaches the threshold resets the whole game to READY
    for (const h of cornerHolds.values()) {
      if (nowMs - h.startMs >= HOLD_RESET_MS) {
        cornerHolds.clear()
        reset()
        return
      }
    }

    if (phase === 'celebrating') {
      // "<TEAM> SCORES!" + scrim holds for the full window, then a fresh countdown runs
      phaseTimer -= PHYS_DT
      if (phaseTimer <= 0) resetPuck(serveToward)
    } else if (phase === 'countdown') {
      phaseTimer -= PHYS_DT
      if (phaseTimer <= 0) phase = 'playing' // puck stays put; players must strike it
    }

    // puck is strikeable only during play; a sensor (pass-through) otherwise so nobody
    // can jump the gun by hitting it during the countdown or celebration
    puck.isSensor = phase !== 'playing'

    // velocity-chase paddles toward fingers
    for (let i = 0; i < 2; i++) {
      const p = paddles[i]
      const tgt = targets[i]
      if (tgt && (phase === 'playing' || phase === 'countdown')) {
        let vx = (tgt.x - p.position.x) * 0.85
        let vy = (tgt.y - p.position.y) * 0.85
        const maxv = geo.rBase * 0.1
        const sp = Math.hypot(vx, vy)
        if (sp > maxv) {
          vx = (vx / sp) * maxv
          vy = (vy / sp) * maxv
        }
        Body.setVelocity(p, { x: vx, y: vy })
      } else {
        Body.setVelocity(p, { x: 0, y: 0 })
      }
    }

    Engine.update(engine, PHYS_DT)

    // shatter any bricks a puck struck this step (the bounce impulse already landed above)
    if (brickRemovals.size) {
      for (const body of brickRemovals) {
        const brick = bricks.find((br) => br.body === body)
        if (brick && !brick.broken) {
          brick.broken = true
          brick.brokenMs = nowMs
          Composite.remove(engine.world, body)
        }
      }
      brickRemovals.clear()
    }
    // drop bricks whose shatter flash has finished animating
    for (let k = bricks.length - 1; k >= 0; k--) {
      if (bricks[k].broken && nowMs - bricks[k].brokenMs > BRICK_SHATTER_MS) bricks.splice(k, 1)
    }

    // keep paddles inside their halves even after puck impacts
    for (let i = 0; i < 2; i++) {
      const p = paddles[i]
      const c = clampToHalf(i, p.position.x, p.position.y)
      if (c.x !== p.position.x || c.y !== p.position.y) Body.setPosition(p, c)
    }

    // invincibility stage 1→2: a charged paddle that touches a puck launches it as the invincible
    // puck — fast, phasing through the opponent — until it strikes a wall or scores.
    if (charge && phase === 'playing') {
      const op = paddles[charge.owner]
      const contact = geo.paddleR + geo.puckR * 1.3
      for (const b of [puck, ...extraPucks]) {
        if (Math.hypot(op.position.x - b.position.x, op.position.y - b.position.y) < contact) {
          launchInvincible(b, charge.owner)
          break
        }
      }
    }

    // the invincible-puck run is purely time-boxed: after INVINCIBLE_MS, restore normal
    // collision + speed (it keeps whatever heading/speed it has, re-clamped to the normal cap)
    if (invincible && nowMs - invincible.sinceMs > INVINCIBLE_MS) endInvincible()

    // cap every puck's speed to prevent tunneling through rails / goal posts (the invincible puck
    // gets a higher cap so its launch boost isn't immediately clamped away)
    const maxp = geo.rBase * 0.03
    for (const b of [puck, ...extraPucks]) {
      const cap = b === invincible?.puck ? maxp * INVINCIBLE_SPEED_MULT : maxp
      const ps = Math.hypot(b.velocity.x, b.velocity.y)
      if (ps > cap) {
        Body.setVelocity(b, { x: (b.velocity.x / ps) * cap, y: (b.velocity.y / ps) * cap })
      }
    }

    if (phase === 'playing') {
      checkGoals()
      checkStuck()
      updatePowerUp()
    }
  }

  // Drive the power-up: spawn it after enough goal-less play, grant its effect when a paddle
  // touches it, or let it time out. The goal-less clock only ticks while no power-up is pending
  // and no invincibility effect is in progress.
  function updatePowerUp() {
    if (powerUp) {
      if (nowMs - powerUp.spawnMs > POWERUP_LIFETIME_MS) {
        clearPowerUp() // faded away uncollected
        return
      }
      // float around the neutral zone, bouncing off its bounds (the blue lines + the rink edges)
      const z = neutralZone()
      powerUp.x += powerUp.vx
      powerUp.y += powerUp.vy
      if (powerUp.x < z.minX) (powerUp.x = z.minX), (powerUp.vx = Math.abs(powerUp.vx))
      else if (powerUp.x > z.maxX) (powerUp.x = z.maxX), (powerUp.vx = -Math.abs(powerUp.vx))
      if (powerUp.y < z.minY) (powerUp.y = z.minY), (powerUp.vy = Math.abs(powerUp.vy))
      else if (powerUp.y > z.maxY) (powerUp.y = z.maxY), (powerUp.vy = -Math.abs(powerUp.vy))

      const reach = geo.paddleR + powerUpRadius()
      for (let i = 0; i < paddles.length; i++) {
        const p = paddles[i]
        if (Math.hypot(p.position.x - powerUp.x, p.position.y - powerUp.y) < reach) {
          if (powerUp.kind === 'two-pucks') spawnExtraPuck()
          else if (powerUp.kind === 'brick') spawnBricks(i as 0 | 1) // raise this player's crease shield
          else charge = { owner: i as 0 | 1, sinceMs: nowMs } // arm this paddle for an invincible strike
          clearPowerUp()
          return
        }
      }
    } else if (puckMovedSinceFaceoff && !charge && !invincible) {
      // A power-up always appears during goal-less play. The puck cap only constrains the
      // "two pucks" kind — spawnPowerUp() falls back to invincibility when extras are maxed.
      goallessMs += PHYS_DT
      if (goallessMs >= POWERUP_DELAY_MS) spawnPowerUp()
    }
  }

  // ── rendering ────────────────────────────────────────────────────────────────
  // Rebuild the cached static rink + puck/paddle sprites for the current geometry. Called at
  // startup and on every resize (kept out of computeGeo to avoid touching `geo` before it's
  // initialized on the first call).
  function rebuildStatics() {
    staticLayer = buildStaticLayer()
    buildSprites()
  }

  function draw() {
    const c = ctx!
    const { W, H } = geo

    // The entire static rink (background, ice, markings, creases, scuffs, logo) is pre-baked;
    // blit it in one shot, then layer the only things that actually move on top.
    if (staticLayer) c.drawImage(staticLayer, 0, 0, W, H)
    else c.clearRect(0, 0, W, H)

    drawScoreboard() // per-frame: digits change + brief scale-pop on a goal
    drawPowerUp() // under the pucks/paddles so a scooping paddle renders on top
    drawBricks() // crease shields, under the pucks so a striking puck renders on top
    drawPuck()
    for (const b of extraPucks) drawPuck(b)
    drawPaddle(0)
    drawPaddle(1)

    if (phase === 'countdown') drawCountdown()
    else if (phase === 'celebrating') {
      drawScrim()
      drawScoreFlash()
    } else if (phase === 'gameover') drawWinner()
    else if (phase === 'ready') drawReady()

    drawCornerHolds() // hidden hold-to-reset glow — on top of everything, including the scrim
  }

  function drawMarkings(c: CanvasRenderingContext2D) {
    const { left, right, top, bottom, cx, cy, pw, ph, rBase, portrait } = geo
    const lw = Math.max(2, rBase * 0.01)
    const ringR = rBase * 0.16 // center face-off ring radius (red center line stops here)
    c.lineWidth = lw

    // washed-out markings use pre-faded pastel colors (full opacity) so overlapping
    // strokes — e.g. the center line crossing the face-off ring — don't darken
    if (!portrait) {
      // blue zone lines
      c.strokeStyle = BLUE_LINE_WASH
      for (const x of [cx - pw * 0.17, cx + pw * 0.17]) {
        c.beginPath()
        c.moveTo(x, top)
        c.lineTo(x, bottom)
        c.stroke()
      }
      // red center line — split into two segments that stop at the face-off ring
      c.strokeStyle = RED_LINE_WASH
      c.lineWidth = lw * 1.4
      c.beginPath()
      c.moveTo(cx, top)
      c.lineTo(cx, cy - ringR)
      c.moveTo(cx, cy + ringR)
      c.lineTo(cx, bottom)
      c.stroke()
    } else {
      c.strokeStyle = BLUE_LINE_WASH
      for (const y of [cy - ph * 0.17, cy + ph * 0.17]) {
        c.beginPath()
        c.moveTo(left, y)
        c.lineTo(right, y)
        c.stroke()
      }
      // red center line — split into two segments that stop at the face-off ring
      c.strokeStyle = RED_LINE_WASH
      c.lineWidth = lw * 1.4
      c.beginPath()
      c.moveTo(left, cy)
      c.lineTo(cx - ringR, cy)
      c.moveTo(cx + ringR, cy)
      c.lineTo(right, cy)
      c.stroke()
    }

    // center face-off ring (red) — washed out; ice texture/gradient/logo show through
    c.strokeStyle = RED_LINE_WASH
    c.lineWidth = lw
    c.beginPath()
    c.arc(cx, cy, ringR, 0, Math.PI * 2)
    c.stroke()
  }

  // The net itself sits at the screen edge (off-screen), so instead of a literal goal
  // box we paint a hockey "crease" — a faded half-circle on the ice in front of each
  // net, bulging inward from the goal line. Purely cosmetic (scoring/bounce geometry is
  // unchanged); painted under the ice texture like the rink lines.
  function drawGoals(c: CanvasRenderingContext2D) {
    const { left, right, top, bottom, cx, cy, goalLen } = geo
    const r = goalLen / 2 // crease spans the goal mouth
    const HALF = Math.PI / 2
    if (!geo.portrait) {
      paintCrease(c, left, cy, r, RED_LINE_WASH, -HALF, HALF) // opens right, into the ice
      paintCrease(c, right, cy, r, BLUE_LINE_WASH, HALF, 3 * HALF) // opens left
    } else {
      paintCrease(c, cx, bottom, r, RED_LINE_WASH, Math.PI, 2 * Math.PI) // opens up
      paintCrease(c, cx, top, r, BLUE_LINE_WASH, 0, Math.PI) // opens down
    }
  }

  function paintCrease(
    c: CanvasRenderingContext2D,
    x: number,
    y: number,
    r: number,
    color: string,
    a0: number,
    a1: number,
  ) {
    c.save()
    // faded ice tint inside the crease
    c.globalAlpha = 0.32
    c.fillStyle = color
    c.beginPath()
    c.arc(x, y, r, a0, a1)
    c.closePath() // chord along the goal line closes the half-disc
    c.fill()
    // painted arc edge for definition
    c.globalAlpha = 0.85
    c.lineWidth = Math.max(2, geo.rBase * 0.01)
    c.strokeStyle = color
    c.beginPath()
    c.arc(x, y, r, a0, a1)
    c.stroke()
    c.restore()
  }

  function drawLogo(c: CanvasRenderingContext2D) {
    if (!(logo.complete && logo.naturalWidth > 0)) return
    const size = geo.rBase * 0.27
    c.save()
    c.globalAlpha = 0.5 // washed out — faded into the ice
    c.drawImage(logo, geo.cx - size / 2, geo.cy - size / 2, size, size)
    c.restore()
  }

  // The invincibility effect's signature: a fast-flashing amber ring with a soft amber glow,
  // shared by the charged paddle (stage 1) and the invincible puck (stage 2).
  function drawAmberFlash(x: number, y: number, radius: number) {
    const c = ctx!
    const flash = 0.35 + 0.45 * Math.abs(Math.sin((nowMs / 1000) * 8)) // fast flash 0.35 → 0.8
    c.save()
    c.beginPath()
    c.arc(x, y, radius, 0, Math.PI * 2)
    c.strokeStyle = `rgba(247,180,53,${flash})`
    c.lineWidth = radius * 0.22
    c.shadowColor = 'rgba(247,180,53,0.9)'
    c.shadowBlur = radius * 0.8
    c.stroke()
    c.restore()
  }

  // Puck and paddles blit their pre-rendered sprites (gradient + shadow baked once per size)
  // centered on the body position — no per-frame gradient/shadow-blur.
  function drawPuck(body: Matter.Body = puck) {
    if (!puckSprite) return
    const half = puckSprite.size / 2
    ctx!.drawImage(puckSprite.canvas, body.position.x - half, body.position.y - half, puckSprite.size, puckSprite.size)
    if (body === invincible?.puck) drawAmberFlash(body.position.x, body.position.y, geo.puckR * 1.6)
  }

  // The drifting power-up badge: a steady glow ring plus the kind's badge with a gentle pulse,
  // drawn at its current floating position in the neutral zone.
  function drawPowerUp() {
    const sprite =
      powerUp?.kind === 'invincibility' ? invincibleSprite : powerUp?.kind === 'brick' ? bricksSprite : powerUpSprite
    if (!powerUp || !sprite) return
    const c = ctx!
    const { x, y } = powerUp
    const t = (nowMs - powerUp.spawnMs) / 1000
    const pulse = 1 + Math.sin(t * 4) * 0.08 // gentle breathing scale
    const r = powerUpRadius()

    // live glow ring so it reads as "grab me", independent of the baked sprite shadow
    c.save()
    c.beginPath()
    c.arc(x, y, r * (1.25 + Math.sin(t * 4) * 0.1), 0, Math.PI * 2)
    c.strokeStyle = 'rgba(247,180,53,0.55)'
    c.lineWidth = r * 0.12
    c.stroke()
    c.restore()

    const size = sprite.size * pulse
    const half = size / 2
    c.drawImage(sprite.canvas, x - half, y - half, size, size)
  }

  // A curved brick: the annular sector between rInner and rOuter spanning a0→a1 (closed by the
  // radial ends), giving a true curved tile rather than the flat physics chord behind it.
  function brickSectorPath(
    c: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    rInner: number,
    rOuter: number,
    a0: number,
    a1: number,
  ) {
    c.beginPath()
    c.arc(cx, cy, rOuter, a0, a1)
    c.arc(cx, cy, rInner, a1, a0, true)
    c.closePath()
  }

  // The brick shield: each unbroken brick is a glossy team-colored curved tile arched over its
  // owner's crease; a freshly struck brick plays a quick outward-pushing fade before it's dropped.
  function drawBricks() {
    if (bricks.length === 0) return
    const c = ctx!
    const half = geo.rBase * 0.026 // visual radial half-thickness — chunky enough to read as a brick
    for (const br of bricks) {
      const color = br.owner === 0 ? RED : BLUE
      const rInner = br.r - half
      const rOuter = br.r + half
      if (!br.broken) {
        c.save()
        // solid brick body with a soft drop shadow lifting it off the ice
        brickSectorPath(c, br.cx, br.cy, rInner, rOuter, br.a0, br.a1)
        c.fillStyle = color
        c.shadowColor = 'rgba(0,0,0,0.4)'
        c.shadowBlur = half * 1.1
        c.fill()
        c.shadowBlur = 0
        // crisp dark mortar outline so the five bricks read as distinct tiles
        c.lineWidth = Math.max(1.5, geo.rBase * 0.004)
        c.strokeStyle = 'rgba(20,28,42,0.55)'
        c.stroke()
        // glossy highlight along the outer half for a beveled, lit-from-outside look
        brickSectorPath(c, br.cx, br.cy, br.r + half * 0.1, rOuter, br.a0, br.a1)
        c.fillStyle = 'rgba(255,255,255,0.32)'
        c.fill()
        c.restore()
      } else {
        const t = clamp((nowMs - br.brokenMs) / BRICK_SHATTER_MS, 0, 1)
        const push = half * 2.5 * t // band shoves outward as it dissolves
        c.save()
        c.globalAlpha = 1 - t
        brickSectorPath(c, br.cx, br.cy, rInner + push, rOuter + push, br.a0, br.a1)
        c.fillStyle = t < 0.35 ? '#ffffff' : color // a brief white pop on impact
        c.fill()
        c.restore()
      }
    }
  }

  function drawPaddle(i: number) {
    const sp = paddleSprites[i]
    if (!sp) return
    const p = paddles[i]
    const half = sp.size / 2
    if (charge?.owner === i) drawAmberFlash(p.position.x, p.position.y, geo.paddleR * 1.2) // charged
    ctx!.drawImage(sp.canvas, p.position.x - half, p.position.y - half, sp.size, sp.size)
  }

  // ── double-sided overlays (readable from both ends) ──────────────────────────
  // Rotations face each player at the end of the rink behind their goal.
  function scoreboardPlacements(): Placement[] {
    const { left, right, top, bottom, cx, cy, pw, ph, portrait } = geo
    if (!portrait) {
      return [
        { x: left + pw * 0.1, y: top + ph * 0.16, angle: Math.PI / 2 }, // RED end (left)
        { x: right - pw * 0.1, y: top + ph * 0.16, angle: -Math.PI / 2 }, // BLUE end (right)
      ]
    }
    return [
      { x: right - pw * 0.16, y: top + ph * 0.08, angle: Math.PI }, // BLUE end (top)
      { x: left + pw * 0.16, y: bottom - ph * 0.08, angle: 0 }, // RED end (bottom)
    ]
  }

  function countdownPlacements(spread = 0.2): Placement[] {
    const { cx, cy, rBase, portrait } = geo
    const d = rBase * spread
    if (!portrait) {
      return [
        { x: cx - d, y: cy, angle: Math.PI / 2 }, // faces RED end (left)
        { x: cx + d, y: cy, angle: -Math.PI / 2 }, // faces BLUE end (right)
      ]
    }
    return [
      { x: cx, y: cy - d, angle: Math.PI }, // faces BLUE end (top)
      { x: cx, y: cy + d, angle: 0 }, // faces RED end (bottom)
    ]
  }

  // brief scale "pop" for a scoreboard digit right after its team scores
  function teamPulse(i: number): number {
    const t = (nowMs - scorePulseAt[i]) / 450
    if (t < 0 || t > 1) return 1
    return 1 + 0.7 * (1 - easeOutCubic(t))
  }

  function drawScoreboard() {
    const c = ctx!
    const fs = geo.rBase * 0.055
    const gap = fs * 0.55
    const r = String(scores[0])
    const b = String(scores[1])
    const sep = '–'
    for (const p of scoreboardPlacements()) {
      c.save()
      c.translate(p.x, p.y)
      c.rotate(p.angle)
      c.textBaseline = 'middle'
      c.textAlign = 'center'
      c.font = `700 ${fs}px 'Orbitron', sans-serif`
      const rw = c.measureText(r).width
      const sw = c.measureText(sep).width
      const bw = c.measureText(b).width
      const total = rw + bw + sw + gap * 2
      const start = -total / 2
      const rCenter = start + rw / 2
      const sepCenter = start + rw + gap + sw / 2
      const bCenter = start + rw + gap + sw + gap + bw / 2
      // Painted-on-the-ice look: faded line-wash colors (matching the rink markings),
      // no glow. The scratch texture is drawn over these so they read as worn paint.
      // red digit (pops when red scores)
      c.save()
      c.translate(rCenter, 0)
      c.scale(teamPulse(0), teamPulse(0))
      c.fillStyle = RED_LINE_WASH
      c.fillText(r, 0, 0)
      c.restore()
      // separator
      c.fillStyle = 'rgba(40,55,80,0.3)'
      c.fillText(sep, sepCenter, 0)
      // blue digit (pops when blue scores)
      c.save()
      c.translate(bCenter, 0)
      c.scale(teamPulse(1), teamPulse(1))
      c.fillStyle = BLUE_LINE_WASH
      c.fillText(b, 0, 0)
      c.restore()
      c.restore()
    }
  }

  function drawCountdown() {
    const c = ctx!
    const n = Math.max(1, Math.ceil(phaseTimer / 500))
    // progress within the current 1s digit (0 = just appeared → 1 = about to switch)
    let rem = phaseTimer % 500
    if (rem === 0) rem = 500
    const p01 = (500 - rem) / 500
    // fast zoom-in (no overshoot) with a brief horizontal motion-stretch, then hold/fade
    const e = easeOutExpo(clamp(p01 / 0.22, 0, 1))
    const zoom = 1 + 0.9 * (1 - e) // 1.9 → 1.0, snappy
    const stretchX = zoom * (1 + 0.7 * (1 - e))
    let alpha = Math.min(1, p01 * 6)
    if (p01 > 0.78) alpha *= 1 - (p01 - 0.78) / 0.22 // fade as the digit expires
    for (const p of countdownPlacements()) {
      c.save()
      c.translate(p.x, p.y)
      c.rotate(p.angle)
      c.scale(stretchX, zoom)
      c.textAlign = 'center'
      c.textBaseline = 'middle'
      c.font = `700 ${geo.rBase * 0.16}px 'Orbitron', sans-serif`
      c.fillStyle = `rgba(20,30,45,${alpha})`
      c.fillText(String(n), 0, 0)
      c.restore()
    }
  }

  // Draws text at the local origin with a horizontal "speed streak": the glyph slides
  // along its reading axis (slideX), stretches while moving fast (stretchX), and trails
  // faint motion-blur echoes behind it. Caller sets font + textAlign/baseline and the
  // translate/rotate placement. `speed` is the current motion magnitude (0 = parked).
  function drawStreakText(text: string, color: string, alpha: number, slideX: number, stretchX: number, speed: number, lineHeight = 0) {
    const c = ctx!
    if (alpha <= 0.01) return
    const lines = text.split('\n')
    const y0 = -((lines.length - 1) / 2) * lineHeight
    const fillLines = () => lines.forEach((ln, i) => c.fillText(ln, 0, y0 + i * lineHeight))
    if (speed > 0.04) {
      for (let g = 3; g >= 1; g--) {
        c.save()
        c.globalAlpha = alpha * 0.12 * (1 - (g - 1) / 3)
        c.translate(slideX + speed * geo.rBase * 0.25 * g, 0)
        c.scale(stretchX, 1)
        c.fillStyle = color
        fillLines()
        c.restore()
      }
    }
    c.save()
    c.globalAlpha = alpha
    c.translate(slideX, 0)
    c.scale(stretchX, 1)
    c.shadowColor = color
    c.shadowBlur = geo.rBase * 0.03
    c.fillStyle = color
    fillLines()
    c.restore()
  }

  // Celebratory "<TEAM> SCORES!" — zooms in fast from the side, holds, then streaks out.
  function drawScoreFlash() {
    if (!scoreFlash) return
    const c = ctx!
    const color = scoreFlash.team === 0 ? RED : BLUE
    const label = `${scoreFlash.team === 0 ? 'RED' : 'BLUE'} SCORES!`
    const p = clamp((phaseDuration - phaseTimer) / phaseDuration, 0, 1)
    const inP = clamp(p / 0.1, 0, 1)
    const outP = clamp((p - 0.88) / 0.12, 0, 1)
    const eIn = easeOutExpo(inP)
    const eOut = easeInExpo(outP)
    const slideX = (1 - eIn) * geo.rBase * 1.4 - eOut * geo.rBase * 1.9 // whoosh in → blast out
    const speed = 1 - eIn + eOut
    const stretchX = 1 + speed * 1.3 // motion-blur stretch along travel
    const alpha = Math.min(1, inP * 2) * (1 - outP)
    for (const pl of countdownPlacements()) {
      c.save()
      c.translate(pl.x, pl.y)
      c.rotate(pl.angle)
      c.textAlign = 'center'
      c.textBaseline = 'middle'
      c.font = `700 ${geo.rBase * 0.1}px 'Orbitron', sans-serif`
      drawStreakText(label, color, alpha, slideX, stretchX, speed)
      c.restore()
    }
  }

  // White wash over the ice — used for the goal celebration and the game-over banner.
  function drawScrim() {
    const c = ctx!
    c.save()
    roundRectPath(c, geo.left, geo.top, geo.pw, geo.ph, geo.cornerR)
    c.clip()
    c.fillStyle = 'rgba(255,255,255,0.7)'
    c.fillRect(0, 0, geo.W, geo.H)
    c.restore()
  }

  function drawWinner() {
    const c = ctx!
    drawScrim()

    const color = winner === 0 ? RED : BLUE
    const team = `${winner === 0 ? 'RED' : 'BLUE'}\nWINS!`
    const inT = clamp((nowMs - winStartMs) / 450, 0, 1)
    const e = easeOutExpo(inT) // fast zoom-in, then dead steady (no breathing)
    const slideX = (1 - e) * geo.rBase * 1.9 // streaks in from the side
    const speed = 1 - e
    const stretchX = 1 + speed * 1.6
    // the prompt only appears after the full celebration window, then fades in
    const promptIn = clamp((nowMs - winStartMs - GOAL_CELEBRATION_MS) / 400, 0, 1)
    const tapAlpha = (0.35 + 0.35 * (0.5 + 0.5 * Math.sin(nowMs / 600))) * promptIn // slow steady fade
    for (const p of countdownPlacements(0.34)) {
      c.save()
      c.translate(p.x, p.y)
      c.rotate(p.angle)
      c.textAlign = 'center'
      c.textBaseline = 'middle'
      // headline streaks in along its reading axis
      c.save()
      c.translate(0, -geo.rBase * 0.03)
      c.font = `700 ${geo.rBase * 0.16}px 'Orbitron', sans-serif`
      drawStreakText(team, color, e, slideX, stretchX, speed, geo.rBase * 0.17)
      c.restore()
      // steady prompt (fades in once the 5s celebration window has passed)
      c.fillStyle = `rgba(20,30,45,${tapAlpha})`
      c.font = `600 ${geo.rBase * 0.03}px 'Inter', sans-serif`
      c.fillText('Tap to play again', 0, geo.rBase * 0.18)
      c.restore()
    }
  }

  // READY lobby — mirrors the winner banner (scrim + double-sided headline + tap prompt) but
  // shows "READY" in TelemetryOS yellow. Reached on first launch and after a secret hold-reset.
  function drawReady() {
    const c = ctx!
    drawScrim()

    const inT = clamp((nowMs - readyStartMs) / 450, 0, 1)
    const e = easeOutExpo(inT) // fast zoom-in, then dead steady
    const slideX = (1 - e) * geo.rBase * 1.9 // streaks in from the side
    const speed = 1 - e
    const stretchX = 1 + speed * 1.6
    // prompt fades in shortly after the headline lands (no celebration window to wait on)
    const promptIn = clamp((nowMs - readyStartMs - 300) / 400, 0, 1)
    const tapAlpha = (0.35 + 0.35 * (0.5 + 0.5 * Math.sin(nowMs / 600))) * promptIn
    for (const p of countdownPlacements(0.34)) {
      c.save()
      c.translate(p.x, p.y)
      c.rotate(p.angle)
      c.textAlign = 'center'
      c.textBaseline = 'middle'
      c.save()
      c.translate(0, -geo.rBase * 0.03)
      c.font = `700 ${geo.rBase * 0.16}px 'Orbitron', sans-serif`
      drawStreakText('READY', TOS_YELLOW, e, slideX, stretchX, speed)
      c.restore()
      c.fillStyle = `rgba(20,30,45,${tapAlpha})`
      c.font = `600 ${geo.rBase * 0.03}px 'Inter', sans-serif`
      c.fillText('Tap to play', 0, geo.rBase * 0.18)
      c.restore()
    }
  }

  // While a dark-corner hot zone is pressed, fill its black wedge with a pulsing white glow that
  // brightens as it nears the HOLD_RESET_MS threshold ("appears and pulses white"). Invisible
  // at rest (drawn only for active holds).
  function drawCornerHolds() {
    if (cornerHolds.size === 0) return
    const c = ctx!
    const cs = corners()
    const pulse = 0.6 + 0.4 * Math.sin(nowMs / 140)
    for (const h of cornerHolds.values()) {
      const { acx, acy, a0, a1, scx, scy } = cs[h.corner]
      const t = clamp((nowMs - h.startMs) / HOLD_RESET_MS, 0, 1)
      const alpha = clamp((0.18 + 0.5 * t) * pulse, 0, 1)
      c.save()
      c.beginPath()
      c.moveTo(scx, scy) // screen corner vertex
      c.arc(acx, acy, geo.cornerR, a0, a1) // along the ice arc between the two edge tangent points
      c.closePath()
      c.fillStyle = `rgba(255,255,255,${alpha})`
      c.fill()
      c.restore()
    }
  }

  // ── input ────────────────────────────────────────────────────────────────────
  // All input is swallowed for the full 5s of a goal celebration and a game-over banner.
  function inputLocked(): boolean {
    if (phase === 'gameover') return nowMs - winStartMs < GOAL_CELEBRATION_MS
    return phase === 'celebrating'
  }

  function toLocal(e: PointerEvent): Matter.Vector {
    const rect = canvas.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function onDown(e: PointerEvent) {
    e.preventDefault()
    const pt = toLocal(e)
    // hidden secret reset: a press in any dark corner starts a hold (active in every phase,
    // even while input is otherwise locked). It never grabs a paddle.
    const corner = cornerAt(pt.x, pt.y)
    if (corner >= 0) {
      cornerHolds.set(e.pointerId, { corner, startMs: nowMs })
      try {
        canvas.setPointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
      return
    }
    if (inputLocked()) return
    if (phase === 'gameover') {
      reset() // "tap to play again" → back to the READY lobby
      return
    }
    if (phase === 'ready') {
      startGame()
      return
    }
    const i = halfAt(pt.x, pt.y)
    if ([...pointerOwner.values()].includes(i)) return // one finger per paddle
    pointerOwner.set(e.pointerId, i)
    targets[i] = clampToHalf(i, pt.x, pt.y)
    try {
      canvas.setPointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }

  function onMove(e: PointerEvent) {
    const hold = cornerHolds.get(e.pointerId)
    if (hold !== undefined) {
      // sliding the finger out of the corner's dark zone cancels the hold (button semantics)
      const pt = toLocal(e)
      if (cornerAt(pt.x, pt.y) !== hold.corner) cornerHolds.delete(e.pointerId)
      return
    }
    const i = pointerOwner.get(e.pointerId)
    if (i === undefined) return
    const pt = toLocal(e)
    targets[i] = clampToHalf(i, pt.x, pt.y)
  }

  function onUp(e: PointerEvent) {
    cornerHolds.delete(e.pointerId)
    const i = pointerOwner.get(e.pointerId)
    if (i === undefined) {
      try {
        canvas.releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
      return
    }
    pointerOwner.delete(e.pointerId)
    targets[i] = null
    try {
      canvas.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }

  // ── main loop ─────────────────────────────────────────────────────────────────
  const IDLE_FRAME_MS = 1000 / 15 // throttle target while the game-over screen sits idle
  const WIN_BANNER_SETTLE_MS = 450 // winner headline entrance length (see drawWinner) — after
  //                                  this only the slow "tap to play" prompt pulse remains
  let raf = 0
  let last = performance.now()
  let acc = 0
  let lastWork = 0
  function frame(now: number) {
    raf = requestAnimationFrame(frame)
    nowMs = now
    // Idle on the game-over screen: once the winner banner has settled, nothing moves but the
    // slow prompt pulse, so drop to ~15fps to cut power/heat. A tap still resets instantly
    // (handled in onDown, independent of this loop). rAF is already re-scheduled above.
    // A live corner-hold must animate its pulse + check the 2s timer every frame, so it
    // overrides the game-over idle throttle.
    const idle = phase === 'gameover' && now - winStartMs > WIN_BANNER_SETTLE_MS && cornerHolds.size === 0
    if (idle && now - lastWork < IDLE_FRAME_MS) return
    lastWork = now
    let dt = now - last
    last = now
    if (dt > 100) dt = 100 // clamp after tab/visibility stalls
    acc += dt
    let steps = 0
    while (acc >= PHYS_DT && steps < 5) {
      step()
      acc -= PHYS_DT
      steps++
    }
    if (steps === 5) acc = 0
    draw()
  }

  // ── bootstrap ─────────────────────────────────────────────────────────────────
  buildWorld()
  rebuildStatics()
  reset()
  Events.on(engine, 'collisionStart', onBrickCollision)
  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerup', onUp)
  canvas.addEventListener('pointercancel', onUp)
  raf = requestAnimationFrame(frame)

  return {
    resize() {
      // Rebuild geometry/bodies for the new size WITHOUT disturbing match state
      // (phase, countdown timer, score celebration, winner all preserved). buildWorld
      // re-seats the puck at the current face-off spot; gameover parks it at center.
      geo = computeGeo()
      buildWorld()
      rebuildStatics() // re-bake rink + sprites for the new dimensions/orientation
      if (phase === 'gameover') {
        Body.setPosition(puck, { x: geo.cx, y: geo.cy })
        Body.setVelocity(puck, { x: 0, y: 0 })
      }
    },
    reset,
    destroy() {
      cancelAnimationFrame(raf)
      Events.off(engine, 'collisionStart', onBrickCollision)
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
      Composite.clear(engine.world, false, true)
      Engine.clear(engine)
    },
    getState() {
      return {
        scores: [scores[0], scores[1]],
        phase,
        winner,
        portrait: geo.portrait,
        phaseTimer: Math.round(phaseTimer),
        celebrating: scoreFlash ? scoreFlash.team : null,
        holding: cornerHolds.size > 0,
      }
    },
    debugSetScore(p1: number, p2: number) {
      scores[0] = p1
      scores[1] = p2
      if (p1 >= WIN_SCORE) {
        winner = 0
        phase = 'gameover'
        winStartMs = nowMs
      } else if (p2 >= WIN_SCORE) {
        winner = 1
        phase = 'gameover'
        winStartMs = nowMs
      }
    },
    debugGoal(team: 0 | 1) {
      onGoal(team)
    },
    debugBricks(team: 0 | 1) {
      spawnBricks(team)
    },
  }
}
