/**
 * 装机体检：把"插件能不能用"这件事一次问清楚。
 *
 * 起因：skill 的投递靠一个 **`~/.dsh/skills/` 里的目录联接**，它在仓库之外。
 * 任何一次清理都可能把它悄悄弄丢——而症状是"模型不再加载 skill"，
 * 从外面完全看不出来（本轮就被咬过一次）。
 *
 * 跑法：`node test/doctor.mjs`（或 `npm run doctor`）。
 * 只读，不改任何东西；不健康时退出码非 0。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')

let failures = 0
let warnings = 0

/**
 * 一条检查。
 * @param label - 检查名。
 * @param fn - 返回 true/健康、或返回一段字符串当作"不健康的原因"。
 * @param fix - 不健康时给出的修复命令。
 */
function check(label, fn, fix) {
  let outcome
  try {
    outcome = fn()
  } catch (error) {
    outcome = error instanceof Error ? error.message : String(error)
  }
  if (outcome === true) {
    console.log(`  ✓  ${label}`)
    return
  }
  failures += 1
  console.log(`  ✗  ${label}`)
  console.log(`     ${outcome}`)
  if (fix !== undefined) console.log(`     修复：${fix}`)
}

/** 提醒（不算失败）。 */
function warn(label, detail) {
  warnings += 1
  console.log(`  !  ${label}`)
  console.log(`     ${detail}`)
}

/** 读文件，失败返回 undefined。 */
function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

console.log(`\n仓库：${repo}`)
console.log(`DSH 家目录：${dshHome}\n`)

// ── 1. 仓库资产 ────────────────────────────────────────────────────────
console.log('[1] 仓库资产')

check('skill/showme-report/SKILL.md 存在', () => {
  const path = join(repo, 'skill', 'showme-report', 'SKILL.md')
  return existsSync(path) ? true : `找不到 ${path}`
})

check('SKILL.md 的 frontmatter 有 name 与 description', () => {
  const text = readText(join(repo, 'skill', 'showme-report', 'SKILL.md')) ?? ''
  if (!/^name:\s*showme-report\s*$/m.test(text)) return 'frontmatter 里没有 name: showme-report'
  if (!/^description:\s*\S/m.test(text)) return 'frontmatter 里没有 description'
  return true
})

check('四套预设样式齐全', () => {
  const missing = ['soft.css', 'swiss.css', 'brutal.css', 'blueprint.css', 'index.json']
    .filter((name) => !existsSync(join(repo, 'styles', name)))
  return missing.length === 0 ? true : `缺 ${missing.join(' ')}`
})

check('模板资产齐全（内核 + 三个外壳 + 字段表）', () => {
  const missing = ['core.js', 'review.html', 'pick.html', 'report.html', 'README.md']
    .filter((name) => !existsSync(join(repo, 'templates', name)))
  return missing.length === 0 ? true : `缺 ${missing.join(' ')}`
})

// ── 2. skill 投递 ──────────────────────────────────────────────────────
console.log('\n[2] skill 投递（最容易悄悄丢掉的一环）')

const skillLink = join(dshHome, 'skills', 'showme-report')
const repairSkill = `New-Item -ItemType Junction -Path "${skillLink}" -Target "${join(repo, 'skill', 'showme-report')}"`

check(`${skillLink} 存在`, () => (existsSync(skillLink) ? true : '目录联接不在——模型不会加载这个 skill'), repairSkill)

check('通过链接能读到 SKILL.md（不是断链）', () => {
  if (!existsSync(skillLink)) return '链接本身不存在（见上一条）'
  const path = join(skillLink, 'SKILL.md')
  const text = readText(path)
  if (text === undefined) return `链接在，但读不到 ${path}（多半是断链，指向的源码挪走了）`
  return /^name:\s*showme-report\s*$/m.test(text) ? true : '读到了 SKILL.md，但内容不是 showme-report'
})

check('链接与仓库源码指向同一份内容', () => {
  if (!existsSync(skillLink)) return '链接不存在（见上一条）'
  const viaLink = readText(join(skillLink, 'SKILL.md'))
  const inRepo = readText(join(repo, 'skill', 'showme-report', 'SKILL.md'))
  if (viaLink === undefined || inRepo === undefined) return '有一侧读不到'
  return viaLink === inRepo ? true : '两侧内容不一致——链接可能指向了别处的副本'
})

// ── 3. profile 装配 ────────────────────────────────────────────────────
console.log('\n[3] profile 装配')

const profilesDir = join(dshHome, 'profiles')
const profileNames = existsSync(profilesDir)
  ? readdirSync(profilesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  : []

const manifests = profileNames
  .map((name) => ({ name, path: join(profilesDir, name, 'package.json') }))
  .filter((entry) => existsSync(entry.path))

const installed = manifests.filter((entry) => {
  try {
    const manifest = JSON.parse(readFileSync(entry.path, 'utf8'))
    return Object.keys(manifest.dependencies ?? {}).some((dep) => dep === 'dsh-showme-html')
  } catch {
    return false
  }
})

check('至少有一个 profile 装了这个插件', () => {
  if (manifests.length === 0) return `在 ${profilesDir} 下没找到任何 profile`
  if (installed.length === 0) return `已看的 profile：${manifests.map((e) => e.name).join(' ')} —— 都没装`
  return true
}, `dsh plugin --profile <name> add "link:${repo}"`)

for (const entry of installed) {
  check(`profile ${entry.name}：写进了 dsh.profile.bundles`, () => {
    const manifest = JSON.parse(readFileSync(entry.path, 'utf8'))
    const bundles = manifest.dsh?.profile?.bundles ?? []
    return bundles.includes('dsh-showme-html')
      ? true
      : `dependencies 里有，但 dsh.profile.bundles 里没有——插件行不会被并入装配`
  })
  check(`profile ${entry.name}：node_modules 里有实体`, () => {
    const linked = join(profilesDir, entry.name, 'node_modules', 'dsh-showme-html')
    if (!existsSync(linked)) return `${linked} 不存在——大概率还没跑过 pnpm install`
    return statSync(linked).isDirectory() ? true : '路径存在但不是目录'
  })
}

// ── 4. 运行中的服务 ────────────────────────────────────────────────────
console.log('\n[4] 运行中的服务（可选）')

const port = Number(process.env.DSH_WEB_PORT ?? 3080)
try {
  const response = await fetch(`http://127.0.0.1:${port}/api/showme/raw/probe-doctor/x.html`, {
    signal: AbortSignal.timeout(3000),
  })
  const body = await response.text()
  if (/loopback-only/.test(body)) {
    warn('镜像路由有响应，但回环围栏拒了本机请求', '不该发生：本机请求应当放行。')
  } else if (/unknown session|not found in workspace/.test(body)) {
    console.log(`  ✓  镜像路由已在 ${port} 上服务（回环围栏正常）`)
  } else {
    warn(`镜像路由响应意外：HTTP ${response.status}`, body.slice(0, 120))
  }
} catch (error) {
  warn(`连不上 127.0.0.1:${port}`, `${error.message} —— dsh web 没在跑，或端口不同（用 DSH_WEB_PORT 指定）`)
}

console.log(
  failures === 0
    ? `\n体检通过${warnings > 0 ? `（${warnings} 条提醒）` : ''}。\n`
    : `\n${failures} 项不健康${warnings > 0 ? `，另有 ${warnings} 条提醒` : ''}。\n`,
)
process.exit(failures === 0 ? 0 : 1)
