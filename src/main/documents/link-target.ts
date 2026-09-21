import { fileURLToPath } from 'node:url'
import { fail } from './reader'
export type LinkTarget = { kind: 'anchor'; fragment: string } | { kind: 'external'; url: string } | { kind: 'local'; path: string; fragment: string }
function hasControls(value: string): boolean { return [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) }
export function classifyLink(raw: string): LinkTarget {
  if (!raw || raw.length > 4096 || hasControls(raw) || /^[\\/]{2}/u.test(raw)) fail('INVALID_REQUEST', '链接地址无效')
  if (/^(https?:|mailto:)/iu.test(raw)) {
    let url: URL; try { url = new URL(raw) } catch { return fail('INVALID_REQUEST', '链接地址无效') }
    if (url.username || url.password || (url.protocol !== 'mailto:' && !url.hostname) || /%0[ad]/iu.test(raw)) fail('INVALID_REQUEST', '链接地址无效')
    return { kind: 'external', url: url.href }
  }
  const hash = raw.indexOf('#'); const base = hash < 0 ? raw : raw.slice(0, hash)
  let fragment: string; let path: string
  try { fragment = hash < 0 ? '' : decodeURIComponent(raw.slice(hash + 1)); path = decodeURIComponent(base) } catch { return fail('INVALID_REQUEST', '链接编码无效') }
  if (hasControls(path + fragment)) fail('INVALID_REQUEST', '链接地址无效')
  if (!base && hash === 0) return { kind: 'anchor', fragment }
  if (/^file:/iu.test(base)) {
    try { const url = new URL(base); if (url.hostname || url.search) throw new Error(); path = fileURLToPath(url) } catch { return fail('ACCESS_DENIED', '此文件链接无法解析') }
  } else if (/^[a-z][a-z\d+.-]*:/iu.test(path) && !/^[a-z]:[\\/]/iu.test(path)) fail('UNSUPPORTED_TYPE', '不支持此链接协议')
  if (base.includes('?') || /^[\\/]{2}/u.test(path)) fail('INVALID_REQUEST', '不支持此文件链接格式')
  return { kind: 'local', path, fragment }
}
