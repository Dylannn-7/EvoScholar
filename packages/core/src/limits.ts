// Shared size and count limits for file tools, HTTP message attachments, and CLI.
export const KiB = 1024
export const MiB_BYTES = 1024 * 1024

export const FILE_LIMITS = Object.freeze({
  /** Maximum UTF-8 bytes returned by a single read_file text call (256 KiB). */
  textReadBytes: 256 * KiB,
  /** Maximum size of a single image file read by tools or attached to a message (10 MiB). */
  imageBytes: 10 * MiB_BYTES,
  /** Maximum number of images in a single user message. */
  messageImagesMax: 8,
  /** Maximum combined decoded size of all images in a single user message (20 MiB). */
  messageImagesTotalBytes: 20 * MiB_BYTES
})

/** Estimate decoded byte length of a base64 payload without allocating a Buffer. */
export function base64DecodedBytes(b64: string): number {
  const clean = b64.replace(/\s+/g, '')
  const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((clean.length * 3) / 4) - pad)
}
