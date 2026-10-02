/**
 * 오른쪽 '보유 능력' 칸 숫자 읽기. 캡처마다 사람이 눈으로 읽은 값과 맞는지 본다.
 * 칸 36.6px(작은 창) · 48.8px(큰 창) 캡처가 섞여 있다.
 */
import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { describe, expect, test } from 'vitest'
import { detectGrid } from '../src/lib/vision/read'
import { PANEL_DIST, PANEL_SHAPES, matchShape, readGlyphs } from '../src/lib/vision/digits'
import { ScreenCounts } from '../src/lib/core/counts'

// [파일, 점 찍기, 바꿔 뽑기, 다음 능력, 보유 개수] — null: 그 자리에 숫자가 없다 (full: 능력 꽉 참 주황 칸)
export const truth: [string, number, number, number | null, number | null][] = [
  ['clearpreview', 0, 1, 2, 1], ['count-off', 3, 2, 2, 5], ['cursor', 1, 3, 1, 4], ['empty3', 0, 0, 7, 0],
  ['full', 1, 6, null, null], ['icon-over1', 1, 1, 2, 2], ['icon-over2', 1, 3, 1, 4], ['icons-missing', 3, 2, 4, 5],
  ['play1', 0, 0, 1, 0], ['play2', 0, 0, 7, 0], ['play3', 0, 1, 4, 1], ['stuck-dot', 0, 0, 2, 0],
  ['hover1', 0, 1, 4, 1], ['hover2', 0, 1, 4, 1],
]

const load = (file: string) => {
  const img = PNG.sync.read(readFileSync(`test/fixtures/${file}.png`)) as any
  return { img, g: detectGrid(img)! }
}

describe('숫자 모양: 획 구조로 짐작', () => {
  for (const [file, dots, swaps, next, held] of truth) {
    test(file, () => {
      const { img, g } = load(file)
      const r = readGlyphs(img, g)
      // 배지 글꼴(점 찍기·바꿔 뽑기)과 판넬 글꼴(다음 능력·보유) 모두 같은 규칙으로 맞아야 한다
      expect([r.dots?.guess ?? null, r.swaps?.guess ?? null, r.next?.guess ?? null, r.held?.guess ?? null]).toEqual([dots, swaps, next, held])
    })
  }

  test('판넬 글꼴은 표본 대조도 같은 숫자를 가리킨다 (틀린 숫자를 가리키는 일은 없다)', () => {
    for (const [file, , , next, held] of truth) {
      const { img, g } = load(file)
      const r = readGlyphs(img, g)
      for (const [gl, want] of [[r.next, next], [r.held, held]] as const) {
        if (!gl) continue
        const m = matchShape(gl.f, PANEL_SHAPES, PANEL_DIST)
        expect(m === null || m === want, `${file}: 표본 ${m}, 정답 ${want}`).toBe(true)
      }
    }
  })

  test('숫자가 없는 화면(능력 꽉 참 주황 칸)에서는 모양을 잡지 않는다', () => {
    const { img, g } = load('full')
    const r = readGlyphs(img, g)
    expect(r.next).toBeNull()
    expect(r.held).toBeNull()
    expect(r.why.next).toContain('바탕색')
  })
})

describe('캡처 한 장으로 개수 정하기', () => {
  for (const [file, dots, swaps, next, held] of truth) {
    test(file, () => {
      const { img, g } = load(file)
      const sc = new ScreenCounts()
      const ev = sc.feed(readGlyphs(img, g), held === null, 1)
      expect(ev).toEqual([])
      expect([sc.dots, sc.swaps, sc.next]).toEqual([dots, swaps, next])
      expect(sc.unsure).toBe(false)
    })
  }
})

/** 화면 크기가 달라져도(게임 창 크기, 화면 공유 해상도) 구조 짐작이 유지되는지: 캡처를 늘리고 줄여서 본다 */
function resize(img: any, k: number) {
  const W = Math.round(img.width * k), H = Math.round(img.height * k)
  const data = new Uint8Array(W * H * 4)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const sx = Math.min(img.width - 1.001, Math.max(0, (x + 0.5) / k - 0.5)), sy = Math.min(img.height - 1.001, Math.max(0, (y + 0.5) / k - 0.5))
    const xa = Math.floor(sx), ya = Math.floor(sy), fx = sx - xa, fy = sy - ya
    for (let c = 0; c < 4; c++) {
      const a = img.data[(ya * img.width + xa) * 4 + c], b = img.data[(ya * img.width + xa + 1) * 4 + c]
      const d = img.data[((ya + 1) * img.width + xa) * 4 + c], e = img.data[((ya + 1) * img.width + xa + 1) * 4 + c]
      data[(y * W + x) * 4 + c] = Math.round(a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + d * (1 - fx) * fy + e * fx * fy)
    }
  }
  return { width: W, height: H, data }
}

describe('화면 크기가 달라도 구조 짐작이 같다', () => {
  for (const k of [0.8, 0.9, 1.33, 1.75]) {
    test(`${k}배`, () => {
      const wrong: string[] = []
      for (const [file, ...vals] of truth) {
        const { img, g } = load(file)
        const r = readGlyphs(resize(img, k) as any, { x: (g.x + 0.5) * k - 0.5, y: (g.y + 0.5) * k - 0.5, pitch: g.pitch * k })
        ;[r.dots, r.swaps, r.next, r.held].forEach((gl, i) => { if ((gl?.guess ?? null) !== vals[i]) wrong.push(`${file} ${i}번 자리: ${vals[i]} → ${gl?.guess ?? '못 잡음'}`) })
      }
      expect(wrong).toEqual([])
    }, 120_000)
  }
})

describe('캡처가 없는 버튼 숫자 4·5·7', () => {
  // 버튼 글꼴은 7세그먼트식이다 (캡처로 본 0·3·6이 그렇다). 같은 방식으로 그린 4·5·7을 규칙이 가르는지 본다.
  // 실제 모양이 다르면 counts가 합으로 알아내고 배운다. 여기서는 규칙이 흔한 모양에서 틀리지 않는 것만 지킨다
  const seg = (rows: string[]) => ({ w: rows[0].length, h: rows.length, data: Float32Array.from(rows.join('').split('').map((c) => (c === '#' ? 1 : 0))) })
  const shapes: [number, string, string[]][] = [
    [4, '열린 모양', ['##....##', '##....##', '##....##', '##....##', '##....##', '########', '......##', '......##', '......##', '......##', '......##']],
    [4, '대각선', ['.....###', '....####', '...##.##', '..##..##', '.##...##', '##....##', '########', '########', '......##', '......##', '......##']],
    [5, '갈고리', ['.######.', '##......', '##......', '##......', '#######.', '......##', '......##', '......##', '......##', '##....##', '.######.']],
    [5, '갈고리 없음', ['########', '##......', '##......', '##......', '#######.', '......##', '......##', '......##', '......##', '......##', '#######.']],
    [7, '대각선', ['########', '......##', '......##', '.....##.', '.....##.', '....##..', '....##..', '...##...', '...##...', '...##...', '...##...']],
    [7, '세로', ['.######.', '##....##', '......##', '......##', '......##', '......##', '......##', '......##', '......##', '......##', '......##']],
  ]
  for (const [d, name, rows] of shapes) test(`${d} (${name})`, async () => {
    const { guessDigit } = await import('../src/lib/vision/digits')
    expect(guessDigit(seg(rows))).toBe(d)
  })
})
