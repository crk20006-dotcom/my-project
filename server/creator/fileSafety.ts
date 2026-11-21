import fs from 'node:fs';
import path from 'node:path';

export const CREATOR_SUPPORTED_CODE_EXTENSIONS = [
  '.py',
  '.js',
  '.ts',
  '.tsx',
  '.html',
  '.css',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
];

export const CREATOR_SUPPORTED_DOCUMENT_EXTENSIONS = ['.md', '.txt', '.docx', '.pdf', '.json'];
export const CREATOR_SUPPORTED_PRESENTATION_EXTENSIONS = ['.pptx', '.json'];
export const CREATOR_SUPPORTED_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg'];

export const ALL_CREATOR_UPLOAD_EXTENSIONS = new Set([
  ...CREATOR_SUPPORTED_CODE_EXTENSIONS,
  ...CREATOR_SUPPORTED_DOCUMENT_EXTENSIONS,
  ...CREATOR_SUPPORTED_PRESENTATION_EXTENSIONS,
  ...CREATOR_SUPPORTED_IMAGE_EXTENSIONS,
]);

const BLOCKED_FILENAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  'genesis.db',
  'genesis.db-wal',
  'genesis.db-shm',
]);

const BLOCKED_EXTENSIONS = new Set([
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
]);

export function getCreatorWorkspaceRoot(customRoot?: string): string {
  const base = customRoot
    ? path.resolve(customRoot)
    : path.resolve(process.cwd(), 'data', 'creator_workspace');
  if (!fs.existsSync(base)) {
    fs.mkdirSync(base, { recursive: true });
  }
  return base;
}

export function sanitizeCreatorId(rawId: string): string {
  const cleaned = rawId.trim().replace(/[^a-zA-Z0-9_-]/g, '');
  if (!cleaned) {
    throw new Error('Invalid Creator project identifier.');
  }
  return cleaned;
}

export function sanitizeCreatorFilename(rawName: string): string {
  const raw = String(rawName || '').trim();
  if (!raw || raw.includes('\0') || raw.includes('/') || raw.includes('\\') || raw.includes('..')) {
    throw new Error('Filename cannot contain path separators or traversal segments.');
  }
  const sanitized = raw.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!sanitized || sanitized === '.' || sanitized === '..') {
    throw new Error('Invalid filename.');
  }
  const lower = sanitized.toLowerCase();
  if (BLOCKED_FILENAMES.has(lower)) {
    throw new Error(`Filename "${sanitized}" is protected by security policy.`);
  }
  const ext = path.extname(lower);
  if (BLOCKED_EXTENSIONS.has(ext)) {
    throw new Error(`Extension "${ext}" is blocked by Creator security policy.`);
  }
  return sanitized;
}

export function resolveCreatorProjectDir(projectId: string, customRoot?: string): string {
  const workspaceRoot = getCreatorWorkspaceRoot(customRoot);
  const safeId = sanitizeCreatorId(projectId);
  const resolved = path.resolve(workspaceRoot, safeId);
  if (!resolved.startsWith(workspaceRoot + path.sep)) {
    throw new Error('Project path escapes approved Creator workspace.');
  }
  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { recursive: true });
  }
  return resolved;
}

export function resolveCreatorFilePath(
  projectId: string,
  filename: string,
  customRoot?: string
): string {
  const projDir = resolveCreatorProjectDir(projectId, customRoot);
  const safeName = sanitizeCreatorFilename(filename);
  const resolved = path.resolve(projDir, safeName);
  if (!resolved.startsWith(projDir + path.sep)) {
    throw new Error('File path escapes approved Creator project directory.');
  }
  return resolved;
}

export function verifyZipMagicBytes(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b;
}

export function verifyImageMagicBytes(buf: Buffer, ext: string): boolean {
  if (ext === '.png') {
    return (
      buf.length >= 8 &&
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47
    );
  }
  if (ext === '.jpg' || ext === '.jpeg') {
    return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  }
  return false;
}

export function inferKindAndFormatFromFilename(filename: string): {
  kind: 'code' | 'document' | 'presentation';
  format: string;
} {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.pptx.json') || lower.endsWith('.pptx')) {
    return { kind: 'presentation', format: 'pptx' };
  }
  const ext = path.extname(lower);
  const codeMap: Record<string, string> = {
    '.py': 'python',
    '.js': 'javascript',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.html': 'html',
    '.css': 'css',
    '.c': 'c',
    '.cpp': 'cpp',
    '.h': 'c',
    '.hpp': 'cpp',
  };
  if (codeMap[ext]) {
    return { kind: 'code', format: codeMap[ext] };
  }
  if (ext === '.md') return { kind: 'document', format: 'markdown' };
  if (ext === '.txt') return { kind: 'document', format: 'txt' };
  if (ext === '.docx') return { kind: 'document', format: 'docx' };
  if (ext === '.pdf') return { kind: 'document', format: 'pdf' };
  if (ext === '.json') return { kind: 'code', format: 'json' };
  return { kind: 'document', format: 'markdown' };
}
