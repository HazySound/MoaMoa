<script lang="ts">
  import type { Frame } from '../capture'
  import { cardBox, type Grid } from '../vision/read'
  import { COLS, ROWS } from '../core/board'

  /** 지금 읽고 있는 화면과 인식한 격자를 겹쳐 보여 준다. 인식이 어긋났는지 눈으로 확인하는 용도 */
  let { frame, grid }: { frame: Frame | null; grid: Grid | null } = $props()

  let canvas: HTMLCanvasElement | undefined = $state()

  $effect(() => {
    if (!canvas || !frame) return
    const { image, ox, oy } = frame
    canvas.width = image.width
    canvas.height = image.height
    const ctx = canvas.getContext('2d')!
    ctx.putImageData(image, 0, 0)
    if (!grid) return
    const g = { x: grid.x - ox, y: grid.y - oy, pitch: grid.pitch }
    ctx.lineWidth = Math.max(1, g.pitch / 18)
    ctx.strokeStyle = 'rgba(45,212,191,0.9)'
    ctx.strokeRect(g.x, g.y, COLS * g.pitch, ROWS * g.pitch)
    ctx.strokeStyle = 'rgba(45,212,191,0.35)'
    ctx.beginPath()
    for (let c = 1; c < COLS; c++) { ctx.moveTo(g.x + c * g.pitch, g.y); ctx.lineTo(g.x + c * g.pitch, g.y + ROWS * g.pitch) }
    for (let r = 1; r < ROWS; r++) { ctx.moveTo(g.x, g.y + r * g.pitch); ctx.lineTo(g.x + COLS * g.pitch, g.y + r * g.pitch) }
    ctx.stroke()
    ctx.strokeStyle = 'rgba(251,191,36,0.9)'
    for (let i = 0; i < 3; i++) {
      const b = cardBox(g, i)
      ctx.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0)
    }
  })
</script>

{#if frame}
  <canvas bind:this={canvas} class="h-auto max-h-[60vh] w-full rounded-xl object-contain"></canvas>
{:else}
  <div class="grid h-40 place-items-center rounded-xl bg-ink-900 text-sm text-ink-400">아직 받은 화면이 없어요</div>
{/if}
