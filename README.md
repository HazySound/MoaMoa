# 모아모아 도우미

메이플스토리 미니게임 **한글 모아모아** 화면을 브라우저 화면 공유로 읽어서, 보유 조각 세 개를
어떤 순서·방향·자리에 놓으면 좋은지 추천하는 웹 도구.

- 화면 인식: 판(10×16)과 보유 조각 카드를 색으로 읽는다. 배치 미리보기·줄 강조·커서·게임 오버 창을 걸러 낸다
- 추천: 놓는 순서 × 회전·반전 × 위치를 빔 탐색으로 훑고, 다음 세트에 19종 조각이 들어갈 자리가 남는지까지 평가한다
- 모든 처리는 브라우저 안에서 한다. 화면을 서버로 보내지 않는다

## 개발

```sh
npm install
npm run dev        # http://localhost:5174
npm test           # 인식(test/fixtures 캡처) · 규칙 · 추천 테스트
SIM=1 npx vitest run test/sim.test.ts   # 가상 플레이로 추천 성능 재기
npm run deploy     # 빌드 후 Cloudflare Pages(moamoa)로 올린다
```

## 구조

```
src/lib/core/     판·조각 규칙(board), 조각 19종(pieces), 추천 엔진(solver)
src/lib/vision/   캡처에서 판·카드 읽기(read)
src/lib/capture.ts      화면 공유 프레임 받기
src/lib/engine.svelte.ts 읽기 → 상태 추적 → 추천 잇기
src/lib/solver.worker.ts 추천 계산 워커
```
