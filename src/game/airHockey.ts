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

const { Engine, Bodies, Body, Composite } = Matter

// ── Tunables ─────────────────────────────────────────────────────────────────
const WIN_SCORE = 3
const PHYS_DT = 1000 / 60 // fixed physics step (ms)
const COUNTDOWN_MS = 1500 // pre-play countdown (3 → 2 → 1)
const GOAL_CELEBRATION_MS = 2000 // "<TEAM> SCORES!" / win celebration hold (scrim + input lock)
const STUCK_MS = 2000 // re-face-off if the puck idles in the unreachable neutral band

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

type Phase = 'celebrating' | 'countdown' | 'playing' | 'gameover'

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
  }
  debugSetScore(p1: number, p2: number): void
  /** Dev/test helper: drive a real goal through the scoring path (so it broadcasts). */
  debugGoal(team: 0 | 1): void
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
  const paddleSprites: ({ canvas: HTMLCanvasElement; size: number } | null)[] = [null, null]
  let geo: Geo = computeGeo()
  let puck: Matter.Body
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

  // animation clocks (wall-clock ms, refreshed each frame)
  let nowMs = performance.now()
  let scoreFlash: { team: 0 | 1; startMs: number } | null = null // "<TEAM> SCORES!" celebration
  let winStartMs = 0 // when the win banner began (entrance anim)
  const scorePulseAt: [number, number] = [-1e9, -1e9] // per-team scoreboard pop timestamps

  // paddle finger targets (null = released); one pointer owns one paddle
  const targets: (Matter.Vector | null)[] = [null, null]
  const pointerOwner = new Map<number, number>()

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

  // ── world construction ────────────────────────────────────────────────────
  function buildWorld() {
    Composite.clear(engine.world, false, true)
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
    puck = Bodies.circle(fo.x, fo.y, geo.puckR, {
      restitution: 0.98,
      friction: 0,
      frictionStatic: 0,
      frictionAir: 0.006,
      density: 0.002,
    })
    Composite.add(engine.world, puck)

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

  // ── match flow ──────────────────────────────────────────────────────────────
  // Face-off: drop the puck STILL. It only moves once struck. A new game faces off
  // dead center; post-goal (and re-drops) sit on the receiving player's blue line.
  function resetPuck(toward: 0 | 1, duration = COUNTDOWN_MS, center = false) {
    scoreFlash = null
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
    scores[scorer]++
    scorePulseAt[scorer] = nowMs // pop the scoreboard digit
    const team: 'red' | 'blue' = scorer === 0 ? 'red' : 'blue'
    onEvent?.({ type: 'goal', team, red: scores[0], blue: scores[1] })
    if (scores[scorer] >= WIN_SCORE) {
      winner = scorer
      winStartMs = nowMs
      phase = 'gameover'
      Body.setPosition(puck, { x: geo.cx, y: geo.cy })
      Body.setVelocity(puck, { x: 0, y: 0 })
      onEvent?.({ type: 'win', team, red: scores[0], blue: scores[1] })
    } else {
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

  function checkGoals() {
    const { left, right, top, bottom, cx, cy, goalLen, puckR } = geo
    const { x, y } = puck.position
    let scorer = -1
    if (!geo.portrait) {
      const inMouth = Math.abs(y - cy) < goalLen / 2
      if (x < left - puckR && inMouth) scorer = 1 // into left (RED) goal → BLUE scores
      else if (x > right + puckR && inMouth) scorer = 0 // into right (BLUE) goal → RED scores
    } else {
      const inMouth = Math.abs(x - cx) < goalLen / 2
      if (y > bottom + puckR && inMouth) scorer = 1 // into bottom (RED) goal → BLUE scores
      else if (y < top - puckR && inMouth) scorer = 0 // into top (BLUE) goal → RED scores
    }
    if (scorer >= 0) {
      onGoal(scorer)
      return
    }
    // failsafe: puck escaped without a valid goal — face off again
    if (x < left - geo.pw * 0.2 || x > right + geo.pw * 0.2 || y < top - geo.ph * 0.2 || y > bottom + geo.ph * 0.2) {
      resetPuck(serveToward)
    }
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

  function reset() {
    scores[0] = 0
    scores[1] = 0
    winner = -1
    paddles.forEach((p, i) => {
      Body.setPosition(p, homePos(i))
      Body.setVelocity(p, { x: 0, y: 0 })
    })
    targets[0] = null
    targets[1] = null
    resetPuck(serveToward, COUNTDOWN_MS, true) // new game: puck dead center
  }

  // ── per-frame simulation ────────────────────────────────────────────────────
  function step() {
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
      if (tgt && phase !== 'gameover' && phase !== 'celebrating') {
        let vx = (tgt.x - p.position.x) * 0.7
        let vy = (tgt.y - p.position.y) * 0.7
        const maxv = geo.rBase * 0.08
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

    // keep paddles inside their halves even after puck impacts
    for (let i = 0; i < 2; i++) {
      const p = paddles[i]
      const c = clampToHalf(i, p.position.x, p.position.y)
      if (c.x !== p.position.x || c.y !== p.position.y) Body.setPosition(p, c)
    }

    // cap puck speed to prevent tunneling through rails / goal posts
    const ps = Math.hypot(puck.velocity.x, puck.velocity.y)
    const maxp = geo.rBase * 0.03
    if (ps > maxp) {
      Body.setVelocity(puck, { x: (puck.velocity.x / ps) * maxp, y: (puck.velocity.y / ps) * maxp })
    }

    if (phase === 'playing') {
      checkGoals()
      checkStuck()
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
    drawPuck()
    drawPaddle(0)
    drawPaddle(1)

    if (phase === 'countdown') drawCountdown()
    else if (phase === 'celebrating') {
      drawScrim()
      drawScoreFlash()
    } else if (phase === 'gameover') drawWinner()
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

  // Puck and paddles blit their pre-rendered sprites (gradient + shadow baked once per size)
  // centered on the body position — no per-frame gradient/shadow-blur.
  function drawPuck() {
    if (!puckSprite) return
    const half = puckSprite.size / 2
    ctx!.drawImage(puckSprite.canvas, puck.position.x - half, puck.position.y - half, puckSprite.size, puckSprite.size)
  }

  function drawPaddle(i: number) {
    const sp = paddleSprites[i]
    if (!sp) return
    const p = paddles[i]
    const half = sp.size / 2
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
    if (inputLocked()) return
    if (phase === 'gameover') {
      reset()
      return
    }
    const pt = toLocal(e)
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
    const i = pointerOwner.get(e.pointerId)
    if (i === undefined) return
    const pt = toLocal(e)
    targets[i] = clampToHalf(i, pt.x, pt.y)
  }

  function onUp(e: PointerEvent) {
    const i = pointerOwner.get(e.pointerId)
    if (i === undefined) return
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
    const idle = phase === 'gameover' && now - winStartMs > WIN_BANNER_SETTLE_MS
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
  }
}
