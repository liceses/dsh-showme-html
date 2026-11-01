/**
 * 把 mermaid 的浏览器版单文件 bundle 拉进 `vendor/`。
 *
 * 为什么是 `dist/mermaid.min.js` 而不是 ESM 分块版：后者入口只有 30 KB，
 * 但要拖 **208 个 chunk / 24 MB**；而 `mermaid.min.js` 是 5.5 MB 一个文件，
 * 末尾一行 `globalThis["mermaid"] = …` 把自己挂成全局，页面里一句
 * `<script src>` 就能用 —— 在不透明源的展示页里这是唯一稳妥的加载方式。
 *
 * 这一份文件**一份两用**：
 *   - 浏览器：原样加载、渲染、出图；
 *   - Node 侧预检（`lib/mermaid-check.js`）：读同一份文件，**只在内存里**把
 *     `Z1=Rsr()`（`createDOMPurify()` 的返回）换成 stub 再喂 `vm`，磁盘文件不动。
 *     不换就会在流程图解析时抛 `TypeError: Z1.addHook is not a function`。
 *
 * 用法：
 *   node tools/vendor-mermaid.mjs            # 拉 12.2.0（默认）
 *   node tools/vendor-mermaid.mjs --version 12.2.0
 *
 * 拉完打印字节数与 sha256；`vendor/README.md` 里记着同一个值。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const vendorDir = join(repo, 'vendor')
const target = join(vendorDir, 'mermaid.min.js')

const argv = process.argv.slice(2)
const versionFlag = argv.indexOf('--version')
const version = versionFlag >= 0 && argv[versionFlag + 1] ? argv[versionFlag + 1] : '12.2.0'

/**
 * 在系统临时目录里建一个唯一工作目录。
 * 目录名带固定前缀，`cleanup()` 靠这个前缀确认"要删的确实是自己建的"。
 */
const workDir = mkdtempSync(join(tmpdir(), 'dsh-vendor-mermaid-'))

/** 只删自己建的临时目录；前缀不对就拒绝（`$HOME` 只读变量那次事故的教训）。 */
function cleanup() {
  const root = resolve(tmpdir())
  const dir = resolve(workDir)
  if (!dir.startsWith(root) || !dir.includes('dsh-vendor-mermaid-')) {
    console.warn(`跳过清理（不在临时目录内）：${dir}`)
    return
  }
  rmSync(dir, { recursive: true, force: true })
}

try {
  console.log(`拉取 mermaid@${version} …`)
  const packOut = execFileSync('npm', ['pack', `mermaid@${version}`, '--silent'], {
    cwd: workDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: process.platform === 'win32',
  }).trim()
  const tarball = join(workDir, packOut.split(/\r?\n/).filter(Boolean).pop())

  execFileSync('tar', ['xzf', tarball, '-C', workDir], { stdio: 'inherit' })

  const source = join(workDir, 'package', 'dist', 'mermaid.min.js')
  mkdirSync(vendorDir, { recursive: true })
  copyFileSync(source, target)

  const bytes = readFileSync(target)
  const sha = createHash('sha256').update(bytes).digest('hex')
  const tail = bytes.subarray(-80).toString('utf8').trim()
  console.log(`\n写入 ${target}`)
  console.log(`字节数：${statSync(target).size}（同 ${bytes.length}）`)
  console.log(`sha256：${sha}`)
  console.log(`末尾：${tail}`)
  if (!tail.includes('globalThis["mermaid"]')) {
    console.warn('\n⚠ 末尾没有 globalThis["mermaid"]，这份 bundle 可能不是普通脚本版，请人工确认。')
  }
} finally {
  cleanup()
}
