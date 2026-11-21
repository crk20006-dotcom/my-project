import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { getDb, runInTransaction } from '../db.ts';
import { resolveCreatorFilePath, sanitizeCreatorFilename } from '../creator/fileSafety.ts';
import { isFfmpegAvailable, LocalPiperTtsAdapter, LocalWhisperSttAdapter } from './audioEngine.ts';
import {
  ALL_MULTIMODAL_EXTENSIONS,
  countMultimodalTempFiles,
  decodeValidatedMediaPayload,
  getTessdataCacheDir,
  MULTIMODAL_AUDIO_EXTENSIONS,
  MULTIMODAL_DOCUMENT_EXTENSIONS,
  MULTIMODAL_IMAGE_EXTENSIONS,
  normalizeMimeType,
  sanitizeMultimodalFilename,
  verifyMultimodalMagicBytes,
  withTempMediaFile,
} from './mediaSafety.ts';
import { LocalMediaPreprocessor } from './preprocessor.ts';
import { LocalImageAnalyzer } from './visionEngine.ts';

export interface MultimodalSettingsSnapshot {
  max_upload_mb: number;
  allowed_extensions: string[];
  inference_endpoint_url: string;
  inference_timeout_ms: number;
  voice_stt_language: string;
  voice_tts_voice: string;
  voice_tts_rate: number;
  voice_auto_speak: boolean;
  voice_stt_endpoint_url: string;
  voice_tts_endpoint_url: string;
  vision_endpoint_url: string;
  ocr_enabled: boolean;
}

export function createMultimodalRouter(getSettings: () => MultimodalSettingsSnapshot): express.Router {
  const router = express.Router();
  const preprocessor = new LocalMediaPreprocessor();
  const imageAnalyzer = new LocalImageAnalyzer();
  const sttAdapter = new LocalWhisperSttAdapter();
  const ttsAdapter = new LocalPiperTtsAdapter();

  router.get('/status', async (_req, res) => {
    const settings = getSettings();
    const ffmpegAvailable = await isFfmpegAvailable();
    const tessDir = getTessdataCacheDir();
    let cachedTessLangs: string[] = [];
    try {
      cachedTessLangs = fs
        .readdirSync(tessDir)
        .filter((f) => f.endsWith('.traineddata') || f.endsWith('.traineddata.gz'))
        .map((f) => f.replace(/\.traineddata(\.gz)?$/, ''));
    } catch {
      cachedTessLangs = [];
    }

    res.json({
      ffmpeg_available: ffmpegAvailable,
      ocr_enabled: settings.ocr_enabled,
      tesseract_engine: 'tesseract.js (CPU WASM)',
      cached_tessdata_languages: cachedTessLangs,
      stt_endpoint_configured: Boolean(settings.voice_stt_endpoint_url.trim()),
      tts_endpoint_configured: Boolean(settings.voice_tts_endpoint_url.trim()),
      vision_endpoint_configured: Boolean(settings.vision_endpoint_url.trim()),
      temp_files_pending: countMultimodalTempFiles(),
      supported_formats: {
        images: MULTIMODAL_IMAGE_EXTENSIONS,
        documents: MULTIMODAL_DOCUMENT_EXTENSIONS,
        audio: MULTIMODAL_AUDIO_EXTENSIONS,
      },
    });
  });

  router.get('/assets', (_req, res) => {
    const db = getDb();
    const rows = db
      .prepare('SELECT id, filename, media_type, mime_type, byte_size, summary, extracted_text, created_at FROM multimodal_assets ORDER BY created_at DESC LIMIT 40')
      .all();
    res.json(rows);
  });

  router.post('/process', async (req, res) => {
    const settings = getSettings();
    const {
      filename,
      mimeType,
      encoding,
      data,
      question,
      ocr_enabled,
      language,
      save_asset,
    } = req.body as {
      filename?: string;
      mimeType?: string;
      encoding?: 'base64' | 'utf8';
      data?: string;
      question?: string;
      ocr_enabled?: boolean;
      language?: string;
      save_asset?: boolean;
    };

    if (!filename || typeof data !== 'string') {
      res.status(400).json({ error: 'filename and data payload are required.' });
      return;
    }

    try {
      const safeName = sanitizeMultimodalFilename(filename);
      const ext = path.extname(safeName).toLowerCase();
      if (!ALL_MULTIMODAL_EXTENSIONS.includes(ext)) {
        res.status(400).json({
          error: `Extension "${ext || '(none)'}" is not a supported multimodal format.`,
        });
        return;
      }

      const maxBytes = Math.max(1, settings.max_upload_mb) * 1024 * 1024;
      const buf = decodeValidatedMediaPayload(
        data,
        encoding === 'utf8' ? 'utf8' : 'base64',
        maxBytes
      );

      const result = await preprocessor.preprocess({
        filename: safeName,
        mimeType: mimeType || normalizeMimeType(ext),
        buffer: buf,
        question,
        ocrEnabled: ocr_enabled ?? settings.ocr_enabled,
        language: language || settings.voice_stt_language || 'en-US',
        sttEndpointUrl: settings.voice_stt_endpoint_url,
        visionEndpointUrl: settings.vision_endpoint_url,
        maxUploadMb: settings.max_upload_mb,
        allowedExtensions: settings.allowed_extensions,
      });

      let assetId: string | undefined;
      if (save_asset) {
        const db = getDb();
        assetId = `mm-${crypto.randomUUID()}`;
        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO multimodal_assets (id, filename, media_type, mime_type, byte_size, summary, extracted_text, metadata_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          assetId,
          result.filename,
          result.asset_kind,
          result.mimeType,
          result.size,
          result.summary,
          result.extracted_text.slice(0, 60000),
          JSON.stringify({ extension: result.extension }),
          now
        );
      }

      res.json({ ...result, asset_id: assetId });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to process multimodal file.',
      });
    }
  });

  router.post('/analyze-image', async (req, res) => {
    const settings = getSettings();
    const { filename, mimeType, dataBase64, question, ocr_enabled, ocr_language } = req.body as {
      filename?: string;
      mimeType?: string;
      dataBase64?: string;
      question?: string;
      ocr_enabled?: boolean;
      ocr_language?: string;
    };

    if (!filename || !dataBase64) {
      res.status(400).json({ error: 'filename and dataBase64 are required.' });
      return;
    }

    try {
      const safeName = sanitizeMultimodalFilename(filename);
      const ext = path.extname(safeName).toLowerCase();
      if (!MULTIMODAL_IMAGE_EXTENSIONS.includes(ext)) {
        res.status(400).json({ error: 'Only .png, .jpg, .jpeg, and .webp images are supported.' });
        return;
      }

      const maxBytes = Math.max(1, settings.max_upload_mb) * 1024 * 1024;
      const buf = decodeValidatedMediaPayload(dataBase64, 'base64', maxBytes);
      const sig = verifyMultimodalMagicBytes(buf, ext);
      if (!sig.valid) {
        res.status(400).json({ error: sig.reason || 'Invalid image signature.' });
        return;
      }

      const normalizedMime = normalizeMimeType(ext, mimeType);
      const dataUrl = `data:${normalizedMime};base64,${buf.toString('base64')}`;

      const analysis = await withTempMediaFile(ext, buf, (tempPath) =>
        imageAnalyzer.analyze({
          filePath: tempPath,
          filename: safeName,
          mimeType: normalizedMime,
          buffer: buf,
          dataUrl,
          question,
          ocrEnabled: ocr_enabled ?? settings.ocr_enabled,
          ocrLanguage: ocr_language || 'eng',
          visionEndpointUrl: settings.vision_endpoint_url,
          timeoutMs: settings.inference_timeout_ms,
        })
      );

      res.json(analysis);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Image analysis failed.',
      });
    }
  });

  router.post('/transcribe', async (req, res) => {
    const settings = getSettings();
    const { filename, mimeType, dataBase64, language } = req.body as {
      filename?: string;
      mimeType?: string;
      dataBase64?: string;
      language?: string;
    };

    if (!filename || !dataBase64) {
      res.status(400).json({ error: 'filename and dataBase64 audio data are required.' });
      return;
    }

    try {
      const safeName = sanitizeMultimodalFilename(filename);
      const ext = path.extname(safeName).toLowerCase();
      if (!MULTIMODAL_AUDIO_EXTENSIONS.includes(ext)) {
        res.status(400).json({
          error: `Unsupported audio extension "${ext}". Supported: ${MULTIMODAL_AUDIO_EXTENSIONS.join(', ')}`,
        });
        return;
      }

      const maxBytes = Math.max(1, settings.max_upload_mb) * 1024 * 1024;
      const buf = decodeValidatedMediaPayload(dataBase64, 'base64', maxBytes);
      const sig = verifyMultimodalMagicBytes(buf, ext);
      if (!sig.valid) {
        res.status(400).json({ error: sig.reason || 'Invalid audio header signature.' });
        return;
      }

      const result = await withTempMediaFile(ext, buf, (tempPath) =>
        sttAdapter.transcribe({
          filePath: tempPath,
          filename: safeName,
          mimeType: normalizeMimeType(ext, mimeType),
          buffer: buf,
          language: language || settings.voice_stt_language || 'en-US',
          endpointUrl: settings.voice_stt_endpoint_url,
          timeoutMs: settings.inference_timeout_ms,
        })
      );

      res.json(result);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Audio transcription failed.',
      });
    }
  });

  router.post('/synthesize', async (req, res) => {
    const settings = getSettings();
    const { text, voice, speed } = req.body as {
      text?: string;
      voice?: string;
      speed?: number;
    };

    if (!text || !text.trim()) {
      res.status(400).json({ error: 'text is required for speech synthesis.' });
      return;
    }

    const result = await ttsAdapter.synthesize({
      text,
      voice: voice || settings.voice_tts_voice,
      speed: typeof speed === 'number' ? speed : settings.voice_tts_rate,
      endpointUrl: settings.voice_tts_endpoint_url,
      timeoutMs: settings.inference_timeout_ms,
    });

    res.json(result);
  });

  router.post('/send-to-research', (req, res) => {
    const db = getDb();
    const { research_id, title, summary, source_name, content, tags } = req.body as {
      research_id?: string | null;
      title?: string;
      summary?: string;
      source_name?: string;
      content?: string;
      tags?: string[];
    };

    if (!content || !content.trim()) {
      res.status(400).json({ error: 'Extracted content is required to save to Research.' });
      return;
    }

    const now = new Date().toISOString();
    const cleanSourceName = (source_name || 'Multimodal Extraction').trim();
    const cleanSummary = (summary || `Imported from ${cleanSourceName}`).trim();
    const cleanBody = content.trim().slice(0, 60000);

    if (research_id) {
      const existing = db.prepare('SELECT * FROM research_projects WHERE id = ?').get(research_id) as
        | {
            id: string;
            title: string;
            summary: string;
            status: string;
            tags_json: string;
            sources_json: string;
            notes: string;
            created_at: string;
            updated_at: string;
          }
        | undefined;
      if (!existing) {
        res.status(404).json({ error: 'Target Research Study not found.' });
        return;
      }

      let currentSources: Array<{ id: string; title: string; reference: string; note: string }> = [];
      try {
        currentSources = JSON.parse(existing.sources_json || '[]') as typeof currentSources;
      } catch {
        currentSources = [];
      }

      currentSources.push({
        id: `src-${crypto.randomUUID().slice(0, 8)}`,
        title: cleanSourceName,
        reference: `multimodal://${cleanSourceName}`,
        note: cleanSummary,
      });

      const appendedNotes = existing.notes
        ? `${existing.notes}\n\n### ${cleanSourceName}\n${cleanBody}`
        : `### ${cleanSourceName}\n${cleanBody}`;

      db.prepare('UPDATE research_projects SET sources_json = ?, notes = ?, updated_at = ? WHERE id = ?').run(
        JSON.stringify(currentSources),
        appendedNotes,
        now,
        existing.id
      );

      res.json({
        action: 'appended',
        id: existing.id,
        title: existing.title,
        sources_count: currentSources.length,
      });
      return;
    }

    const id = `res-${crypto.randomUUID()}`;
    const projTitle = (title || `Multimodal Study: ${cleanSourceName}`).trim().slice(0, 140);
    const sources = [
      {
        id: `src-${crypto.randomUUID().slice(0, 8)}`,
        title: cleanSourceName,
        reference: `multimodal://${cleanSourceName}`,
        note: cleanSummary,
      },
    ];
    const tagList = Array.isArray(tags) && tags.length > 0 ? tags : ['multimodal', 'step-10'];

    db.prepare(
      'INSERT INTO research_projects (id, title, summary, status, tags_json, sources_json, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, projTitle, cleanSummary, 'active', JSON.stringify(tagList), JSON.stringify(sources), cleanBody, now, now);

    res.status(201).json({
      action: 'created',
      id,
      title: projTitle,
      sources_count: 1,
    });
  });

  router.post('/send-to-creator', (req, res) => {
    const db = getDb();
    const { project_id, filename, content, overwrite, summary } = req.body as {
      project_id?: string;
      filename?: string;
      content?: string;
      overwrite?: boolean;
      summary?: string;
    };

    const targetProjectId = project_id || 'proj-genesis-studio';
    const project = db.prepare('SELECT id, name FROM creator_projects WHERE id = ?').get(targetProjectId) as
      | { id: string; name: string }
      | undefined;
    if (!project) {
      res.status(404).json({ error: `Creator project "${targetProjectId}" not found.` });
      return;
    }
    if (!content || !content.trim()) {
      res.status(400).json({ error: 'Extracted content is required.' });
      return;
    }

    try {
      const requestedName = (filename || `multimodal_extract_${Date.now()}.md`).trim();
      const baseSafe = sanitizeCreatorFilename(requestedName);
      const ext = path.extname(baseSafe).toLowerCase();
      const finalName = ext === '.md' || ext === '.txt' ? baseSafe : `${path.parse(baseSafe).name}.md`;
      const format = finalName.endsWith('.txt') ? 'txt' : 'markdown';
      const now = new Date().toISOString();

      const existing = db
        .prepare('SELECT id, version FROM creator_project_files WHERE project_id = ? AND filename = ?')
        .get(targetProjectId, finalName) as { id: string; version: number } | undefined;

      if (existing && !overwrite) {
        res.status(409).json({
          error: `File "${finalName}" already exists in "${project.name}". Confirm overwrite to replace it.`,
          code: 'OVERWRITE_CONFIRMATION_REQUIRED',
          existing_name: finalName,
        });
        return;
      }

      const diskPath = resolveCreatorFilePath(targetProjectId, finalName);
      fs.writeFileSync(diskPath, content, 'utf-8');

      let fileId = existing?.id || `cfile-${crypto.randomUUID()}`;
      let version = existing ? existing.version + 1 : 1;

      runInTransaction(db, () => {
        if (existing) {
          db.prepare(
            'UPDATE creator_project_files SET content = ?, version = ?, updated_at = ? WHERE id = ?'
          ).run(content, version, now, existing.id);
        } else {
          db.prepare(
            `INSERT INTO creator_project_files (id, project_id, filename, kind, format, content, metadata_json, version, created_at, updated_at)
             VALUES (?, ?, ?, 'document', ?, ?, ?, 1, ?, ?)`
          ).run(fileId, targetProjectId, finalName, format, content, JSON.stringify({ source: 'multimodal' }), now, now);
        }
        db.prepare(
          'INSERT INTO creator_revisions (id, file_id, project_id, version, summary, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(
          `crev-${crypto.randomUUID()}`,
          fileId,
          targetProjectId,
          version,
          summary || 'Imported from Voice, Vision & Multimodal Intelligence',
          content,
          now
        );
        db.prepare('UPDATE creator_projects SET updated_at = ? WHERE id = ?').run(now, targetProjectId);
      });

      const saved = db.prepare('SELECT * FROM creator_project_files WHERE id = ?').get(fileId);
      res.status(existing ? 200 : 201).json({ file: saved, project_name: project.name });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to save extracted content to Creator Studio.',
      });
    }
  });

  return router;
}
