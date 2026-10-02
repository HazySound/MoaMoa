/**
 * 나오는 조각 19종.
 *
 * 공식 안내에는 목록이 없다. 다른 이용자가 정리한 표(블록 선택 19종)를 옮겨 왔고,
 * 게임 캡처에서 읽은 조각들과 모두 맞는지 test/vision.test.ts에서 확인한다.
 * 이름은 게임 카드 왼쪽 위 동그라미에 적힌 글자다. 모르는 것은 칸 수로 부른다.
 *
 * 조각이 꼭 한 덩어리로 붙어 있지는 않다(ㅅ, ㅊ처럼 대각선으로만 닿는 칸이 있다).
 */

import { canonicalKey, orientations, parseShape, type Orientation, type Shape } from './board'

export interface PieceDef {
  id: number
  name: string
  color: 'pink' | 'green' | 'blue' | 'yellow'
  shape: Shape
}

const raw: [id: number, name: string, color: PieceDef['color'], rows: string][] = [
  [1, '점', 'pink', '#'],
  [2, 'ㅅ', 'green', '.#.\n#.#'],
  [3, 'ㅡ', 'blue', '###'],
  [4, 'ㄱ3', 'pink', '#.\n##'],
  [5, 'ㄱ', 'pink', '###\n#..'],
  [6, 'ㅗ', 'blue', '.#.\n###'],
  [7, 'ㅇ', 'green', '.#.\n#.#\n.#.'],
  [8, 'ㄷ', 'pink', '##\n#.\n##'],
  [9, 'ㅣ', 'blue', '#####'],
  [16, 'ㅈ', 'green', '###\n.#.\n#.#'],
  [17, 'ㅋ', 'yellow', '##\n.#\n##\n.#'],
  [14, 'ㅏ', 'green', '#.\n##\n#.\n##\n#.'],
  [19, 'ㅊ', 'yellow', '.#.\n###\n.#.\n#.#'],
  [15, 'ㅁ', 'green', '###\n#.#\n###'],
  [10, 'ㄹ', 'pink', '##.\n.#.\n##.\n#..\n##.'],
  [11, 'ㅌ', 'yellow', '##\n#.\n##\n#.\n##'],
  [18, 'ㅎ', 'green', '..#..\n#####\n.#.#.\n..#..'],
  [12, 'ㅂ', 'green', '#.#\n###\n#.#\n###'],
  [13, 'ㅐ', 'blue', '#.#\n###\n###\n#.#'],
]

export const PIECES: PieceDef[] = raw
  .map(([id, name, color, rows]) => ({ id, name, color, shape: parseShape(rows) }))
  .sort((a, b) => a.shape.cells - b.shape.cells || a.id - b.id)

const byCanon = new Map(PIECES.map((p) => [canonicalKey(p.shape), p]))

/** 화면에서 읽은 모양이 어느 조각인지. 회전·반전된 상태여도 찾는다 */
export function identify(s: Shape): PieceDef | null {
  return byCanon.get(canonicalKey(s)) ?? null
}

/** 조각별 가능한 방향들. 탐색 중에 계속 쓰므로 미리 만들어 둔다 */
export const PIECE_ORIENTS: Map<number, Shape[]> = new Map(
  PIECES.map((p) => [p.id, orientations(p.shape).map((o: Orientation) => o.shape)]),
)

/**
 * 조각 등장 확률. 공식 수치는 비공개라서 처음에는 모두 같다고 두고, 단계가 오를수록
 * 칸 수 적은 조각이 덜 나온다는 안내만 반영한다. 실제 플레이에서 본 조각을 세서
 * (stats.ts) 쌓이면 그 빈도로 바꿔 쓴다.
 */
export function defaultWeights(stage: number): Map<number, number> {
  const w = new Map<number, number>()
  for (const p of PIECES) {
    const small = Math.max(0, 6 - p.shape.cells) // 1칸 → 5, 5칸 이상 → 0
    w.set(p.id, Math.max(0.15, 1 - small * 0.08 * (stage - 1)))
  }
  const total = [...w.values()].reduce((a, b) => a + b, 0)
  for (const [k, v] of w) w.set(k, v / total)
  return w
}

/** 지운 줄 누적 수로 단계를 정한다 (공식 안내 표) */
export function stageOf(lines: number): number {
  if (lines <= 30) return 1
  if (lines <= 60) return 2
  if (lines <= 100) return 3
  if (lines <= 150) return 4
  return 5
}
