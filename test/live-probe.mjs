/**
 * 对着**运行中**的 dsh web 服务器打真实请求，验证镜像路由已经挂上。
 *
 * 离线测试（route.test.mjs）验的是逻辑；这个脚本验的是"装配真的生效了"——
 * 插件被 profile 装载、路由注册到了真实的 3080 端口上。
 *
 * 跑法：
 *   node test/live-probe.mjs <sessionId> [工作区相对路径...]
 *
 * ⚠️ `sessionId` 是**会话目录名**、带 `session-` 前缀（= 工具里的 `exec.agent.session.id`）：
 *
 *   ~/.dsh/sessions/--D-developing-xxx--/session-96f165a6-….v4/
 *                                          ^^^^^^^^^^^^^^^^^^^ 这一段整段都是 id
 *
 * 只写裸 uuid 会拿到 `404 unknown session`（2026-09-26 实测踩到）。
 * 另外：**必须先在那个会话里展示过一次页面**，宿主才记下「会话 → 工作区根」；
 * 那条记录在内存里，所以 dsh 重启后旧会话 id 一律 404。
 *
 * 例：
 *   node test/live-probe.mjs session-96f165a6-4c2f-4db7-9a4f-2774b71fca90 .dsh/showme/review.html
 */

const sessionId = process.argv[2]
if (sessionId === undefined || sessionId === '') {
  console.error('用法: node test/live-probe.mjs <sessionId> [工作区相对路径...]')
  process.exit(1)
}

const base = process.env.DSH_WEB_BASE ?? 'http://127.0.0.1:3080'
const prefix = `/api/showme/raw/${encodeURIComponent(sessionId)}/`

/**
 * 默认探针：一个展示页、一个相对引用的资源、一次越界尝试。
 *
 * ⚠️ 415 那条用 `LICENSE`（**没有**扩展名，不在服务表里）。
 * 别拿 `package.json` 当"未登记类型"——`.json` 早就在 `CONTENT_TYPES` 里
 * （页面要能取数据文件），实测返回 200。旧版探针写的就是它，于是**这一项永远红**。
 */
const targets = process.argv.length > 3
  ? process.argv.slice(3).map((path) => ({ label: path, path, expect: 200 }))
  : [
      { label: '展示页', path: '.dsh/showme/review.html', expect: 200 },
      { label: '相对引用的 SVG', path: '.dsh/showme/assets/arch.svg', expect: 200 },
      { label: '越界（../ 到工作区外）', path: '%2e%2e%2fdsh-text-drop%2fpackage.json', expect: 403 },
      { label: '不存在的文件', path: '.dsh/showme/nope.html', expect: 404 },
      { label: '未登记类型（无扩展名）', path: 'LICENSE', expect: 415 },
    ]

let failed = 0
console.log(`\n探针目标：${base}${prefix}\n`)

for (const target of targets) {
  const url = prefix + target.path
  let response
  try {
    response = await fetch(base + url)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${target.label}  连接失败：${error.message}`)
    continue
  }
  const body = await response.text()
  const ok = response.status === target.expect
  if (!ok) failed += 1
  const csp = response.headers.get('content-security-policy')
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'} ${String(response.status).padEnd(3)} (期望 ${target.expect})  ${target.label}`,
  )
  console.log(
    `       content-type: ${response.headers.get('content-type') ?? '-'}` +
      `${csp === null ? '' : `  csp: ${csp}`}`,
  )
  if (target.expect === 200) {
    console.log(`       正文 ${body.length} 字节，开头：${JSON.stringify(body.slice(0, 60))}`)
  }
}

console.log(failed === 0 ? '\n全部符合预期。\n' : `\n${failed} 项不符合预期。\n`)
// 用 exitCode 而不是 process.exit()：Node 24 在还有 fetch 连接在飞时强退，
// 会在 Windows 上抛出 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`
// —— 检查全绿也会看到这条吓人的崩溃（2026-09-26 实测）。
process.exitCode = failed === 0 ? 0 : 1
