import crypto from 'node:crypto';
import path from 'node:path';
import { LocalAudioProcessor, LocalWhisperSttAdapter } from './audioEngine.ts';
import { extractDocumentContent } from './documentExtractor.ts';
import type {
  ExtractedMediaResult,
  MediaPreprocessor,
  MediaPreprocessRequest,
} from './interfaces.ts';
import {
  ALL_MULTIMODAL_EXTENSIONS,
  classifyMultimodalExtension,
  normalizeMimeType,
  sanitizeMultimodalFilename,
  verifyMultimodalMagicBytes,
  withTempMediaFile,
} from './mediaSafety.ts';
import { LocalImageAnalyzer } from './visionEngine.ts';

const MAX_ATTACHMENT_PREVIEW_CHARS = 3800;
const MAX_INLINE_IMAGE_DATA_URL_CHARS = 2_400_000;

export class LocalMediaPreprocessor implements MediaPreprocessor {
  private readonly imageAnalyzer = new LocalImageAnalyzer();
  private readonly audioProcessor = new LocalAudioProcessor();
  private readonly whisperAdapter = new LocalWhisperSttAdapter();

  async preprocess(request: MediaPreprocessRequest): Promise<ExtractedMediaResult> {
    const safeName = sanitizeMultimodalFilename(request.filename);
    const ext = path.extname(safeName).toLowerCase();
    const assetKind = classifyMultimodalExtension(ext);
    if (!assetKind || !ALL_MULTIMODAL_EXTENSIONS.includes(ext)) {
      throw new Error(`Unsupported multimodal file extension "${ext || '(none)'}".`);
    }

    if (request.allowedExtensions && request.allowedExtensions.length > 0) {
      const normalizedAllowed = request.allowedExtensions.map((e) => e.toLowerCase());
      if (!normalizedAllowed.includes(ext)) {
        throw new Error(
          `Extension "${ext}" is blocked by local upload policy. Enable it in System Settings if needed.`
        );
      }
    }

    const maxBytes = Math.max(1, request.maxUploadMb ?? 10) * 1024 * 1024;
    if (request.buffer.byteLength <= 0 || request.buffer.byteLength > maxBytes) {
      throw new Error(`File size must be between 1 byte and ${request.maxUploadMb ?? 10} MB.`);
    }

    const sigCheck = verifyMultimodalMagicBytes(request.buffer, ext);
    if (!sigCheck.valid) {
      throw new Error(sigCheck.reason || `Invalid file signature for ${safeName}.`);
    }

    const mimeType = normalizeMimeType(ext, request.mimeType);

    return withTempMediaFile(ext, request.buffer, async (tempPath) => {
      if (assetKind === 'image') {
        const rawDataUrl = `data:${mimeType};base64,${request.buffer.toString('base64')}`;
        const safeDataUrl =
          rawDataUrl.length <= MAX_INLINE_IMAGE_DATA_URL_CHARS ? rawDataUrl : undefined;

        const analysis = await this.imageAnalyzer.analyze({
          filePath: tempPath,
          filename: safeName,
          mimeType,
          buffer: request.buffer,
          dataUrl: rawDataUrl,
          question: request.question,
          ocrEnabled: request.ocrEnabled,
          ocrLanguage: request.language,
          visionEndpointUrl: request.visionEndpointUrl,
        });

        const extractedParts = [analysis.description];
        if (analysis.vqa_answer) {
          extractedParts.push(`Visual Answer (${analysis.vqa_model_name}): ${analysis.vqa_answer}`);
        }
        const extractedText = extractedParts.join('\n\n');

        return {
          ok: true,
          asset_kind: 'image',
          filename: safeName,
          mimeType,
          extension: ext,
          size: request.buffer.byteLength,
          summary: `${analysis.metrics.width}x${analysis.metrics.height} ${analysis.metrics.format.toUpperCase()} (${analysis.metrics.classification})${analysis.ocr.text ? ` · OCR ${analysis.ocr.text.length} chars` : ''}`,
          extracted_text: extractedText,
          image_data_url: safeDataUrl,
          image_analysis: analysis,
          attachment: {
            id: `att-${crypto.randomUUID()}`,
            name: safeName,
            size: request.buffer.byteLength,
            mimeType,
            extension: ext,
            previewText: extractedText.slice(0, MAX_ATTACHMENT_PREVIEW_CHARS),
            imageDataUrl: safeDataUrl,
            mediaKind: 'image',
            validated: true,
          },
        };
      }

      if (assetKind === 'document') {
        const docRes = await extractDocumentContent(request.buffer, safeName, ext);
        const summary = `${docRes.format.toUpperCase()} document · ${docRes.metrics.words} words · ${docRes.metrics.headings} headings · ${docRes.metrics.tables} tables${docRes.page_count ? ` · ${docRes.page_count} page(s)` : ''}`;
        return {
          ok: true,
          asset_kind: 'document',
          filename: safeName,
          mimeType,
          extension: ext,
          size: request.buffer.byteLength,
          summary,
          extracted_text: docRes.extracted_text,
          document_extraction: docRes,
          attachment: {
            id: `att-${crypto.randomUUID()}`,
            name: safeName,
            size: request.buffer.byteLength,
            mimeType,
            extension: ext,
            previewText: docRes.extracted_text.slice(0, MAX_ATTACHMENT_PREVIEW_CHARS),
            mediaKind: 'document',
            validated: true,
          },
        };
      }

      // Audio
      const speechResult = request.sttEndpointUrl
        ? await this.whisperAdapter.transcribe({
            filePath: tempPath,
            filename: safeName,
            mimeType,
            buffer: request.buffer,
            language: request.language,
            endpointUrl: request.sttEndpointUrl,
          })
        : {
            ok: false,
            mode: 'acoustic_only_no_stt_server' as const,
            transcript: '',
            language: request.language || 'en-US',
            acoustic: await this.audioProcessor.inspect(tempPath, safeName, request.buffer),
            message:
              'Audio inspected cleanly. Connect a loopback Whisper server for file transcription, or use live voice capture in Chat.',
          };

      const acousticSummary = `${speechResult.acoustic.format.toUpperCase()} audio · ${speechResult.acoustic.duration_sec !== null ? `${speechResult.acoustic.duration_sec}s` : 'duration n/a'} · ${speechResult.acoustic.sample_rate ? `${speechResult.acoustic.sample_rate} Hz` : 'rate n/a'} · ${speechResult.acoustic.channels ? `${speechResult.acoustic.channels}ch` : 'ch n/a'}`;
      const extractedText = speechResult.transcript
        ? `[Transcript (${speechResult.language})]\n${speechResult.transcript}\n\n[Audio Metadata]\n${acousticSummary}`
        : `${acousticSummary}\n${speechResult.message}`;

      return {
        ok: true,
        asset_kind: 'audio',
        filename: safeName,
        mimeType,
        extension: ext,
        size: request.buffer.byteLength,
        summary: speechResult.transcript
          ? `${acousticSummary} · Transcript (${speechResult.transcript.length} chars)`
          : acousticSummary,
        extracted_text: extractedText,
        speech_result: speechResult,
        attachment: {
          id: `att-${crypto.randomUUID()}`,
          name: safeName,
          size: request.buffer.byteLength,
          mimeType,
          extension: ext,
          previewText: extractedText.slice(0, MAX_ATTACHMENT_PREVIEW_CHARS),
          mediaKind: 'audio',
          validated: true,
        },
      };
    });
  }
}
