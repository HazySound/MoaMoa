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
  test: { include: ['test/**/*.test.ts'] },
})
