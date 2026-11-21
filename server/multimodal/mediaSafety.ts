import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MultimodalAssetKind } from './interfaces.ts';

export const MULTIMODAL_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];
export const MULTIMODAL_DOCUMENT_EXTENSIONS = ['.pdf', '.docx', '.txt', '.md'];
export const MULTIMODAL_AUDIO_EXTENSIONS = ['.wav', '.mp3', '.ogg', '.webm', '.m4a'];

export const ALL_MULTIMODAL_EXTENSIONS = [
  ...MULTIMODAL_IMAGE_EXTENSIONS,
  ...MULTIMODAL_DOCUMENT_EXTENSIONS,
  ...MULTIMODAL_AUDIO_EXTENSIONS,
];

export const DEFAULT_CHAT_ALLOWED_EXTENSIONS = [
  '.txt',
  '.md',
  '.json',
  '.csv',
  '.py',
  '.ts',
  '.tsx',
  '.js',
  '.yaml',
  '.yml',
  '.log',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.pdf',
  '.docx',
  '.wav',
  '.mp3',
  '.ogg',
  '.webm',
  '.m4a',
];

const BLOCKED_MEDIA_EXTENSIONS = new Set([
  '.db',
  '.sqlite',
  '.sqlite3',
  '.exe',
  '.dll',
  '.bat',
  '.cmd',
  '.ps1',
  '.sh',
  '.so',
  '.vbs',
]);

export function getMultimodalTempRoot(customRoot?: string): string {
  const root = customRoot
    ? path.resolve(customRoot)
    : path.resolve(process.cwd(), 'data', 'multimodal_tmp');
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
  }
  return root;
}

export function getTessdataCacheDir(): string {
  const dir = path.resolve(process.cwd(), 'data', 'tessdata');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function sanitizeMultimodalFilename(rawName: string): string {
  const raw = String(rawName || '').trim();
  if (!raw || raw.includes('\0') || raw.includes('/') || raw.includes('\\') || raw.includes('..')) {
    throw new Error('Filename cannot contain path separators or traversal segments.');
  }
  const safe = raw.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!safe || safe === '.' || safe === '..') {
    throw new Error('Invalid filename.');
  }
  const ext = path.extname(safe).toLowerCase();
  if (BLOCKED_MEDIA_EXTENSIONS.has(ext)) {
    throw new Error(`Extension "${ext}" is blocked by multimodal security policy.`);
  }
  return safe;
}

export function classifyMultimodalExtension(ext: string): MultimodalAssetKind | null {
  const lower = ext.toLowerCase();
  if (MULTIMODAL_IMAGE_EXTENSIONS.includes(lower)) return 'image';
  if (MULTIMODAL_DOCUMENT_EXTENSIONS.includes(lower)) return 'document';
  if (MULTIMODAL_AUDIO_EXTENSIONS.includes(lower)) return 'audio';
  return null;
}

export function normalizeMimeType(ext: string, providedMime?: string): string {
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.webm': 'audio/webm',
    '.m4a': 'audio/mp4',
  };
  if (map[ext.toLowerCase()]) return map[ext.toLowerCase()];
  return (providedMime || 'application/octet-stream').split(';')[0].trim() || 'application/octet-stream';
}

export function verifyMultimodalMagicBytes(buf: Buffer, ext: string): { valid: boolean; reason?: string } {
  const lower = ext.toLowerCase();
  if (buf.length === 0) {
    return { valid: false, reason: 'Uploaded file is empty.' };
  }

  if (lower === '.png') {
    const ok = buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    return ok ? { valid: true } : { valid: false, reason: 'File does not match PNG signature.' };
  }

  if (lower === '.jpg' || lower === '.jpeg') {
    const ok = buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    return ok ? { valid: true } : { valid: false, reason: 'File does not match JPEG signature.' };
  }

  if (lower === '.webp') {
    const ok =
      buf.length >= 12 &&
      buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buf.subarray(8, 12).toString('ascii') === 'WEBP';
    return ok ? { valid: true } : { valid: false, reason: 'File does not match WEBP signature.' };
  }

  if (lower === '.pdf') {
    const header = buf.subarray(0, 16).toString('ascii');
    const ok = header.includes('%PDF-');
    return ok ? { valid: true } : { valid: false, reason: 'File does not match PDF (%PDF-) header.' };
  }

  if (lower === '.docx') {
    const ok = buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b;
    return ok ? { valid: true } : { valid: false, reason: 'File does not match DOCX ZIP header.' };
  }

  if (lower === '.txt' || lower === '.md') {
    const sample = buf.subarray(0, Math.min(buf.length, 4096));
    if (sample.includes(0x00)) {
      return { valid: false, reason: 'Text file appears to contain binary NUL bytes.' };
    }
    return { valid: true };
  }

  if (lower === '.wav') {
    const ok =
      buf.length >= 12 &&
      buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buf.subarray(8, 12).toString('ascii') === 'WAVE';
    return ok ? { valid: true } : { valid: false, reason: 'Audio file does not match WAV RIFF/WAVE header.' };
  }

  if (lower === '.mp3') {
    const hasId3 = buf.length >= 3 && buf.subarray(0, 3).toString('ascii') === 'ID3';
    const hasFrameSync = buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
    return hasId3 || hasFrameSync
      ? { valid: true }
      : { valid: false, reason: 'Audio file does not match MP3 ID3 or MPEG frame sync header.' };
  }

  if (lower === '.ogg') {
    const ok = buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === 'OggS';
    return ok ? { valid: true } : { valid: false, reason: 'Audio file does not match OGG (OggS) header.' };
  }

  if (lower === '.webm') {
    const ok = buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
    return ok ? { valid: true } : { valid: false, reason: 'Audio file does not match WebM/EBML signature.' };
  }

  if (lower === '.m4a') {
    const ok = buf.length >= 12 && buf.subarray(4, 8).toString('ascii') === 'ftyp';
    return ok ? { valid: true } : { valid: false, reason: 'Audio file does not match M4A/ISO-BMFF ftyp box.' };
  }

  return { valid: false, reason: `Unsupported multimodal format "${lower}".` };
}

export function decodeValidatedMediaPayload(
  raw: string,
  encoding: 'base64' | 'utf8' = 'base64',
  maxBytes = 10 * 1024 * 1024
): Buffer {
  if (typeof raw !== 'string' || !raw.length) {
    throw new Error('Media payload data is required.');
  }
  const normalized = raw.startsWith('data:') && raw.includes(',') ? raw.split(',').slice(1).join(',') : raw;
  if (encoding === 'utf8') {
    const buf = Buffer.from(normalized, 'utf-8');
    if (buf.byteLength > maxBytes) {
      throw new Error(`Payload exceeds ${(maxBytes / (1024 * 1024)).toFixed(1)} MB limit.`);
    }
    return buf;
  }

  const cleanB64 = normalized.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=]+$/.test(cleanB64)) {
    throw new Error('Invalid base64 encoding in uploaded media.');
  }
  const approxBytes = Math.ceil((cleanB64.length * 3) / 4);
  if (approxBytes > maxBytes + 16) {
    throw new Error(`Encoded media exceeds ${(maxBytes / (1024 * 1024)).toFixed(1)} MB limit.`);
  }
  const buf = Buffer.from(cleanB64, 'base64');
  if (buf.byteLength > maxBytes) {
    throw new Error(`Decoded media exceeds ${(maxBytes / (1024 * 1024)).toFixed(1)} MB limit.`);
  }
  return buf;
}

export async function withTempMediaFile<T>(
  ext: string,
  buffer: Buffer,
  fn: (tempPath: string) => Promise<T>,
  customRoot?: string
): Promise<T> {
  cleanupExpiredTempMedia(15 * 60 * 1000, customRoot);
  const root = getMultimodalTempRoot(customRoot);
  const safeExt = ext.startsWith('.') ? ext.toLowerCase().replace(/[^a-z0-9.]/g, '') : `.${ext.replace(/[^a-z0-9]/g, '')}`;
  const tempName = `media-${crypto.randomUUID()}${safeExt || '.bin'}`;
  const tempPath = path.resolve(root, tempName);
  if (!tempPath.startsWith(root + path.sep)) {
    throw new Error('Temporary media path escapes confined staging directory.');
  }

  fs.writeFileSync(tempPath, buffer);
  try {
    return await fn(tempPath);
  } finally {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // Best-effort cleanup
    }
  }
}

export function cleanupExpiredTempMedia(maxAgeMs = 15 * 60 * 1000, customRoot?: string): number {
  const root = getMultimodalTempRoot(customRoot);
  let removed = 0;
  try {
    const entries = fs.readdirSync(root);
    const now = Date.now();
    for (const entry of entries) {
      const target = path.resolve(root, entry);
      if (!target.startsWith(root + path.sep)) continue;
      try {
        const stat = fs.statSync(target);
        if (stat.isFile() && now - stat.mtimeMs > maxAgeMs) {
          fs.unlinkSync(target);
          removed += 1;
        }
      } catch {
        // Ignore transient race
      }
    }
  } catch {
    // Ignore read errors
  }
  return removed;
}

export function countMultimodalTempFiles(customRoot?: string): number {
  const root = getMultimodalTempRoot(customRoot);
  try {
    return fs.readdirSync(root).length;
  } catch {
    return 0;
  }
}
