/**
 * 라이트·다크 전환. 처음에는 운영체제 설정을 따르고, 한 번 고르면 그 선택을 기억한다.
 * 실제 적용은 <html data-theme>이다. 깜빡임 없이 첫 화면부터 맞추려고 index.html에서도 한 번 정한다.
 */
export type Theme = 'light' | 'dark'

const KEY = 'moamoa.theme'

function initial(): Theme {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved === 'light' || saved === 'dark') return saved
  } catch { /* 저장소를 못 쓰는 창 */ }
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

class ThemeStore {
  current = $state<Theme>(initial())

  constructor() {
    $effect.root(() => {
      $effect(() => {
        document.documentElement.dataset.theme = this.current
        document.querySelector('meta[name="theme-color"]')?.setAttribute('content', this.current === 'light' ? '#f3f4f6' : '#1b1e23')
      })
    })
  }

  toggle() {
    this.current = this.current === 'light' ? 'dark' : 'light'
    try { localStorage.setItem(KEY, this.current) } catch { /* 이번 창에서만 바뀐다 */ }
  }
}

export const theme = new ThemeStore()
