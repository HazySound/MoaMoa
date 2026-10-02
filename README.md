# 모아모아 도우미

메이플스토리 미니게임 **한글 모아모아** 화면을 브라우저 화면 공유로 읽어서, 보유 조각 세 개를
어떤 순서·방향·자리에 놓으면 좋은지 추천하는 웹 도구. https://moamoa.cemigs1.workers.dev

- 화면 인식: 판(10×16)·보유 조각 카드·능력 아이콘을 색으로 읽는다. 배치 미리보기·줄 강조·커서·아이콘 반짝임을 걸러 낸다
- 추적: 세트마다 추천을 한 번 계산해 고정하고, 판 변화가 손의 조각 배치로 풀릴 때만 따라간다
- 추천: 놓는 순서 × 회전·반전 × 위치를 빔 탐색하고, 남은 시간 동안 다음 세트를 가상 플레이해 고른다.
  능력(바꿔 뽑기·점 찍기)을 언제 쓸지도 알려 준다
- 작은 창(PiP): 게임 위에 늘 떠 있는 창에서 실제 화면 위 배치 표시와 설정
- 모든 처리는 브라우저 안에서 한다. 화면을 서버로 보내지 않는다

**이어서 작업할 때는 [docs/HANDOFF.md](docs/HANDOFF.md)부터.**

## 개발

```sh
npm install
npm run dev        # http://localhost:5174
npm test           # 인식(test/fixtures 캡처) · 추적 · 규칙 · 추천 테스트
npm run check      # 타입 검사
npm run deploy     # 빌드 후 Cloudflare Workers(moamoa)로 올린다 (처음엔 npx wrangler login)

SIM=1 GAMES=10 npx vitest run test/sim.test.ts       # 가상 플레이로 추천 성능 재기
scripts/sim-parallel.sh out.txt base '{}' p1 '{"p1":200}'   # 가중치 실험 병렬
```

## 구조

```
src/lib/core/       판·조각 규칙(board), 조각 19종(pieces), 추천 엔진(solver), 판 변화 풀기(track), 통계(stats)
src/lib/vision/     캡처에서 판·카드·아이콘 읽기(read)
src/lib/engine.svelte.ts   읽기 → 추적 → 추천을 잇는 상태
src/lib/pip.svelte.ts      작은 창
src/lib/components/        화면 조각들
test/                      테스트, 가상 플레이(simlib)
docs/                      인수인계 노트, 실제 조각 통계
```
