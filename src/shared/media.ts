// Uploaded images: allowed types, limits and the public path they are served from.

// Product photos from a phone or camera fit comfortably; MEDIUMBLOB allows up to 16 MB.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const IMAGE_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const;
export type ImageMimeType = keyof typeof IMAGE_TYPES;

export function isImageMimeType(value: string): value is ImageMimeType {
  return Object.hasOwn(IMAGE_TYPES, value);
}

// The type is decided from the file's leading bytes, never from the client's Content-Type or filename.
// SVG is deliberately not accepted: it can carry scripts.
export function detectImageType(data: Uint8Array): ImageMimeType | null {
  const at = (offset: number, bytes: number[]) => bytes.every((byte, i) => data[offset + i] === byte);
  if (data.length >= 3 && at(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (data.length >= 8 && at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  // RIFF....WEBP
  if (data.length >= 12 && at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return "image/webp";
  return null;
}

// The original filename is kept for display only: no path parts, no control characters, bounded length.
export function cleanFilename(original: string | undefined, mimeType: ImageMimeType): string {
  const base = (original ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, "").trim().slice(0, 200);
  return cleaned || `image.${IMAGE_TYPES[mimeType]}`;
}

// Stored images are referenced by ID; the URL is derived, never stored, so it works in every environment.
export function mediaPath(id: string): string {
  return `/api/v1/media/${id}`;
}
