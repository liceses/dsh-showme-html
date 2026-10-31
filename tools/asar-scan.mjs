/**
 * 在 `app.asar` 里按字节找字符串，打印上下文 —— 用来定位"某个契约的实现在哪"。
 *
 * 用法：
 *   node tools/asar-scan.mjs <needle> [上下文字节数] [最多几处] [--asar <path>]
 *
 * 例（查窗口标题栏覆盖层的高度，全屏按钮被挡住就是它）：
 *   node tools/asar-scan.mjs titleBarOverlay 300 4
 *
 * 为什么用字节扫描而不是先解包：asar 里的代码是**原样**存的，
 * 而 `peek list` 只能按路径找。当我们只知道一个字符串、不知道它在哪个包里时，
 * 直接扫字节最快。
 *
 * 只读，不改归档。
 */

import { readFileSync } from 'node:fs'
import { resolveArchive, splitAsarFlag } from './asar-lib.mjs'

const { args, asar } = splitAsarFlag(process.argv.slice(2))
const [needle, contextArg, maxArg] = args

if (needle === undefined || needle === '') {
  console.error('用法: node tools/asar-scan.mjs <needle> [上下文字节数] [最多几处] [--asar <path>]')
  process.exit(2)
}

const context = Number(contextArg ?? 260)
const limit = Number(maxArg ?? 6)
const archive = resolveArchive(asar)
const buffer = readFileSync(archive)
const target = Buffer.from(needle, 'utf8')

const hits = []
let from = 0
while (hits.length < limit) {
  const at = buffer.indexOf(target, from)
  if (at < 0) break
  hits.push(at)
  from = at + 1
}

console.log(`归档：${archive}（${buffer.length} 字节）`)
console.log(`needle=${JSON.stringify(needle)}  命中 ${hits.length} 处（上限 ${limit}）`)

for (const at of hits) {
  const start = Math.max(0, at - context)
  const end = Math.min(buffer.length, at + target.length + context)
  // 控制字符换成 ·，否则终端会把上下文吃掉。
  const text = buffer.toString('utf8', start, end).replace(/[\u0000-\u0008\u000b-\u001f]/g, '·')
  console.log(`\n--- @${at} ---\n${text}`)
}

if (hits.length === 0) console.log('(没找到)')
