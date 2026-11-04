/** Screenshots can be huge. Before uploading, images are made smaller and given a small preview,
 *  which keeps within the free storage, loads faster and removes hidden data like photo locations. */

const MAX_SIDE = 2400
const THUMB_SIDE = 480
const QUALITY = 0.85
const THUMB_QUALITY = 0.72
// A GIF would lose its animation, and these can't be drawn in most browsers anyway.
const LEAVE_ALONE = new Set(['image/gif', 'image/svg+xml'])

export interface PreparedFile {
  blob: Blob
  name: string
  width?: number
  height?: number
  thumb?: Blob
  thumbKind?: 'webp' | 'jpeg'
}

export function fitWithin(width: number, height: number, max: number) {
  const scale = Math.min(1, max / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Keeps a real name with the right ending. A pasted screenshot has no real name, so it gets the time. */
export function shrunkName(name: string, extension: string, now = new Date()) {
  const stem = name.replace(/\.[^.]+$/, '')
  const base = stem && stem !== 'image' ? stem : `Screenshot ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}.${pad(now.getMinutes())}`
  return `${base}.${extension}`
}

function draw(bitmap: ImageBitmap, width: number, height: number, type: string, quality: number): Promise<Blob | null> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return Promise.resolve(null)
  if (type === 'image/jpeg') {
    // JPEG has no see-through parts: without this they'd turn black.
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, width, height)
  }
  context.drawImage(bitmap, 0, 0, width, height)
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
}

/** WebP where the browser can make it (older Safari can't, and quietly gives PNG), otherwise JPEG. */
async function encode(bitmap: ImageBitmap, width: number, height: number, quality: number) {
  const webp = await draw(bitmap, width, height, 'image/webp', quality)
  if (webp?.type === 'image/webp') return { blob: webp, kind: 'webp' as const }
  const jpeg = await draw(bitmap, width, height, 'image/jpeg', quality)
  return jpeg ? { blob: jpeg, kind: 'jpeg' as const } : null
}

export async function prepareFile(file: File): Promise<PreparedFile> {
  const untouched: PreparedFile = { blob: file, name: file.name }
  if (!file.type.startsWith('image/') || LEAVE_ALONE.has(file.type) || typeof createImageBitmap !== 'function') return untouched
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return untouched // A photo format this browser can't read, like HEIC on a computer: it stays a download.
  }
  try {
    const size = fitWithin(bitmap.width, bitmap.height, MAX_SIDE)
    const main = await encode(bitmap, size.width, size.height, QUALITY)
    if (!main) return untouched
    const thumbSize = fitWithin(bitmap.width, bitmap.height, THUMB_SIDE)
    const thumb = await encode(bitmap, thumbSize.width, thumbSize.height, THUMB_QUALITY)
    // Already smaller than our copy, and not a photo that could carry a location: keep the original.
    const keepOriginal = main.blob.size >= file.size && file.type !== 'image/jpeg' && size.width === bitmap.width && size.height === bitmap.height
    return {
      blob: keepOriginal ? file : main.blob,
      name: keepOriginal ? shrunkName(file.name, file.name.split('.').pop() || 'png') : shrunkName(file.name, main.kind === 'webp' ? 'webp' : 'jpg'),
      width: size.width,
      height: size.height,
      thumb: thumb?.blob,
      thumbKind: thumb?.kind,
    }
  } finally {
    bitmap.close()
  }
}
