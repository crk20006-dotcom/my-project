import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { createWorker } from 'tesseract.js';
import { isLocalInferenceUrlSafe } from '../ai/interfaces.ts';
import type {
  ImageAnalysisRequest,
  ImageAnalysisResult,
  ImageAnalyzer,
  ImageVisualMetrics,
  OcrExtractor,
  OcrRequest,
  OcrResult,
} from './interfaces.ts';
import { getTessdataCacheDir } from './mediaSafety.ts';

function parseWebpDimensions(buf: Buffer): { width: number; height: number } {
  if (buf.length < 30) return { width: 0, height: 0 };
  const chunkHeader = buf.subarray(12, 16).toString('ascii');
  if (chunkHeader === 'VP8X' && buf.length >= 30) {
    const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return { width, height };
  }
  if (chunkHeader === 'VP8 ' && buf.length >= 30) {
    const width = buf.readUInt16LE(26) & 0x3fff;
    const height = buf.readUInt16LE(28) & 0x3fff;
    return { width, height };
  }
  if (chunkHeader === 'VP8L' && buf.length >= 25) {
    const bits = buf.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { width, height };
  }
  return { width: 0, height: 0 };
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function computeAspectRatio(width: number, height: number): string {
  if (!width || !height) return 'unknown';
  const d = gcd(width, height);
  return `${Math.round(width / d)}:${Math.round(height / d)}`;
}

function inspectImagePixels(buf: Buffer, ext: string): ImageVisualMetrics {
  const lower = ext.toLowerCase();
  const format: 'png' | 'jpeg' | 'webp' =
    lower === '.png' ? 'png' : lower === '.webp' ? 'webp' : 'jpeg';

  let width = 0;
  let height = 0;
  let rgba: Uint8Array | null = null;

  if (format === 'png') {
    const decoded = PNG.sync.read(buf);
    width = decoded.width;
    height = decoded.height;
    rgba = decoded.data;
  } else if (format === 'jpeg') {
    const decoded = jpeg.decode(buf, { useTArray: true, maxResolutionInMP: 25, maxMemoryUsageInMB: 256 });
    width = decoded.width;
    height = decoded.height;
    rgba = decoded.data;
  } else {
    const dims = parseWebpDimensions(buf);
    width = dims.width;
    height = dims.height;
  }

  let sampleCount = 0;
  let lumSum = 0;
  let lumSqSum = 0;
  let lightPixels = 0;
  let darkPixels = 0;
  let colorDeltaSum = 0;
  let edgeHits = 0;
  let edgeComparisons = 0;

  if (rgba && width > 0 && height > 0) {
    const stepX = Math.max(1, Math.floor(width / 96));
    const stepY = Math.max(1, Math.floor(height / 96));

    for (let y = 0; y < height; y += stepY) {
      for (let x = 0; x < width; x += stepX) {
        const idx = (y * width + x) * 4;
        const r = rgba[idx];
        const g = rgba[idx + 1];
        const b = rgba[idx + 2];
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        sampleCount += 1;
        lumSum += lum;
        lumSqSum += lum * lum;
        if (lum >= 220) lightPixels += 1;
        if (lum <= 45) darkPixels += 1;
        colorDeltaSum += Math.max(r, g, b) - Math.min(r, g, b);

        if (x + stepX < width) {
          const rIdx = (y * width + (x + stepX)) * 4;
          const rLum = 0.299 * rgba[rIdx] + 0.587 * rgba[rIdx + 1] + 0.114 * rgba[rIdx + 2];
          edgeComparisons += 1;
          if (Math.abs(lum - rLum) > 28) edgeHits += 1;
        }
        if (y + stepY < height) {
          const dIdx = ((y + stepY) * width + x) * 4;
          const dLum = 0.299 * rgba[dIdx] + 0.587 * rgba[dIdx + 1] + 0.114 * rgba[dIdx + 2];
          edgeComparisons += 1;
          if (Math.abs(lum - dLum) > 28) edgeHits += 1;
        }
      }
    }
  }

  const meanBrightness = sampleCount > 0 ? Number((lumSum / sampleCount).toFixed(1)) : 0;
  const variance = sampleCount > 0 ? Math.max(0, lumSqSum / sampleCount - meanBrightness * meanBrightness) : 0;
  const contrastStddev = Number(Math.sqrt(variance).toFixed(1));
  const lightRatio = sampleCount > 0 ? Number((lightPixels / sampleCount).toFixed(2)) : 0;
  const darkRatio = sampleCount > 0 ? Number((darkPixels / sampleCount).toFixed(2)) : 0;
  const edgeDensity = edgeComparisons > 0 ? Number((edgeHits / edgeComparisons).toFixed(2)) : 0;
  const colorVariance = sampleCount > 0 ? Number((colorDeltaSum / sampleCount).toFixed(1)) : 0;

  let classification: ImageVisualMetrics['classification'] = 'photograph_or_scene';
  if (lightRatio >= 0.55 && colorVariance < 28 && edgeDensity >= 0.04) {
    classification = contrastStddev > 55 ? 'document_scan' : 'technical_diagram_or_chart';
  } else if ((darkRatio >= 0.45 || lightRatio >= 0.45) && edgeDensity >= 0.08 && colorVariance < 65) {
    classification = 'screenshot_or_ui';
  } else if (edgeDensity >= 0.12 && colorVariance < 50) {
    classification = 'technical_diagram_or_chart';
  }

  return {
    format,
    width,
    height,
    aspect_ratio: computeAspectRatio(width, height),
    byte_size: buf.byteLength,
    pixel_sample_count: sampleCount,
    mean_brightness: meanBrightness,
    contrast_stddev: contrastStddev,
    light_pixel_ratio: lightRatio,
    dark_pixel_ratio: darkRatio,
    edge_density: edgeDensity,
    color_variance: colorVariance,
    classification,
  };
}

export class TesseractOcrExtractor implements OcrExtractor {
  readonly engineName = 'tesseract.js';

  async extractText(request: OcrRequest): Promise<OcrResult> {
    const lang = (request.language || 'eng').trim() || 'eng';
    const tessLang = lang.toLowerCase().startsWith('en') ? 'eng' : lang.split('-')[0].toLowerCase();
    const cachePath = getTessdataCacheDir();

    let worker: Awaited<ReturnType<typeof createWorker>> | null = null;
    try {
      const timeoutMs = Math.min(20000, Math.max(3000, request.timeoutMs ?? 12000));
      worker = await Promise.race([
        createWorker(tessLang, 1, {
          cachePath,
          logger: () => {},
          errorHandler: () => {},
        }),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error('OCR initialization timed out (traineddata unavailable offline).')), timeoutMs)
        ),
      ]);

      const result = await Promise.race([
        worker.recognize(request.buffer),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error('OCR recognition timed out.')), timeoutMs)
        ),
      ]);

      const cleanText = (result.data.text || '').trim();
      const confidence = Math.round(Number(result.data.confidence || 0));
      const lines = cleanText
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 80)
        .map((line) => ({ text: line, confidence }));

      return {
        ok: true,
        engine: 'tesseract.js',
        language: tessLang,
        text: cleanText,
        confidence,
        blocks: lines,
      };
    } catch (err) {
      return {
        ok: false,
        engine: 'tesseract.js',
        language: tessLang,
        text: '',
        confidence: 0,
        blocks: [],
        error:
          err instanceof Error
            ? err.message
            : 'Tesseract OCR could not complete (offline traineddata may need initial download).',
      };
    } finally {
      if (worker) {
        await worker.terminate().catch(() => {});
      }
    }
  }
}

export class LocalImageAnalyzer implements ImageAnalyzer {
  readonly name = 'local_vision_analyzer';
  private readonly ocrExtractor = new TesseractOcrExtractor();

  async analyze(request: ImageAnalysisRequest): Promise<ImageAnalysisResult> {
    const ext = request.filename.includes('.')
      ? `.${request.filename.split('.').pop()?.toLowerCase()}`
      : '.png';

    const metrics = inspectImagePixels(request.buffer, ext);

    let ocr: OcrResult = {
      ok: false,
      engine: 'disabled',
      language: request.ocrLanguage || 'eng',
      text: '',
      confidence: 0,
      blocks: [],
    };

    if (request.ocrEnabled !== false && metrics.format !== 'webp') {
      ocr = await this.ocrExtractor.extractText({
        filePath: request.filePath,
        buffer: request.buffer,
        language: request.ocrLanguage || 'eng',
        timeoutMs: 12000,
      });
    } else if (request.ocrEnabled !== false && metrics.format === 'webp') {
      ocr = {
        ok: false,
        engine: 'tesseract.js',
        language: 'eng',
        text: '',
        confidence: 0,
        blocks: [],
        error: 'Convert WEBP to PNG/JPEG when running offline WASM OCR.',
      };
    }

    const kindLabelMap: Record<ImageVisualMetrics['classification'], string> = {
      screenshot_or_ui: 'UI screenshot / high-contrast screen capture',
      technical_diagram_or_chart: 'technical diagram, wireframe, or chart',
      document_scan: 'document page or text-heavy scan',
      photograph_or_scene: 'continuous-tone photograph or rendered scene',
    };

    const descParts = [
      `Image "${request.filename}" is a ${metrics.width}x${metrics.height} ${metrics.format.toUpperCase()} (${metrics.aspect_ratio} aspect ratio, ${(metrics.byte_size / 1024).toFixed(1)} KB).`,
      `Visual structure indicates a **${kindLabelMap[metrics.classification]}** (mean luminance ${metrics.mean_brightness}/255, contrast σ=${metrics.contrast_stddev}, edge density ${Math.round(metrics.edge_density * 100)}%, color saturation spread ${metrics.color_variance}).`,
    ];
    if (ocr.ok && ocr.text) {
      descParts.push(
        `OCR extracted ${ocr.text.length} character(s) (${ocr.confidence}% confidence):\n${ocr.text.slice(0, 600)}`
      );
    } else if (ocr.error) {
      descParts.push(`OCR note: ${ocr.error}`);
    } else if (request.ocrEnabled !== false) {
      descParts.push('OCR detected no clear readable text regions.');
    }

    const endpoint = (request.visionEndpointUrl || '').trim().replace(/\/+$/, '');
    let vqaAnswer: string | null = null;
    let vqaModelName: string | null = null;
    let vqaNote: string | null = null;
    let mode: ImageAnalysisResult['mode'] = 'local_ocr_and_heuristics';

    if (endpoint) {
      const check = isLocalInferenceUrlSafe(endpoint);
      if (!check.valid) {
        vqaNote = check.reason;
      } else {
        try {
          const promptQuestion =
            (request.question || '').trim() ||
            'Describe this image concisely, noting visible objects, UI/chart structure, and any readable text.';
          const res = await fetch(`${endpoint}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              messages: [
                {
                  role: 'user',
                  content: [
                    {
                      type: 'text',
                      text: `${promptQuestion}${ocr.text ? `\n\n[Local OCR Text]\n${ocr.text.slice(0, 1200)}` : ''}`,
                    },
                    {
                      type: 'image_url',
                      image_url: { url: request.dataUrl },
                    },
                  ],
                },
              ],
              temperature: 0.2,
              max_tokens: 400,
            }),
            signal: AbortSignal.timeout(Math.min(45000, Math.max(3000, request.timeoutMs ?? 20000))),
          });

          if (res.ok) {
            const payload = (await res.json()) as {
              model?: string;
              choices?: Array<{ message?: { content?: string }; text?: string }>;
            };
            const text = payload.choices?.[0]?.message?.content || payload.choices?.[0]?.text;
            if (typeof text === 'string' && text.trim()) {
              vqaAnswer = text.trim();
              vqaModelName = payload.model || `local-vision (${endpoint})`;
              mode = 'local_vision_http';
            } else {
              vqaNote = 'Local vision server returned no text response.';
            }
          } else {
            vqaNote = `Local vision server returned HTTP ${res.status}.`;
          }
        } catch (err) {
          vqaNote = `Local vision server (${endpoint}) unreachable: ${
            err instanceof Error ? err.message : 'connection refused'
          }.`;
        }
      }
    } else if (request.question?.trim()) {
      vqaNote =
        'Answered from local structural analysis and OCR. Connect a loopback multimodal vision server (e.g., llama.cpp LLaVA / Qwen-VL on 127.0.0.1) in Settings for neural visual QA.';
    }

    return {
      ok: true,
      mode,
      filename: request.filename,
      metrics,
      ocr,
      description: descParts.join('\n\n'),
      vqa_answer: vqaAnswer,
      vqa_model_name: vqaModelName,
      vqa_note: vqaNote,
    };
  }
}
