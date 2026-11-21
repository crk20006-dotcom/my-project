export type MultimodalAssetKind = 'image' | 'document' | 'audio';

export interface AcousticMetadata {
  format: string;
  duration_sec: number | null;
  sample_rate: number | null;
  channels: number | null;
  codec: string | null;
  byte_size: number;
  ffmpeg_available: boolean;
}

export interface SpeechToTextRequest {
  filePath: string;
  filename: string;
  mimeType: string;
  buffer: Buffer;
  language?: string;
  endpointUrl?: string;
  timeoutMs?: number;
}

export interface SpeechToTextResult {
  ok: boolean;
  mode: 'local_whisper_http' | 'acoustic_only_no_stt_server';
  transcript: string;
  language: string;
  acoustic: AcousticMetadata;
  message: string;
  segments?: Array<{ start?: number; end?: number; text: string }>;
}

export interface TextToSpeechRequest {
  text: string;
  voice?: string;
  speed?: number;
  endpointUrl?: string;
  timeoutMs?: number;
}

export interface TextToSpeechResult {
  ok: boolean;
  mode: 'local_piper_http' | 'browser_tts_fallback';
  mimeType?: string;
  audioBase64?: string;
  message: string;
}

export interface OcrRequest {
  filePath: string;
  buffer: Buffer;
  language?: string;
  timeoutMs?: number;
}

export interface OcrResult {
  ok: boolean;
  engine: 'tesseract.js' | 'disabled';
  language: string;
  text: string;
  confidence: number;
  blocks: Array<{ text: string; confidence: number }>;
  error?: string;
}

export interface ImageVisualMetrics {
  format: 'png' | 'jpeg' | 'webp';
  width: number;
  height: number;
  aspect_ratio: string;
  byte_size: number;
  pixel_sample_count: number;
  mean_brightness: number;
  contrast_stddev: number;
  light_pixel_ratio: number;
  dark_pixel_ratio: number;
  edge_density: number;
  color_variance: number;
  classification:
    | 'screenshot_or_ui'
    | 'technical_diagram_or_chart'
    | 'document_scan'
    | 'photograph_or_scene';
}

export interface ImageAnalysisRequest {
  filePath: string;
  filename: string;
  mimeType: string;
  buffer: Buffer;
  dataUrl: string;
  question?: string;
  ocrEnabled?: boolean;
  ocrLanguage?: string;
  visionEndpointUrl?: string;
  timeoutMs?: number;
}

export interface ImageAnalysisResult {
  ok: boolean;
  mode: 'local_vision_http' | 'local_ocr_and_heuristics';
  filename: string;
  metrics: ImageVisualMetrics;
  ocr: OcrResult;
  description: string;
  vqa_answer?: string | null;
  vqa_model_name?: string | null;
  vqa_note?: string | null;
}

export interface DocumentExtractionResult {
  ok: boolean;
  format: 'pdf' | 'docx' | 'txt' | 'md';
  filename: string;
  extracted_text: string;
  page_count?: number;
  metrics: {
    chars: number;
    words: number;
    lines: number;
    headings: number;
    lists: number;
    tables: number;
    code_blocks: number;
  };
  note?: string;
}

export interface MediaPreprocessRequest {
  filename: string;
  mimeType: string;
  buffer: Buffer;
  question?: string;
  ocrEnabled?: boolean;
  language?: string;
  sttEndpointUrl?: string;
  visionEndpointUrl?: string;
  maxUploadMb?: number;
  allowedExtensions?: string[];
}

export interface ExtractedMediaResult {
  ok: boolean;
  asset_kind: MultimodalAssetKind;
  filename: string;
  mimeType: string;
  extension: string;
  size: number;
  summary: string;
  extracted_text: string;
  image_data_url?: string;
  image_analysis?: ImageAnalysisResult;
  document_extraction?: DocumentExtractionResult;
  speech_result?: SpeechToTextResult;
  attachment: {
    id: string;
    name: string;
    size: number;
    mimeType: string;
    extension: string;
    previewText?: string;
    imageDataUrl?: string;
    mediaKind?: MultimodalAssetKind | 'text';
    validated: boolean;
  };
}

export interface SpeechRecognizer {
  readonly name: string;
  transcribe(request: SpeechToTextRequest): Promise<SpeechToTextResult>;
}

export interface SpeechSynthesizer {
  readonly name: string;
  synthesize(request: TextToSpeechRequest): Promise<TextToSpeechResult>;
}

export interface OcrExtractor {
  readonly engineName: string;
  extractText(request: OcrRequest): Promise<OcrResult>;
}

export interface ImageAnalyzer {
  readonly name: string;
  analyze(request: ImageAnalysisRequest): Promise<ImageAnalysisResult>;
}

export interface AudioProcessor {
  inspect(filePath: string, filename: string, buffer: Buffer): Promise<AcousticMetadata>;
  prepareForStt(inputPath: string, outputWavPath: string): Promise<boolean>;
}

export interface MediaPreprocessor {
  preprocess(request: MediaPreprocessRequest): Promise<ExtractedMediaResult>;
}
