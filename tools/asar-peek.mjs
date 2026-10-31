/**
 * 列 / 取 `app.asar` 里的条目 —— 用来核对"宿主到底有没有这个扩展点"。
 *
 * 用法：
 *   node tools/asar-peek.mjs list <正则...> [--asar <path>]
 *   node tools/asar-peek.mjs x <输出目录> <正则...> [--asar <path>]
 *
 * 例（查右栏页类型注册表的实现）：
 *   node tools/asar-peek.mjs list 'sidebar-right-tabs'
 *   node tools/asar-peek.mjs x .dsh/out 'dsh-session-query/lib/index.js'
 *
 * 只读，不改归档。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readEntry, readHeader, resolveArchive, splitAsarFlag, walk } from './asar-lib.mjs'

const { args, asar } = splitAsarFlag(process.argv.slice(2))
const [mode, ...rest] = args

if (mode !== 'list' && mode !== 'x') {
  console.error('用法: node tools/asar-peek.mjs list <正则...> | x <输出目录> <正则...> [--asar <path>]')
  process.exit(2)
}

const archive = resolveArchive(asar)
const { header, dataOffset } = readHeader(archive)
const entries = walk(header)
console.log(`归档：${archive}\n条目：${entries.length}`)

if (mode === 'list') {
  const patterns = rest.map((source) => new RegExp(source, 'i'))
  const hits = entries
    .filter((entry) => patterns.some((pattern) => pattern.test(entry.path)))
    .sort((left, right) => right.size - left.size)
  console.log(`命中：${hits.length}\n`)
  for (const entry of hits) console.log(`${String(entry.size).padStart(9)}  ${entry.path}`)
} else {
  const outDir = rest[0]
  if (outDir === undefined) {
    console.error('x 模式要一个输出目录')
    process.exit(2)
  }
  const patterns = rest.slice(1).map((source) => new RegExp(source, 'i'))
  // 上限 4 MB：再大的多半是二进制资产，不是我们要读的代码。
  const hits = entries.filter(
    (entry) => patterns.some((pattern) => pattern.test(entry.path)) && entry.size > 0 && entry.size < 4_000_000,
  )
  mkdirSync(outDir, { recursive: true })
  for (const entry of hits) {
    const destination = join(outDir, entry.path.replace(/[\\/]/g, '__'))
    writeFileSync(destination, readEntry(archive, dataOffset, entry))
    console.log(`${String(entry.size).padStart(9)}  -> ${destination}`)
  }
  console.log(`\n取出 ${hits.length} 个文件到 ${outDir}`)
}
