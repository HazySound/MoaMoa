/**
 * 열어 둔 페이지가 최신 배포판인지 본다.
 *
 * 고친 걸 배포해도 열어 둔 탭은 예전 코드로 계속 돈다. 작은 창만 보고 플레이하면 버전을 볼 길이 없어서
 * '고쳤다는데 그대로'인 일이 생겼다. 1분마다 첫 페이지를 다시 받아 스크립트 이름(빌드마다 바뀐다)을 견준다.
 */
class Updater {
  /** 더 새로운 배포판이 있다 (새로고침해야 반영된다) */
  stale = $state(false)
  /** 지금 돌고 있는 빌드의 커밋 (없으면 날짜) */
  readonly build = __BUILD__.split(' · ').pop() ?? __BUILD__

  start() {
    if (import.meta.env.DEV) return
    const name = (html: string) => html.match(/assets\/index-[^"'?]+\.js/)?.[0]
    const mine = name([...document.scripts].map((s) => s.src).join('"'))
    if (!mine) return
    const check = async () => {
      try {
        const now = name(await (await fetch('/', { cache: 'no-store' })).text())
        if (now && now !== mine) this.stale = true
      } catch { /* 연결이 끊겼으면 다음에 다시 본다 */ }
    }
    void check()
    setInterval(check, 60_000)
  }
}

export const updater = new Updater()
