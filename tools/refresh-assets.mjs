/**
 * 把工作区里的**落地副本**同步成插件包里的那一份。
 *
 * 为什么需要它：`show_html` 落地资产是 **create-only**（不覆盖你在工作区里改过的文件），
 * 所以插件升级、或仓库里改了 `templates/README.md` 之后，工作区那份会**悄悄停在旧版**。
 * 症状不是报错，而是"文档教的是已经废弃的流程"——这个坑踩过两次，现在由 doctor 第 [6] 节盯着。
 *
 * 用法：
 *   node tools/refresh-assets.mjs                 # 同步 templates/，补齐 presets/ 缺的文件
 *   node tools/refresh-assets.mjs --dry-run       # 只看会改什么
 *   node tools/refresh-assets.mjs --presets       # 连 presets/ 也覆盖（默认不覆盖，那是留给你改的）
 *   node tools/refresh-assets.mjs --workspace D:/some/workspace
 *
 * 覆盖前会把旧文件备份成 `<文件名>.bak-<时间戳>`，所以手改过的内容不会凭空消失。
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const alsoPresets = argv.includes('--presets')
const workspaceFlag = argv.indexOf('--workspace')
const workspace = resolve(
  workspaceFlag >= 0 && argv[workspaceFlag + 1] !== undefined
    ? argv[workspaceFlag + 1]
    : (process.env.DSH_WORKSPACE ?? process.cwd()),
)

/** 备份后缀用**本地时间**（`toISOString()` 是 UTC，会让人对着文件名算时差）。 */
const pad = (value) => String(value).padStart(2, '0')
const now = new Date()
const stamp =
  `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
  `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`

/**
 * 同步一组资产。
 * @param sourceDir - 仓库里的源目录。
 * @param targetDir - 工作区里的落地目录。
 * @param overwrite - 内容不同时是否覆盖。
 * @returns `{ written, backedUp, kept }`。
 */
function sync(sourceDir, targetDir, overwrite) {
  const result = { written: [], backedUp: [], kept: [] }
  const files = readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)

  for (const file of files) {
    const source = readFileSync(join(sourceDir, file), 'utf8')
    const destination = join(targetDir, file)
    const existing = existsSync(destination) ? readFileSync(destination, 'utf8') : undefined

    if (existing === source) {
      result.kept.push(file)
      continue
    }
    if (existing !== undefined && !overwrite) {
      result.kept.push(file)
      continue
    }
    if (existing !== undefined) {
      const backup = `${destination}.bak-${stamp}`
      if (!dryRun) writeFileSync(backup, existing, 'utf8')
      result.backedUp.push(`${file} → ${file}.bak-${stamp}`)
    }
    if (!dryRun) writeFileSync(destination, source, 'utf8')
    result.written.push(file)
  }
  return result
}

console.log(`\n仓库：${repo}`)
console.log(`工作区：${workspace}${dryRun ? '（dry-run，不落盘）' : ''}\n`)

const templates = sync(join(repo, 'templates'), join(workspace, '.dsh', 'showme', 'templates'), true)
const presets = sync(join(repo, 'styles'), join(workspace, '.dsh', 'showme', 'presets'), alsoPresets)

/**
 * 打印一组结果。
 * @param label - 组名。
 * @param result - `sync()` 的返回。
 * @param note - 追加说明。
 */
function report(label, result, note) {
  console.log(`[${label}]`)
  console.log(`  ${dryRun ? '将更新' : '已更新'}：${result.written.length === 0 ? '（无）' : result.written.join(' ')}`)
  if (result.backedUp.length > 0) console.log(`  备份：${result.backedUp.join(' ')}`)
  console.log(`  一致：${result.kept.length === 0 ? '（无）' : result.kept.join(' ')}`)
  if (note !== undefined) console.log(`  ${note}`)
  console.log('')
}

report('templates', templates)
report(
  'presets',
  presets,
  alsoPresets
    ? '（--presets：内容不同也覆盖）'
    : '（默认只补缺：presets/ 是留给你改的，内容不同不覆盖）',
)
