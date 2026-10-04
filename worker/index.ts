/**
 * 통계 자동 백업 서버. 조각 통계·판 기록이 브라우저 하나(localStorage)에만 남아 있다가 날아갈까 봐
 * 사용자가 원해서 넣었다 (2026-10-03). 화면은 여전히 서버로 오지 않는다. 오는 건 조각 횟수·판 점수·설정뿐이다.
 *
 *   PUT /api/stats/<id>  본문(JSON, 256KB까지)을 KV에 저장
 *   GET /api/stats/<id>  저장한 그대로 돌려준다
 * 그 밖의 경로는 정적 사이트(dist)다.
 *
 * 저장된 걸 보려면: npx wrangler kv key list --binding STATS / npx wrangler kv key get --binding STATS <id>
 */
interface KV { get(key: string): Promise<string | null>; put(key: string, value: string): Promise<void> }
interface Env { STATS: KV; ASSETS: { fetch(req: Request): Promise<Response> } }

const ID = /^\/api\/stats\/([a-z0-9]{6,32})$/

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const m = url.pathname.match(ID)
    if (!m) return url.pathname.startsWith('/api/') ? new Response('없는 주소', { status: 404 }) : env.ASSETS.fetch(req)
    const key = m[1]
    if (req.method === 'GET') {
      const v = await env.STATS.get(key)
      return v === null ? new Response('없음', { status: 404 }) : new Response(v, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
    }
    if (req.method === 'PUT') {
      const body = await req.text()
      // 세트 일지(최근 300세트)까지 실으면 200KB를 넘길 수 있다 (KV 값 한도는 25MB)
      if (body.length > 2 * 1024 * 1024) return new Response('너무 큼', { status: 413 })
      try { JSON.parse(body) } catch { return new Response('JSON이 아님', { status: 400 }) }
      await env.STATS.put(key, body)
      return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })
    }
    return new Response('허용하지 않는 방법', { status: 405 })
  },
}
