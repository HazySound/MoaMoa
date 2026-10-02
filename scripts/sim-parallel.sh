#!/bin/bash
# 가중치·능력 규칙 실험을 병렬로 돌린다 (CPU 코어 수만큼 동시에).
#
#   scripts/sim-parallel.sh 결과파일 이름1 'W_JSON1' 이름2 'W_JSON2' ...
#
# 환경 변수는 그대로 넘어간다: GAMES SETS BEAM BUDGET OFFSET STYLE SMALL ADVICE ADV_JSON
# 예) 30판을 10판씩 3묶음으로 나눠 돌리려면 OFFSET=0,10,20 으로 세 번 부른다.
# 결과 한 줄: 이름 JSON AVG sets=.. score=.. abil=.. clears(1..5)=..
cd "$(dirname "$0")/.."
OUT="$1"; shift
while [ $# -gt 0 ]; do
  name="$1"; json="$2"; shift 2
  ( SIM=1 GAMES=${GAMES:-8} SETS=${SETS:-200} BEAM=${BEAM:-60} BUDGET=${BUDGET:-0} W_JSON="$json" \
      npx vitest run test/sim.test.ts --silent=false 2>&1 | grep AVG | sed "s|^|$name $json |" >> "$OUT" ) &
done
wait
