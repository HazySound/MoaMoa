/**
 * 게임 화면의 숫자 모양으로 능력 개수를 정한다 (점 찍기·바꿔 뽑기 개수, 다음 능력까지 N번).
 *
 * 왜 이렇게 하나 (2026-10-03):
 *   - 배치·아이콘을 따라가며 세면 오독 하나로 개수가 틀어지고 못 되돌린다 → 화면 숫자가 기준이다
 *   - 버튼 숫자(배지 글꼴)는 표본 대조로 못 읽는다. 같은 숫자도 화면 크기·자리에 따라 다르게 그려지고,
 *     4·5·7은 캡처가 없다. 표본에 없는 숫자를 못 읽으면 따라 세기로 돌아가 다시 틀어졌다 (보유 6개에서 틀어진 원인)
 *   → 숫자는 획 구조로 짐작하고(vision/digits guessDigit), '점 찍기 + 바꿔 뽑기 = 보유'로 검산한다.
 *     검산이 맞은 모양은 기억해 두고, 안 맞으면 덜 믿는 하나를 나머지 둘로 계산한다.
 *     그래도 못 정하면 값을 바꾸지 않고 '모름'만 알린다. 여기서 정한 값 말고는 아무도 개수를 바꾸지 않는다
 */
import { PANEL_DIST, PANEL_SHAPES, dist, matchShape, type Glyph, type GlyphReads } from '../vision/digits'

export type SpotName = 'dots' | 'swaps' | 'next' | 'held'
/** 기억한 모양: 어떤 숫자였고, 서로 다른 상황 몇 번에서 확인됐나 */
export interface Known { f: number[]; digit: number; ctx: string[]; art?: string }
export type Memory = Record<SpotName, Known[]>
export const emptyMemory = (): Memory => ({ dots: [], swaps: [], next: [], held: [] })

/** 같은 창에서 같은 숫자는 프레임마다 똑같이 그려진다. 이 안쪽이면 같은 모양이다 (다른 숫자는 5.9 이상) */
const SAME = 1.5
/** 구조 짐작이 캡처 표본으로 검증된 숫자. 나머지(배지 4·5·7, 판넬 3·6)는 캡처가 없어 덜 믿는다 */
const VALIDATED = { badge: [0, 1, 2, 3, 6], panel: [0, 1, 2, 4, 5, 7] }

/** 믿는 정도: 0 짐작(검증 안 된 숫자) · 1 짐작(검증된 숫자) · 2 검산으로 한 번 확인 · 3 확실 */
interface Belief { v: number; trust: number }
export interface CountEvent { what: string; detail: string }

interface Slot { cur: Glyph | null; n: number; none: number }
const FULL: Glyph = { f: [], guess: 7, art: '꽉 참' }

export class ScreenCounts {
  dots: number | null = null
  swaps: number | null = null
  next: number | null = null
  /** 화면 숫자를 보고도 개수를 정하지 못했다 (작은 창에 ?로 알린다) */
  unsure = false
  /** 이번 프레임에 버튼 숫자가 정해진 값 그대로 보이고 있다 */
  countsFresh = false
  /** 이번 프레임에 '다음 능력' 숫자가 정해진 값 그대로 보이고 있다 */
  nextFresh = false
  /** 이번 프레임의 버튼 숫자 짐작 (확정 전이라도). 사용을 받아들일지 볼 때 쓴다 */
  raw: { dots: number | null; swaps: number | null } = { dots: null, swaps: null }

  private slots: Record<SpotName, Slot> = { dots: { cur: null, n: 0, none: 0 }, swaps: { cur: null, n: 0, none: 0 }, next: { cur: null, n: 0, none: 0 }, held: { cur: null, n: 0, none: 0 } }
  /** 마지막으로 풀어 본 모양 조합 (같은 조합을 프레임마다 다시 풀지 않는다) */
  private solved: { dots: Glyph | null; swaps: Glyph | null; held: Glyph | null; ok: boolean } = { dots: null, swaps: null, held: null, ok: false }
  /** 마지막으로 값을 받아들였을 때의 버튼 모양 */
  private accepted: { dots: Glyph | null; swaps: Glyph | null } = { dots: null, swaps: null }
  private nextGlyph: Glyph | null = null
  private nextOk = false
  private occasion = 0

  constructor(public memory: Memory = emptyMemory(), private onLearn?: (m: Memory) => void) {}

  /** 화면을 처음부터 다시 본다 (새 화면 공유 등). 기억한 모양은 남긴다 */
  reset() {
    for (const s of Object.values(this.slots)) { s.cur = null; s.n = 0; s.none = 0 }
    this.solved = { dots: null, swaps: null, held: null, ok: false }
    this.nextGlyph = null
    this.accepted = { dots: null, swaps: null }
    this.nextOk = false
    this.dots = this.swaps = this.next = null
    this.unsure = this.countsFresh = this.nextFresh = false
  }

  /**
   * 프레임 하나의 숫자 모양을 넣는다. 같은 모양이 need번 이어져야 본다 (숫자가 바뀌는 중·커서가 지나가는 중 방지).
   * full: 보유 칸이 '능력이 가득 찼습니다'(주황)로 바뀌어 있다 = 보유 7
   */
  /** 꽉 참인데 버튼 숫자가 7에 안 맞는 프레임이 이어진 수 */
  private fullStuck = 0

  /**
   * hint: 최근에 얻은 능력 종류. 꽉 찼는데 버튼 숫자로 못 정하면 모자란 만큼 이쪽에 더한다
   */
  /** 방금(몇 초 안에) 판에서 아이콘 줄을 지워 얻은 능력 종류. 합을 맞출 때 '이쪽이 늘었다'는 근거가 된다 */
  private recentGain: 'dots' | 'swaps' | null = null

  /**
   * hint: 최근에 얻은 능력 종류 (null이면 최근 획득 없음). 꽉 찼는데 못 정하면 모자란 만큼 이쪽에 더하고,
   * 합을 맞출 때는 '이쪽이 늘고 다른 쪽은 그대로'인 가정을 먼저 본다 (틀린 기억보다 판에서 본 사실이 먼저다)
   */
  feed(r: GlyphReads, full: boolean, need: number, hint: 'dots' | 'swaps' | null = null): CountEvent[] {
    this.recentGain = hint
    const ev: CountEvent[] = []
    const step = (name: SpotName, g: Glyph | null) => {
      const s = this.slots[name]
      if (!g) { s.cur = null; s.n = 0; s.none++; return }
      s.none = 0
      if (s.cur && (g === FULL ? s.cur === FULL : s.cur !== FULL && dist(g.f, s.cur.f) < SAME)) s.n++
      else { s.cur = g; s.n = 1 }
    }
    step('dots', r.dots)
    step('swaps', r.swaps)
    step('held', full ? FULL : r.held)
    step('next', r.next)
    this.raw = { dots: r.dots ? this.belief('dots', r.dots).v : null, swaps: r.swaps ? this.belief('swaps', r.swaps).v : null }

    this.countsFresh = false
    const d = this.slots.dots, s = this.slots.swaps, h = this.slots.held
    if (d.cur && s.cur && d.n >= need && s.n >= need) {
      // 보유 칸: 모양이 자리 잡았거나, 한동안 아예 안 보일 때(가려짐)만 푼다. 바뀌는 중이면 기다린다
      const held = h.cur && h.n >= need ? h.cur : !h.cur && h.none >= need * 3 ? null : undefined
      if (held !== undefined) {
        if (this.solved.dots !== d.cur || this.solved.swaps !== s.cur || this.solved.held !== held) {
          this.solved = { dots: d.cur, swaps: s.cur, held, ok: this.solve(d.cur, s.cur, held, ev) }
          this.unsure = !this.solved.ok
        }
        this.countsFresh = this.solved.ok
      }
    }
    // 게임이 '능력이 가득 찼습니다'(주황)를 띄웠으면 7개인 게 확실하다. 버튼 숫자를 못 읽거나 못 정해서 합이 7이 안 되면
    // 모자란 만큼 최근에 얻은 쪽에 더해 7로 맞춘다. 전에는 "안 맞아요, 맞춰 주세요"라고만 하고 5개로 두었다
    if (h.cur === FULL && h.n >= need && !this.countsFresh && this.dots !== null && this.swaps !== null && this.dots + this.swaps < 7) {
      if (++this.fullStuck >= need * 3) {
        const gap = 7 - this.dots - this.swaps
        if ((hint ?? 'dots') === 'dots') this.dots += gap
        else this.swaps += gap
        this.unsure = false
        this.countsFresh = true
        this.fullStuck = 0
        ev.push({ what: '꽉 참에 맞춤', detail: `${(hint ?? 'dots') === 'dots' ? '점 찍기' : '바꿔 뽑기'} +${gap} → 점 찍기 ${this.dots} · 바꿔 뽑기 ${this.swaps} (버튼 숫자: ${d.cur ? '짐작 ' + d.cur.guess : '못 읽음'} · ${s.cur ? '짐작 ' + s.cur.guess : '못 읽음'})` })
      }
    } else this.fullStuck = 0

    this.nextFresh = false
    const n = this.slots.next
    if (n.cur && n.n >= need) {
      if (this.nextGlyph !== n.cur) {
        this.nextGlyph = n.cur
        const b = this.belief('next', n.cur)
        // 다음 능력은 7 → 1로 하나씩 줄고 1 다음은 7이다. 그 흐름에 맞으면 덜 믿는 짐작도 받는다
        const follows = this.next === null || b.v === this.next || b.v === (this.next <= 1 ? 7 : this.next - 1)
        this.nextOk = b.v >= 1 && (b.trust >= 1 || follows)
        if (this.nextOk) {
          if (b.trust < 3 && follows && this.next !== null) this.learn('next', n.cur, b.v, `#${this.occasion++}`)
          this.next = b.v
        } else ev.push({ what: '다음 능력 숫자 못 읽음', detail: `짐작 ${b.v} · 직전 ${this.next} · ${n.cur.art}` })
      }
      this.nextFresh = this.nextOk
    }
    return ev
  }

  /** 지금 보고 있는 모양과 기억한 모양을 글로 (기록 복사에 붙여서, 개수가 안 맞을 때 원인을 찾는다) */
  diagnose(): string {
    const now = (['dots', 'swaps', 'held', 'next'] as const).map((k) => {
      const s = this.slots[k]
      if (!s.cur) return `${k}: 안 보임(${s.none}프레임)`
      const b = this.belief(k, s.cur)
      return `${k}: 짐작 ${s.cur.guess} · 믿음 ${b.v}(${b.trust}) · ${s.n}프레임 · ${s.cur.art}`
    })
    const mem = (Object.keys(this.memory) as SpotName[]).flatMap((k) => this.memory[k].map((e) => `${k} ${e.digit} [${e.ctx.join(',')}] ${e.art ?? ''}`))
    return [`정한 값: 점 찍기 ${this.dots} · 바꿔 뽑기 ${this.swaps} · 다음 ${this.next} · ${this.unsure ? '못 정함' : '정함'}`, ...now, '기억한 모양:', ...mem].join('\n')
  }

  /** 버튼 두 숫자와 보유 숫자를 맞춰 개수를 정한다. 정했으면 true */
  private solve(dg: Glyph, sg: Glyph, hg: Glyph | null, ev: CountEvent[], retry = true): boolean {
    const D = this.belief('dots', dg), S = this.belief('swaps', sg)
    const H = hg ? this.belief('held', hg) : null
    const mark = (b: Belief) => `${b.v}${'??! '[b.trust]}`.trim()
    const say = () => `점 찍기 ${mark(D)} · 바꿔 뽑기 ${mark(S)} · 보유 ${H ? mark(H) : '안 보임'}`

    if (!H) {
      // 보유 칸이 안 보이면 검산을 못 한다. 이미 확인된 모양이거나, 직전 값에서 하나 차이인 짐작만 받는다
      const ok = (b: Belief, prev: number | null) => b.trust >= 2 || (b.trust >= 1 && prev !== null && Math.abs(b.v - prev) <= 1)
      if (ok(D, this.dots) && ok(S, this.swaps) && D.v + S.v <= 7) return this.accept(D.v, S.v, dg, sg)
      ev.push({ what: '화면 숫자 못 정함', detail: `${say()} · ${dg.art} · ${sg.art}` })
      return false
    }
    if (D.v + S.v === H.v) {
      const ctx = `${D.v}+${S.v}`
      this.learn('dots', dg, D.v, ctx)
      this.learn('swaps', sg, S.v, ctx)
      if (hg !== FULL) this.learn('held', hg!, H.v, ctx)
      return this.accept(D.v, S.v, dg, sg)
    }
    // 합이 안 맞는다: 셋 중 하나를 잘못 읽었다
    if (D.trust === 3 && S.trust === 3 && H.trust === 3) {
      // 확실하다고 기억한 것끼리 안 맞는다 → 기억이 틀렸다. 지우고 다음에 다시 배운다
      this.forget('dots', dg); this.forget('swaps', sg); if (hg !== FULL) this.forget('held', hg!)
      ev.push({ what: '화면 숫자 안 맞음', detail: `${say()} · 기억한 모양을 지움` })
      // 기억 없이 다시 푼다 (전에는 여기서 멈춰서, 화면이 바뀔 때까지 틀린 값에 머물렀다)
      return retry ? this.solve(dg, sg, hg, ev, false) : false
    }
    // '누가 틀렸나'를 가정별로 따진다. 말이 안 되는 가정(음수, 합이 7 초과, 확실한 걸 틀렸다고 하는 것)은 버리고,
    // 덜 믿는 쪽이 틀렸다는 가정 → 모양이 바뀐 버튼만 값이 바뀌는 가정 → 직전 값에서 덜 벗어나는 가정 순으로 고른다. 그래도 못 가르면 정하지 않는다
    const jump = (d: number, s: number) => (this.dots === null || this.swaps === null ? 0 : Math.abs(d - this.dots) + Math.abs(s - this.swaps))
    // 마지막으로 받아들인 뒤 모양이 그대로인 버튼은 값도 그대로고, 모양이 바뀐 버튼은 값도 바뀌었다. 어긋나는 가정은 덜 믿는다
    const odd = (k: 'dots' | 'swaps', g: Glyph, v: number) => {
      const a = this.accepted[k]
      if (!a || this[k] === null) return 0
      return (dist(a.f, g.f) < SAME) === (v === this[k]) ? 0 : 1
    }
    const hyps = [
      { who: 'held' as const, d: D.v, s: S.v, t: H.trust },
      { who: 'dots' as const, d: H.v - S.v, s: S.v, t: D.trust },
      { who: 'swaps' as const, d: D.v, s: H.v - D.v, t: S.trust },
    // 확실하다고 기억한 쪽을 틀렸다고 하는 가정은 보통 버리지만, 방금 얻은 종류가 늘었다는 가정은 기억보다 판에서 본 사실이 먼저라 남긴다
    ].filter((x) => (x.t < 3 || x.who === this.recentGain) && x.d >= 0 && x.s >= 0 && x.d + x.s <= 7)
      // 방금 점 찍기를 얻었으면 바꿔 뽑기는 그대로여야 한다 (반대도). 어긋나는 가정은 기억이 아무리 확실해도 뒤로 민다
      .map((x) => ({ ...x, hint: this.recentGain === 'dots' ? (x.s !== this.swaps ? 1 : 0) : this.recentGain === 'swaps' ? (x.d !== this.dots ? 1 : 0) : 0, odd: odd('dots', dg, x.d) + odd('swaps', sg, x.s), jump: jump(x.d, x.s) }))
      .sort((a, b) => a.hint - b.hint || a.t - b.t || a.odd - b.odd || a.jump - b.jump)
    const best = hyps[0], second = hyps[1]
    if (best && (!second || best.hint < second.hint || best.t < second.t || best.odd < second.odd || best.jump < second.jump)) {
      if (best.who === 'held') {
        if (hg !== FULL) this.learn('held', hg!, best.d + best.s, `${best.d}+${best.s}`)
      } else {
        const g = best.who === 'dots' ? dg : sg, v = best.who === 'dots' ? best.d : best.s
        ev.push({ what: '합으로 알아냄', detail: `${best.who === 'dots' ? '점 찍기' : '바꿔 뽑기'} ${v} (짐작은 ${(best.who === 'dots' ? D : S).v}) · ${say()} · ${g.art}` })
        this.learn(best.who, g, v, `=${H.v}-${best.who === 'dots' ? S.v : D.v}`)
      }
      return this.accept(best.d, best.s, dg, sg)
    }
    ev.push({ what: '화면 숫자 못 정함', detail: `${say()} · ${dg.art} · ${sg.art}${hg !== FULL ? ' · ' + hg!.art : ''}` })
    return false
  }

  private accept(d: number, s: number, dg: Glyph, sg: Glyph) {
    this.dots = d
    this.swaps = s
    this.accepted = { dots: dg, swaps: sg }
    return true
  }

  /** 이 모양을 무슨 숫자로, 얼마나 믿나 */
  private belief(spot: SpotName, g: Glyph): Belief {
    if (g === FULL) return { v: 7, trust: 3 }
    const panel = spot === 'next' || spot === 'held'
    // 판넬 글꼴은 표본 대조가 통한다. 표본과 구조 짐작이 같은 숫자를 가리키면 확실하다
    if (panel && matchShape(g.f, PANEL_SHAPES, PANEL_DIST) === g.guess) return { v: g.guess, trust: 3 }
    const k = this.memory[spot].find((e) => dist(e.f, g.f) < SAME)
    if (k) return { v: k.digit, trust: k.ctx.length >= 2 ? 3 : 2 }
    return { v: g.guess, trust: VALIDATED[panel ? 'panel' : 'badge'].includes(g.guess) ? 1 : 0 }
  }

  /** 검산으로 확인된 모양을 기억한다. 서로 다른 상황(ctx)에서 두 번 확인되면 확실한 것으로 친다 */
  private learn(spot: SpotName, g: Glyph, digit: number, ctx: string) {
    const list = this.memory[spot]
    const k = list.find((e) => dist(e.f, g.f) < SAME)
    if (k) {
      if (k.digit !== digit) { k.digit = digit; k.ctx = [ctx] }
      else if (!k.ctx.includes(ctx) && k.ctx.length < 3) k.ctx.push(ctx)
      else return
    } else {
      list.push({ f: g.f, digit, ctx: [ctx], art: g.art })
      if (list.length > 40) list.shift()
    }
    this.onLearn?.(this.memory)
  }

  private forget(spot: SpotName, g: Glyph) {
    const list = this.memory[spot]
    const i = list.findIndex((e) => dist(e.f, g.f) < SAME)
    if (i >= 0) { list.splice(i, 1); this.onLearn?.(this.memory) }
  }
}
