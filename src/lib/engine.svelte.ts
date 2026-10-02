/**
 * 화면 읽기 → 상태 추적 → 추천 계산을 잇는 가운데 상태.
 *
 * 추천은 세트(카드 3장)를 처음 읽었을 때 한 번 계산하고 고정한다. 그 뒤로는
 *  - 판이 손의 조각 하나를 놓은 결과로 바뀌면 그 조각을 '사용'으로 표시하고
 *    추천대로였으면 다음 단계로, 아니면 남은 조각으로 다시 계산한다
 *  - 커서·반짝임·미리보기로 흔들린 판은 어떤 배치로도 설명되지 않아서 무시된다
 *  - 세 조각을 다 놓으면 새 카드 3장을 기다린다
 * 점 찍기(1칸)와 바꿔 뽑기(카드가 다른 조각으로 바뀜)도 알아채서 그때만 다시 계산한다.
 */
import { ABILITY_SCORE, canPlace, place, popcount, boardKey, canonicalKey, COLS, emptyBoard, lineScore, orientations, ROWS, type Board, type Icon, type Shape } from './core/board'
import { explainMove, type Move } from './core/track'
import { identify, stageOf, type PieceDef } from './core/pieces'
import { blendedWeights, loadCounts, loadGames, newGame, record, saveCounts, saveGames, seenIn, type Counts, type GameHistory, type GameLog } from './core/stats'
import type { Plan, Rescue, Step } from './core/solver'
import { ScreenSource, regionOf, frameFromBlob, type Frame } from './capture'
import { detectGrid, isFilledState, isIconState, readBoard, readCards, type CardRead, type CellState, type Grid } from './vision/read'
import type { SolveRequest, SolveResponse } from './solver.worker'
import SolverWorker from './solver.worker?worker'

export type Status = 'idle' | 'searching' | 'live' | 'busy' | 'obscured' | 'image'

export interface HandCard {
  /** 'used'는 화면이 아니라 추적 결과다: 이 세트에서 이미 놓은 카드 */
  state: 'piece' | 'used'
  selected: boolean
  /** 지금 화면에 보이는 방향 */
  shape: Shape | null
  piece: PieceDef | null
}

const PREFS_KEY = 'moamoa.prefs.v1'

interface Prefs { style: number; swaps: number; dots: number; lines: number; thinkMs: number }

function loadPrefs(): Prefs {
  const d: Prefs = { style: 0.2, swaps: 0, dots: 0, lines: 0, thinkMs: 1500 }
  try { return { ...d, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') } } catch { return d }
}

const cardSig = (cards: CardRead[]) => cards.map((c) => (c.state === 'piece' && c.shape ? c.shape.key : c.state)).join('/')

class Engine {
  status = $state<Status>('idle')
  capturing = $state(false)
  error = $state<string | null>(null)
  grid = $state<Grid | null>(null)

  board = $state<Board>(emptyBoard())
  icons = $state<Icon[]>([])
  hand = $state<HandCard[]>([])
  /** 마지막으로 상태를 맞춘 시각. 0이면 아직 한 번도 못 읽었다 */
  updatedAt = $state(0)

  plans = $state<Plan[]>([])
  /** 다 못 놓을 때 능력으로 살리는 방법 */
  rescue = $state<Rescue | null>(null)
  planIdx = $state(0)
  /** 지금 안내 중인 단계 (0부터) */
  stepIdx = $state(0)
  solving = $state(false)
  /** 마지막 계산을 시작한 까닭 */
  solveReason = $state('')
  /** 최근 일어난 일 (인식 화면 보기에 보여 준다. 문제를 제보받을 때 원인을 찾는 용도) */
  events = $state<{ t: number; what: string; detail: string }[]>([])
  private log(what: string, detail = '') {
    this.events = [{ t: Date.now(), what, detail }, ...this.events].slice(0, 30)
  }

  /** 계산 진행률 0~1 */
  progress = $state(0)
  solveMs = $state(0)
  /** 세트마다 계산에 쓸 시간 */
  thinkMs = $state(1500)

  style = $state(0.2)
  swaps = $state(0)
  dots = $state(0)
  lines = $state(0)
  /**
   * 다음 능력 아이콘까지 남은 배치 수 (게임 화면의 '다음 능력 획득까지 N번').
   * 조각을 7번 놓을 때마다 아이콘이 생긴다. 점 찍기는 세지 않는다. 모르면 null이고,
   * 새 아이콘이 나타나는 순간 7로 맞춘다.
   */
  nextAbility = $state<number | null>(null)
  get held() { return this.swaps + this.dots }

  /** 실제로 나온 조각 수 (단계별) */
  pieceCounts = $state<Counts>(loadCounts())
  /** 판별 기록 (지금 판 + 지난 판들) */
  games = $state<GameHistory>(loadGames())

  /** 지금 판 기록을 고친다. 없으면 (중간부터 공유한 것으로 보고) 새로 연다 */
  private logGame(fn: (g: GameLog) => void) {
    if (!this.live) return
    const g = this.games.current ?? newGame(false)
    fn(g)
    g.end = Date.now()
    this.games = { ...this.games, current: { ...g } }
    saveGames(this.games)
  }

  private startGame() {
    if (!this.live) return
    const past = this.games.current && this.games.current.pieces > 0 ? [this.games.current, ...this.games.past].slice(0, 200) : this.games.past
    this.games = { current: newGame(true), past }
    saveGames(this.games)
  }

  resetGames() {
    this.games = { current: null, past: [] }
    saveGames(this.games)
  }
  get seenThisStage() { return seenIn(this.pieceCounts, this.stage) }

  /** 디버그 미리보기용: 마지막으로 읽은 프레임 */
  lastFrame = $state.raw<Frame | null>(null)
  fps = $state(0)

  private source: ScreenSource | null = null
  private timer = 0
  private badFrames = 0
  private worker: Worker | null = null
  private reqId = 0

  constructor() {
    const p = loadPrefs()
    this.style = p.style
    this.swaps = p.swaps
    this.dots = p.dots
    this.lines = p.lines
    this.thinkMs = p.thinkMs
    $effect.root(() => {
      $effect(() => {
        const prefs: Prefs = { style: this.style, swaps: this.swaps, dots: this.dots, lines: this.lines, thinkMs: this.thinkMs }
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
    this.reset()
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
    this.reset()
    this.ingest(frame, g, false)
  }

  private reset() {
    this.updatedAt = 0
    this.iconTrack.clear()
    this.keys = {}
    this.counts = {}
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
    this.fps = Math.round(1000 / Math.max(spent, 140))
    // 놓은 뒤 0.3초 안에 다음 단계로 넘어가도록 초당 6~7번 읽는다
    this.timer = this.timerHost.setTimeout(this.loop, Math.max(40, 140 - spent))
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
    this.ingest(frame, local, true)
  }

  // ─── 추적 ────────────────────────────────────────────────────────────

  /**
   * 프레임 하나를 읽는다. live면 같은 결과가 두 번 이어져야 믿고, 스크린샷 한 장이면 바로 믿는다.
   *
   * 세트 진행 중에는 판이 '손의 조각 하나를 놓은 결과'로 바뀔 때만 따라간다. 설명되지 않는 판이
   * 한참 그대로면(시작 직후, 놓친 배치 등) 그때 화면대로 다시 맞춘다.
   */
  private ingest(frame: Frame, g: Grid, live: boolean) {
    const br = readBoard(frame.image, g)
    const cards = readCards(frame.image, g)
    if (br.obscured) {
      this.status = 'obscured'
      // 오래 가려져 있으면 창이 움직였을 수도 있다. 다시 찾는다
      if (++this.badFrames > 20 && live) { this.grid = null; this.badFrames = 0 }
      return
    }
    this.badFrames = 0
    // 선택 표시(노란 카드)는 확정과 상관없이 바로 보여 준다
    if (this.hand.length === 3 && cards.some((c, i) => c.selected !== this.hand[i].selected)) {
      this.hand = this.hand.map((h, i) => ({ ...h, selected: cards[i].selected }))
    }
    if (br.busy) { this.status = 'busy'; return }
    this.status = live ? 'live' : 'image'

    // 커서·못 읽은 칸은 직전 값을 쓰고 '모름'으로 표시해 둔다. 판 변화를 풀 때 그 칸은 어느 쪽이든 맞는 것으로 본다
    const B = new Array<number>(ROWS).fill(0)
    const unsure = new Array<number>(ROWS).fill(0)
    br.cells.forEach((st, i) => {
      const r = Math.floor(i / COLS), c = i % COLS
      // 아이콘 칸도 '모름'이다. 아이콘이 반짝이면 밑이 블록인지 빈칸인지 프레임마다 다르게 읽힌다.
      // 그 칸이 바뀌는 건 조각을 놓거나 줄이 지워질 때뿐이고, 그때는 다른 칸도 함께 바뀌어서 그걸로 안다
      if (st === 'cursor' || st === 'unknown' || isIconState(st)) {
        unsure[r] |= 1 << c
        const known = this.updatedAt ? (this.board[r] >> c) & 1 : isFilledState(st) ? 1 : 0
        if (known) B[r] |= 1 << c
      } else if (isFilledState(st)) B[r] |= 1 << c
    })
    this.trackIcons(br.cells, B, live ? 2 : 1)
    this.lastUnsure = unsure

    const need = live ? 2 : 1
    const cardsReadable = cards.every((c) => c.state !== 'unknown')
    if (!this.updatedAt) {
      if (cardsReadable && this.steady('init', boardKey(B) + cardSig(cards), need)) this.resync(B, cards)
      return
    }

    const key = boardKey(B)
    if (key !== boardKey(this.board)) {
      if (!this.steady('board', key, need)) return
      const remaining = this.hand.flatMap((h, slot) => (h.state === 'piece' && h.shape ? [{ slot, shape: h.shape }] : []))
      // 점 찍기는 갖고 있을 때만 후보로 둔다. 아니면 한 칸짜리 잘못 읽음을 점 찍기로 오해한다
      const mv = explainMove(this.board, B, remaining, this.dots > 0, unsure)
      if (mv) { this.applyMove(mv, mv.board); return }
      // 어떤 배치로도 설명이 안 되는 판이 1.5초 넘게 그대로면 화면을 믿는다
      if (this.counts.board >= (live ? 10 : 1) && cardsReadable) {
        let diff = 0
        for (let r = 0; r < ROWS; r++) diff += popcount((B[r] ^ this.board[r]) & ~unsure[r])
        if (live) this.log('설명 안 되는 판', `기억과 ${diff}칸 다름`)
        this.resync(B, cards)
      }
      return
    }
    this.keys.board = ''
    this.watchCards(cards, need)
  }

  /** 같은 값이 need번 이어졌는지 */
  private keys: Record<string, string> = {}
  private counts: Record<string, number> = {}
  private steady(name: string, key: string, need: number) {
    if (this.keys[name] === key) this.counts[name]++
    else { this.keys[name] = key; this.counts[name] = 1 }
    return this.counts[name] >= need
  }

  /** 판은 그대로인데 카드가 바뀌었다: 회전·반전, 새 세트, 바꿔 뽑기 */
  private watchCards(cards: CardRead[], need: number) {
    const ok = (c: CardRead) => c.state === 'piece' && !!c.shape && !!identify(c.shape)
    const setDone = this.hand.length !== 3 || this.hand.every((h) => h.state === 'used')
    if (setDone) {
      if (cards.every(ok) && this.steady('set', cardSig(cards), need)) this.newSet(cards)
      return
    }

    // 판은 그대로인데 게임 카드가 '사용 완료'가 됐다 → 판에서 안 보이는 칸(아이콘·커서 밑)에 놓았다.
    // 대표적으로 1칸 조각을 아이콘 칸에 넣은 경우다
    for (let i = 0; i < 3; i++) {
      if (this.hand[i].state === 'piece' && cards[i].state === 'used' && this.steady(`gone${i}`, 'used', need)) {
        if (!this.placeHidden([i])) this.log('안 보이는 배치를 못 찾음', `${i + 1}번 카드`)
        return
      }
    }
    // 이미 놓은 카드 자리에 새 조각이 떴다 → 새 세트다. 남은 조각도 모두 놓였다는 뜻이다
    // (바꿔 뽑기는 아직 안 놓은 카드만 바꾼다)
    if (this.hand.some((h, i) => h.state === 'used' && ok(cards[i])) && cards.every(ok)) {
      if (!this.steady('set', cardSig(cards), need)) return
      const left = this.hand.flatMap((h, i) => (h.state === 'piece' ? [i] : []))
      if (left.length && !this.placeHidden(left)) this.log('안 보이는 배치를 못 찾음', left.map((i) => `${i + 1}번`).join(','))
      this.newSet(cards)
      return
    }
    let changed = false, swapped = false
    const hand = this.hand.map((h, i) => {
      const c = cards[i]
      if (h.state !== 'piece' || !h.shape || !ok(c)) return h
      if (canonicalKey(c.shape!) === canonicalKey(h.shape)) {
        this.keys[`swap${i}`] = ''
        // 돌리기만 했다. 계획은 그대로, 버튼 안내만 바뀐다
        if (c.shape!.key !== h.shape.key) { changed = true; return { ...h, shape: c.shape } }
        return h
      }
      // 다른 조각이 됐다: 바꿔 뽑기. 커서 겹침으로 잘못 읽은 것과 구별하려고 조금 더 기다린다
      if (!this.steady(`swap${i}`, canonicalKey(c.shape!), need + 2)) return h
      changed = swapped = true
      return { ...h, shape: c.shape, piece: identify(c.shape!) }
    })
    if (!changed) return
    this.hand = hand
    if (swapped) {
      this.swaps = Math.max(0, this.swaps - 1)
      this.logGame((g) => g.swapsUsed++)
      this.requestSolve('바꿔 뽑기를 써서')
    }
  }

  /** 마지막 프레임에서 못 읽은 칸 (아이콘·커서 밑) */
  private lastUnsure: Board = new Array(ROWS).fill(0)

  /**
   * 판에 드러나지 않게 놓인 조각들을 안 보이는 칸 안에서 찾아 채운다.
   * 계획에 그 카드의 단계가 있고 자리가 맞으면 그 자리를 먼저 쓴다.
   */
  private placeHidden(slots: number[]): boolean {
    for (const slot of slots) {
      const h = this.hand[slot]
      if (!h.shape) return false
      const planned = this.plan?.steps.find((s) => s.slot === slot)
      let mv: Move | null = null
      if (planned && canPlace(this.board, planned.shape, planned.r, planned.c)) {
        // 추천한 자리가 통째로 안 보이는 칸 안이면 그 자리다
        let hidden = true
        for (let i = 0; i < planned.shape.h; i++) {
          const bits = planned.shape.rows[i] << planned.c
          if ((bits & ~this.lastUnsure[planned.r + i]) !== 0) hidden = false
        }
        if (hidden) {
          const res = place(this.board, planned.shape, planned.r, planned.c)
          if (!res.cleared.length) mv = { slot, shape: planned.shape, r: planned.r, c: planned.c, cleared: [], board: res.board }
        }
      }
      mv ??= explainMove(this.board, this.board, [{ slot, shape: h.shape }], false, this.lastUnsure)
      if (!mv) return false
      this.log('안 보이는 칸에 놓음', `${slot + 1}번 카드 ↓${mv.r + 1}행 →${mv.c + 1}열`)
      this.applyMove(mv, mv.board)
    }
    return true
  }

  private newSet(cards: CardRead[]) {
    this.hand = cards.map((c) => ({ state: 'piece', selected: c.selected, shape: c.shape, piece: c.shape ? identify(c.shape) : null }))
    // 실시간으로 새 세트를 볼 때만 센다 (스크린샷이나 중간부터 맞춘 세트는 빼서 같은 세트를 두 번 세지 않는다)
    if (this.live) this.recordSet()
    this.updatedAt = Date.now()
    this.requestSolve('새 세트')
  }

  private recordSet() {
    this.logGame((g) => g.sets++)
    this.pieceCounts = record(this.pieceCounts, this.stage, this.hand.flatMap((h) => (h.piece ? [h.piece.id] : [])))
    saveCounts(this.pieceCounts)
  }

  resetStats() {
    this.pieceCounts = {}
    saveCounts(this.pieceCounts)
  }

  /** 화면에 보이는 대로 처음부터 다시 맞춘다 */
  private resync(B: Board, cards: CardRead[]) {
    // 판이 텅 비고 카드 세 장이 다 새것이면 새 게임이다. 줄 수(=단계)와 능력을 처음부터 센다
    const fresh = B.every((row) => row === 0) && cards.every((c) => c.state === 'piece')
    if (fresh) {
      this.startGame()
      this.nextAbility = 7
      this.lines = 0
      this.swaps = 0
      this.dots = 0
      this.iconTrack.clear()
      this.publishIcons()
    }
    this.board = B
    this.hand = cards.map((c) => ({
      state: c.state === 'piece' ? 'piece' : 'used', selected: c.selected, shape: c.shape,
      piece: c.shape ? identify(c.shape) : null,
    }))
    // 새 게임의 첫 세트도 통계에 넣는다
    if (fresh && this.live) this.recordSet()
    this.keys = {}
    this.counts = {}
    this.updatedAt = Date.now()
    this.requestSolve(fresh ? '새 게임' : '화면과 기억이 달라 다시 맞춰서')
  }

  private applyMove(mv: Move, B: Board) {
    this.keys.board = ''
    // 지운 줄, 아이콘 줄을 지워서 얻은 능력
    let got = 0
    if (mv.cleared.length) {
      this.lines += mv.cleared.length
      for (const [idx, ic] of this.iconTrack) {
        if (!mv.cleared.includes(Math.floor(idx / COLS))) continue
        this.iconTrack.delete(idx)
        if (ic.seen < this.iconNeed || this.swaps + this.dots >= 7) continue
        got++
        if (ic.kind === 'dot') this.dots++
        else this.swaps++
      }
      this.publishIcons()
    }
    this.logGame((g) => {
      g.score += mv.shape.cells + lineScore(mv.cleared.length) + got * ABILITY_SCORE
      g.lines += mv.cleared.length
      g.clears[Math.min(5, mv.cleared.length)]++
      if (mv.slot < 0) g.dotsUsed++
      else g.pieces++
    })
    if (mv.slot >= 0 && this.nextAbility !== null) this.nextAbility = this.nextAbility <= 1 ? 7 : this.nextAbility - 1
    this.board = B
    this.updatedAt = Date.now()
    if (mv.slot < 0) {
      // 점 찍기를 썼다
      this.dots = Math.max(0, this.dots - 1)
      this.requestSolve('점 찍기를 써서')
      return
    }
    this.hand = this.hand.map((h, i) => (i === mv.slot ? { ...h, state: 'used', selected: false } : h))
    const plan = this.plan
    const st = plan?.steps[this.stepIdx]
    if (!this.solving && plan && st && boardKey(st.boardAfter) === boardKey(B)) {
      if (st.slot !== mv.slot) {
        // 같은 조각이 두 장이면 어느 카드로 놓았는지 판만 봐서는 모른다. 남은 단계의 카드 번호를 맞바꾼다
        const a = st.slot, b = mv.slot
        const swapSlot = (x: number) => (x === a ? b : x === b ? a : x)
        this.plans = this.plans.map((p, i) => (i === this.planIdx ? { ...p, steps: p.steps.map((s, k) => (k < this.stepIdx ? s : { ...s, slot: swapSlot(s.slot) })) } : p))
      }
      this.stepIdx++
      this.log('추천대로 놓음', `${this.stepIdx}단계`)
      return
    }
    // 추천과 다르게 놓았다. 남은 조각으로 다시 계산한다
    const where = `${mv.shape.cells}칸 조각을 ↓${mv.r + 1}행 →${mv.c + 1}열에`
    if (this.solving) this.log('계산 중에 놓음', where)
    if (this.hand.some((h) => h.state === 'piece')) this.requestSolve(this.solving ? '계산이 끝나기 전에 놓아서' : '추천과 다른 자리에 놓아서')
    else { this.plans = []; this.stepIdx = 0 }
  }

  // ─── 아이콘 ──────────────────────────────────────────────────────────

  /** 아이콘은 반짝여서 프레임마다 보였다 안 보였다 한다. 두 번 보이면 있고, 한참 안 보여야 없다 */
  private iconTrack = new Map<number, { kind: Icon['kind']; seen: number; miss: number }>()

  private iconNeed = 2
  private trackIcons(cells: CellState[], B: Board, need: number) {
    this.iconNeed = need
    let changed = false
    cells.forEach((st, i) => {
      const r = Math.floor(i / COLS), c = i % COLS
      const t = this.iconTrack.get(i)
      if (isIconState(st)) {
        const kind: Icon['kind'] = st.startsWith('icon-dot') ? 'dot' : 'swap'
        if (!t) { this.iconTrack.set(i, { kind, seen: 1, miss: 0 }); if (need === 1) changed = true; return }
        if (++t.seen === need) {
          changed = true
          // 새 아이콘이 생겼다 = 방금 7번째 배치였다. 세던 값이 어긋났으면 여기서 맞춘다
          if (this.updatedAt && this.nextAbility !== 7) {
            if (this.nextAbility !== null) this.log('능력 카운트 보정', `${this.nextAbility} → 7`)
            this.nextAbility = 7
          }
        }
        t.miss = 0
        if (t.kind !== kind) { t.kind = kind; changed = true }
      } else if (t && st !== 'cursor' && st !== 'unknown' && !((B[r] >> c) & 1)) {
        if (++t.miss > 12) {
          this.iconTrack.delete(i)
          if (t.seen >= need) changed = true
        }
      }
    })
    if (changed) this.publishIcons()
  }

  private publishIcons() {
    this.icons = [...this.iconTrack]
      .filter(([, t]) => t.seen >= this.iconNeed)
      .map(([i, t]) => ({ r: Math.floor(i / COLS), c: i % COLS, kind: t.kind }))
  }

  // ─── 추천 ────────────────────────────────────────────────────────────

  resolve() {
    this.requestSolve('직접 다시 계산')
  }

  /**
   * 최근 계산 결과. 같은 상황을 다시 계산하지 않는다. 인식이 잠깐 흔들려 상태가 오갈 때
   * 계산이 되풀이되며 추천이 깜빡이는 것을 막는 안전장치이기도 하다.
   */
  private solveCache = new Map<string, { plans: Plan[]; rescue: Rescue | null }>()
  private pendingKey = ''

  private situationKey(hand: (Shape | null)[]) {
    return [boardKey(this.board), this.icons.map((i) => `${i.r},${i.c}${i.kind[0]}`).join(';'), hand.map((h) => h?.key ?? '-').join('/'),
      this.style, this.thinkMs, this.swaps, this.dots, this.stage].join('|')
  }

  private requestSolve(reason: string) {
    const hand = this.hand.map((h) => (h.state === 'piece' ? h.shape : null))
    if (!hand.some(Boolean)) { this.plans = []; this.stepIdx = 0; return }
    const key = this.situationKey(hand)
    const hit = this.solveCache.get(key)
    if (hit && reason !== '직접 다시 계산') {
      if (this.solving && this.worker) { this.worker.terminate(); this.worker = null }
      this.solving = false
      this.plans = hit.plans
      this.rescue = hit.rescue
      this.planIdx = 0
      this.stepIdx = 0
      this.log('저장된 계산 사용', reason)
      return
    }
    this.solveReason = reason
    this.log('계산', reason)
    this.pendingKey = key
    // 이전 계산이 아직 돌고 있으면 버린다. 기다리면 새 계산이 그만큼 늦게 끝난다
    if (this.solving && this.worker) { this.worker.terminate(); this.worker = null }
    this.worker ??= this.makeWorker()
    const id = ++this.reqId
    this.solving = true
    this.progress = 0
    const req: SolveRequest = {
      id,
      input: {
        board: $state.snapshot(this.board), icons: $state.snapshot(this.icons), hand: $state.snapshot(hand) as (Shape | null)[],
        heldAbilities: this.swaps + this.dots, swaps: this.swaps, dots: this.dots,
        weights: blendedWeights(this.pieceCounts, this.stage), style: this.style, budgetMs: this.thinkMs,
      },
    }
    this.worker.postMessage(req)
  }

  private makeWorker() {
    const w = new SolverWorker()
    w.onmessage = (e: MessageEvent<SolveResponse>) => {
      const d = e.data
      if (d.id !== this.reqId) return
      if (d.type === 'progress') { this.progress = d.progress; return }
      this.progress = 1
      this.plans = d.plans
      this.rescue = d.rescue
      this.solveCache.set(this.pendingKey, { plans: d.plans, rescue: d.rescue })
      if (this.solveCache.size > 40) this.solveCache.delete(this.solveCache.keys().next().value!)
      this.planIdx = 0
      this.stepIdx = 0
      this.solving = false
      this.solveMs = Math.round(d.ms)
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
    // 세트를 시작하기 전에만 다시 계산한다. 놓는 중에 계획이 바뀌면 헷갈린다
    if (this.stepIdx === 0) this.resolve()
  }
}

export const engine = new Engine()
