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
import { ABILITY_SCORE, anyPlacement, canPlace, filledCount, place, popcount, boardKey, canonicalKey, COLS, emptyBoard, lineScore, orientations, ROWS, type Board, type Icon, type Shape } from './core/board'
import { explainMove, type Move } from './core/track'
import { identify, stageOf, type PieceDef } from './core/pieces'
import { blendedWeights, loadCounts, loadGames, newGame, record, saveCounts, saveGames, seenIn, type Counts, type GameHistory, type GameLog } from './core/stats'
import { ADV, type Plan, type Rescue, type Step } from './core/solver'
import { ScreenSource, regionOf, frameFromBlob, type Frame } from './capture'
import { detectGrid, isFilledState, isIconState, readAbilityFull, readBoard, readCards, type CardRead, type CellState, type Grid } from './vision/read'
import { readGlyphs, type GlyphReads } from './vision/digits'
import { readTopBar, type TopBar } from './vision/topbar'
import { backup } from './backup.svelte'
import { ScreenCounts, emptyMemory, type Memory } from './core/counts'
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
const SHAPES_KEY = 'moamoa.shapes.v1'
const EVENTS_KEY = 'moamoa.events.v1'
const JOURNAL_KEY = 'moamoa.journal.v1'

/**
 * 세트 일지 (2026-10-04 사용자 요청): 세트마다 판·손·능력, 그 세트에서 나온 계산(추천과 근거), 실제로 놓은 자리를 남긴다.
 * 나중에 "의도대로 동작했나, 최적해였나"를 되짚는 용도. localStorage(최근 300세트)와 KV 백업에 같이 간다
 */
export interface JournalSolve { t: number; why: string; ms: number; best?: string; value?: number; risk?: number; samples?: number; gained?: number; alt?: string; rescue?: string }
export interface JournalMove { t: number; slot: number; key: string; r: number; c: number; cleared: number; how: string }
export interface JournalSet {
  t: number
  /** 판 시작 시각 (어느 판인지) */
  game: number
  set: number
  lines: number
  stage: number
  free: number
  /** 손의 조각 id 세 개 */
  hand: number[]
  /** 세트 시작 시점의 판 (줄별 비트) */
  board: number[]
  icons: string
  dots: number
  swaps: number
  solves: JournalSolve[]
  moves: JournalMove[]
}
const JOURNAL_MAX = 300
function loadJournal(): JournalSet[] {
  try { return JSON.parse(localStorage.getItem(JOURNAL_KEY) ?? '[]') } catch { return [] }
}
const stepText = (s: Step) => `${s.slot}:${s.shape.key}@${s.r},${s.c}${s.cleared.length ? '!' + s.cleared.length : ''}${s.abilities ? '+' + s.abilities : ''}`

/** 검산으로 확인한 숫자 모양 (core/counts.ts). 같은 창 크기로 다시 열면 바로 알아본다 */
function loadShapes(): Memory {
  try { return { ...emptyMemory(), ...JSON.parse(localStorage.getItem(SHAPES_KEY) ?? '{}') } } catch { return emptyMemory() }
}
function saveShapes(m: Memory) {
  try { localStorage.setItem(SHAPES_KEY, JSON.stringify(m)) } catch { /* 이번 창에서만 기억한다 */ }
}
/** 최근 기록은 새로고침해도 남긴다. 개수가 틀어진 걸 보고 새로고침한 뒤에도 원인을 되짚을 수 있게 */
function loadEvents(): { t: number; what: string; detail: string }[] {
  try { const v = JSON.parse(localStorage.getItem(EVENTS_KEY) ?? '[]'); return Array.isArray(v) ? v : [] } catch { return [] }
}

interface Prefs { style: number; swaps: number; dots: number; lines: number; thinkMs: number; v?: number }

/**
 * 권장 설정 (2026-10-04, docs/SCORE-CYCLE.md): 2줄 사이클 설계는 앱 조건 가상 플레이에서 성향 0.75가 가장 좋았다
 * (137세트·134,483 vs 1.0 130.6·126,322). 계산 시간 2.5초면 다음 세트 가상 플레이 표본이 넉넉하다
 */
export const RECOMMENDED = { style: 0.75, thinkMs: 2500 }
/** 권장 설정이 바뀌면 올린다. 저장된 설정의 v가 이보다 낮으면 성향·계산 시간을 권장값으로 한 번 맞춘다 */
const PREFS_VERSION = 2

function loadPrefs(): Prefs {
  const d: Prefs = { ...RECOMMENDED, swaps: 0, dots: 0, lines: 0, v: PREFS_VERSION }
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>
    const p = { ...d, ...saved }
    // 예전 설정(성향 0.2·0.9 등)을 쓰던 브라우저는 새 로직의 권장값으로 옮긴다. 그 뒤로는 사용자가 바꾼 값을 지킨다
    if ((saved.v ?? 1) < PREFS_VERSION) Object.assign(p, RECOMMENDED, { v: PREFS_VERSION })
    return p
  } catch { return d }
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
  events = $state<{ t: number; what: string; detail: string }[]>(loadEvents())
  /**
   * 화면 숫자로 값을 바로잡았을 때 몇 초간 띄우는 알림. 사용자가 보정된 값을 직접 보고 맞는지 확인할 수 있게
   * (조용히 바꾸면 틀린 보정을 알아챌 길이 없다). 1.2초 뒤 tick에서 지운다
   */
  notices = $state<{ t: number; text: string }[]>([])
  private notify(text: string) {
    this.notices = [...this.notices.slice(-3), { t: Date.now(), text }]
  }
  private log(what: string, detail = '') {
    // 능력 개수가 어긋난 원인을 한 판 단위로 되짚을 수 있게 넉넉히 남긴다 (30개로는 몇 세트밖에 안 됐다)
    this.events = [{ t: Date.now(), what, detail }, ...this.events].slice(0, 400)
    if (what === '화면 숫자' || what === '화면 줄 수' || what === '합으로 알아냄' || what === '아이콘 칸 바로잡음' || what === '꽉 참에 맞춤') this.notify(`${what}: ${detail.split(' · ')[0]}`)
    try { localStorage.setItem(EVENTS_KEY, JSON.stringify(this.events)) } catch { /* 이번 창에서만 남는다 */ }
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
  /** 화면 기준으로 다시 맞춘 뒤라 그 사이 배치·획득을 못 셌을 수 있다 (작은 창에 ?로 알린다) */
  abilityUnsure = $state(false)
  nextUnsure = $state(false)
  /** 설정에서 직접 맞추면 다시 믿는다 */
  confirmCounts() { this.abilityUnsure = false; this.nextUnsure = false }
  /** 게임 화면의 '능력이 가득 찼습니다'(주황색 칸)가 떠 있다 */
  gameFull = $state(false)
  /** 게임 화면과 도우미가 센 능력 개수가 안 맞는다 (꽉 찼는지 여부로만 안다) */
  get heldMismatch() { return this.updatedAt > 0 && this.gameFull !== (this.held >= 7) }
  /** 계산에 쓰는 보유 수. 게임이 꽉 찼다고 하면 7로 본다 */
  get heldForSolve() { return this.gameFull ? 7 : this.held }

  /** 실제로 나온 조각 수 (단계별) */
  pieceCounts = $state<Counts>(loadCounts())
  /** 판별 기록 (지금 판 + 지난 판들) */
  games = $state<GameHistory>(loadGames())
  /** 세트 일지 (최근 300세트). 화면 상태가 아니라 기록이라 $state가 아니다 */
  journal: JournalSet[] = loadJournal()
  private saveJournal() {
    try { localStorage.setItem(JOURNAL_KEY, JSON.stringify(this.journal)) } catch { /* 용량·사생활 보호 모드 */ }
  }
  /** 지금 세트의 일지 항목 (없으면 null) */
  private get journalNow(): JournalSet | null {
    const j = this.journal[this.journal.length - 1]
    return j && j.game === (this.games.current?.start ?? 0) ? j : null
  }
  private journalSolve(note: JournalSolve) {
    const j = this.journalNow
    if (!j) return
    j.solves.push(note)
    this.saveJournal()
  }
  private journalMove(mv: { slot: number; shape: Shape; r: number; c: number; cleared: number[] }, how: string) {
    const j = this.journalNow
    if (!j) return
    j.moves.push({ t: Date.now(), slot: mv.slot, key: mv.shape.key, r: mv.r, c: mv.c, cleared: mv.cleared.length, how })
    this.saveJournal()
  }

  /** 지금 판 기록을 고친다. 없으면 (중간부터 공유한 것으로 보고) 새로 연다 */
  private logGame(fn: (g: GameLog) => void) {
    if (!this.live) return
    const g = this.games.current ?? newGame(false)
    fn(g)
    g.end = Date.now()
    this.games = { ...this.games, current: { ...g } }
    saveGames(this.games)
    backup.schedule(() => this.snapshot())
  }

  private startGame() {
    if (!this.live) return
    const past = this.games.current && this.games.current.pieces > 0 ? [this.games.current, ...this.games.past].slice(0, 200) : this.games.past
    this.games = { current: newGame(true), past }
    saveGames(this.games)
    backup.schedule(() => this.snapshot())
  }

  resetGames() {
    this.games = { current: null, past: [] }
    saveGames(this.games)
    backup.schedule(() => this.snapshot())
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
        const prefs: Prefs = { style: this.style, swaps: this.swaps, dots: this.dots, lines: this.lines, thinkMs: this.thinkMs, v: PREFS_VERSION }
        try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)) } catch { /* 사생활 보호 모드 */ }
      })
    })
  }

  get plan(): Plan | null { return this.plans[this.planIdx] ?? null }
  /**
   * 화면에 보여 줄 계획. 능력을 먼저 써야 하면
   *  - 점 찍기: 찍은 뒤의 계획 (결과가 정해져 있다)
   *  - 바꿔 뽑기: 없음 (무슨 조각이 나올지 몰라서, 새 조각을 본 뒤 다시 계산한다)
   */
  get displayPlan(): Plan | null {
    const r = this.rescue
    if (r?.kind === 'dot') return r.plan
    if (r?.kind === 'swap') return null
    return this.plan
  }
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
    this.lingering.clear()
    this.lastIconRead = { mask: new Array(ROWS).fill(0), filled: new Array(ROWS).fill(0) }
    this.numsSeen = false
    this.numsSettled = false
    this.nextAt = 0
    this.screen.reset()
    this.adoptFrames = 0
    this.icons = []
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
    // 1.2초면 눈에 들어온다. 길면 거슬린다 (사용자 요청)
    if (this.notices.length && this.notices[0].t < Date.now() - 1200) this.notices = this.notices.filter((n) => n.t >= Date.now() - 1200)
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
    // 커서·못 읽은 칸은 직전 값을 쓰고 '모름'으로 표시해 둔다. 판 변화를 풀 때 그 칸은 어느 쪽이든 맞는 것으로 본다
    const B = new Array<number>(ROWS).fill(0)
    const unsure = new Array<number>(ROWS).fill(0)
    const iconMask = new Array<number>(ROWS).fill(0), iconFilled = new Array<number>(ROWS).fill(0)
    br.cells.forEach((st, i) => {
      const r = Math.floor(i / COLS), c = i % COLS
      if (isIconState(st)) { iconMask[r] |= 1 << c; if (isFilledState(st)) iconFilled[r] |= 1 << c }
      // 아이콘 칸도 '모름'이다. 아이콘이 반짝이면 밑이 블록인지 빈칸인지 프레임마다 다르게 읽힌다.
      // 그 칸이 바뀌는 건 조각을 놓거나 줄이 지워질 때뿐이고, 그때는 다른 칸도 함께 바뀌어서 그걸로 안다
      // 배치 미리보기·줄 강조 칸도 '모름'이다. 그동안에도 아이콘은 계속 따라간다
      // 아이콘이 있다고 아는 칸은 아이콘이 안 읽힌 프레임에도 '모름'이다. 반짝임이 큰 순간에는 아이콘 대신
      // 블록이나 빈칸으로 읽히는데, 그걸 믿으면 한 칸짜리 판 변화로 보인다
      const tracked = (this.iconTrack.get(i)?.seen ?? 0) >= this.iconNeed
      if (st === 'cursor' || st === 'unknown' || st === 'hover' || st === 'invalid' || st === 'flash' || isIconState(st) || tracked) {
        unsure[r] |= 1 << c
        const known = this.updatedAt ? (this.board[r] >> c) & 1 : isFilledState(st) ? 1 : 0
        if (known) B[r] |= 1 << c
      } else if (isFilledState(st)) B[r] |= 1 << c
    })
    this.lastIconRead = { mask: iconMask, filled: iconFilled }
    // 미리보기·줄 강조가 떠 있는 동안은 그 색이 칸 가장자리에 겹치므로 아이콘 밑 판별을 쓰지 않는다
    this.trackIcons(br.cells, B, live ? 2 : 1, br.busy ? null : br.under)
    this.lastUnsure = unsure
    // 능력 숫자는 판 미리보기와 상관없는 자리라 매 프레임 읽는다
    const full = readAbilityFull(frame.image, g)
    this.syncNumbers(readGlyphs(frame.image, g), full, live)
    this.syncTopBar(readTopBar(frame.image, g), live)
    if (br.busy) { this.status = 'busy'; return }
    this.status = live ? 'live' : 'image'
    if (full !== this.gameFull && this.steady('full', String(full), live ? 3 : 1)) {
      this.gameFull = full
      this.log(full ? '게임: 능력 꽉 참' : '게임: 능력 자리 있음', `도우미 ${this.held}/7`)
    }


    const need = live ? 2 : 1
    const cardsReadable = cards.every((c) => c.state !== 'unknown')
    if (!this.updatedAt) {
      if (cardsReadable && this.steady('init', boardKey(B) + cardSig(cards), need)) this.resync(B, cards)
      return
    }

    this.track(B, unsure, cards, live)
  }

  // ─── 능력 숫자 (게임 화면) ─────────────────────────────────────────────

  /** 게임 화면의 숫자 모양으로 개수를 정한다 (core/counts.ts). 검산으로 확인한 숫자 모양은 브라우저에 남긴다 */
  private screen = new ScreenCounts(loadShapes(), saveShapes)
  /**
   * 버튼 옆 숫자를 한 번이라도 읽었으면 그 뒤로 개수는 화면 숫자로만 바뀐다. 잠깐 못 읽어도(커서가 버튼을 가림,
   * 처음 보는 숫자 모양) 도우미가 따라 세며 더하고 빼지 않는다. 전에는 2초 못 읽으면 따라 세기로 돌아갔고,
   * 버튼 숫자 4·5·7은 표본이 없어 늘 못 읽었기 때문에 보유가 많아지면 개수가 혼자 틀어졌다
   */
  private numsSeen = false
  get screenCounts() { return this.numsSeen }
  /** '다음 능력 N번'을 마지막으로 읽은 때 */
  private nextAt = 0
  /** 남은 프레임 동안은 보이는 아이콘을 조건 없이 받는다 (화면 기준으로 다시 맞춘 직후). 시간이 아니라 프레임으로 센다:
   *  계산이 오래 걸려 프레임이 늦게 와도 다시 맞춘 뒤 화면을 몇 장은 꼭 본다 */
  private adoptFrames = 0
  /** 화면 숫자가 줄어든 때(아직 배치로 설명 안 된 사용). 사용을 받아들이는 근거가 된다 */
  private drops = { dots: 0, swaps: 0 }
  /** 판·카드로 사용을 받아들인 때. 그 직후 숫자가 주는 건 같은 사용이다 */
  private usedAt = { dots: 0, swaps: 0 }

  /** 화면 숫자로 개수를 맞춘다. full: 보유 칸이 '능력이 가득 찼습니다'로 바뀌어 있다 */
  private syncNumbers(r: GlyphReads, full: boolean, live: boolean) {
    this.lastWhy = r.why
    // 최근 20초 안에 얻은 능력 종류. 꽉 찼는데 버튼 숫자로 못 정하면 그쪽에 더한다
    const hint = Date.now() - this.lastGain.at < 6000 ? this.lastGain.kind : null
    for (const e of this.screen.feed(r, full, live ? 3 : 1, hint)) {
      // 같은 화면이 깜빡일 때마다 같은 말을 되풀이하지 않는다
      const key = e.what + e.detail
      if (key !== this.lastScreenEvent) { this.lastScreenEvent = key; this.log(e.what, e.detail) }
    }
    if (!this.updatedAt) return
    const now = Date.now()
    const sc = this.screen
    if (sc.countsFresh) {
      if (!this.numsSeen) { this.numsSeen = true; this.log('화면 숫자 읽기 시작', `◎${sc.dots} ⇄${sc.swaps}`) }
      let gained = false
      for (const k of ['dots', 'swaps'] as const) {
        const v = sc[k]!
        if (v === this[k]) continue
        if (v > this[k]) gained = true
        // 판·카드로 아직 못 본 사용이면 기억해 둔다. 곧 그 배치(점 찍기)·카드 변화(바꿔 뽑기)를 받아들이는 근거가 된다
        if (v < this[k] && now - this.usedAt[k] > 3000) this.drops[k] = now
        this.log('화면 숫자', `${k === 'dots' ? '점 찍기' : '바꿔 뽑기'} ${this[k]} → ${v}`)
        this[k] = v
      }
      this.abilityUnsure = false
      // 추천은 세트가 나올 때 한 번 계산하고, 능력 쓰기 안내도 그때만 계산됐다. 세트 중간에 능력을 얻어 6개 이상이 되면
      // (7개면 더 못 얻는다) 남은 조각으로 다시 계산해서 지금 털지 본다. 전에는 세 조각을 다 놓을 때까지 대응이 없었다
      if (gained && this.numsSettled && this.held >= ADV.cap && this.hand.some((h) => h.state === 'piece')) this.requestSolve('능력이 늘어서')
      this.numsSettled = true
    } else if (this.numsSeen && sc.unsure) this.abilityUnsure = true
    // 숫자가 한참 안 읽히면 까닭을 한 번 남긴다 (기록을 받아 보면 무엇이 문제인지 알 수 있게)
    if (sc.countsFresh) { this.numsFreshAt = now; this.numsStaleLogged = false }
    else if (!this.numsStaleLogged && now - Math.max(this.numsFreshAt, this.updatedAt) > 4000) {
      this.numsStaleLogged = true
      const why = Object.entries(r.why).map(([k, v]) => k + ': ' + v).join(' · ')
      this.log('화면 숫자 못 읽는 중', why || (sc.unsure ? '모양은 보이지만 개수를 못 정함' : '모양이 자리 잡지 않음'))
    }
    if (sc.nextFresh && sc.next !== null) {
      this.nextAt = now
      if (sc.next !== this.nextAbility) {
        // 1 → 7: 방금 7번째 배치였다. 새 아이콘 차례다
        if (sc.next === 7 && this.nextAbility === 1) this.spawnPending = true
        if (this.nextAbility !== null && !(this.nextAbility === sc.next + 1 || (this.nextAbility === 1 && sc.next === 7)))
          this.log('화면 숫자', `다음 능력 ${this.nextAbility} → ${sc.next}`)
        this.nextAbility = sc.next
      }
      this.nextUnsure = false
    }
  }
  private lastScreenEvent = ''

  /** 마지막으로 읽은 위쪽 표시줄 (진단용) */
  private top: TopBar = { score: null, lines: null, best: null }
  /**
   * 위쪽 표시줄의 '제거한 줄 수'와 '점수'로 지운 줄 수와 판 기록 점수를 맞춘다.
   * 따라 세면 화면 기준으로 다시 맞출 때마다 그 사이 지운 줄이 빠진다 (16만 점 판에서 도우미 381줄, 실제 406줄).
   * 같은 값이 3프레임 이어져야 믿는다 (숫자가 바뀌는 중, 반짝임 등)
   */
  private syncTopBar(t: TopBar, live: boolean) {
    this.top = t
    if (!this.updatedAt) return
    const need = live ? 3 : 1
    if (t.lines !== null && this.steady('topLines', String(t.lines), need) && t.lines !== this.lines) {
      // 줄 수는 늘기만 한다. 새 판이면 0으로 돌아간다 (새 게임은 resync가 따로 잡지만, 못 잡았어도 화면을 믿는다)
      this.log('화면 줄 수', `${this.lines} → ${t.lines}`)
      this.lines = t.lines
      this.logGame((g) => { g.lines = t.lines! })
    }
    if (t.score !== null && this.steady('topScore', String(t.score), need)) {
      const cur = this.games.current
      if (cur && cur.score !== t.score) this.logGame((g) => { g.score = t.score! })
    }
  }
  /** 화면 숫자로 개수를 한 번 맞춘 뒤다 (처음 맞출 때 값이 커지는 건 능력을 얻은 게 아니다) */
  private numsSettled = false
  private lastWhy: Record<string, string> = {}
  /** 마지막으로 얻은 능력 종류와 때 */
  private lastGain: { kind: 'dots' | 'swaps'; at: number } = { kind: 'dots', at: 0 }

  /** 백업·내보내기에 쓰는 통계 묶음. 화면은 없고 조각 횟수·판 기록·설정뿐이다 */
  snapshot() {
    return {
      note: '모아모아 조각 통계 (단계 → 조각 id → 나온 횟수)와 판 기록',
      at: new Date().toISOString(),
      build: __BUILD__,
      counts: $state.snapshot(this.pieceCounts),
      games: $state.snapshot(this.games),
      prefs: { style: this.style, thinkMs: this.thinkMs, lines: this.lines, swaps: this.swaps, dots: this.dots },
      journal: this.journal,
    }
  }

  /** 지금 화면 숫자를 어떻게 읽고 있는지 (기록 복사에 붙는다. 개수가 안 맞을 때 이걸로 원인을 찾는다) */
  diagnostics(): string {
    const why = Object.entries(this.lastWhy).map(([k, v]) => k + ': ' + v).join(' · ')
    return [
      `도우미: 점 찍기 ${this.dots} · 바꿔 뽑기 ${this.swaps} · 다음 ${this.nextAbility} · 꽉 참 ${this.gameFull} · 화면 숫자 ${this.numsSeen ? '읽는 중' : '아직 못 읽음'}`,
      `판 칸 크기 ${this.grid?.pitch.toFixed(2) ?? '?'}${why ? ' · 못 잡은 자리 ' + why : ''}`,
      `위쪽 표시줄: 점수 ${this.top.score ?? '못 읽음'} · 줄 수 ${this.top.lines ?? '못 읽음'} · 최고 ${this.top.best ?? '못 읽음'} (도우미 줄 수 ${this.lines})`,
      this.screen.diagnose(),
    ].join('\n')
  }
  private numsFreshAt = 0
  private numsStaleLogged = false

  /**
   * 능력을 썼다고 받아들여도 되나. 화면 숫자를 읽고 있으면 그 숫자가 실제로 줄었을 때만이다.
   * 커서 오독 한 칸을 '점 찍기 사용'으로, 카드 오독을 '바꿔 뽑기 사용'으로 세던 걸 막는다
   */
  private canUse(k: 'dots' | 'swaps') {
    if (!this.numsSeen) return this[k] > 0
    const raw = this.screen.raw[k]
    return (raw !== null && raw < this[k]) || Date.now() - this.drops[k] < 3000
  }

  /** 능력 사용을 받아들였다. 화면 숫자를 읽고 있으면 개수는 화면이 정하므로 빼지 않는다 */
  private markUsed(k: 'dots' | 'swaps') {
    this.usedAt[k] = Date.now()
    this.drops[k] = 0
    if (!this.screenCounts) this[k] = Math.max(0, this[k] - 1)
  }

  /** 읽은 판·카드를 기억과 맞춰 본다: 배치로 설명되면 따라가고, 판이 그대로면 카드 변화를 본다 */
  private track(B: Board, unsure: Board, cards: CardRead[], live: boolean) {
    const need = live ? 2 : 1
    const cardsReadable = cards.every((c) => c.state !== 'unknown')
    const key = boardKey(B)
    if (key !== boardKey(this.board)) {
      if (!this.steady('board', key, need)) return
      const remaining = this.hand.flatMap((h, slot) => (h.state === 'piece' && h.shape ? [{ slot, shape: h.shape }] : []))
      // 점 찍기는 갖고 있을 때만 후보로 둔다. 아니면 한 칸짜리 잘못 읽음을 점 찍기로 오해한다
      let mv = explainMove(this.board, B, remaining, this.canUse('dots'), unsure)
      // 조각을 진짜 놓으면 그 카드는 '사용 완료'(또는 새 세트)로 바뀐다. 카드가 아직 같은 조각으로 보이면 놓은 게 아니라
      // 커서·미리보기를 잘못 읽은 것이다. 특히 1칸 조각을 들고 있으면 한 칸 오독이 전부 '놓음'으로 설명돼 버렸다
      if (mv && mv.slot >= 0 && this.cardStillHeld(cards, mv.slot)) {
        if (this.keys.heldReject !== key) { this.keys.heldReject = key; this.log('배치 무시', `${mv.slot + 1}번 카드가 그대로 보임 (화면 오독)`) }
        mv = null
      }
      if (mv) { this.applyMove(mv, mv.board); return }
      // 카드가 하나도 안 바뀌었으면 아무것도 놓지 않았다. 판이 달라 보이는 건 마우스를 대고 있어서 생긴 오독이라
      // 오래(약 8초) 그대로일 때만 화면을 믿고, 그때도 놓친 배치가 없으니 능력 카운트는 '모름'으로 만들지 않는다
      const nothingPlaced = this.hand.every((h, i) => (h.state === 'used' ? cards[i].state === 'used' : this.cardStillHeld(cards, i)))
      // 어떤 배치로도 설명이 안 되는 판이 1.5초 넘게 그대로면 화면을 믿는다
      if (this.counts.board >= (!live ? 1 : nothingPlaced ? 57 : 10) && cardsReadable) {
        let diff = 0
        for (let r = 0; r < ROWS; r++) diff += popcount((B[r] ^ this.board[r]) & ~unsure[r])
        if (live) this.log('설명 안 되는 판', `기억과 ${diff}칸 다름${nothingPlaced ? ' (카드 그대로)' : ''}`)
        this.resync(B, cards, nothingPlaced)
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

    // 바꿔 뽑기 버튼을 누르면 '바꿀 조각을 골라 주세요'가 뜨고 카드가 보라색이 된다. 흰/노란 바탕이 아니라
    // 남은 카드가 모두 '못 읽음'이 된다. 커서는 카드 한 장만 가리므로, 남은 카드가 한꺼번에 못 읽히면 그 화면이다
    const waiting = this.hand.flatMap((h, i) => (h.state === 'piece' ? [i] : []))
    if (waiting.length && waiting.every((i) => cards[i].state === 'unknown')) this.swapModeAt = Date.now()

    // 안전장치: 게임 카드와 기억한 카드가 2초 넘게 계속 다르면 화면 기준으로 다시 맞춘다.
    // (새 세트가 뜨자마자 하나를 놓아 버려 '세 장 다 새것'을 못 본 경우 등, 어떤 길로 꼬여도 빠져나온다)
    if (this.hand.length === 3 && cards.every((c) => c.state === 'used' || ok(c))) {
      let usedDiffers = false
      const differs = cards.some((c, i) => {
        const h = this.hand[i]
        if ((c.state === 'used') !== (h.state === 'used')) return (usedDiffers = true)
        return c.state === 'piece' && !!h.shape && canonicalKey(c.shape!) !== canonicalKey(h.shape)
      })
      if (differs) {
        if (this.steady('cardMismatch', cardSig(cards), need * 8)) {
          const names = cards.map((c) => (c.shape ? identify(c.shape)?.name : '사용')).join(' ')
          if (usedDiffers) {
            this.log('카드와 기억이 달라 다시 맞춤', names)
            this.resync(this.board, cards)
          } else {
            // 조각 모양만 다르다 (새 세트를 덜 그려진 채 읽었거나 바꿔 뽑기를 못 봤다). 판은 그대로라 놓친 배치가 없으니
            // 카드만 고친다. 전체 다시 맞춤은 카운트를 '모름'으로 만들어 커서를 아이콘으로 받는 창을 넓혔다
            this.log('카드만 다시 읽음', names)
            this.hand = this.hand.map((h, i) => (h.state === 'piece' && ok(cards[i]) ? { ...h, shape: cards[i].shape, piece: identify(cards[i].shape!) } : h))
            this.keys.cardMismatch = ''
            this.requestSolve('카드를 다시 읽어서')
          }
          return
        }
      } else this.keys.cardMismatch = ''
    }

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
    // 무엇이 무엇으로 바뀌어 '사용'으로 셌는지 남긴다. 실제로 안 썼는데 줄었다면 카드를 잘못 읽은 것이다
    let swapWhat = ''
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
      // 보라 카드(바꿔 뽑기 고르는 화면)를 못 봤으면 바꿔 뽑기가 아니다. 커서가 카드를 가렸거나 새 세트를
      // 덜 그려진 채 읽은 것이다. 개수는 건드리지 않는다 (진짜로 바뀐 거라면 2초 뒤 '카드만 다시 읽음'이 고친다)
      if (Date.now() - this.swapModeAt > 15_000 && !(this.screenCounts && this.canUse('swaps'))) {
        if (!this.keys[`swapIgnored${i}`]) {
          this.keys[`swapIgnored${i}`] = '1'
          this.log('카드 바뀜 무시', `${i + 1}번 ${h.piece?.name ?? '?'}→${identify(c.shape!)?.name ?? '?'} 보라 카드를 못 봄`)
        }
        return h
      }
      this.keys[`swapIgnored${i}`] = ''
      this.swapModeAt = 0
      changed = swapped = true
      const next = identify(c.shape!)
      swapWhat = `${i + 1}번 ${h.piece?.name ?? '?'}→${next?.name ?? '?'} `
      return { ...h, shape: c.shape, piece: next }
    })
    if (!changed) return
    this.hand = hand
    if (swapped) {
      this.markUsed('swaps')
      this.log('바꿔 뽑기 사용', `${swapWhat}→ ◎${this.dots} ⇄${this.swaps}`)
      { const j = this.journalNow; if (j) { j.moves.push({ t: Date.now(), slot: -2, key: swapWhat.trim(), r: -1, c: -1, cleared: 0, how: '바꿔 뽑기' }); this.saveJournal() } }
      this.logGame((g) => g.swapsUsed++)
      this.requestSolve('바꿔 뽑기를 써서')
    }
  }

  /** 바꿔 뽑기 고르는 화면(보라 카드)을 마지막으로 본 때. 이걸 본 뒤에만 카드가 바뀐 걸 바꿔 뽑기로 센다 */
  private swapModeAt = 0

  /** 마지막 프레임의 아이콘 칸과, 그 밑이 블록으로 읽힌 칸 (줄별 비트) */
  private lastIconRead: { mask: Board; filled: Board } = { mask: new Array(ROWS).fill(0), filled: new Array(ROWS).fill(0) }

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
    this.swapModeAt = 0
    // 실시간으로 새 세트를 볼 때만 센다 (스크린샷이나 중간부터 맞춘 세트는 빼서 같은 세트를 두 번 세지 않는다)
    if (this.live) this.recordSet()
    this.updatedAt = Date.now()
    this.requestSolve('새 세트')
  }

  private recordSet() {
    // 세트 시작 시점에 세 조각이 각각 놓을 자리가 있는지와 빈칸 수를 남긴다 (실제 게임의 조각 생성 규칙 조사용, GameLog.fit)
    const shapes = this.hand.flatMap((h) => (h.state === 'piece' && h.shape ? [h.shape] : []))
    const fits = shapes.filter((s) => anyPlacement(this.board, s)).length
    const free = ROWS * COLS - filledCount(this.board)
    const bucket = Math.min(3, Math.floor(free / 40))
    const ids = this.hand.flatMap((h) => (h.piece ? [h.piece.id] : []))
    this.logGame((g) => {
      g.sets++
      g.fit ??= [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]
      if (shapes.length === 3) g.fit[bucket][fits]++
      g.seq ??= []
      if (g.seq.length < 1800) g.seq.push(...ids)
    })
    this.journal.push({
      t: Date.now(), game: this.games.current?.start ?? 0, set: this.games.current?.sets ?? 0, lines: this.lines, stage: this.stage, free,
      hand: ids, board: $state.snapshot(this.board) as number[], icons: this.icons.map((ic) => `${ic.kind === 'dot' ? '◎' : '⇄'}${ic.r},${ic.c}`).join(' '),
      dots: this.dots, swaps: this.swaps, solves: [], moves: [],
    })
    if (this.journal.length > JOURNAL_MAX) this.journal.splice(0, this.journal.length - JOURNAL_MAX)
    this.saveJournal()
    this.pieceCounts = record(this.pieceCounts, this.stage, this.hand.flatMap((h) => (h.piece ? [h.piece.id] : [])))
    saveCounts(this.pieceCounts)
    backup.schedule(() => this.snapshot())
  }

  resetStats() {
    this.pieceCounts = {}
    saveCounts(this.pieceCounts)
    backup.schedule(() => this.snapshot())
  }

  /** 기억한 카드 자리에 같은 조각이 그대로 보이는지 (못 읽는 카드는 '모름'이라 아니라고 본다) */
  private cardStillHeld(cards: CardRead[], slot: number) {
    const h = this.hand[slot], c = cards[slot]
    return h?.state === 'piece' && !!h.shape && c?.state === 'piece' && !!c.shape && canonicalKey(c.shape) === canonicalKey(h.shape)
  }

  /** 화면에 보이는 대로 처음부터 다시 맞춘다. keepCounts: 놓친 배치가 없다고 확신할 때 (카드가 그대로) */
  private resync(B: Board, cards: CardRead[], keepCounts = false) {
    // 기억을 버리고 화면을 믿는 자리다. 아이콘 칸도 기억 대신 지금 화면에서 읽은 대로(블록 위인지 빈칸 위인지) 둔다
    const ir = this.lastIconRead
    B = B.map((row, r) => (row & ~ir.mask[r]) | ir.filled[r])
    for (const t of this.iconTrack.values()) t.under = 0
    // 판이 텅 비고 카드 세 장이 다 새것이면 새 게임이다. 줄 수(=단계)와 능력을 처음부터 센다
    const fresh = B.every((row) => row === 0) && cards.every((c) => c.state === 'piece')
    if (!fresh && this.updatedAt && !keepCounts) {
      // 그 사이 놓은 조각·지운 아이콘 줄을 못 셌을 수 있다. 다음 새 아이콘은 언제 보이든 받아서 카운트를 맞춘다
      this.abilityUnsure = true
      this.nextUnsure = true
      this.spawnPending = true
    }
    if (fresh) {
      this.startGame()
      this.nextAbility = 7
      this.abilityUnsure = false
      this.nextUnsure = false
      this.spawnPending = false
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
    // 화면을 믿기로 했으니 지금 화면에 보이는 아이콘도 받는다 (차례·빈칸 조건 없이, 처음 맞출 때처럼)
    // 단, 카드가 그대로라 마우스 오독으로 다시 맞춘 경우는 빼다 (그 커서를 아이콘으로 받을 수 있다)
    this.adoptFrames = keepCounts ? 0 : 6
    for (const ic of this.iconTrack.values()) ic.fresh = false
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
        // 판이 바뀌는 도중에 나타난 아이콘은 이번 배치 뒤에 새로 생긴 것이다. 줄을 지운 직후 빈칸에
        // 생기므로 방금 지워진 줄에 있을 수 있지만, 지운 줄의 아이콘이 아니라서 획득이 아니다
        if (ic.fresh) { ic.fresh = false; continue }
        if (ic.seen < this.iconNeed) { this.iconTrack.delete(idx); continue }
        // 7개를 들고 있으면 획득하지 못하고 아이콘은 판에 그대로 남는다 (공지)
        if (this.heldForSolve >= 7) { this.log('꽉 차서 못 얻음', ic.kind === 'dot' ? '점 찍기' : '바꿔 뽑기'); continue }
        this.iconTrack.delete(idx)
        got++
        // 화면 숫자를 읽고 있으면 개수는 화면이 정한다 (여기서 더하면 숫자가 먼저 바뀐 경우 두 번 센다)
        if (!this.screenCounts) {
          if (ic.kind === 'dot') this.dots++
          else this.swaps++
        }
        this.lastGain = { kind: ic.kind === 'dot' ? 'dots' : 'swaps', at: Date.now() }
        this.log('능력 획득', `↓${Math.floor(idx / COLS) + 1} →${(idx % COLS) + 1} ${ic.kind === 'dot' ? '점 찍기' : '바꿔 뽑기'} → ◎${this.dots} ⇄${this.swaps}`)
      }
      this.publishIcons()
    }
    // 이번 배치에서 새로 생긴 아이콘도 이제는 판에 있던 아이콘이다. 줄을 안 지운 배치에서도 꼭 풀어야
    // 다음에 그 줄을 지울 때 획득으로 센다 (전에는 줄을 지운 배치에서만 풀어서 획득이 자주 빠졌다)
    for (const ic of this.iconTrack.values()) ic.fresh = false
    this.logGame((g) => {
      g.score += mv.shape.cells + lineScore(mv.cleared.length) + got * ABILITY_SCORE
      g.lines += mv.cleared.length
      g.clears[Math.min(5, mv.cleared.length)]++
      if (mv.slot < 0) g.dotsUsed++
      else g.pieces++
    })
    if (mv.slot >= 0) {
      this.lastPlacedAt = Date.now()
      this.ignoredIcons.clear()
      // 7개를 들고 있으면 아이콘이 생기지 않고 카운트도 멈춘다
      // 화면의 '다음 능력 N번'을 읽고 있으면 그 숫자가 정한다 (차례도 syncNumbers가 1 → 7을 보고 켠다)
      if (Date.now() - this.nextAt < 2000) { /* 화면 기준 */ }
      else if (this.nextAbility !== null && this.heldForSolve < 7) {
        this.nextAbility = this.nextAbility <= 1 ? 7 : this.nextAbility - 1
        if (this.nextAbility === 7) this.spawnPending = true
      } else if (this.nextAbility === null) this.spawnPending = true
    }
    this.board = B
    this.updatedAt = Date.now()
    if (mv.slot < 0) {
      // 점 찍기를 썼다. 계획에 있던 점 찍기 단계 그대로면 다음 단계로 넘어가고, 아니면 다시 계산한다
      this.markUsed('dots')
      this.log('점 찍기 사용', `→ ◎${this.dots} ⇄${this.swaps}`)
      const dotStep = this.plan?.steps[this.stepIdx]
      if (!this.solving && dotStep && dotStep.slot < 0 && boardKey(dotStep.boardAfter) === boardKey(B)) {
        this.stepIdx++
        this.log('추천대로 놓음', `${this.stepIdx}단계 (점 찍기)`)
        return
      }
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
      this.journalMove(mv, mv.slot < 0 ? '점 찍기(추천)' : '추천대로')
      // 조각 하나를 놓을 때마다 남은 조각으로 다시 계산한다 (2026-10-04). 전에는 인식 보정이 있을 때만 우연히 다시 계산했는데,
      // 가상 플레이에서 조각마다 다시 계산하면 생존 145.5 → 169.5세트(+16%). 세트 중간은 계산 시간을 짧게 (midThinkMs)
      if (this.stepIdx < 3 && this.hand.some((h) => h.state === 'piece') && !this.plan?.steps.slice(this.stepIdx).some((s) => s.slot < 0)) this.requestSolve('조각을 놓아서')
      return
    }
    // 추천과 다르게 놓았다. 남은 조각으로 다시 계산한다
    const where = `${mv.shape.cells}칸 조각을 ↓${mv.r + 1}행 →${mv.c + 1}열에`
    if (this.solving) this.log('계산 중에 놓음', where)
    this.journalMove(mv, mv.slot < 0 ? '점 찍기' : this.solving ? '계산 중에' : '다른 자리')
    if (this.hand.some((h) => h.state === 'piece')) this.requestSolve(this.solving ? '계산이 끝나기 전에 놓아서' : '추천과 다른 자리에 놓아서')
    else { this.plans = []; this.stepIdx = 0 }
  }

  // ─── 아이콘 ──────────────────────────────────────────────────────────

  /** 아이콘은 반짝여서 프레임마다 보였다 안 보였다 한다. 두 번 보이면 있고, 한참 안 보여야 없다 */
  /** fresh: 판이 바뀌는 도중(기억한 판과 화면이 다를 때) 처음 나타난 아이콘 */
  /** under: 아이콘 밑이 블록(+)인지 빈칸(-)인지 프레임마다 쌓은 점수. 기억이 틀렸을 때 바로잡는 데 쓴다 */
  private iconTrack = new Map<number, { kind: Icon['kind']; seen: number; miss: number; fresh: boolean; under: number }>()

  private iconNeed = 2
  /**
   * 아이콘은 그 줄이 지워질 때(applyMove)나 판에 넷째가 생겨 가장 오래된 것이 밀려날 때만 없어진다.
   * 반짝여서 잠깐 안 보이는 건 사라진 게 아니다. 처음 보는 아이콘은 연달아 need번 보여야 인정하고,
   * 인정한 아이콘이 아주 오래(약 5초) 빈칸으로만 읽히면 그때서야 잘못 본 것으로 치고 지운다.
   */
  private trackIcons(cells: CellState[], B: Board, need: number, under?: Int8Array | null) {
    // under: 칸마다 '아이콘 밑이 블록인가' (vision underOf). null이면 이번 프레임은 판별하지 않는다.
    // 안 주면(테스트) 칸 상태에서 얻는다
    this.iconNeed = need
    let changed = false
    const changing = this.updatedAt > 0 && boardKey(B) !== boardKey(this.board)
    cells.forEach((st, i) => {
      const r = Math.floor(i / COLS), c = i % COLS
      const t = this.iconTrack.get(i)
      if (isIconState(st)) {
        const kind: Icon['kind'] = st.startsWith('icon-dot') ? 'dot' : 'swap'
        if (!t) {
          // 아이콘은 7번째 배치 직후에만, 빈칸에만 새로 생긴다(공지). 그 밖에 갑자기 보이는 '아이콘'은
          // 커서(흰 손) 등을 잘못 본 것이라 받지 않는다. 처음 맞출 때 이미 판에 있던 아이콘은 받는다.
          // 카운트를 알면 차례(spawnPending)일 때만 받는다. 전에는 '아무 배치 뒤 3초 안'이면 받아서
          // 놓은 직후 커서를 아이콘으로 자꾸 오인했다. 카운트를 모를 때(?)만 예전처럼 넓게 받는다
          const countKnown = this.nextAbility !== null && !this.nextUnsure
          const due = countKnown ? this.spawnPending : Date.now() - this.lastPlacedAt < 3000 || changing || this.spawnPending
          const why = !due ? (countKnown ? '아이콘 차례가 아님' : '놓은 직후가 아님')
            // 빈칸 조건은 카운트를 알 때만 본다. 다시 맞춘 직후엔 못 따라간 사이 밑에 블록이 채워진 아이콘도 있다
            : countKnown && (st.endsWith('-on') || (this.board[r] >> c) & 1) ? '빈칸이 아님' : ''
          // 7번째 배치 직후에는 판 변화를 확정(applyMove)하기 전 프레임에 아이콘이 먼저 보인다. 차례는 확정 뒤에
          // 켜지므로 그 사이는 조용히 넘기고 다음 프레임에 받는다 (기록이 '무시'로 어지럽지 않게)
          const adopting = this.adoptFrames > 0
          if (this.updatedAt && why && countKnown && changing && !adopting) return
          if (this.updatedAt && why && !adopting) {
            // 원래 판에 있던 아이콘(새로고침·화면 공유 다시 시작 뒤, 놓친 생성 등)은 차례와 상관없이 받아야 한다.
            // 커서와 구별하는 법: 조각을 놓을 때 커서는 놓은 자리로 가므로, 다른 칸에 놓는 동안에도 같은 칸에서
            // 계속 보이고 놓은 뒤 1.5초가 지나도 그대로면 커서가 아니라 진짜 아이콘이다. 카운트는 건드리지 않는다
            const now = Date.now()
            const l = this.lingering.get(i)
            if (!l) this.lingering.set(i, { firstAt: now, lastAt: now })
            else {
              l.lastAt = now
              if (l.firstAt < this.lastPlacedAt && now - this.lastPlacedAt > 1500) {
                this.lingering.delete(i)
                this.iconTrack.set(i, { kind, seen: need, miss: 0, fresh: false, under: 0 })
                changed = true
                this.log('있던 아이콘 받음', `↓${r + 1} →${c + 1} ${kind === 'dot' ? '점 찍기' : '바꿔 뽑기'} 놓는 동안에도 그대로`)
                return
              }
            }
            // 진짜 아이콘을 못 받으면 그 줄을 지워도 획득을 못 센다. 원인을 찾을 수 있게 칸마다 한 번 남긴다
            if (!this.ignoredIcons.has(i)) { this.ignoredIcons.add(i); this.log('아이콘 무시', `↓${r + 1} →${c + 1} ${why}`) }
            return
          }
          this.iconTrack.set(i, { kind, seen: 1, miss: 0, fresh: changing, under: 0 })
          if (need === 1) { changed = true; this.onNewIcon() }
          return
        }
        t.miss = 0
        if (t.seen < need && ++t.seen === need) {
          changed = true
          // 처음 맞출 때(새로고침·화면 공유 시작) 읽은 건 새로 생긴 게 아니라 원래 있던 아이콘이다. 기록에서 헷갈리지 않게 나눈다
          this.log(this.updatedAt ? '새 아이콘' : '판에 있던 아이콘', `↓${r + 1} →${c + 1} ${kind === 'dot' ? '점 찍기' : '바꿔 뽑기'}`)
          // 한 번에 하나만 생긴다. 같이 후보로 잡혔던 다른 칸(커서 등)은 버린다
          if (this.updatedAt && this.adoptFrames === 0) for (const [j, o] of this.iconTrack) if (j !== i && o.seen < need) this.iconTrack.delete(j)
          this.onNewIcon()
        }
        if (t.kind !== kind) { t.kind = kind; changed = true }
        if (t.seen >= need && under !== null) this.checkUnder(t, i, under ? under[i] : st.endsWith('-on') ? 2 : -1)
      } else if (t) {
        if (t.seen < need) { this.iconTrack.delete(i); return } // 한 번 보이고 만 것은 잘못 본 것
        if (under !== null && (st === 'empty' || st === 'block')) this.checkUnder(t, i, under ? under[i] : st === 'block' ? 2 : -1)
        if (st === 'empty' && !((B[r] >> c) & 1) && ++t.miss > 35) {
          this.iconTrack.delete(i)
          changed = true
          this.log('아이콘 지움', `↓${r + 1} →${c + 1} 오래 안 보임`)
        }
      }
    })
    if (this.adoptFrames > 0) this.adoptFrames--
    // 한동안(4초) 안 보인 후보는 버린다. 반짝임·미리보기로 잠깐 가려지는 건 견디고, 커서가 떠난 자리는 잊는다
    const now = Date.now()
    for (const [j, l] of this.lingering) if (now - l.lastAt > 4000 || this.iconTrack.has(j)) this.lingering.delete(j)
    // 판에는 아이콘이 셋까지만 있다. 넷째가 생기면 가장 먼저 생긴 것이 없어진다
    const confirmed = [...this.iconTrack].filter(([, t]) => t.seen >= need)
    if (confirmed.length > 3) {
      for (const [i] of confirmed.slice(0, confirmed.length - 3)) {
        this.iconTrack.delete(i)
        this.log('아이콘 밀려남', `↓${Math.floor(i / COLS) + 1} →${(i % COLS) + 1} 넷째가 생겨서`)
      }
      changed = true
    }
    if (changed) this.publishIcons()
  }

  /**
   * 아이콘 칸은 판 변화를 풀 때 '모름'으로 두고 기억한 값을 쓴다. 그 기억이 틀리면(막힌 칸을 뚫렸다고 아는 등)
   * 못 놓는 자리를 추천하므로, 아이콘 밑이 어떻게 읽히는지(vision underOf)를 쌓아 기억을 바로잡는다.
   *
   * 판별값은 2(분홍·노랑·초록 블록, 확실) · 1(파랑 블록) · -1(빈칸) · 0(모름). 캡처로 본 아이콘 칸 19개와 일반 칸
   * 2,057개에서 반짝임(밝기 0~80%)과 상관없이 틀린 적이 없어서, 같은 쪽으로 4점(두세 프레임~0.6초)이면 고친다.
   * 예전 판별(가장자리 채도)은 20%만 밝아져도 뒤집혀서, 실제 화면에서는 블록 위 아이콘을 계속 빈칸으로 알았다
   */
  private checkUnder(t: { under: number }, i: number, vote: number) {
    if (!this.updatedAt || !vote) return
    // 반대쪽 판별이 나오면 쌓던 걸 버리고 새로 센다 (한쪽으로 이어질 때만 고친다)
    t.under = Math.sign(t.under) === Math.sign(vote) ? Math.max(-8, Math.min(8, t.under + vote)) : vote
    const r = Math.floor(i / COLS), c = i % COLS
    const mem = (this.board[r] >> c) & 1
    const seen = t.under >= 4 ? 1 : t.under <= -4 ? 0 : -1
    if (seen < 0 || mem === seen) return
    t.under = 0
    const B = this.board.slice()
    B[r] ^= 1 << c
    this.board = B
    this.log('아이콘 칸 바로잡음', `↓${r + 1} →${c + 1} ${seen ? '빈칸 → 블록' : '블록 → 빈칸'}`)
    this.requestSolve('아이콘 칸 기억을 바로잡아서')
  }

  /** 마지막으로 조각을 놓은 때. 새 아이콘은 놓은 직후에만 생긴다 */
  private lastPlacedAt = 0
  /** 받지 않은 아이콘 후보가 처음·마지막으로 보인 때. 배치를 사이에 두고도 그대로면 원래 있던 아이콘이다 */
  private lingering = new Map<number, { firstAt: number; lastAt: number }>()
  /** '아이콘 무시'를 이미 기록한 칸. 배치마다 비운다 (같은 칸을 프레임마다 기록하지 않게) */
  private ignoredIcons = new Set<number>()
  /**
   * 새 아이콘이 나올 차례다 (7번째 배치를 마쳤거나, 카운트를 믿을 수 없을 때).
   * 놓자마자 다음 조각을 판 위에 올려 미리보기가 오래 떠 있으면 새 아이콘을 늦게 보게 되는데,
   * 차례인 동안은 시간이 지나도 받는다
   */
  private spawnPending = false

  /**
   * 새 아이콘이 생겼다 = 방금 7번째 배치였다. 단, 카운트를 7로 맞추는 건 카운트를 모를 때(다시 맞춤 뒤 `?`)만이다.
   * 전에는 놓은 직후 아이콘이 보이기만 하면 늘 7로 맞췄는데, 놓은 직후의 커서·반짝임을 새 아이콘으로 잘못 보면
   * 멀쩡히 세던 카운트가 자꾸 7로 초기화됐다. 배치 수는 확실히 세고 있으니 그걸 믿는다
   */
  private onNewIcon() {
    const pending = this.spawnPending
    this.spawnPending = false
    if (!this.updatedAt || (!pending && Date.now() - this.lastPlacedAt > 3000)) return
    if (!this.nextUnsure && this.nextAbility !== null) return
    this.nextUnsure = false
    if (this.nextAbility !== 7) {
      if (this.nextAbility !== null) this.log('능력 카운트 보정', `${this.nextAbility} → 7`)
      this.nextAbility = 7
    }
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
  private pendingWhy = ''

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
      this.journalSolve({ t: Date.now(), why: reason + ' (저장된 계산)', ms: 0, best: hit.plans[0]?.steps.map(stepText).join(' '), value: hit.plans[0] ? Math.round(hit.plans[0].value) : undefined })
      return
    }
    this.solveReason = reason
    this.log('계산', reason)
    this.pendingKey = key
    this.pendingWhy = reason
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
        heldAbilities: this.heldForSolve, swaps: this.swaps, dots: this.dots,
        weights: blendedWeights(this.pieceCounts, this.stage), stage: this.stage, style: this.style,
        // 세트 중간(조각을 놓은 뒤) 다시 계산은 짧게. 세트당 세 번 계산하니 2.5초씩이면 기다림이 길다
        budgetMs: reason === '조각을 놓아서' ? Math.min(this.thinkMs, 1200) : this.thinkMs,
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
      {
        const best = d.plans[0]
        const r = d.rescue
        this.journalSolve({
          t: Date.now(), why: this.pendingWhy, ms: Math.round(d.ms),
          best: best ? best.steps.map(stepText).join(' ') : undefined, value: best ? Math.round(best.value) : undefined,
          risk: best ? Math.round(best.risk * 100) / 100 : undefined, samples: best?.samples, gained: best?.gained,
          alt: d.plans.slice(1, 3).map((p) => `${Math.round(p.value)}: ${p.steps.map(stepText).join(' ')}`).join(' | ') || undefined,
          rescue: r ? (r.kind === 'dot' ? `점 찍기 ${r.r},${r.c} 이득 ${r.gain}` : `바꿔 뽑기 ${r.slot + 1}번 이득 ${r.gain}`) : undefined,
        })
      }
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
    if (step.slot < 0) return { flip: false, rot: 0, ok: true }
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

  /** 권장 설정으로 되돌린다 (성향 0.75 · 계산 2.5초) */
  useRecommended() {
    this.thinkMs = RECOMMENDED.thinkMs
    this.setStyle(RECOMMENDED.style)
  }
}

export const engine = new Engine()
