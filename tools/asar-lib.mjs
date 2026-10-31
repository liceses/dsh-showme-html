/**
 * `app.asar` 的最小只读解析（不依赖 `@electron/asar`）。
 *
 * 为什么自己写：我们只用它做一件事 —— **核对宿主的真实契约**。
 * 例如「`sidebarRightTabs` 到底存不存在」「`sessionQuery.readSession()` 真实返回什么形状」
 * 「`titleBarOverlay` 的高度是不是 40」。这类问题的答案只在装好的 asar 里，
 * 而为了读 18k 个条目装一个依赖不值得。
 *
 * 头部布局（Electron asar 格式）：
 *
 *   [u32 = 4][u32 pickle 尺寸][u32 字符串 pickle 尺寸][u32 JSON 字节数][JSON…]
 *
 * ⚠️ 踩过的坑：0.2.x 的 header JSON 已经涨到 ~4.8 MB。早期版本按
 * 「固定 4 MiB 探测缓冲 + 花括号配对」写，于是报 `asar header JSON 没找到结尾`。
 * 这里一律按 offset 12 的长度字段读，不再猜。
 */

import { closeSync, existsSync, openSync, readSync } from 'node:fs'

/** 桌面版 app.asar 的默认落点（Windows）。别的机器用 --asar / DSH_ASAR 指定。 */
const DEFAULT_ARCHIVES = ['D:/applications/dshDesktop/resources/app.asar']

/** header JSON 的合理上限：再大就不是 asar 了，别把内存读爆。 */
const MAX_HEADER_BYTES = 64 * 1024 * 1024

/**
 * 定位要读的 asar：显式参数 → `DSH_ASAR` → 桌面版默认落点。
 * @param explicit - `--asar` 给的值。
 * @returns 存在的归档绝对路径。
 */
export function resolveArchive(explicit) {
  const candidates = [explicit, process.env.DSH_ASAR, ...DEFAULT_ARCHIVES]
    .filter((value) => typeof value === 'string' && value !== '')
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    `找不到 app.asar。用 --asar <路径> 或 DSH_ASAR 环境变量指定。试过：${candidates.join(' | ')}`,
  )
}

/**
 * 读归档头，算出数据区起点。
 * @param archive - asar 路径。
 * @returns `{ header, dataOffset }`。
 */
export function readHeader(archive) {
  const fd = openSync(archive, 'r')
  try {
    const prefix = Buffer.alloc(16)
    readSync(fd, prefix, 0, 16, 0)
    const jsonLength = prefix.readUInt32LE(12)
    if (jsonLength <= 0 || jsonLength > MAX_HEADER_BYTES) {
      throw new Error(`header JSON 长度不合理：${jsonLength}（这个文件不是 asar？）`)
    }
    const jsonBytes = Buffer.alloc(jsonLength)
    readSync(fd, jsonBytes, 0, jsonLength, 16)
    const header = JSON.parse(jsonBytes.toString('utf8'))
    // 数据区从 header 之后开始，按 4 字节对齐。
    const raw = 16 + jsonLength
    const dataOffset = raw + ((4 - (raw % 4)) % 4)
    return { header, dataOffset }
  } finally {
    closeSync(fd)
  }
}

/**
 * 把头部树摊平成条目列表。
 * @param header - 头部根节点。
 * @returns `[{ path, size, offset }]`。
 */
export function walk(header) {
  const out = []
  const visit = (node, prefix) => {
    for (const [name, value] of Object.entries(node.files ?? {})) {
      const full = prefix === '' ? name : `${prefix}/${name}`
      if (value.files) visit(value, full)
      else out.push({ path: full, size: Number(value.size ?? 0), offset: Number(value.offset ?? 0) })
    }
  }
  visit(header, '')
  return out
}

/**
 * 取一个条目的字节。
 * @param archive - asar 路径。
 * @param dataOffset - 数据区起点。
 * @param entry - `walk()` 给的条目。
 * @returns Buffer。
 */
export function readEntry(archive, dataOffset, entry) {
  const fd = openSync(archive, 'r')
  try {
    const buffer = Buffer.alloc(entry.size)
    readSync(fd, buffer, 0, entry.size, dataOffset + entry.offset)
    return buffer
  } finally {
    closeSync(fd)
  }
}

/**
 * 从 argv 里摘掉 `--asar <path>`，返回剩下的位置参数。
 * @param argv - `process.argv.slice(2)`。
 * @returns `{ args, asar }`。
 */
export function splitAsarFlag(argv) {
  const args = []
  let asar
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--asar') {
      asar = argv[index + 1]
      index += 1
    } else {
      args.push(argv[index])
    }
  }
  return { args, asar }
}
