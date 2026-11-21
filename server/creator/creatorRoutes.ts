import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { getDb, hasFts5Support, runInTransaction } from '../db.ts';
import { inspectTokensServer } from '../ai/interfaces.ts';
import { resolveModelAdapter } from '../ai/adapters.ts';
import {
  chunkKnowledgeText,
  detectSensitiveSecret,
  formatRetrievedSystemContext,
  SqliteKeywordRetriever,
} from '../ai/memoryRetrieval.ts';
import { defaultAgentManager } from '../agent/agentManager.ts';
import {
  analyzeCode,
  generateStarterTemplate,
  runRestrictedJavaScript,
  SUPPORTED_CODE_LANGUAGES,
  type SupportedCodeLanguage,
} from './codeStudio.ts';
import {
  exportDocumentAsDocx,
  exportDocumentAsMarkdown,
  exportDocumentAsPdf,
  exportDocumentAsText,
  extractMarkdownFromDocxBuffer,
} from './documentStudio.ts';
import {
  ALL_CREATOR_UPLOAD_EXTENSIONS,
  inferKindAndFormatFromFilename,
  resolveCreatorFilePath,
  resolveCreatorProjectDir,
  sanitizeCreatorFilename,
  verifyImageMagicBytes,
} from './fileSafety.ts';
import {
  buildPresentationFromOutline,
  exportPresentationAsPptx,
  importUploadedPptx,
  normalizePresentationDeck,
  type PresentationDeck,
  type PresentationThemeId,
} from './presentationStudio.ts';

interface CreatorRuntimeSettings {
  operator_name: string;
  inference_endpoint_url: string;
  prefer_local_inference: boolean;
  active_model_id: string;
  inference_temperature: number;
  inference_max_tokens: number;
  inference_timeout_ms: number;
  max_upload_mb: number;
}

export function createCreatorStudioRouter(getSettings: () => CreatorRuntimeSettings): express.Router {
  const router = express.Router();

  // ---------------------------------------------------------------------------
  // Projects CRUD
  // ---------------------------------------------------------------------------
  router.get('/projects', (_req, res) => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT p.*,
                (SELECT COUNT(*) FROM creator_project_files f WHERE f.project_id = p.id) AS file_count
         FROM creator_projects p
         ORDER BY p.updated_at DESC`
      )
      .all() as Array<Record<string, unknown>>;

    res.json(
      rows.map((r) => ({
        ...r,
        metadata: (() => {
          try {
            return JSON.parse(String(r.metadata_json || '{}'));
          } catch {
            return {};
          }
        })(),
      }))
    );
  });

  router.post('/projects', (req, res) => {
    const db = getDb();
    const { name, description, workspace_type, linked_research_id } = req.body as {
      name?: string;
      description?: string;
      workspace_type?: string;
      linked_research_id?: string | null;
    };

    if (!name || !name.trim()) {
      res.status(400).json({ error: 'Project name is required.' });
      return;
    }

    const validType = ['coding', 'documents', 'presentations', 'mixed'].includes(workspace_type || '')
      ? workspace_type!
      : 'mixed';
    const now = new Date().toISOString();
    const id = `proj-${crypto.randomUUID()}`;

    db.prepare(
      'INSERT INTO creator_projects (id, name, description, workspace_type, linked_research_id, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      id,
      name.trim().slice(0, 120),
      (description || '').trim().slice(0, 800),
      validType,
      linked_research_id || null,
      JSON.stringify({}),
      now,
      now
    );

    const created = db.prepare('SELECT * FROM creator_projects WHERE id = ?').get(id) as Record<
      string,
      unknown
    >;
    res.status(201).json({ ...created, file_count: 0, metadata: {} });
  });

  router.patch('/projects/:id', (req, res) => {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM creator_projects WHERE id = ?').get(req.params.id) as
      | Record<string, unknown>
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Creator project not found.' });
      return;
    }

    const { name, description, linked_research_id } = req.body as {
      name?: string;
      description?: string;
      linked_research_id?: string | null;
    };

    const now = new Date().toISOString();
    db.prepare(
      'UPDATE creator_projects SET name = ?, description = ?, linked_research_id = ?, updated_at = ? WHERE id = ?'
    ).run(
      name !== undefined ? name.trim().slice(0, 120) || String(existing.name) : String(existing.name),
      description !== undefined ? description.trim().slice(0, 800) : String(existing.description || ''),
      linked_research_id !== undefined
        ? linked_research_id
        : (existing.linked_research_id as string | null),
      now,
      req.params.id
    );

    const updated = db.prepare('SELECT * FROM creator_projects WHERE id = ?').get(req.params.id) as Record<
      string,
      unknown
    >;
    const fileCount = (
      db.prepare('SELECT COUNT(*) as c FROM creator_project_files WHERE project_id = ?').get(req.params.id) as {
        c: number;
      }
    ).c;
    res.json({ ...updated, file_count: fileCount, metadata: {} });
  });

  router.delete('/projects/:id', (req, res) => {
    const db = getDb();
    const result = db.prepare('DELETE FROM creator_projects WHERE id = ?').run(req.params.id);
    if (result.changes === 0) {
      res.status(404).json({ error: 'Creator project not found.' });
      return;
    }
    try {
      const projDir = resolveCreatorProjectDir(req.params.id);
      if (fs.existsSync(projDir)) {
        fs.rmSync(projDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors for workspace folder
    }
    res.json({ deleted: true, id: req.params.id });
  });

  // ---------------------------------------------------------------------------
  // Project Files & Revision History (with Overwrite Protection)
  // ---------------------------------------------------------------------------
  router.get('/projects/:id/files', (req, res) => {
    const db = getDb();
    const project = db.prepare('SELECT id FROM creator_projects WHERE id = ?').get(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Creator project not found.' });
      return;
    }
    const rows = db
      .prepare('SELECT * FROM creator_project_files WHERE project_id = ? ORDER BY updated_at DESC')
      .all(req.params.id) as Array<Record<string, unknown>>;

    res.json(
      rows.map((r) => ({
        ...r,
        metadata: (() => {
          try {
            return JSON.parse(String(r.metadata_json || '{}'));
          } catch {
            return {};
          }
        })(),
      }))
    );
  });

  router.post('/projects/:id/files', (req, res) => {
    const db = getDb();
    const project = db.prepare('SELECT id FROM creator_projects WHERE id = ?').get(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Creator project not found.' });
      return;
    }

    const { filename, kind, format, content, summary, overwrite, metadata } = req.body as {
      filename?: string;
      kind?: 'code' | 'document' | 'presentation';
      format?: string;
      content?: string;
      summary?: string;
      overwrite?: boolean;
      metadata?: Record<string, unknown>;
    };

    if (!filename || !filename.trim()) {
      res.status(400).json({ error: 'Filename is required.' });
      return;
    }

    let safeName: string;
    try {
      safeName = sanitizeCreatorFilename(filename);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid filename.' });
      return;
    }

    const inferred = inferKindAndFormatFromFilename(safeName);
    const finalKind = kind && ['code', 'document', 'presentation'].includes(kind) ? kind : inferred.kind;
    const finalFormat = (format || inferred.format || 'markdown').toLowerCase();
    const finalContent =
      typeof content === 'string'
        ? content
        : finalKind === 'code' && SUPPORTED_CODE_LANGUAGES.includes(finalFormat as SupportedCodeLanguage)
          ? generateStarterTemplate(finalFormat as SupportedCodeLanguage, safeName.replace(/\.[^.]+$/, ''))
          : finalKind === 'presentation'
            ? JSON.stringify(
                normalizePresentationDeck({
                  title: safeName.replace(/\.pptx\.json$|\.pptx$/i, ''),
                }),
                null,
                2
              )
            : `# ${safeName.replace(/\.[^.]+$/, '')}\n\n`;

    const existing = db
      .prepare('SELECT * FROM creator_project_files WHERE project_id = ? AND filename = ?')
      .get(req.params.id, safeName) as { id: string; filename: string; version: number } | undefined;

    if (existing && overwrite !== true) {
      res.status(409).json({
        error: `File "${safeName}" already exists in this project. Confirm overwrite before replacing it.`,
        code: 'OVERWRITE_CONFIRMATION_REQUIRED',
        existing_id: existing.id,
        existing_name: existing.filename,
      });
      return;
    }

    const now = new Date().toISOString();
    const fileId = runInTransaction(db, () => {
      if (existing) {
        const nextVersion = existing.version + 1;
        db.prepare(
          'UPDATE creator_project_files SET kind = ?, format = ?, content = ?, metadata_json = ?, version = ?, updated_at = ? WHERE id = ?'
        ).run(
          finalKind,
          finalFormat,
          finalContent,
          JSON.stringify(metadata || {}),
          nextVersion,
          now,
          existing.id
        );
        db.prepare(
          'INSERT INTO creator_revisions (id, file_id, project_id, version, summary, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(
          `crev-${crypto.randomUUID()}`,
          existing.id,
          req.params.id,
          nextVersion,
          summary || 'Confirmed overwrite',
          finalContent,
          now
        );
        db.prepare('UPDATE creator_projects SET updated_at = ? WHERE id = ?').run(now, req.params.id);
        return existing.id;
      }

      const id = `cfile-${crypto.randomUUID()}`;
      db.prepare(
        'INSERT INTO creator_project_files (id, project_id, filename, kind, format, content, metadata_json, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        id,
        req.params.id,
        safeName,
        finalKind,
        finalFormat,
        finalContent,
        JSON.stringify(metadata || {}),
        1,
        now,
        now
      );
      db.prepare(
        'INSERT INTO creator_revisions (id, file_id, project_id, version, summary, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(
        `crev-${crypto.randomUUID()}`,
        id,
        req.params.id,
        1,
        summary || 'Created file',
        finalContent,
        now
      );
      db.prepare('UPDATE creator_projects SET updated_at = ? WHERE id = ?').run(now, req.params.id);
      return id;
    });

    const saved = db.prepare('SELECT * FROM creator_project_files WHERE id = ?').get(fileId) as Record<
      string,
      unknown
    >;
    res.status(existing ? 200 : 201).json({
      ...saved,
      metadata: metadata || {},
    });
  });

  router.put('/files/:fileId', (req, res) => {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM creator_project_files WHERE id = ?').get(req.params.fileId) as
      | {
          id: string;
          project_id: string;
          filename: string;
          kind: string;
          format: string;
          content: string;
          metadata_json: string;
          version: number;
        }
      | undefined;

    if (!existing) {
      res.status(404).json({ error: 'Creator file not found.' });
      return;
    }

    const { filename, format, content, summary, overwrite, metadata } = req.body as {
      filename?: string;
      format?: string;
      content?: string;
      summary?: string;
      overwrite?: boolean;
      metadata?: Record<string, unknown>;
    };

    let targetName = existing.filename;
    if (filename !== undefined && filename.trim() !== existing.filename) {
      try {
        targetName = sanitizeCreatorFilename(filename);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid filename.' });
        return;
      }
      const conflict = db
        .prepare('SELECT id, filename FROM creator_project_files WHERE project_id = ? AND filename = ? AND id != ?')
        .get(existing.project_id, targetName, existing.id) as { id: string; filename: string } | undefined;
      if (conflict && overwrite !== true) {
        res.status(409).json({
          error: `Target filename "${targetName}" already exists. Confirm overwrite before replacing it.`,
          code: 'OVERWRITE_CONFIRMATION_REQUIRED',
          existing_id: conflict.id,
          existing_name: conflict.filename,
        });
        return;
      }
    }

    const nextContent = typeof content === 'string' ? content : existing.content;
    const nextFormat = format ? format.toLowerCase() : existing.format;
    const nextMeta = metadata ? JSON.stringify(metadata) : existing.metadata_json;
    const nextVersion = existing.version + 1;
    const now = new Date().toISOString();

    runInTransaction(db, () => {
      if (targetName !== existing.filename) {
        db.prepare('DELETE FROM creator_project_files WHERE project_id = ? AND filename = ? AND id != ?').run(
          existing.project_id,
          targetName,
          existing.id
        );
      }
      db.prepare(
        'UPDATE creator_project_files SET filename = ?, format = ?, content = ?, metadata_json = ?, version = ?, updated_at = ? WHERE id = ?'
      ).run(targetName, nextFormat, nextContent, nextMeta, nextVersion, now, existing.id);

      db.prepare(
        'INSERT INTO creator_revisions (id, file_id, project_id, version, summary, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(
        `crev-${crypto.randomUUID()}`,
        existing.id,
        existing.project_id,
        nextVersion,
        summary || `Saved v${nextVersion}`,
        nextContent,
        now
      );
      db.prepare('UPDATE creator_projects SET updated_at = ? WHERE id = ?').run(now, existing.project_id);
    });

    const updated = db.prepare('SELECT * FROM creator_project_files WHERE id = ?').get(existing.id) as Record<
      string,
      unknown
    >;
    res.json({
      ...updated,
      metadata: (() => {
        try {
          return JSON.parse(String(updated.metadata_json || '{}'));
        } catch {
          return {};
        }
      })(),
    });
  });

  router.delete('/files/:fileId', (req, res) => {
    const db = getDb();
    const result = db.prepare('DELETE FROM creator_project_files WHERE id = ?').run(req.params.fileId);
    if (result.changes === 0) {
      res.status(404).json({ error: 'Creator file not found.' });
      return;
    }
    res.json({ deleted: true, id: req.params.fileId });
  });

  router.get('/files/:fileId/revisions', (req, res) => {
    const db = getDb();
    const file = db.prepare('SELECT id FROM creator_project_files WHERE id = ?').get(req.params.fileId);
    if (!file) {
      res.status(404).json({ error: 'Creator file not found.' });
      return;
    }
    const revisions = db
      .prepare('SELECT * FROM creator_revisions WHERE file_id = ? ORDER BY version DESC')
      .all(req.params.fileId);
    res.json(revisions);
  });

  router.post('/files/:fileId/restore/:revisionId', (req, res) => {
    const db = getDb();
    const file = db.prepare('SELECT * FROM creator_project_files WHERE id = ?').get(req.params.fileId) as
      | { id: string; project_id: string; version: number }
      | undefined;
    const rev = db
      .prepare('SELECT * FROM creator_revisions WHERE id = ? AND file_id = ?')
      .get(req.params.revisionId, req.params.fileId) as
      | { id: string; version: number; content: string }
      | undefined;

    if (!file || !rev) {
      res.status(404).json({ error: 'File or revision not found.' });
      return;
    }

    const nextVersion = file.version + 1;
    const now = new Date().toISOString();
    runInTransaction(db, () => {
      db.prepare('UPDATE creator_project_files SET content = ?, version = ?, updated_at = ? WHERE id = ?').run(
        rev.content,
        nextVersion,
        now,
        file.id
      );
      db.prepare(
        'INSERT INTO creator_revisions (id, file_id, project_id, version, summary, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(
        `crev-${crypto.randomUUID()}`,
        file.id,
        file.project_id,
        nextVersion,
        `Restored from v${rev.version}`,
        rev.content,
        now
      );
      db.prepare('UPDATE creator_projects SET updated_at = ? WHERE id = ?').run(now, file.project_id);
    });

    const updated = db.prepare('SELECT * FROM creator_project_files WHERE id = ?').get(file.id);
    res.json(updated);
  });

  // ---------------------------------------------------------------------------
  // File Upload & Parsing (Code, Markdown, Text, DOCX, PPTX, PNG/JPEG)
  // ---------------------------------------------------------------------------
  router.post('/upload', async (req, res) => {
    const db = getDb();
    const settings = getSettings();
    const { project_id, filename, encoding, data, overwrite } = req.body as {
      project_id?: string;
      filename?: string;
      encoding?: 'utf8' | 'base64';
      data?: string;
      overwrite?: boolean;
    };

    if (!project_id || !filename || typeof data !== 'string') {
      res.status(400).json({ error: 'project_id, filename, and data are required.' });
      return;
    }

    const project = db.prepare('SELECT id FROM creator_projects WHERE id = ?').get(project_id);
    if (!project) {
      res.status(404).json({ error: 'Creator project not found.' });
      return;
    }

    let safeName: string;
    try {
      safeName = sanitizeCreatorFilename(filename);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid filename.' });
      return;
    }

    const ext = path.extname(safeName).toLowerCase();
    if (!ALL_CREATOR_UPLOAD_EXTENSIONS.has(ext)) {
      res.status(400).json({
        error: `Unsupported file extension "${ext}". Allowed: ${Array.from(ALL_CREATOR_UPLOAD_EXTENSIONS).join(', ')}`,
      });
      return;
    }

    const buf = encoding === 'base64' ? Buffer.from(data, 'base64') : Buffer.from(data, 'utf-8');
    const maxBytes = (settings.max_upload_mb || 5) * 1024 * 1024;
    if (buf.byteLength > maxBytes) {
      res.status(400).json({
        error: `File size (${(buf.byteLength / (1024 * 1024)).toFixed(2)} MB) exceeds ${settings.max_upload_mb} MB limit.`,
      });
      return;
    }

    try {
      // Image asset validation returns validated Data URL for Presentations
      if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
        if (!verifyImageMagicBytes(buf, ext)) {
          res.status(400).json({ error: `Invalid ${ext.toUpperCase()} image file signature.` });
          return;
        }
        const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
        res.json({
          type: 'image_asset',
          name: safeName,
          mimeType,
          size: buf.byteLength,
          dataUrl: `data:${mimeType};base64,${buf.toString('base64')}`,
        });
        return;
      }

      let targetFilename = safeName;
      let parsedKind: 'code' | 'document' | 'presentation';
      let parsedFormat: string;
      let parsedContent: string;

      if (ext === '.docx') {
        parsedContent = await extractMarkdownFromDocxBuffer(buf);
        parsedKind = 'document';
        parsedFormat = 'markdown';
        targetFilename = safeName.replace(/\.docx$/i, '.md');
      } else if (ext === '.pptx') {
        const deck = await importUploadedPptx(safeName, buf);
        parsedContent = JSON.stringify(deck, null, 2);
        parsedKind = 'presentation';
        parsedFormat = 'pptx';
        targetFilename = safeName.replace(/\.pptx$/i, '.pptx.json');
      } else if (ext === '.pdf') {
        res.status(400).json({
          error: 'Binary PDF import is not supported for text editing; upload .md, .txt, or .docx for editable import, and export to .pdf.',
        });
        return;
      } else {
        parsedContent = buf.toString('utf-8');
        const inferred = inferKindAndFormatFromFilename(safeName);
        parsedKind = inferred.kind;
        parsedFormat = inferred.format;
      }

      const existing = db
        .prepare('SELECT id, filename, version FROM creator_project_files WHERE project_id = ? AND filename = ?')
        .get(project_id, targetFilename) as { id: string; filename: string; version: number } | undefined;

      if (existing && overwrite !== true) {
        res.status(409).json({
          error: `File "${targetFilename}" already exists in this project. Confirm overwrite before replacing it.`,
          code: 'OVERWRITE_CONFIRMATION_REQUIRED',
          existing_id: existing.id,
          existing_name: existing.filename,
        });
        return;
      }

      const now = new Date().toISOString();
      const fileId = runInTransaction(db, () => {
        if (existing) {
          const nextVersion = existing.version + 1;
          db.prepare(
            'UPDATE creator_project_files SET kind = ?, format = ?, content = ?, version = ?, updated_at = ? WHERE id = ?'
          ).run(parsedKind, parsedFormat, parsedContent, nextVersion, now, existing.id);
          db.prepare(
            'INSERT INTO creator_revisions (id, file_id, project_id, version, summary, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
          ).run(
            `crev-${crypto.randomUUID()}`,
            existing.id,
            project_id,
            nextVersion,
            `Uploaded overwrite from ${safeName}`,
            parsedContent,
            now
          );
          return existing.id;
        }
        const id = `cfile-${crypto.randomUUID()}`;
        db.prepare(
          'INSERT INTO creator_project_files (id, project_id, filename, kind, format, content, metadata_json, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(
          id,
          project_id,
          targetFilename,
          parsedKind,
          parsedFormat,
          parsedContent,
          JSON.stringify({ imported_from: safeName }),
          1,
          now,
          now
        );
        db.prepare(
          'INSERT INTO creator_revisions (id, file_id, project_id, version, summary, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(
          `crev-${crypto.randomUUID()}`,
          id,
          project_id,
          1,
          `Imported from ${safeName}`,
          parsedContent,
          now
        );
        return id;
      });

      const saved = db.prepare('SELECT * FROM creator_project_files WHERE id = ?').get(fileId);
      res.status(existing ? 200 : 201).json({ type: 'project_file', file: saved });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to parse uploaded file.',
      });
    }
  });

  // ---------------------------------------------------------------------------
  // Real Binary & Text Exports (.docx, .pdf, .md, .txt, .pptx, source code)
  // ---------------------------------------------------------------------------
  router.post('/export', async (req, res) => {
    const settings = getSettings();
    const {
      project_id,
      title,
      filename,
      export_format,
      content,
      deck,
      save_to_workspace,
      overwrite,
    } = req.body as {
      project_id?: string;
      title?: string;
      filename?: string;
      export_format?: string;
      content?: string;
      deck?: Partial<PresentationDeck>;
      save_to_workspace?: boolean;
      overwrite?: boolean;
    };

    const fmt = (export_format || 'md').toLowerCase().replace(/^\./, '');
    const docTitle = (title || filename || 'genesis_export').trim();
    const author = settings.operator_name || 'Local Operator';

    try {
      let buffer: Buffer;
      let contentType: string;
      let downloadExt: string;

      if (fmt === 'docx') {
        buffer = await exportDocumentAsDocx(docTitle, author, content || '');
        contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        downloadExt = '.docx';
      } else if (fmt === 'pdf') {
        buffer = await exportDocumentAsPdf(docTitle, author, content || '');
        contentType = 'application/pdf';
        downloadExt = '.pdf';
      } else if (fmt === 'txt') {
        buffer = exportDocumentAsText(docTitle, content || '');
        contentType = 'text/plain; charset=utf-8';
        downloadExt = '.txt';
      } else if (fmt === 'md' || fmt === 'markdown') {
        buffer = exportDocumentAsMarkdown(docTitle, content || '');
        contentType = 'text/markdown; charset=utf-8';
        downloadExt = '.md';
      } else if (fmt === 'pptx') {
        let deckObj: PresentationDeck;
        if (deck) {
          deckObj = normalizePresentationDeck(deck);
        } else if (content) {
          deckObj = normalizePresentationDeck(JSON.parse(content) as Partial<PresentationDeck>);
        } else {
          res.status(400).json({ error: 'Presentation deck payload is required for PPTX export.' });
          return;
        }
        buffer = await exportPresentationAsPptx(deckObj);
        contentType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
        downloadExt = '.pptx';
      } else {
        // Source code / JSON export
        buffer = Buffer.from(content || '', 'utf-8');
        contentType = 'text/plain; charset=utf-8';
        downloadExt = `.${fmt}`;
      }

      const baseSlug = (filename || docTitle)
        .replace(/\.(docx|pdf|pptx|md|txt|pptx\.json)$/i, '')
        .replace(/[^a-zA-Z0-9._-]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'genesis_export';
      const outName = sanitizeCreatorFilename(
        baseSlug.endsWith(downloadExt) ? baseSlug : `${baseSlug}${downloadExt}`
      );

      if (save_to_workspace && project_id) {
        const diskPath = resolveCreatorFilePath(project_id, outName);
        if (fs.existsSync(diskPath) && overwrite !== true) {
          res.status(409).json({
            error: `Workspace export "${outName}" already exists on disk. Confirm overwrite first.`,
            code: 'OVERWRITE_CONFIRMATION_REQUIRED',
            existing_name: outName,
          });
          return;
        }
        fs.writeFileSync(diskPath, buffer);
      }

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${outName}"`);
      res.setHeader('X-Genesis-Export-Bytes', String(buffer.byteLength));
      res.send(buffer);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to export Creator file.',
      });
    }
  });

  // ---------------------------------------------------------------------------
  // Coding Studio: Static Analysis, Debugging, Refactoring & Approval-Gated Run
  // ---------------------------------------------------------------------------
  router.post('/code/analyze', (req, res) => {
    const { language, code } = req.body as { language?: string; code?: string };
    if (typeof code !== 'string') {
      res.status(400).json({ error: 'Code string is required.' });
      return;
    }
    const result = analyzeCode(language || 'python', code);
    res.json(result);
  });

  router.post('/code/run', (req, res) => {
    const { language, code, approved } = req.body as {
      language?: string;
      code?: string;
      approved?: boolean;
    };
    const lang = (language || 'javascript').toLowerCase();
    if (lang !== 'javascript') {
      res.status(400).json({
        error: `Direct sandbox execution is restricted to JavaScript in the local Node.js runtime. Use static diagnostics or export for ${lang.toUpperCase()}.`,
      });
      return;
    }
    const result = runRestrictedJavaScript(code || '', approved === true);
    if (result.requires_approval) {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  });

  // ---------------------------------------------------------------------------
  // Genesis Intelligence + Memory + Knowledge + Research + Lab Assist
  // ---------------------------------------------------------------------------
  router.post('/assist', async (req, res) => {
    const db = getDb();
    const settings = getSettings();
    const {
      workspace,
      action,
      language,
      title,
      content,
      goal,
      use_memory = true,
      use_knowledge = true,
      research_id,
      laboratory_item_id,
      model_id,
    } = req.body as {
      workspace?: 'coding' | 'documents' | 'presentations';
      action?: string;
      language?: string;
      title?: string;
      content?: string;
      goal?: string;
      use_memory?: boolean;
      use_knowledge?: boolean;
      research_id?: string | null;
      laboratory_item_id?: string | null;
      model_id?: string | null;
    };

    const queryText = `${title || ''} ${goal || ''} ${(content || '').slice(0, 300)}`.trim();
    const retriever = new SqliteKeywordRetriever(db);
    const retrieval = retriever.retrieve(queryText, {
      includeMemory: use_memory,
      includeKnowledge: use_knowledge,
      maxMemoryItems: 3,
      maxKnowledgeChunks: 3,
      contextLength: 8192,
    });

    let researchContext = '';
    let researchTitle: string | null = null;
    if (research_id) {
      const rRow = db.prepare('SELECT title, summary, notes FROM research_projects WHERE id = ?').get(
        research_id
      ) as { title: string; summary: string; notes: string } | undefined;
      if (rRow) {
        researchTitle = rRow.title;
        researchContext = `[Research Study: ${rRow.title}]\nSummary: ${rRow.summary}\nNotes: ${rRow.notes.slice(0, 800)}`;
      }
    }

    let labContext = '';
    let labTitle: string | null = null;
    if (laboratory_item_id) {
      const lRow = db.prepare('SELECT name, content FROM laboratory_items WHERE id = ?').get(
        laboratory_item_id
      ) as { name: string; content: string } | undefined;
      if (lRow) {
        labTitle = lRow.name;
        labContext = `[Laboratory Template: ${lRow.name}]\n${lRow.content.slice(0, 600)}`;
      }
    }

    const memSys = formatRetrievedSystemContext(retrieval);
    const systemParts = [
      `You are Project Genesis Creator Studio operating in ${workspace || 'coding'} workspace (${action || 'assist'}).`,
      memSys,
      researchContext,
      labContext,
    ].filter(Boolean);

    const userPrompt = [
      `Action: ${action || 'assist'}`,
      language ? `Language: ${language}` : '',
      title ? `Title: ${title}` : '',
      goal ? `Operator Goal: ${goal}` : '',
      content ? `Current Content:\n${content.slice(0, 3500)}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    const requestedModel =
      model_id ||
      settings.active_model_id ||
      (settings.prefer_local_inference ? 'local-inference-http' : 'genesis-core-placeholder');
    const resolved = resolveModelAdapter(db, requestedModel, settings.inference_endpoint_url);

    let inferenceMode: 'local_inference' | 'demo' = 'demo';
    let modelName = 'DEMO MODE (No Local Server Connected)';
    let inferenceOutput = '';
    let inferenceError: string | undefined;

    if (!('error' in resolved) && resolved.adapter.provider === 'local_http') {
      const result = await resolved.adapter.generate({
        messages: [
          { role: 'system', content: systemParts.join('\n\n') },
          { role: 'user', content: userPrompt },
        ],
        temperature: settings.inference_temperature ?? 0.2,
        max_tokens: settings.inference_max_tokens ?? 512,
        timeout_ms: settings.inference_timeout_ms ?? 30000,
      });
      if (result.ok) {
        inferenceMode = 'local_inference';
        modelName = result.model_name;
        inferenceOutput = result.content;
      } else {
        inferenceError = result.error;
        modelName = result.model_name;
      }
    } else if (!('error' in resolved)) {
      modelName = `DEMO MODE (${resolved.model.name})`;
    }

    // Build honest deterministic companion analysis/scaffold so Creator Studio is genuinely helpful offline
    let deterministicSummary = '';
    let suggestedDraft: string | undefined;
    let suggestedDeck: PresentationDeck | undefined;
    let analysis: ReturnType<typeof analyzeCode> | undefined;

    if (workspace === 'coding') {
      const lang = (SUPPORTED_CODE_LANGUAGES.includes((language || '') as SupportedCodeLanguage)
        ? language
        : 'python') as SupportedCodeLanguage;
      analysis = analyzeCode(lang, content || '');
      if (action === 'generate') {
        suggestedDraft = generateStarterTemplate(lang, goal || title || 'Genesis Module');
        deterministicSummary = `Prepared ${lang.toUpperCase()} starter module for "${goal || title || 'Genesis Module'}".`;
      } else {
        deterministicSummary = [
          ...analysis.explanation,
          analysis.diagnostics.length > 0
            ? `Diagnostics (${analysis.diagnostics.length}): ${analysis.diagnostics
                .slice(0, 5)
                .map((d) => `L${d.line} [${d.severity}] ${d.message}`)
                .join(' | ')}`
            : 'Static diagnostics: 0 syntax or hygiene errors detected.',
          `Suggestions: ${analysis.refactoring_suggestions.join(' ')}`,
        ].join('\n');
      }
    } else if (workspace === 'presentations') {
      const outlineSource =
        researchContext ||
        content ||
        `# ${title || 'Genesis Presentation'}\n- ${goal || 'Core Architecture Overview'}\n- Local SQLite Persistence\n- Sandboxed Agent Workflows`;
      suggestedDeck = buildPresentationFromOutline(
        title || researchTitle || 'Genesis Presentation',
        outlineSource,
        'genesis_dark'
      );
      deterministicSummary = `Structured ${suggestedDeck.slides.length}-slide deck draft from local context (${retrieval.memories.length} memories, ${retrieval.knowledge.length} KB chunks).`;
    } else {
      const sections = [
        `# ${title || goal || 'Genesis Technical Document'}`,
        '',
        '## Executive Summary',
        '',
        goal || 'Structured document authored in Genesis Creator Studio.',
        '',
      ];
      if (researchContext) {
        sections.push('## Linked Research Context', '', researchContext, '');
      }
      if (retrieval.memories.length > 0 || retrieval.knowledge.length > 0) {
        sections.push('## Referenced Local Memory & Knowledge', '');
        for (const m of retrieval.memories) {
          sections.push(`- **Memory (${m.title})**: ${m.content}`);
        }
        for (const k of retrieval.knowledge) {
          sections.push(`- **KB (${k.document_title})**: ${k.content}`);
        }
        sections.push('');
      }
      suggestedDraft = sections.join('\n');
      deterministicSummary = `Assembled grounded Markdown document structure (${inspectTokensServer(suggestedDraft, 8192).token_count} baseline tokens).`;
    }

    res.json({
      mode: inferenceMode,
      model_name: modelName,
      inference_output: inferenceOutput || null,
      inference_error: inferenceError || null,
      deterministic_summary: deterministicSummary,
      suggested_draft: suggestedDraft,
      suggested_deck: suggestedDeck,
      code_analysis: analysis,
      context_used: {
        retrieval_backend: retrieval.retrieval_backend,
        memories: retrieval.memories.map((m) => ({ id: m.id, title: m.title, category: m.category })),
        knowledge: retrieval.knowledge.map((k) => ({
          document_id: k.document_id,
          document_title: k.document_title,
          chunk_index: k.chunk_index,
        })),
        research_title: researchTitle,
        laboratory_template: labTitle,
      },
    });
  });

  // ---------------------------------------------------------------------------
  // Creator -> Memory, Knowledge Base, and Agent OS Dispatch
  // ---------------------------------------------------------------------------
  router.post('/files/:fileId/save-memory', (req, res) => {
    const db = getDb();
    const file = db.prepare('SELECT * FROM creator_project_files WHERE id = ?').get(req.params.fileId) as
      | { id: string; filename: string; content: string }
      | undefined;
    if (!file) {
      res.status(404).json({ error: 'Creator file not found.' });
      return;
    }

    const { approved, title, category, namespace, tags } = req.body as {
      approved?: boolean;
      title?: string;
      category?: string;
      namespace?: string;
      tags?: string[];
    };

    if (approved !== true) {
      res.status(400).json({ error: 'Explicit operator approval (approved: true) is required to save memory.' });
      return;
    }

    const finalTitle = (title || `Creator: ${file.filename}`).trim();
    const contentSnippet = file.content.slice(0, 1500);
    const secretHit = detectSensitiveSecret(`${finalTitle}\n${contentSnippet}`);
    if (secretHit) {
      res.status(400).json({ error: `Rejected for privacy: potential ${secretHit} detected.` });
      return;
    }

    const now = new Date().toISOString();
    const memId = `mem-${crypto.randomUUID()}`;
    const validNs = ['episodic', 'semantic', 'procedural', 'project'].includes(namespace || '')
      ? namespace!
      : 'project';
    const validCat = ['fact', 'preference', 'instruction', 'constraint'].includes(category || '')
      ? category!
      : 'fact';
    const tagList = Array.isArray(tags) && tags.length > 0 ? tags : ['creator-studio'];

    runInTransaction(db, () => {
      db.prepare(
        'INSERT INTO memory_entries (id, namespace, category, title, content, tags_json, importance, approved, source_conversation_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(memId, validNs, validCat, finalTitle, contentSnippet, JSON.stringify(tagList), 4, 1, null, now, now);

      if (hasFts5Support(db)) {
        db.prepare('INSERT INTO memory_entries_fts (memory_id, title, content, tags) VALUES (?, ?, ?, ?)').run(
          memId,
          finalTitle,
          contentSnippet,
          tagList.join(' ')
        );
      }
    });

    res.status(201).json({ id: memId, title: finalTitle, namespace: validNs, category: validCat });
  });

  router.post('/files/:fileId/save-knowledge', (req, res) => {
    const db = getDb();
    const file = db.prepare('SELECT * FROM creator_project_files WHERE id = ?').get(req.params.fileId) as
      | { id: string; filename: string; kind: string; content: string }
      | undefined;
    if (!file) {
      res.status(404).json({ error: 'Creator file not found.' });
      return;
    }

    const { title, tags } = req.body as { title?: string; tags?: string[] };
    const finalTitle = (title || file.filename).trim();
    const secretHit = detectSensitiveSecret(`${finalTitle}\n${file.content}`);
    if (secretHit) {
      res.status(400).json({ error: `Rejected for privacy: potential ${secretHit} detected.` });
      return;
    }

    const docId = `kb-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const tagList = Array.isArray(tags) && tags.length > 0 ? tags : ['creator-studio', file.kind];
    const chunks = chunkKnowledgeText(file.content);

    runInTransaction(db, () => {
      db.prepare(
        'INSERT INTO knowledge_documents (id, title, source_type, source_name, content, tags_json, char_count, chunk_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        docId,
        finalTitle,
        file.kind === 'code' ? 'code' : 'markdown',
        file.filename,
        file.content,
        JSON.stringify(tagList),
        file.content.length,
        chunks.length,
        now,
        now
      );

      const insChunk = db.prepare(
        'INSERT INTO knowledge_chunks (id, document_id, chunk_index, content, token_estimate, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      );
      const insFts = hasFts5Support(db)
        ? db.prepare(
            'INSERT INTO knowledge_chunks_fts (chunk_id, document_id, title, content, tags) VALUES (?, ?, ?, ?, ?)'
          )
        : null;

      for (const ch of chunks) {
        const chunkId = `kbc-${crypto.randomUUID()}`;
        insChunk.run(chunkId, docId, ch.chunk_index, ch.content, ch.token_estimate, now);
        insFts?.run(chunkId, docId, finalTitle, ch.content, tagList.join(' '));
      }
    });

    res.status(201).json({ id: docId, title: finalTitle, chunk_count: chunks.length });
  });

  router.post('/files/:fileId/dispatch-agent', async (req, res) => {
    const db = getDb();
    const file = db.prepare('SELECT * FROM creator_project_files WHERE id = ?').get(req.params.fileId) as
      | { id: string; filename: string; kind: string; format: string; content: string }
      | undefined;
    if (!file) {
      res.status(404).json({ error: 'Creator file not found.' });
      return;
    }

    const { agent_id, goal } = req.body as { agent_id?: string; goal?: string };
    const targetAgentId = agent_id || 'agent-task-operator';
    const taskGoal =
      goal?.trim() ||
      `Review Creator Studio file "${file.filename}" (${file.format}) and create a workspace summary document.`;

    try {
      const detail = await defaultAgentManager.createAndPlanTask(db, {
        agentId: targetAgentId,
        title: `Creator Dispatch: ${file.filename}`,
        goal: taskGoal,
        documentFilename: `creator_report_${file.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}.md`,
        codeSnippet: file.format === 'javascript' ? file.content.slice(0, 4000) : undefined,
        autoRun: false,
      });
      res.status(201).json(detail);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to dispatch task to Agent OS.',
      });
    }
  });

  return router;
}
