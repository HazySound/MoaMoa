# MoaMoa (메이플스토리 '한글 모아모아' 도우미)

이어서 작업하기 전에 **docs/HANDOFF.md를 먼저 읽는다** — 게임 규칙, 인식·추적 구조, 겪은 버그와 해결, 실험 결과, 다음 할 일이 있다.

## 규칙
- 사용자와는 한국어로. 코드 주석도 한국어로 '왜'를 적는다
- 변경 뒤: `npm test` → `npm run check` → 커밋 → `git push origin main`. 푸시하면 GitHub Actions(.github/workflows/deploy.yml)가 테스트 뒤 자동 배포한다
  - 사용자가 "플레이 중"이라고 하면 푸시하지 말고 로컬 커밋만 (푸시 = 배포)
- 버그 제보는 추측으로 원인을 단정하지 말고, 캡처를 test/fixtures에 넣어 재현 테스트부터 만든다
- 추적 로직(src/lib/engine.svelte.ts)을 고치면 test/engine.test.ts에 그 상황을 테스트로 남긴다
- 추천 엔진 가중치·능력 기준을 바꾸면 가상 플레이(scripts/sim-parallel.sh, 30판 이상)로 비교하고 결과를 주석에 남긴다
- `@cloudflare/vite-plugin`은 넣지 않는다 (vitest가 깨진다)
- 화면 숫자 OCR, 데스크톱 앱은 사용자가 원치 않는다
