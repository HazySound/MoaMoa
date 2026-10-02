/**
 * 판 변화를 '어떤 조각을 어디에 놓았다'로 풀어낸다.
 *
 * 화면은 커서, 아이콘 반짝임, 배치 미리보기 때문에 프레임마다 조금씩 다르게 읽힌다.
 * 그런 흔들림에 추천이 휘둘리지 않도록, 판이 바뀌었다고 믿는 건 그 변화가 손에 든
 * 조각 하나를 놓은 결과(줄 지우기 포함)와 정확히 같을 때뿐이다.
 */
import { type Board, type Shape, boardKey, canPlace, orientations, place, COLS, ROWS } from './board'

export interface Move {
  /** 손의 몇 번째 카드인지. 점 찍기는 -1 */
  slot: number
  shape: Shape
  r: number
  c: number
  cleared: number[]
}

const DOT: Shape = { w: 1, h: 1, rows: [1], cells: 1, key: '1x1:1' }

export function explainMove(prev: Board, next: Board, hand: { slot: number; shape: Shape }[], allowDot: boolean): Move | null {
  const target = boardKey(next)
  const tries = [...hand.map((h) => ({ slot: h.slot, orients: orientations(h.shape).map((o) => o.shape) }))]
  if (allowDot) tries.push({ slot: -1, orients: [DOT] })
  for (const { slot, orients } of tries) {
    for (const s of orients) {
      for (let r = 0; r + s.h <= ROWS; r++) for (let c = 0; c + s.w <= COLS; c++) {
        if (!canPlace(prev, s, r, c)) continue
        const res = place(prev, s, r, c)
        if (boardKey(res.board) === target) return { slot, shape: s, r, c, cleared: res.cleared }
      }
    }
  }
  return null
}
