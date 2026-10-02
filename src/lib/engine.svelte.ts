/**
 * 화면 읽기 → 상태 추적 → 추천 계산을 잇는 가운데 상태.
 *
 * 화면은 계속 바뀐다(커서, 배치 미리보기, 줄 강조, 게임 오버 창). 그래서
 *  - 미리보기·강조가 떠 있는 프레임은 버리고
 *  - 커서에 가린 칸은 직전 값을 쓰고
 *  - 같은 결과가 두 번 연속 나와야 확정한다.
 * 확정된 상태가 바뀌었을 때만 추천을 다시 계산한다. 조각을 회전만 한 경우나
 * 추천대로 한 단계를 놓은 경우에는 계산을 다시 하지 않고 다음 단계로 넘어간다.
 */
import { boardKey, canonicalKey, COLS, emptyBoard, orientations, ROWS, type Board, type Icon, type Shape } from './core/board'
import { defaultWeights, identify, stageOf, type PieceDef } from './core/pieces'
import type { Plan, Step } from './core/solver'
import { ScreenSource, regionOf, frameFromBlob, type Frame } from './capture'
import { detectGrid, readBoard, readCards, type CardRead, type Grid } from './vision/read'
import type { SolveRequest, SolveResponse } from './solver.worker'
import SolverWorker from './solver.worker?worker'

export type Status = 'idle' | 'searching' | 'live' | 'busy' | 'obscured' | 'image'

export interface HandCard {
  state: CardRead['state']
  selected: boolean
  shape: Shape | null
  piece: PieceDef | null
}

const PREFS_KEY = 'moamoa.prefs.v1'

interface Prefs { style: number; swaps: number; dots: number; lines: number }

function loadPrefs(): Prefs {
  const d: Prefs = { style: 0.2, swaps: 0, dots: 0, lines: 0 }
  try { return { ...d, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') } } catch { return d }
}

class Engine {
  status = $state<Status>('idle')
  capturing = $state(false)
  error = $state<string | null>(null)
  grid = $state<Grid | null>(null)

  board = $state<Board>(emptyBoard())
  icons = $state<Icon[]>([])
  hand = $state<HandCard[]>([])
  /** 마지막으로 확정한 시각 */
  updatedAt = $state(0)

  plans = $state<Plan[]>([])
  planIdx = $state(0)
  /** 지금 안내 중인 단계 (0부터) */
  stepIdx = $state(0)
  solving = $state(false)
  solveMs = $state(0)

  style = $state(0.2)
  swaps = $state(0)
  dots = $state(0)
  lines = $state(0)

  /** 디버그 미리보기용: 마지막으로 읽은 프레임 */
  lastFrame = $state.raw<Frame | null>(null)
  fps = $state(0)

  private source: ScreenSource | null = null
  private timer = 0
  private pendingSig = ''
  private pendingCount = 0
  private stableSig = ''
  private badFrames = 0
  private oddFrames = 0
  private worker: Worker | null = null
  private reqId = 0
  private solvedFor = ''

  constructor() {
    const p = loadPrefs()
    this.style = p.style
    this.swaps = p.swaps
    this.dots = p.dots
    this.lines = p.lines
    $effect.root(() => {
      $effect(() => {
        const prefs: Prefs = { style: this.style, swaps: this.swaps, dots: this.dots, lines: this.lines }
        try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)) } catch { /* 사생활 보호 모드 */ }
      })
    })
  }

  get plan(): Plan | null { return this.plans[this.planIdx] ?? null }
  get stage() { return stageOf(this.lines) }
  get live() { return this.capturing }

  // ─── 입력 ────────────────────────────────────────────────────────────

  async startCapture() {
    this.error = null
    try {
      this.source = await ScreenSource.start()
    } catch (e) {
      const err = e as DOMException
      this.error = err.name === 'NotAllowedError' ? '화면 공유를 취소했어요.' : `화면 공유를 시작하지 못했어요: ${err.message}`
      return
    }
    this.source.onEnded = () => this.stopCapture()
    this.capturing = true
    this.grid = null
    this.status = 'searching'
    this.loop()
  }

  stopCapture() {
    this.timerHost.clearTimeout(this.timer)
    clearTimeout(this.timer)
    this.source?.stop()
    this.source = null
    this.capturing = false
    this.status = this.updatedAt ? 'image' : 'idle'
  }

  /** 스크린샷 한 장으로 해 보기 (붙여넣기·끌어다 놓기) */
  async loadImage(blob: Blob) {
    this.error = null
    const frame = await frameFromBlob(blob)
    const g = detectGrid(frame.image)
    if (!g) { this.error = '이미지에서 게임판을 찾지 못했어요. 모아모아 창 전체가 보이게 캡처해 주세요.'; return }
    this.grid = g
    this.lastFrame = frame
    this.stableSig = ''
    this.ingest(frame, g, 1)
    if (!this.live) this.status = 'image'
  }

  /**
   * 타이머는 PiP 창이 열려 있으면 그 창의 것을 쓴다. 게임을 보는 동안 원래 탭은 뒤에 있어서
   * 브라우저가 타이머를 1초에 한 번으로 늦추지만, 늘 보이는 PiP 창은 그러지 않는다.
   */
  timerHost: Window = window

  /** PiP 창이 열리고 닫힐 때 타이머를 옮겨 단다. 닫힌 창에 걸어 둔 타이머는 영영 안 울린다 */
  setTimerHost(win: Window) {
    this.timerHost.clearTimeout(this.timer)
    this.timerHost = win
    if (this.source) this.timer = win.setTimeout(this.loop, 0)
  }

  private loop = async () => {
    const t0 = performance.now()
    try { await this.tick() } catch (e) { console.error(e) }
    if (!this.source) return
    const spent = performance.now() - t0
    this.fps = Math.round(1000 / Math.max(spent, 200))
    // 시간 제한이 없는 게임이라 초당 4~5번이면 충분하다
    this.timer = this.timerHost.setTimeout(this.loop, Math.max(60, 220 - spent))
  }

  private async tick() {
    const src = this.source
    if (!src) return
    if (!this.grid) {
      const full = await src.grab()
      if (!full) return
      const g = detectGrid(full.image)
      if (!g) { this.status = 'searching'; this.lastFrame = full; return }
      this.grid = { x: g.x + full.ox, y: g.y + full.oy, pitch: g.pitch }
    }
    const g = this.grid
    const frame = await src.grab(regionOf(g))
    if (!frame || !this.source) return
    this.lastFrame = frame
    const local: Grid = { x: g.x - frame.ox, y: g.y - frame.oy, pitch: g.pitch }
    this.ingest(frame, local, 2)
  }

  /** 프레임 하나를 읽어서, 같은 결과가 need번 이어지면 확정한다 */
  private ingest(frame: Frame, g: Grid, need: number) {
    const br = readBoard(frame.image, g)
    const cards = readCards(frame.image, g)
    if (br.obscured) {
      this.status = 'obscured'
      // 오래 가려져 있으면 창이 움직였을 수도 있다. 다시 찾는다
      if (++this.badFrames > 15 && this.live) { this.grid = null; this.badFrames = 0 }
      return
    }
    this.badFrames = 0
    if (br.busy) { this.status = 'busy'; return }
    if (cards.some((c) => c.state === 'unknown')) { this.status = 'busy'; return }
    // 회전 버튼을 누를 때 커서가 카드 위에 겹치면 모양이 틀리게 읽힌다. 19종에 없는 모양은
    // 일단 믿지 않는다. 목록에 없는 새 조각일 수도 있으니 오래 그대로면 받아들인다
    if (cards.some((c) => c.state === 'piece' && !identify(c.shape!))) {
      if (++this.oddFrames < 12) { this.status = 'busy'; return }
    } else this.oddFrames = 0

    // 커서에 가린 칸은 직전 값
    const board = br.board.slice()
    for (const i of br.cursor) {
      const r = Math.floor(i / COLS), c = i % COLS
      if ((this.board[r] >> c) & 1) board[r] |= 1 << c
    }
    const icons = [...br.icons]
    for (const i of br.cursor) {
      const r = Math.floor(i / COLS), c = i % COLS
      const prev = this.icons.find((ic) => ic.r === r && ic.c === c)
      if (prev) icons.push(prev)
    }
    const sig = boardKey(board) + '|' + icons.map((i) => `${i.r},${i.c}`).join(';') + '|' +
      cards.map((c) => (c.state === 'used' ? 'U' : c.shape!.key)).join('/')
    if (sig === this.pendingSig) this.pendingCount++
    else { this.pendingSig = sig; this.pendingCount = 1 }
    if (this.status !== 'image') this.status = 'live'
    // 선택 상태(노란 카드)는 확정 조건에 넣지 않지만 화면에는 바로 보여 준다
    this.hand = this.hand.map((h, i) => ({ ...h, selected: cards[i]?.selected ?? false }))
    if (this.pendingCount < need || sig === this.stableSig) return
    this.stableSig = sig
    this.commit(board, icons, cards)
  }

  private commit(board: Board, icons: Icon[], cards: CardRead[]) {
    const prev = this.board
    const prevIcons = this.icons
    // 지워진 줄 세기: 차 있던 줄이 통째로 비었다
    let cleared = 0
    const clearedRows: number[] = []
    for (let r = 0; r < ROWS; r++) if (prev[r] && !board[r] && this.updatedAt) { cleared++; clearedRows.push(r) }
    if (cleared && cleared <= 5) {
      this.lines += cleared
      for (const ic of prevIcons) {
        if (!clearedRows.includes(ic.r)) continue
        if (this.swaps + this.dots >= 7) continue
        if (ic.kind === 'dot') this.dots++
        else this.swaps++
      }
    }

    this.board = board
    this.icons = icons
    this.hand = cards.map((c) => ({
      state: c.state, selected: c.selected, shape: c.shape,
      piece: c.shape ? identify(c.shape) : null,
    }))
    this.updatedAt = Date.now()
    this.decide()
  }

  // ─── 추천 ────────────────────────────────────────────────────────────

  /** 이미 있는 계획으로 설명이 되면 단계만 넘기고, 아니면 새로 계산한다 */
  private decide() {
    const plan = this.plan
    const key = this.situationKey()
    if (plan && !plan.incomplete) {
      // 추천대로 k번째까지 놓았다
      const used = this.hand.map((h) => h.state === 'used')
      for (let k = 0; k < plan.steps.length; k++) {
        const st = plan.steps[k]
        const doneSlots = plan.steps.slice(0, k + 1).map((s) => s.slot)
        if (boardKey(st.boardAfter) === boardKey(this.board) && doneSlots.every((s) => used[s])) {
          this.stepIdx = k + 1
          return
        }
      }
      // 같은 판, 같은 조각인데 회전만 바뀌었다
      if (key === this.solvedFor) return
    }
    this.requestSolve(key)
  }

  private situationKey() {
    return boardKey(this.board) + '|' + this.icons.map((i) => `${i.r},${i.c}`).join(';') + '|' +
      this.hand.map((h) => (h.shape ? canonicalKey(h.shape) : 'U')).join('/') + '|' + this.style.toFixed(2)
  }

  resolve() {
    this.requestSolve(this.situationKey())
  }

  private requestSolve(key: string) {
    const hand = this.hand.map((h) => (h.state === 'piece' ? h.shape : null))
    if (!hand.some(Boolean)) { this.plans = []; return }
    this.worker ??= this.makeWorker()
    const id = ++this.reqId
    this.solving = true
    this.solvedFor = key
    const req: SolveRequest = {
      id,
      input: {
        board: $state.snapshot(this.board), icons: $state.snapshot(this.icons), hand: $state.snapshot(hand) as (Shape | null)[],
        heldAbilities: this.swaps + this.dots, weights: defaultWeights(this.stage), style: this.style,
      },
    }
    this.worker.postMessage(req)
  }

  private makeWorker() {
    const w = new SolverWorker()
    w.onmessage = (e: MessageEvent<SolveResponse>) => {
      if (e.data.id !== this.reqId) return
      this.plans = e.data.plans
      this.planIdx = 0
      this.stepIdx = 0
      this.solving = false
      this.solveMs = Math.round(e.data.ms)
    }
    return w
  }

  /** 지금 화면에 보이는 카드 모양에서 목표 모양까지의 버튼 조작 */
  turnsFor(step: Step): { flip: boolean; rot: number; ok: boolean } | null {
    const cur = this.hand[step.slot]?.shape
    if (!cur) return null
    const o = orientations(cur).find((x) => x.shape.key === step.shape.key)
    if (!o) return null
    return { flip: o.flip, rot: o.rot, ok: !o.flip && o.rot === 0 }
  }

  setStyle(v: number) {
    this.style = v
    this.resolve()
  }
}

export const engine = new Engine()
