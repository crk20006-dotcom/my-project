import React, { useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  CheckCircle2,
  Eye,
  FileAudio,
  FileText,
  Layers,
  Loader2,
  Mic,
  MicOff,
  Pause,
  Play,
  Save,
  Square,
  Upload,
  Volume2,
} from 'lucide-react';
import { fileToBase64, useSpeechControls } from '../../hooks/useSpeechControls';
import { apiClient, ApiRequestError } from '../../services/apiClient';
import type {
  CreatorProject,
  ImageAnalysisPayload,
  MultimodalProcessResponse,
  MultimodalStatusResponse,
  ResearchProject,
  SystemSettings,
} from '../../types/genesis';

interface GenesisVoiceModuleProps {
  settings: SystemSettings | null;
  onSettingsUpdated: (next: SystemSettings) => void;
}

type StudioTab = 'voice' | 'vision' | 'media';

function isSafePreviewImageUrl(url: string | null): url is string {
  return Boolean(
    url &&
      url.length <= 4_000_000 &&
      /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(url)
  );
}

export const GenesisVoiceModule: React.FC<GenesisVoiceModuleProps> = ({
  settings,
  onSettingsUpdated,
}) => {
  const [activeTab, setActiveTab] = useState<StudioTab>('voice');
  const [status, setStatus] = useState<MultimodalStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Voice Input & Hardware Monitor State
  const [micActive, setMicActive] = useState(false);
  const [rmsLevel, setRmsLevel] = useState(0);
  const [dictationDraft, setDictationDraft] = useState('');
  const [ttsSampleText, setTtsSampleText] = useState(
    'Project Genesis local voice synthesis and speech playback verification active.'
  );
  const [audioFileResult, setAudioFileResult] = useState<{
    filename: string;
    durationSec: number | null;
    sampleRate: number | null;
    channels: number | null;
    codec: string | null;
    transcript: string;
    message: string;
  } | null>(null);
  const [audioBusy, setAudioBusy] = useState(false);

  // Local Adapter Config State
  const [sampleRate, setSampleRate] = useState(settings?.voice_sample_rate ?? 16000);
  const [vadThreshold, setVadThreshold] = useState(settings?.voice_vad_threshold ?? 0.45);
  const [sttLanguage, setSttLanguage] = useState(settings?.voice_stt_language ?? 'en-US');
  const [ttsVoice, setTtsVoice] = useState(settings?.voice_tts_voice ?? '');
  const [ttsRate, setTtsRate] = useState(settings?.voice_tts_rate ?? 1.0);
  const [autoSpeak, setAutoSpeak] = useState(settings?.voice_auto_speak ?? false);
  const [sttUrl, setSttUrl] = useState(settings?.voice_stt_endpoint_url ?? '');
  const [ttsUrl, setTtsUrl] = useState(settings?.voice_tts_endpoint_url ?? '');
  const [visionUrl, setVisionUrl] = useState(settings?.vision_endpoint_url ?? '');
  const [ocrEnabled, setOcrEnabled] = useState(settings?.ocr_enabled ?? true);
  const [saving, setSaving] = useState(false);

  // Vision & OCR Workspace State
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [imageFilename, setImageFilename] = useState('');
  const [imageBase64, setImageBase64] = useState('');
  const [imageMimeType, setImageMimeType] = useState('image/png');
  const [visionQuestion, setVisionQuestion] = useState('');
  const [visionBusy, setVisionBusy] = useState(false);
  const [visionResult, setVisionResult] = useState<ImageAnalysisPayload | null>(null);

  // Document & Media Extraction State
  const [mediaBusy, setMediaBusy] = useState(false);
  const [mediaResult, setMediaResult] = useState<MultimodalProcessResponse | null>(null);

  // Cross-module Export Targets (Research + Creator Studio)
  const [researchList, setResearchList] = useState<ResearchProject[]>([]);
  const [creatorProjects, setCreatorProjects] = useState<CreatorProject[]>([]);
  const [selectedResearchId, setSelectedResearchId] = useState<string>('');
  const [selectedCreatorProjectId, setSelectedCreatorProjectId] = useState<string>('proj-genesis-studio');
  const [pendingCreatorOverwrite, setPendingCreatorOverwrite] = useState<{
    sourceName: string;
    targetName: string;
    content: string;
  } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);

  const speech = useSpeechControls({
    language: sttLanguage,
    preferredVoice: ttsVoice,
    rate: ttsRate,
    ttsEndpointConfigured: Boolean(ttsUrl),
    onTranscriptFinal: (text) => {
      setDictationDraft((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text));
    },
  });

  const loadCapabilities = async () => {
    try {
      const [mmStatus, resProjs, cProjs] = await Promise.all([
        apiClient.getMultimodalStatus(),
        apiClient.listResearch(),
        apiClient.listCreatorProjects(),
      ]);
      setStatus(mmStatus);
      setResearchList(resProjs);
      setCreatorProjects(cProjs);
      if (cProjs.length > 0 && !cProjs.some((p) => p.id === selectedCreatorProjectId)) {
        setSelectedCreatorProjectId(cProjs[0].id);
      }
    } catch {
      // Optional auxiliary load
    }
  };

  useEffect(() => {
    void loadCapabilities();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!settings) return;
    setSampleRate(settings.voice_sample_rate);
    setVadThreshold(settings.voice_vad_threshold);
    setSttLanguage(settings.voice_stt_language ?? 'en-US');
    setTtsVoice(settings.voice_tts_voice ?? '');
    setTtsRate(settings.voice_tts_rate ?? 1.0);
    setAutoSpeak(settings.voice_auto_speak ?? false);
    setSttUrl(settings.voice_stt_endpoint_url ?? '');
    setTtsUrl(settings.voice_tts_endpoint_url ?? '');
    setVisionUrl(settings.vision_endpoint_url ?? '');
    setOcrEnabled(settings.ocr_enabled ?? true);
  }, [settings]);

  const stopWaveformMonitor = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    void audioCtxRef.current?.close();
    streamRef.current = null;
    audioCtxRef.current = null;
    setMicActive(false);
    setRmsLevel(0);
  };

  useEffect(() => {
    return () => stopWaveformMonitor();
  }, []);

  const startWaveformMonitor = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);

      streamRef.current = stream;
      audioCtxRef.current = ctx;
      setMicActive(true);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const render = () => {
        analyser.getByteTimeDomainData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const v = (dataArray[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / dataArray.length);
        setRmsLevel(Number((rms * 100).toFixed(1)));

        const canvas = canvasRef.current;
        if (canvas) {
          const g = canvas.getContext('2d');
          if (g) {
            g.fillStyle = '#0A0D12';
            g.fillRect(0, 0, canvas.width, canvas.height);
            g.strokeStyle = '#3B82F6';
            g.lineWidth = 1.75;
            g.beginPath();
            const sliceWidth = canvas.width / dataArray.length;
            let x = 0;
            for (let i = 0; i < dataArray.length; i++) {
              const y = (dataArray[i] / 255) * canvas.height;
              if (i === 0) g.moveTo(x, y);
              else g.lineTo(x, y);
              x += sliceWidth;
            }
            g.stroke();
          }
        }
        rafRef.current = requestAnimationFrame(render);
      };
      render();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Microphone permission denied or audio device unavailable.'
      );
    }
  };

  const handleUploadAudioFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setNotice(null);
    setAudioBusy(true);
    try {
      const base64 = await fileToBase64(file);
      const res = await apiClient.transcribeAudio({
        filename: file.name,
        mimeType: file.type || 'audio/wav',
        dataBase64: base64,
        language: sttLanguage,
      });
      setAudioFileResult({
        filename: file.name,
        durationSec: res.acoustic.duration_sec,
        sampleRate: res.acoustic.sample_rate,
        channels: res.acoustic.channels,
        codec: res.acoustic.codec,
        transcript: res.transcript,
        message: res.message,
      });
      if (res.transcript) {
        setDictationDraft(res.transcript);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to process audio file.');
    } finally {
      setAudioBusy(false);
      e.target.value = '';
    }
  };

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await apiClient.updateSettings({
        voice_sample_rate: sampleRate,
        voice_vad_threshold: vadThreshold,
        voice_stt_language: sttLanguage,
        voice_tts_voice: ttsVoice,
        voice_tts_rate: ttsRate,
        voice_auto_speak: autoSpeak,
        voice_stt_endpoint_url: sttUrl.trim(),
        voice_tts_endpoint_url: ttsUrl.trim(),
        vision_endpoint_url: visionUrl.trim(),
        ocr_enabled: ocrEnabled,
      });
      onSettingsUpdated(updated);
      setNotice('Multimodal voice & vision pipeline settings saved.');
      await loadCapabilities();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save multimodal settings.');
    } finally {
      setSaving(false);
    }
  };

  const handleSelectImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setNotice(null);
    setVisionBusy(true);

    try {
      const b64 = await fileToBase64(file);
      const mime = file.type || (file.name.toLowerCase().endsWith('.webp') ? 'image/webp' : file.name.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg');
      const dataUrl = `data:${mime};base64,${b64}`;
      setImageFilename(file.name);
      setImageMimeType(mime);
      setImageBase64(b64);
      setImagePreviewUrl(dataUrl);

      const analysis = await apiClient.analyzeMultimodalImage({
        filename: file.name,
        mimeType: mime,
        dataBase64: b64,
        question: visionQuestion.trim() || undefined,
        ocr_enabled: ocrEnabled,
        ocr_language: sttLanguage,
      });
      setVisionResult(analysis);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to analyze image.');
    } finally {
      setVisionBusy(false);
      e.target.value = '';
    }
  };

  const handleReanalyzeImage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!imageBase64 || !imageFilename) return;
    setError(null);
    setVisionBusy(true);
    try {
      const analysis = await apiClient.analyzeMultimodalImage({
        filename: imageFilename,
        mimeType: imageMimeType,
        dataBase64: imageBase64,
        question: visionQuestion.trim() || undefined,
        ocr_enabled: ocrEnabled,
        ocr_language: sttLanguage,
      });
      setVisionResult(analysis);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Visual question answering failed.');
    } finally {
      setVisionBusy(false);
    }
  };

  const handleProcessMediaFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setNotice(null);
    setMediaBusy(true);

    try {
      const b64 = await fileToBase64(file);
      const res = await apiClient.processMultimodalFile({
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
        encoding: 'base64',
        data: b64,
        ocr_enabled: ocrEnabled,
        language: sttLanguage,
        save_asset: true,
      });
      setMediaResult(res);
      setNotice(`Extracted ${res.filename} (${res.summary}).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Document or media extraction failed.');
    } finally {
      setMediaBusy(false);
      e.target.value = '';
    }
  };

  const sendToResearch = async (sourceName: string, summary: string, content: string) => {
    setError(null);
    setNotice(null);
    try {
      const res = await apiClient.sendMediaToResearch({
        research_id: selectedResearchId || null,
        title: `Multimodal Notes: ${sourceName}`,
        summary,
        source_name: sourceName,
        content,
      });
      setNotice(
        res.action === 'appended'
          ? `Attached "${sourceName}" to Research Study "${res.title}".`
          : `Created Research Study "${res.title}" with extracted content.`
      );
      await loadCapabilities();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send content to Research.');
    }
  };

  const sendToCreator = async (sourceName: string, content: string, overwrite = false) => {
    setError(null);
    setNotice(null);
    const stem = sourceName.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9._-]/g, '_');
    const targetName = `${stem}_extract.md`;
    try {
      const res = await apiClient.sendMediaToCreator({
        project_id: selectedCreatorProjectId,
        filename: targetName,
        content,
        overwrite,
        summary: `Imported from Multimodal Studio (${sourceName})`,
      });
      setPendingCreatorOverwrite(null);
      setNotice(`Saved "${res.file.filename}" in Creator project "${res.project_name}".`);
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'OVERWRITE_CONFIRMATION_REQUIRED') {
        setPendingCreatorOverwrite({ sourceName, targetName, content });
        return;
      }
      setError(err instanceof Error ? err.message : 'Failed to send content to Creator Studio.');
    }
  };

  return (
    <div className="h-full overflow-y-auto px-4 lg:px-8 py-6">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header & Capability Strip */}
        <div className="flex flex-wrap items-center justify-between gap-4 pb-5 border-b border-white/[0.08]">
          <div>
            <h2 className="font-display text-xl font-semibold text-slate-100">
              Genesis Voice, Vision & Multimodal Intelligence
            </h2>
            <p className="text-sm text-slate-400 mt-1">
              Local speech input/output, CPU OCR & image analysis, and PDF/DOCX/Audio extraction with zero paid cloud APIs.
            </p>
          </div>
          {status && (
            <div className="flex flex-wrap items-center gap-3 text-xs text-slate-300">
              <span className="px-2.5 py-1 rounded bg-[#11161F] border border-white/[0.08]">
                FFmpeg: <strong className={status.ffmpeg_available ? 'text-emerald-400' : 'text-amber-300'}>{status.ffmpeg_available ? 'Detected' : 'Not Installed'}</strong>
              </span>
              <span className="px-2.5 py-1 rounded bg-[#11161F] border border-white/[0.08]">
                OCR: <strong className="text-blue-300">{status.ocr_enabled ? 'Tesseract.js' : 'Disabled'}</strong>
              </span>
            </div>
          )}
        </div>

        {/* Workspace Tab Selector */}
        <div className="flex flex-wrap items-center gap-2">
          {[
            { id: 'voice' as const, label: 'Voice & Speech', icon: Mic },
            { id: 'vision' as const, label: 'Vision & OCR', icon: Eye },
            { id: 'media' as const, label: 'Document & Media Extractor', icon: FileText },
          ].map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium border transition-colors cursor-pointer ${
                  active
                    ? 'bg-blue-600 border-blue-500 text-white'
                    : 'bg-[#11161F] border-white/[0.08] text-slate-300 hover:bg-[#18202D]'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        {(error || speech.speechError) && (
          <div className="p-3.5 rounded-lg bg-red-500/10 border border-red-500/25 text-xs text-red-300">
            {error || speech.speechError}
          </div>
        )}
        {notice && (
          <div className="p-3.5 rounded-lg bg-emerald-500/10 border border-emerald-500/25 text-xs text-emerald-300 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{notice}</span>
          </div>
        )}
        {pendingCreatorOverwrite && (
          <div className="p-4 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200 flex flex-wrap items-center justify-between gap-3">
            <span>
              File <strong>{pendingCreatorOverwrite.targetName}</strong> already exists in the selected Creator Studio project. Save as a new versioned revision?
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  void sendToCreator(
                    pendingCreatorOverwrite.sourceName,
                    pendingCreatorOverwrite.content,
                    true
                  )
                }
                className="px-3 py-1.5 rounded bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/40 text-amber-100 font-medium cursor-pointer"
              >
                Confirm Overwrite (New Revision)
              </button>
              <button
                type="button"
                onClick={() => setPendingCreatorOverwrite(null)}
                className="px-3 py-1.5 rounded bg-[#161C26] hover:bg-[#1E2634] border border-white/[0.1] text-slate-300 cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* TAB 1: VOICE & SPEECH */}
        {activeTab === 'voice' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            <div className="lg:col-span-7 space-y-6">
              {/* Speech Recognition + Waveform */}
              <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-6 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="font-display text-base font-semibold text-slate-100">
                      Microphone & Speech-to-Text
                    </h3>
                    <p className="text-xs text-slate-400 mt-0.5 tabular-nums">
                      RMS Signal: {rmsLevel}% · Language: {sttLanguage}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={micActive ? stopWaveformMonitor : () => void startWaveformMonitor()}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer border ${
                        micActive
                          ? 'bg-red-500/15 border-red-500/40 text-red-200'
                          : 'bg-[#161C26] border-white/[0.1] text-slate-200'
                      }`}
                    >
                      {micActive ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
                      <span>{micActive ? 'Stop Meter' : 'Mic Waveform'}</span>
                    </button>

                    <button
                      type="button"
                      onClick={speech.toggleRecording}
                      className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium cursor-pointer ${
                        speech.recordingState === 'listening'
                          ? 'bg-red-600 hover:bg-red-500 text-white'
                          : 'bg-blue-600 hover:bg-blue-500 text-white'
                      }`}
                    >
                      {speech.recordingState === 'listening' ? (
                        <MicOff className="w-3.5 h-3.5" />
                      ) : (
                        <Mic className="w-3.5 h-3.5" />
                      )}
                      <span>
                        {speech.recordingState === 'listening' ? 'Stop Dictation' : 'Start Dictation'}
                      </span>
                    </button>
                  </div>
                </div>

                <canvas
                  ref={canvasRef}
                  width={640}
                  height={110}
                  className="w-full h-28 rounded-lg border border-white/[0.08] bg-[#0A0D12]"
                />

                <div>
                  <label className="block text-xs text-slate-400 mb-1.5">
                    Editable Transcript Buffer {speech.interimTranscript ? `— Live: "${speech.interimTranscript}"` : ''}
                  </label>
                  <textarea
                    rows={3}
                    value={dictationDraft}
                    onChange={(e) => setDictationDraft(e.target.value)}
                    placeholder="Speak using Start Dictation or upload an audio file below..."
                    className="w-full px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 focus:outline-none focus:border-blue-500"
                  />
                </div>

                <div className="pt-3 border-t border-white/[0.08] flex flex-wrap items-center justify-between gap-3">
                  <div className="text-xs text-slate-400">
                    Inspect or transcribe audio file (.wav, .mp3, .ogg, .webm, .m4a):
                  </div>
                  <label className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-white/[0.1] bg-[#161C26] hover:bg-[#1E2634] text-xs font-medium text-slate-200 cursor-pointer">
                    {audioBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileAudio className="w-3.5 h-3.5" />}
                    <span>{audioBusy ? 'Processing Audio...' : 'Upload Audio File'}</span>
                    <input
                      type="file"
                      accept=".wav,.mp3,.ogg,.webm,.m4a,audio/*"
                      onChange={handleUploadAudioFile}
                      className="hidden"
                    />
                  </label>
                </div>

                {audioFileResult && (
                  <div className="p-3.5 rounded-lg bg-[#0A0D12] border border-white/[0.08] space-y-2 text-xs">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <div>
                        <div className="text-slate-500">File</div>
                        <div className="font-mono text-slate-200 truncate">{audioFileResult.filename}</div>
                      </div>
                      <div>
                        <div className="text-slate-500">Duration</div>
                        <div className="font-mono text-slate-200 tabular-nums">
                          {audioFileResult.durationSec !== null ? `${audioFileResult.durationSec}s` : 'n/a'}
                        </div>
                      </div>
                      <div>
                        <div className="text-slate-500">Sample Rate</div>
                        <div className="font-mono text-slate-200 tabular-nums">
                          {audioFileResult.sampleRate ? `${audioFileResult.sampleRate} Hz` : 'n/a'}
                        </div>
                      </div>
                      <div>
                        <div className="text-slate-500">Codec / Ch</div>
                        <div className="font-mono text-slate-200">
                          {audioFileResult.codec || 'audio'} / {audioFileResult.channels ?? '?'}ch
                        </div>
                      </div>
                    </div>
                    <div className="text-slate-400">{audioFileResult.message}</div>
                  </div>
                )}
              </div>

              {/* Speech Output Tester */}
              <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-6 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 font-display text-base font-semibold text-slate-100">
                    <Volume2 className="w-4 h-4 text-blue-400" />
                    <span>Speech Output Test (TTS)</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {speech.speakingId === 'voice-studio-test' ? (
                      <>
                        <button
                          type="button"
                          onClick={speech.pauseOrResumeSpeech}
                          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-blue-600/20 border border-blue-500/40 text-xs text-blue-200 cursor-pointer"
                        >
                          {speech.ttsState === 'paused' ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
                          <span>{speech.ttsState === 'paused' ? 'Resume' : 'Pause'}</span>
                        </button>
                        <button
                          type="button"
                          onClick={speech.stopAudioOutput}
                          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-red-600 text-xs text-white cursor-pointer"
                        >
                          <Square className="w-3 h-3 fill-current" />
                          <span>Stop</span>
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void speech.speak('voice-studio-test', ttsSampleText)}
                        className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white cursor-pointer"
                      >
                        <Play className="w-3.5 h-3.5" />
                        <span>Speak Sample</span>
                      </button>
                    )}
                  </div>
                </div>
                <textarea
                  rows={2}
                  value={ttsSampleText}
                  onChange={(e) => setTtsSampleText(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 focus:outline-none"
                />
              </div>
            </div>

            {/* Technical Pipeline Configuration */}
            <form
              onSubmit={handleSaveConfig}
              className="lg:col-span-5 rounded-xl border border-white/[0.08] bg-[#11161F] p-6 space-y-4"
            >
              <h3 className="font-display text-base font-semibold text-slate-100">
                Multimodal Adapter Configuration
              </h3>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">STT Language</label>
                  <select
                    value={sttLanguage}
                    onChange={(e) => setSttLanguage(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-100 focus:outline-none"
                  >
                    <option value="en-US">English (US)</option>
                    <option value="en-GB">English (UK)</option>
                    <option value="es-ES">Spanish</option>
                    <option value="fr-FR">French</option>
                    <option value="de-DE">German</option>
                    <option value="hi-IN">Hindi</option>
                    <option value="ja-JP">Japanese</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Sample Rate (Hz)</label>
                  <select
                    value={sampleRate}
                    onChange={(e) => setSampleRate(Number(e.target.value))}
                    className="w-full px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-100 tabular-nums focus:outline-none"
                  >
                    <option value={16000}>16,000 Hz</option>
                    <option value={22050}>22,050 Hz</option>
                    <option value={44100}>44,100 Hz</option>
                    <option value={48000}>48,000 Hz</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">TTS Voice</label>
                <select
                  value={ttsVoice}
                  onChange={(e) => setTtsVoice(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-100 focus:outline-none"
                >
                  <option value="">System Default Voice</option>
                  {speech.voices.map((v) => (
                    <option key={`${v.name}-${v.lang}`} value={v.name}>
                      {v.name} ({v.lang})
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-slate-400 mb-1 tabular-nums">
                    TTS Speed ({ttsRate.toFixed(1)}x)
                  </label>
                  <input
                    type="range"
                    min={0.6}
                    max={1.8}
                    step={0.1}
                    value={ttsRate}
                    onChange={(e) => setTtsRate(Number(e.target.value))}
                    className="w-full accent-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1 tabular-nums">
                    VAD Threshold ({vadThreshold})
                  </label>
                  <input
                    type="range"
                    min={0.1}
                    max={0.95}
                    step={0.05}
                    value={vadThreshold}
                    onChange={(e) => setVadThreshold(Number(e.target.value))}
                    className="w-full accent-blue-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">Whisper STT Endpoint (Loopback)</label>
                <input
                  type="text"
                  value={sttUrl}
                  onChange={(e) => setSttUrl(e.target.value)}
                  placeholder="http://127.0.0.1:8081"
                  className="w-full px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] font-mono text-xs text-slate-100 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">Piper TTS Endpoint (Loopback)</label>
                <input
                  type="text"
                  value={ttsUrl}
                  onChange={(e) => setTtsUrl(e.target.value)}
                  placeholder="http://127.0.0.1:5000"
                  className="w-full px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] font-mono text-xs text-slate-100 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">Local Vision VQA Endpoint (Loopback)</label>
                <input
                  type="text"
                  value={visionUrl}
                  onChange={(e) => setVisionUrl(e.target.value)}
                  placeholder="http://127.0.0.1:8082"
                  className="w-full px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] font-mono text-xs text-slate-100 focus:outline-none"
                />
              </div>

              <div className="space-y-2 pt-1">
                <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={autoSpeak}
                    onChange={(e) => setAutoSpeak(e.target.checked)}
                    className="accent-blue-500"
                  />
                  <span>Auto-speak new Chat replies</span>
                </label>
                <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={ocrEnabled}
                    onChange={(e) => setOcrEnabled(e.target.checked)}
                    className="accent-blue-500"
                  />
                  <span>Enable Tesseract OCR on uploaded images</span>
                </label>
              </div>

              <button
                type="submit"
                disabled={saving}
                className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white cursor-pointer"
              >
                <Save className="w-3.5 h-3.5" />
                <span>{saving ? 'Saving...' : 'Save Multimodal Settings'}</span>
              </button>
            </form>
          </div>
        )}

        {/* TAB 2: VISION & OCR */}
        {activeTab === 'vision' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            <div className="lg:col-span-5 rounded-xl border border-white/[0.08] bg-[#11161F] p-6 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-display text-base font-semibold text-slate-100">
                  Image Upload & Preview
                </h3>
                <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white cursor-pointer">
                  {visionBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                  <span>Upload Image</span>
                  <input
                    type="file"
                    accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
                    onChange={handleSelectImage}
                    className="hidden"
                  />
                </label>
              </div>

              {isSafePreviewImageUrl(imagePreviewUrl) ? (
                <div className="rounded-lg border border-white/[0.08] bg-[#0A0D12] p-2">
                  <img
                    src={imagePreviewUrl}
                    alt={imageFilename || 'Uploaded preview'}
                    className="w-full max-h-72 object-contain rounded"
                  />
                  <div className="text-[11px] font-mono text-slate-400 mt-2 truncate">{imageFilename}</div>
                </div>
              ) : (
                <div className="h-52 rounded-lg border border-dashed border-white/[0.12] bg-[#0A0D12] flex flex-col items-center justify-center text-xs text-slate-500 p-4 text-center">
                  <Eye className="w-6 h-6 text-slate-600 mb-2" />
                  <span>Upload a PNG, JPG, or WEBP screenshot, diagram, chart, or scan.</span>
                </div>
              )}

              <form onSubmit={handleReanalyzeImage} className="space-y-2.5">
                <label className="block text-xs text-slate-400">
                  Visual Question (optional — queries connected local vision model + OCR)
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={visionQuestion}
                    onChange={(e) => setVisionQuestion(e.target.value)}
                    placeholder="e.g., What components or text appear in this diagram?"
                    className="flex-1 px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-100 focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={!imageBase64 || visionBusy}
                    className="px-3.5 py-2 rounded-lg border border-white/[0.1] bg-[#161C26] hover:bg-[#1E2634] disabled:opacity-40 text-xs font-medium text-slate-200 cursor-pointer"
                  >
                    Ask
                  </button>
                </div>
              </form>
            </div>

            <div className="lg:col-span-7 rounded-xl border border-white/[0.08] bg-[#11161F] p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="font-display text-base font-semibold text-slate-100">
                  Vision Inspection & Extracted OCR Text
                </h3>
                {visionResult && (
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        void sendToResearch(
                          visionResult.filename,
                          `Image Analysis (${visionResult.metrics.width}x${visionResult.metrics.height} ${visionResult.metrics.classification})`,
                          [
                            visionResult.description,
                            visionResult.vqa_answer ? `Visual Answer: ${visionResult.vqa_answer}` : '',
                            visionResult.ocr.text ? `OCR Text:\n${visionResult.ocr.text}` : '',
                          ]
                            .filter(Boolean)
                            .join('\n\n')
                        )
                      }
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/[0.1] bg-[#161C26] hover:bg-[#1E2634] text-xs text-slate-200 cursor-pointer"
                    >
                      <BookOpen className="w-3.5 h-3.5 text-blue-400" />
                      <span>Send to Research</span>
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void sendToCreator(
                          visionResult.filename,
                          `# Visual Analysis: ${visionResult.filename}\n\n${visionResult.description}\n${
                            visionResult.vqa_answer ? `\n## Visual Answer\n${visionResult.vqa_answer}\n` : ''
                          }${visionResult.ocr.text ? `\n## Extracted OCR Text\n\`\`\`\n${visionResult.ocr.text}\n\`\`\`\n` : ''}`
                        )
                      }
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/[0.1] bg-[#161C26] hover:bg-[#1E2634] text-xs text-slate-200 cursor-pointer"
                    >
                      <Layers className="w-3.5 h-3.5 text-blue-400" />
                      <span>Send to Creator</span>
                    </button>
                  </div>
                )}
              </div>

              {visionResult ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                    <div className="p-3 rounded-lg bg-[#0A0D12] border border-white/[0.08]">
                      <div className="text-slate-500">Dimensions</div>
                      <div className="font-mono text-slate-200 tabular-nums mt-0.5">
                        {visionResult.metrics.width} × {visionResult.metrics.height}
                      </div>
                    </div>
                    <div className="p-3 rounded-lg bg-[#0A0D12] border border-white/[0.08]">
                      <div className="text-slate-500">Detected Kind</div>
                      <div className="font-mono text-blue-300 mt-0.5 truncate">
                        {visionResult.metrics.classification.replace(/_/g, ' ')}
                      </div>
                    </div>
                    <div className="p-3 rounded-lg bg-[#0A0D12] border border-white/[0.08]">
                      <div className="text-slate-500">Contrast / Edges</div>
                      <div className="font-mono text-slate-200 tabular-nums mt-0.5">
                        σ={visionResult.metrics.contrast_stddev} · {Math.round(visionResult.metrics.edge_density * 100)}%
                      </div>
                    </div>
                    <div className="p-3 rounded-lg bg-[#0A0D12] border border-white/[0.08]">
                      <div className="text-slate-500">OCR Engine</div>
                      <div className="font-mono text-slate-200 mt-0.5">
                        {visionResult.ocr.ok ? `${visionResult.ocr.confidence}% conf` : visionResult.ocr.engine}
                      </div>
                    </div>
                  </div>

                  <div className="p-4 rounded-lg bg-[#0A0D12] border border-white/[0.08] text-xs text-slate-300 whitespace-pre-wrap leading-relaxed">
                    {visionResult.description}
                  </div>

                  {visionResult.vqa_answer && (
                    <div className="p-4 rounded-lg bg-blue-500/10 border border-blue-500/25 text-xs text-blue-100 space-y-1">
                      <div className="font-semibold text-blue-300">
                        Visual QA ({visionResult.vqa_model_name})
                      </div>
                      <div className="whitespace-pre-wrap">{visionResult.vqa_answer}</div>
                    </div>
                  )}

                  {visionResult.vqa_note && (
                    <div className="text-xs text-amber-300/90">{visionResult.vqa_note}</div>
                  )}

                  <div>
                    <div className="text-xs text-slate-400 mb-1.5">Extracted OCR Text</div>
                    <textarea
                      readOnly
                      rows={5}
                      value={
                        visionResult.ocr.text ||
                        visionResult.ocr.error ||
                        '(No text extracted from image.)'
                      }
                      className="w-full px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.08] font-mono text-xs text-slate-200 focus:outline-none"
                    />
                  </div>
                </div>
              ) : (
                <div className="py-12 text-center text-xs text-slate-500 border border-white/[0.06] rounded-lg bg-[#0A0D12]">
                  Upload an image to inspect structural metrics, extract OCR text, or run local visual QA.
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 3: DOCUMENT & MEDIA EXTRACTOR */}
        {activeTab === 'media' && (
          <div className="space-y-6">
            <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h3 className="font-display text-base font-semibold text-slate-100">
                    Document, Image & Audio Extractor
                  </h3>
                  <p className="text-xs text-slate-400 mt-1">
                    Extract clean text from PDF, DOCX, TXT, Markdown, PNG/JPG/WEBP, or Audio files for Research and Creator Studio.
                  </p>
                </div>

                <label className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white cursor-pointer">
                  {mediaBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                  <span>{mediaBusy ? 'Extracting Content...' : 'Upload Media / Document'}</span>
                  <input
                    type="file"
                    accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg,.webp,.wav,.mp3,.ogg,.webm,.m4a"
                    onChange={handleProcessMediaFile}
                    className="hidden"
                  />
                </label>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-white/[0.08]">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Target Research Study</label>
                  <select
                    value={selectedResearchId}
                    onChange={(e) => setSelectedResearchId(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-100 focus:outline-none"
                  >
                    <option value="">Create New Research Study</option>
                    {researchList.map((r) => (
                      <option key={r.id} value={r.id}>
                        Append to: {r.title}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Target Creator Studio Project</label>
                  <select
                    value={selectedCreatorProjectId}
                    onChange={(e) => setSelectedCreatorProjectId(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-100 focus:outline-none"
                  >
                    {creatorProjects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {mediaResult && (
              <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-6 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-slate-100 font-mono">{mediaResult.filename}</div>
                    <div className="text-xs text-slate-400 mt-0.5">{mediaResult.summary}</div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        void sendToResearch(
                          mediaResult.filename,
                          mediaResult.summary,
                          mediaResult.extracted_text
                        )
                      }
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/[0.1] bg-[#161C26] hover:bg-[#1E2634] text-xs text-slate-200 cursor-pointer"
                    >
                      <BookOpen className="w-3.5 h-3.5 text-blue-400" />
                      <span>Send to Research</span>
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void sendToCreator(mediaResult.filename, mediaResult.extracted_text)
                      }
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/[0.1] bg-[#161C26] hover:bg-[#1E2634] text-xs text-slate-200 cursor-pointer"
                    >
                      <Layers className="w-3.5 h-3.5 text-blue-400" />
                      <span>Send to Creator</span>
                    </button>
                  </div>
                </div>

                <textarea
                  readOnly
                  rows={12}
                  value={mediaResult.extracted_text}
                  className="w-full px-3.5 py-2.5 rounded-lg bg-[#0A0D12] border border-white/[0.08] font-mono text-xs text-slate-200 focus:outline-none"
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
