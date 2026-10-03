/**
 * 화면 숫자 모양으로 개수 정하기 (core/counts.ts). 가짜 모양으로 상황을 만든다:
 * 모양은 숫자마다 뚜렷이 다르고, guess는 '획 구조 짐작'이 낸 값이다 (틀리게도 만들 수 있다).
 */
import { describe, expect, test } from 'vitest'
import { ScreenCounts } from '../src/lib/core/counts'
import type { Glyph, GlyphReads } from '../src/lib/vision/digits'

/** 숫자 shape처럼 생긴 모양. guess를 따로 주면 구조 짐작이 틀린 경우다 */
const gl = (shape: number, guess = shape): Glyph => {
  const f = new Array(36).fill(0)
  f[shape] = 10
  return { f, guess, art: `모양${shape}` }
}
const reads = (dots: Glyph | null, swaps: Glyph | null, held: Glyph | null, next: Glyph | null = null): GlyphReads => ({ dots, swaps, held, next, why: {} })
const feed = (sc: ScreenCounts, r: GlyphReads, full = false, n = 3) => {
  const ev = []
  for (let i = 0; i < n; i++) ev.push(...sc.feed(r, full, 3))
  return ev
}

describe('화면 숫자로 개수 정하기', () => {
  test('같은 모양이 3프레임 이어져야 받아들인다', () => {
    const sc = new ScreenCounts()
    feed(sc, reads(gl(3), gl(2), gl(5)), false, 2)
    expect(sc.dots).toBeNull()
    feed(sc, reads(gl(3), gl(2), gl(5)), false, 1)
    expect([sc.dots, sc.swaps]).toEqual([3, 2])
    expect(sc.countsFresh).toBe(true)
  })

  test('보유가 꽉 차면(주황 칸) 보유 7로 검산한다', () => {
    const sc = new ScreenCounts()
    feed(sc, reads(gl(1), gl(6), null), true)
    expect([sc.dots, sc.swaps, sc.unsure]).toEqual([1, 6, false])
  })

  test('처음 보는 숫자를 구조 짐작이 틀려도, 합으로 알아내고 그 모양을 배운다 (보유 6개에서 틀어지던 원인)', () => {
    const sc = new ScreenCounts()
    feed(sc, reads(gl(3), gl(2), gl(5)))
    // 점 찍기를 하나 얻어 4가 됐다. 버튼의 4는 처음 보는 모양이고 구조 짐작은 7이라고 한다. 보유는 6
    const four = gl(4, 7)
    const ev = feed(sc, reads(four, gl(2), gl(6)))
    expect([sc.dots, sc.swaps, sc.unsure]).toEqual([4, 2, false])
    expect(ev.map((e) => e.what)).toEqual(['합으로 알아냄'])
    // 그다음부터는 그 모양을 4로 안다: 바꿔 뽑기도 같이 바뀌어도 맞춘다
    feed(sc, reads(four, gl(3), gl(7, 7)), true)
    expect([sc.dots, sc.swaps]).toEqual([4, 3])
    // 보유 칸이 안 보여도 (가려짐) 배운 모양이면 받는다
    feed(sc, reads(gl(3), gl(3), gl(6)))
    feed(sc, reads(four, gl(3), null), false, 12)
    expect([sc.dots, sc.swaps, sc.unsure]).toEqual([4, 3, false])
  })

  test('꽉 찼는데 버튼 숫자를 못 읽거나 못 정하면, 최근에 얻은 쪽에 더해 7로 맞춘다 (게임 7개·도우미 5개로 멈추던 문제)', () => {
    const sc = new ScreenCounts()
    feed(sc, reads(gl(3), gl(2), gl(5)))
    // 꽉 찼는데 버튼이 안 읽힌다 (예: 버튼이 반짝임)
    const ev = []
    for (let i = 0; i < 12; i++) ev.push(...sc.feed(reads(null, null, null), true, 3, 'swaps'))
    expect([sc.dots, sc.swaps, sc.unsure]).toEqual([3, 4, false])
    expect(ev.map((e) => e.what)).toEqual(['꽉 참에 맞춤'])
    // 버튼이 읽히지만 짐작이 틀려 합이 안 맞으면, 꽉 참(7)이 확실하니 덜 믿는 쪽을 7에서 뺀 값으로 정한다
    const sc2 = new ScreenCounts()
    feed(sc2, reads(gl(3), gl(2), gl(5)))
    for (let i = 0; i < 12; i++) sc2.feed(reads(gl(4, 7), gl(3), null), true, 3, 'dots')
    expect([sc2.dots, sc2.swaps, sc2.unsure]).toEqual([4, 3, false])
  })

  test('방금 점 찍기를 얻었으면, 틀린 기억 때문에 합이 안 맞아도 바꿔 뽑기는 그대로 두고 점 찍기를 올린다 (기록 17:55: ⇄0이 ⇄1로 되던 문제)', () => {
    const sc = new ScreenCounts()
    feed(sc, reads(gl(5), gl(0), gl(5)))
    // 점 찍기 6 모양을 전에 5로 잘못 기억해 뒀다 (확실하다고까지). 보유 6 모양도 확실히 안다
    sc.memory.dots.push({ f: gl(6).f, digit: 5, ctx: ['a', 'b'] })
    sc.memory.held.push({ f: gl(6).f, digit: 6, ctx: ['a', 'b'] })
    // 아이콘 줄을 지워 점 찍기를 얻었다 (판에서 본 사실). 화면: 점 찍기 6 · 바꿔 뽑기 0 · 보유 6
    for (let i = 0; i < 3; i++) sc.feed(reads(gl(6), gl(0), gl(6)), false, 3, 'dots')
    expect([sc.dots, sc.swaps]).toEqual([6, 0])
    // 틀린 기억은 그 자리에서 고쳐진다
    expect(sc.memory.dots.find((e) => e.f[6] === 10)?.digit).toBe(6)
  })

  test('못 정하면 값을 바꾸지 않고 모름만 알린다', () => {
    const sc = new ScreenCounts()
    feed(sc, reads(gl(3), gl(2), gl(5)))
    // 두 버튼이 한꺼번에 처음 보는 모양으로 바뀌고 합도 안 맞는다
    const ev = feed(sc, reads(gl(4, 7), gl(5, 3), gl(1)))
    expect([sc.dots, sc.swaps]).toEqual([3, 2])
    expect(sc.unsure).toBe(true)
    expect(sc.countsFresh).toBe(false)
    expect(ev.map((e) => e.what)).toEqual(['화면 숫자 못 정함'])
    // 다시 읽히면 풀린다
    feed(sc, reads(gl(3), gl(2), gl(5)))
    expect(sc.unsure).toBe(false)
  })

  test('버튼이 가려진 동안(모양 없음)은 값을 그대로 둔다', () => {
    const sc = new ScreenCounts()
    feed(sc, reads(gl(3), gl(2), gl(5)))
    feed(sc, reads(null, gl(2), gl(5)), false, 20)
    expect([sc.dots, sc.swaps, sc.unsure]).toEqual([3, 2, false])
    expect(sc.countsFresh).toBe(false)
  })

  test('보유 숫자를 잘못 짐작해도, 확인된 두 버튼을 믿는다', () => {
    const sc = new ScreenCounts()
    feed(sc, reads(gl(1), gl(1), gl(2)))
    feed(sc, reads(gl(1), gl(2), gl(3)))
    feed(sc, reads(gl(2), gl(2), gl(4)))
    feed(sc, reads(gl(2), gl(1), gl(3)))
    // 판넬의 6은 캡처가 없는 숫자다. 구조 짐작이 3이라고 틀려도 버튼 2 + 1... 이 아니라 확인된 3 + 3을 믿는다
    feed(sc, reads(gl(3), gl(2), gl(5)))
    feed(sc, reads(gl(3), gl(3), gl(6, 3)))
    expect([sc.dots, sc.swaps, sc.unsure]).toEqual([3, 3, false])
  })

  test('기억한 모양끼리 합이 안 맞으면 기억을 지우고 다시 배운다', () => {
    const sc = new ScreenCounts()
    // 잘못 배운 기억: 모양 4를 5로 (서로 다른 상황 두 번 = 확실)
    sc.memory.dots.push({ f: gl(4).f, digit: 5, ctx: ['a', 'b'] })
    sc.memory.swaps.push({ f: gl(2).f, digit: 2, ctx: ['a', 'b'] })
    sc.memory.held.push({ f: gl(6).f, digit: 6, ctx: ['a', 'b'] })
    const ev = feed(sc, reads(gl(4), gl(2), gl(6)))
    expect(ev.map((e) => e.what)).toEqual(['화면 숫자 안 맞음'])
    // 틀린 기억을 지우고 그 자리에서 다시 풀어, 구조 짐작(4) + 2 = 6으로 맞춘다
    expect([sc.dots, sc.swaps, sc.unsure]).toEqual([4, 2, false])
    expect(sc.memory.dots.map((e) => e.digit)).toEqual([4])
  })

  test('꽉 찼는데 기억한 모양끼리 합이 6이면, 틀린 기억을 지우고 바로 다시 풀어 7로 맞춘다 (꽉 참인데 6개로 멈추던 문제)', () => {
    const sc = new ScreenCounts()
    // 버튼의 4 모양을 3으로 잘못 기억하고 있다 (확실하다고까지 믿는다)
    sc.memory.dots.push({ f: gl(4).f, digit: 3, ctx: ['a', 'b'] })
    sc.memory.swaps.push({ f: gl(3).f, digit: 3, ctx: ['a', 'b'] })
    const ev = feed(sc, reads(gl(4), gl(3), null), true)
    expect(ev.map((e) => e.what)).toEqual(['화면 숫자 안 맞음'])
    expect([sc.dots, sc.swaps, sc.unsure]).toEqual([4, 3, false])
  })

  test('꽉 찼는데 어느 버튼이 틀렸는지 동점이면, 모양이 바뀐 버튼의 값이 바뀐 것으로 본다', () => {
    const sc = new ScreenCounts()
    feed(sc, reads(gl(3), gl(3), gl(6)))
    expect([sc.dots, sc.swaps]).toEqual([3, 3])
    // 버튼의 4 모양을 3으로 한 번 잘못 배운 적이 있다. 점 찍기를 얻어 4 + 3 = 7(꽉 참)이 됐다
    sc.memory.dots.push({ f: gl(4).f, digit: 3, ctx: ['a'] })
    feed(sc, reads(gl(4), gl(3), null), true)
    expect([sc.dots, sc.swaps, sc.unsure]).toEqual([4, 3, false])
  })

  test('다음 능력: 흐름(7 → 6 → … → 1 → 7)에 맞으면 처음 보는 모양도 받고 배운다', () => {
    const sc = new ScreenCounts()
    const b = reads(gl(0), gl(0), gl(0))
    feed(sc, { ...b, next: gl(7) })
    expect(sc.next).toBe(7)
    // 판넬의 6은 캡처가 없는 숫자지만 7 다음이라 받는다
    feed(sc, { ...b, next: gl(6) })
    expect(sc.next).toBe(6)
    feed(sc, { ...b, next: gl(5) })
    feed(sc, { ...b, next: gl(4) })
    // 3도 캡처가 없다. 구조 짐작이 엉뚱한 6을 내면(4 다음이 아니다) 받지 않는다
    const ev = feed(sc, { ...b, next: gl(3, 6) })
    expect(sc.next).toBe(4)
    expect(sc.nextFresh).toBe(false)
    expect(ev.map((e) => e.what)).toEqual(['다음 능력 숫자 못 읽음'])
  })
})
