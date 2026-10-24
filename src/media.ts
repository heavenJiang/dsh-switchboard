/** Pure media helpers: what to download from a message, and how to send a file back. */

import { basename, extname } from 'node:path'
import type { TgMessage } from './telegram.ts'

/** One downloadable attachment of an incoming message. */
export interface IncomingAttachment {
  readonly fileId: string
  /** Display name for the staged file. */
  readonly name: string
  /** Declared MIME type, when Telegram reports or implies one. */
  readonly mediaType?: string
  /** Declared size in bytes, when known; checked before downloading. */
  readonly size?: number
}

/** Image types offered to the image channel; the Host still decides what it accepts. */
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

const EXTENSION_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
}

/**
 * List a message's attachments. Photos keep only their largest size; animated
 * stickers carry no usable image and are skipped.
 * @param message - incoming message.
 * @returns attachments in display order (usually zero or one).
 */
export function incomingAttachments(message: TgMessage): IncomingAttachment[] {
  const out: IncomingAttachment[] = []
  const id = message.message_id
  // Telegram lists photo sizes smallest first.
  const largest = message.photo?.at(-1)
  if (largest !== undefined) {
    out.push({ fileId: largest.file_id, name: `photo_${id}.jpg`, mediaType: 'image/jpeg', ...size(largest.file_size) })
  }
  const media: [keyof TgMessage, string, string | undefined][] = [
    ['document', `file_${id}`, undefined],
    ['video', `video_${id}.mp4`, 'video/mp4'],
    ['animation', `animation_${id}.mp4`, 'video/mp4'],
    ['video_note', `video_note_${id}.mp4`, 'video/mp4'],
    ['audio', `audio_${id}.mp3`, 'audio/mpeg'],
    ['voice', `voice_${id}.ogg`, 'audio/ogg'],
  ]
  for (const [field, fallbackName, fallbackType] of media) {
    const file = message[field] as { file_id: string; file_name?: string; mime_type?: string; file_size?: number } | undefined
    if (file === undefined) continue
    const mediaType = file.mime_type ?? fallbackType
    out.push({
      fileId: file.file_id,
      name: safeName(file.file_name ?? fallbackName),
      ...(mediaType === undefined ? {} : { mediaType }),
      ...size(file.file_size),
    })
  }
  const sticker = message.sticker
  if (sticker !== undefined && sticker.is_animated !== true && sticker.is_video !== true) {
    out.push({ fileId: sticker.file_id, name: `sticker_${id}.webp`, mediaType: 'image/webp', ...size(sticker.file_size) })
  }
  return out
}

/**
 * Whether an attachment should go through the Host's image channel, where the
 * model sees the picture itself rather than a file path.
 * @param attachment - incoming attachment.
 */
export function isPromptImage(attachment: IncomingAttachment): boolean {
  return attachment.mediaType !== undefined && IMAGE_TYPES.has(attachment.mediaType)
}

/** Telegram's photo upload ceiling; larger images go as documents. */
const PHOTO_LIMIT = 10 * 1024 * 1024

/**
 * Choose how to send a file back: inline photo for ordinary images, document otherwise.
 * @param path - file path (only the extension is read).
 * @param bytes - file size.
 */
export function outgoingKind(path: string, bytes: number): 'photo' | 'document' {
  const type = EXTENSION_TYPES[extname(path).toLowerCase()]
  // GIFs lose animation as photos.
  return type !== undefined && type !== 'image/gif' && bytes <= PHOTO_LIMIT ? 'photo' : 'document'
}

/** Strip directory parts and control characters from a sender-supplied name. */
export function safeName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const leaf = basename(name.replace(/\\/gu, '/')).replace(/[\u0000-\u001f]/gu, '').trim()
  return leaf === '' || leaf === '.' || leaf === '..' ? 'file' : leaf
}

function size(bytes: number | undefined): { size?: number } {
  return bytes === undefined ? {} : { size: bytes }
}
