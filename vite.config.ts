/// <reference types="vitest/config" />
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import Icons from 'unplugin-icons/vite'
import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'

/** 화면 구석에 찍을 빌드 표시. 제보를 받을 때 어느 판을 보고 있는지 알아야 한다. */
function buildTag(): string {
  const date = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10)
  let sha = ''
  try { sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch { /* git이 없다 */ }
  return sha ? `${date} · ${sha}` : date
}

export default defineConfig({
  plugins: [svelte(), tailwindcss(), Icons({ compiler: 'svelte' })],
  define: { __BUILD__: JSON.stringify(buildTag()) },
  worker: { format: 'es' },
  server: { port: 5174, strictPort: true },
  // 엔진 테스트는 추천 계산을 여러 번 돌려서, 가상 플레이가 같이 돌 때는 5초를 넘긴다
  // ANALYSIS=1이면 scripts/analysis의 분석 스크립트(조각 조합 열거, 띠 모델)도 돌린다: ANALYSIS=1 npx vitest run scripts/analysis
  test: { include: process.env.ANALYSIS ? ['scripts/analysis/**/*.test.ts'] : ['test/**/*.test.ts'], testTimeout: 20000 },
})
