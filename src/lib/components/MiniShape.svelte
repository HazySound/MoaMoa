<script lang="ts">
  import type { Shape } from '../core/board'

  let { shape, color = 'var(--color-ink-300)', cell = 10, gap = 2 }: {
    shape: Shape
    color?: string
    cell?: number
    gap?: number
  } = $props()

  const step = $derived(cell + gap)
  const cells = $derived.by(() => {
    const out: [number, number][] = []
    for (let r = 0; r < shape.h; r++) for (let c = 0; c < shape.w; c++) if ((shape.rows[r] >> c) & 1) out.push([r, c])
    return out
  })
</script>

<svg
  width={shape.w * step - gap}
  height={shape.h * step - gap}
  viewBox="0 0 {shape.w * step - gap} {shape.h * step - gap}"
  aria-hidden="true"
>
  {#each cells as [r, c] (r * 16 + c)}
    <rect x={c * step} y={r * step} width={cell} height={cell} rx={cell * 0.22} fill={color} />
  {/each}
</svg>
