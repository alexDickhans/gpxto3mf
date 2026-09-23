/** Decode a fetched tile blob to ImageData (Firefox-safe createImageBitmap fallback). */
let sharedCanvas: HTMLCanvasElement | null = null
let sharedCtx: CanvasRenderingContext2D | null = null

function getSharedCtx(w: number, h: number): CanvasRenderingContext2D {
  if (!sharedCanvas) {
    sharedCanvas = document.createElement('canvas')
    sharedCtx = sharedCanvas.getContext('2d', { willReadFrequently: true })
  }
  if (!sharedCtx) throw new Error('2D canvas unavailable')
  if (sharedCanvas.width !== w) sharedCanvas.width = w
  if (sharedCanvas.height !== h) sharedCanvas.height = h
  return sharedCtx
}

export async function decodeTileImage(blob: Blob): Promise<ImageData> {
  try {
    const bmp = await createImageBitmap(blob)
    const ctx = getSharedCtx(bmp.width, bmp.height)
    ctx.drawImage(bmp, 0, 0)
    const data = ctx.getImageData(0, 0, bmp.width, bmp.height)
    bmp.close()
    return data
  } catch {
    const objectUrl = URL.createObjectURL(blob)
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image()
        el.onload = () => resolve(el)
        el.onerror = () => reject(new Error('Image decode failed'))
        el.src = objectUrl
      })
      const ctx = getSharedCtx(img.naturalWidth, img.naturalHeight)
      ctx.drawImage(img, 0, 0)
      return ctx.getImageData(0, 0, img.naturalWidth, img.naturalHeight)
    } finally {
      URL.revokeObjectURL(objectUrl)
    }
  }
}

export async function fetchTileImageData(url: string, label: string): Promise<ImageData> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${label} tile failed: ${res.status}`)
  return decodeTileImage(await res.blob())
}
