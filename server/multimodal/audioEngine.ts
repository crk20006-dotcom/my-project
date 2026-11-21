import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { isLocalInferenceUrlSafe } from '../ai/interfaces.ts';
import type {
  AcousticMetadata,
  AudioProcessor,
  SpeechRecognizer,
  SpeechSynthesizer,
  SpeechToTextRequest,
  SpeechToTextResult,
  TextToSpeechRequest,
  TextToSpeechResult,
} from './interfaces.ts';
import { getMultimodalTempRoot } from './mediaSafety.ts';

const execFileAsync = promisify(execFile);

let cachedFfmpegAvailable: boolean | null = null;

export async function isFfmpegAvailable(): Promise<boolean> {
  if (cachedFfmpegAvailable !== null) return cachedFfmpegAvailable;
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 2500 });
    cachedFfmpegAvailable = true;
  } catch {
    cachedFfmpegAvailable = false;
  }
  return cachedFfmpegAvailable;
}

function parseWavRiffHeader(buf: Buffer): {
  sampleRate: number | null;
  channels: number | null;
  bitsPerSample: number | null;
  durationSec: number | null;
} {
  if (
    buf.length < 44 ||
    buf.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    buf.subarray(8, 12).toString('ascii') !== 'WAVE'
  ) {
    return { sampleRate: null, channels: null, bitsPerSample: null, durationSec: null };
  }

  let offset = 12;
  let channels: number | null = null;
  let sampleRate: number | null = null;
  let byteRate: number | null = null;
  let bitsPerSample: number | null = null;
  let dataSize: number | null = null;

  while (offset + 8 <= buf.length) {
    const chunkId = buf.subarray(offset, offset + 4).toString('ascii');
    const chunkSize = buf.readUInt32LE(offset + 4);
    const dataStart = offset + 8;

    if (chunkId === 'fmt ' && dataStart + 16 <= buf.length) {
      channels = buf.readUInt16LE(dataStart + 2);
      sampleRate = buf.readUInt32LE(dataStart + 4);
      byteRate = buf.readUInt32LE(dataStart + 8);
      bitsPerSample = buf.readUInt16LE(dataStart + 14);
    } else if (chunkId === 'data') {
      dataSize = chunkSize;
    }

    offset = dataStart + chunkSize + (chunkSize % 2);
  }

  let durationSec: number | null = null;
  if (dataSize !== null && byteRate && byteRate > 0) {
    durationSec = Number((dataSize / byteRate).toFixed(2));
  }

  return { sampleRate, channels, bitsPerSample, durationSec };
}

function parseFfmpegStderrInfo(stderr: string): {
  duration_sec: number | null;
  sample_rate: number | null;
  channels: number | null;
  codec: string | null;
} {
  let durationSec: number | null = null;
  const durMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (durMatch) {
    const h = Number(durMatch[1]);
    const m = Number(durMatch[2]);
    const s = Number(durMatch[3]);
    durationSec = Number((h * 3600 + m * 60 + s).toFixed(2));
  }

  let codec: string | null = null;
  let sampleRate: number | null = null;
  let channels: number | null = null;

  const streamMatch = stderr.match(/Audio:\s*([^,\n]+),\s*(\d+)\s*Hz,\s*([^,\n]+)/);
  if (streamMatch) {
    codec = streamMatch[1].trim();
    sampleRate = Number(streamMatch[2]);
    const chanDesc = streamMatch[3].toLowerCase();
    if (chanDesc.includes('mono') || chanDesc.includes('1 channels')) channels = 1;
    else if (chanDesc.includes('stereo') || chanDesc.includes('2 channels')) channels = 2;
  }

  return { duration_sec: durationSec, sample_rate: sampleRate, channels, codec };
}

export class LocalAudioProcessor implements AudioProcessor {
  async inspect(filePath: string, filename: string, buffer: Buffer): Promise<AcousticMetadata> {
    const ext = path.extname(filename).toLowerCase().replace('.', '') || 'audio';
    const ffmpegOk = await isFfmpegAvailable();

    const wavInfo = ext === 'wav' ? parseWavRiffHeader(buffer) : null;
    let durationSec = wavInfo?.durationSec ?? null;
    let sampleRate = wavInfo?.sampleRate ?? null;
    let channels = wavInfo?.channels ?? null;
    let codec: string | null = ext === 'wav' ? 'pcm' : ext;

    if (ffmpegOk && fs.existsSync(filePath)) {
      try {
        await execFileAsync('ffmpeg', ['-hide_banner', '-i', filePath], { timeout: 5000 });
      } catch (err) {
        // ffmpeg exits non-zero when no output target is supplied, emitting stream metadata on stderr
        const stderr =
          typeof err === 'object' && err !== null && 'stderr' in err
            ? String((err as { stderr?: string }).stderr || '')
            : '';
        if (stderr) {
          const parsed = parseFfmpegStderrInfo(stderr);
          if (parsed.duration_sec !== null) durationSec = parsed.duration_sec;
          if (parsed.sample_rate !== null) sampleRate = parsed.sample_rate;
          if (parsed.channels !== null) channels = parsed.channels;
          if (parsed.codec) codec = parsed.codec;
        }
      }
    }

    return {
      format: ext,
      duration_sec: durationSec,
      sample_rate: sampleRate,
      channels,
      codec,
      byte_size: buffer.byteLength,
      ffmpeg_available: ffmpegOk,
    };
  }

  async prepareForStt(inputPath: string, outputWavPath: string): Promise<boolean> {
    const ffmpegOk = await isFfmpegAvailable();
    if (!ffmpegOk) return false;
    try {
      await execFileAsync(
        'ffmpeg',
        ['-y', '-hide_banner', '-loglevel', 'error', '-i', inputPath, '-ar', '16000', '-ac', '1', '-f', 'wav', outputWavPath],
        { timeout: 15000 }
      );
      return fs.existsSync(outputWavPath);
    } catch {
      return false;
    }
  }
}

export class LocalWhisperSttAdapter implements SpeechRecognizer {
  readonly name = 'local_whisper_http';
  private readonly audioProcessor = new LocalAudioProcessor();

  async transcribe(request: SpeechToTextRequest): Promise<SpeechToTextResult> {
    const language = (request.language || 'en-US').trim();
    const acoustic = await this.audioProcessor.inspect(
      request.filePath,
      request.filename,
      request.buffer
    );

    const endpoint = (request.endpointUrl || '').trim().replace(/\/+$/, '');
    if (!endpoint) {
      return {
        ok: false,
        mode: 'acoustic_only_no_stt_server',
        transcript: '',
        language,
        acoustic,
        message:
          'Audio inspected cleanly. No local Whisper HTTP server URL is configured in Settings, so offline file transcription is unavailable (use the live microphone button for browser SpeechRecognition or run whisper.cpp server on 127.0.0.1).',
      };
    }

    const urlCheck = isLocalInferenceUrlSafe(endpoint);
    if (!urlCheck.valid) {
      return {
        ok: false,
        mode: 'acoustic_only_no_stt_server',
        transcript: '',
        language,
        acoustic,
        message: urlCheck.reason,
      };
    }

    // Prepare 16kHz mono WAV if ffmpeg is present and input isn't already WAV
    const tempRoot = getMultimodalTempRoot();
    const normalizedWavPath = path.resolve(tempRoot, `stt-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`);
    let uploadBuffer = request.buffer;
    let uploadFilename = request.filename;
    let uploadMime = request.mimeType;

    try {
      if (!request.filename.toLowerCase().endsWith('.wav')) {
        const converted = await this.audioProcessor.prepareForStt(request.filePath, normalizedWavPath);
        if (converted) {
          uploadBuffer = fs.readFileSync(normalizedWavPath);
          uploadFilename = `${path.parse(request.filename).name}.wav`;
          uploadMime = 'audio/wav';
        }
      }

      const langShort = language.split('-')[0] || 'en';
      const candidatePaths = ['/v1/audio/transcriptions', '/inference'];
      let lastErr = '';

      for (const routePath of candidatePaths) {
        try {
          const form = new FormData();
          form.append('file', new Blob([new Uint8Array(uploadBuffer)], { type: uploadMime }), uploadFilename);
          form.append('language', langShort);
          form.append('response_format', 'json');

          const res = await fetch(`${endpoint}${routePath}`, {
            method: 'POST',
            body: form,
            signal: AbortSignal.timeout(Math.min(60000, Math.max(2000, request.timeoutMs ?? 20000))),
          });

          if (res.status === 404) {
            continue;
          }
          if (!res.ok) {
            lastErr = `Local STT server returned HTTP ${res.status}`;
            continue;
          }

          const data = (await res.json()) as {
            text?: string;
            language?: string;
            segments?: Array<{ start?: number; end?: number; text: string }>;
          };
          const transcript = typeof data.text === 'string' ? data.text.trim() : '';
          return {
            ok: true,
            mode: 'local_whisper_http',
            transcript,
            language: data.language || language,
            acoustic,
            segments: Array.isArray(data.segments) ? data.segments : undefined,
            message: transcript
              ? `Transcribed via local STT endpoint (${endpoint}${routePath}).`
              : 'Local STT endpoint returned an empty transcript.',
          };
        } catch (err) {
          lastErr = err instanceof Error ? err.message : 'Connection failed';
        }
      }

      return {
        ok: false,
        mode: 'acoustic_only_no_stt_server',
        transcript: '',
        language,
        acoustic,
        message: `Local Whisper STT endpoint (${endpoint}) is unreachable: ${lastErr || 'Connection refused'}. Acoustic metadata was still extracted cleanly.`,
      };
    } finally {
      try {
        if (fs.existsSync(normalizedWavPath)) {
          fs.unlinkSync(normalizedWavPath);
        }
      } catch {
        // Ignore cleanup failure
      }
    }
  }
}

export class LocalPiperTtsAdapter implements SpeechSynthesizer {
  readonly name = 'local_piper_http';

  async synthesize(request: TextToSpeechRequest): Promise<TextToSpeechResult> {
    const cleanText = (request.text || '').trim();
    if (!cleanText) {
      return {
        ok: false,
        mode: 'browser_tts_fallback',
        message: 'Text content is required for speech synthesis.',
      };
    }

    const endpoint = (request.endpointUrl || '').trim().replace(/\/+$/, '');
    if (!endpoint) {
      return {
        ok: false,
        mode: 'browser_tts_fallback',
        message: 'No local Piper TTS server URL configured; using browser Web SpeechSynthesis.',
      };
    }

    const check = isLocalInferenceUrlSafe(endpoint);
    if (!check.valid) {
      return {
        ok: false,
        mode: 'browser_tts_fallback',
        message: check.reason,
      };
    }

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: cleanText.slice(0, 4000),
          voice: request.voice || undefined,
          length_scale: request.speed && request.speed > 0 ? Number((1 / request.speed).toFixed(2)) : 1.0,
        }),
        signal: AbortSignal.timeout(Math.min(30000, Math.max(2000, request.timeoutMs ?? 12000))),
      });

      if (!res.ok) {
        return {
          ok: false,
          mode: 'browser_tts_fallback',
          message: `Local TTS server returned HTTP ${res.status}; falling back to browser SpeechSynthesis.`,
        };
      }

      const contentType = (res.headers.get('content-type') || 'audio/wav').split(';')[0];
      if (contentType.startsWith('audio/')) {
        const arrayBuf = await res.arrayBuffer();
        return {
          ok: true,
          mode: 'local_piper_http',
          mimeType: contentType,
          audioBase64: Buffer.from(arrayBuf).toString('base64'),
          message: `Synthesized audio via local TTS endpoint (${endpoint}).`,
        };
      }

      const json = (await res.json().catch(() => null)) as { audio_base64?: string; mime_type?: string } | null;
      if (json?.audio_base64) {
        return {
          ok: true,
          mode: 'local_piper_http',
          mimeType: json.mime_type || 'audio/wav',
          audioBase64: json.audio_base64,
          message: `Synthesized audio via local TTS endpoint (${endpoint}).`,
        };
      }

      return {
        ok: false,
        mode: 'browser_tts_fallback',
        message: 'Local TTS server did not return an audio payload; using browser SpeechSynthesis.',
      };
    } catch (err) {
      return {
        ok: false,
        mode: 'browser_tts_fallback',
        message: `Local TTS endpoint unreachable (${err instanceof Error ? err.message : 'offline'}); using browser SpeechSynthesis.`,
      };
    }
  }
}
