#!/bin/bash
# 가상 플레이를 한 번에 하나씩(병렬 없이) 돌린다. PC가 느리면 병렬은 부담이라 (2026-10-04 사용자 요청).
#   scripts/sim-single.sh 결과파일 이름1 'W_JSON1' 'ADV_JSON1' 이름2 'W_JSON2' 'ADV_JSON2' ...
# 환경 변수: GAMES(기본 4) SETS(300) BEAM(160) BUDGET(1000, 앱은 2500) STYLE(0.75)
# test/simlib.ts가 게임판 그 자체다: 10×16, 줄이 지워져도 안 내려옴, 3조각 세트, 조각 7개마다 아이콘(바꿔 60%·점 40%),
# 아이콘 줄을 지워야 획득, 최대 7개(7개면 공급 멈춤), 판에 아이콘 최대 3개, 점수 칸+300n²+능력 50, 실제 단계별 조각 빈도
cd "$(dirname "$0")/.."
OUT="$1"; shift
while [ $# -gt 0 ]; do
  name="$1"; wjson="$2"; ajson="$3"; shift 3
  SIM=1 REAL=1 ADVICE=1 GAMES=${GAMES:-4} SETS=${SETS:-300} BEAM=${BEAM:-160} BUDGET=${BUDGET:-1000} STYLE=${STYLE:-0.75} \
    W_JSON="$wjson" ADV_JSON="$ajson" npx vitest run test/sim.test.ts --silent=false 2>&1 | grep -E "AVG|Error|FAIL" | head -3 | sed "s|^|$name |" >> "$OUT"
done
echo DONE >> "$OUT"
