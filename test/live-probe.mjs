/**
 * 对着**运行中**的 dsh web 服务器打真实请求，验证镜像路由已经挂上。
 *
 * 离线测试（route.test.mjs）验的是逻辑；这个脚本验的是"装配真的生效了"——
 * 插件被 profile 装载、路由注册到了真实的 3080 端口上。
 *
 * 跑法：
 *   node test/live-probe.mjs <sessionId> [工作区相对路径...]
 *
 * 例：
 *   node test/live-probe.mjs eec4016e-fa4a-4345-a3b7-4c0fe7f825af .dsh/showme/review.html
 */

const sessionId = process.argv[2]
if (sessionId === undefined || sessionId === '') {
  console.error('用法: node test/live-probe.mjs <sessionId> [工作区相对路径...]')
  process.exit(1)
}

const base = process.env.DSH_WEB_BASE ?? 'http://127.0.0.1:3080'
const prefix = `/api/showme/raw/${encodeURIComponent(sessionId)}/`

/** 默认探针：一个展示页、一个相对引用的资源、一次越界尝试。 */
const targets = process.argv.length > 3
  ? process.argv.slice(3).map((path) => ({ label: path, path, expect: 200 }))
  : [
      { label: '展示页', path: '.dsh/showme/review.html', expect: 200 },
      { label: '相对引用的 SVG', path: '.dsh/showme/assets/arch.svg', expect: 200 },
      { label: '越界（../ 到工作区外）', path: '%2e%2e%2fdsh-text-drop%2fpackage.json', expect: 403 },
      { label: '不存在的文件', path: '.dsh/showme/nope.html', expect: 404 },
      { label: '未登记类型', path: 'package.json', expect: 415 },
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
process.exit(failed === 0 ? 0 : 1)
