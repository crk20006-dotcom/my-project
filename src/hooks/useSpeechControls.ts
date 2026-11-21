import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from '../services/apiClient';

interface BrowserSpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface BrowserSpeechRecognitionResult {
  isFinal: boolean;
  length: number;
  [index: number]: BrowserSpeechRecognitionAlternative;
}

interface BrowserSpeechRecognitionEvent {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: BrowserSpeechRecognitionResult;
  };
}

interface BrowserSpeechRecognitionErrorEvent {
  error: string;
  message?: string;
}

interface BrowserSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onresult: ((ev: BrowserSpeechRecognitionEvent) => void) | null;
  onerror: ((ev: BrowserSpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type SpeechRecognitionCtor = new () => BrowserSpeechRecognition;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const win = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return win.SpeechRecognition || win.webkitSpeechRecognition || null;
}

export function stripMarkdownForSpeech(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' Code block omitted. ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[-*]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function fileToBase64(file: Blob): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export interface SpeechVoiceOption {
  name: string;
  lang: string;
  localService: boolean;
}

export function useSpeechControls(options: {
  language?: string;
  preferredVoice?: string;
  rate?: number;
  ttsEndpointConfigured?: boolean;
  onTranscriptFinal?: (text: string) => void;
}) {
  const [recordingState, setRecordingState] = useState<'idle' | 'listening' | 'transcribing'>('idle');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [speechError, setSpeechError] = useState<string | null>(null);

  const [voices, setVoices] = useState<SpeechVoiceOption[]>([]);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [ttsState, setTtsState] = useState<'idle' | 'playing' | 'paused'>('idle');

  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const audioObjectUrlRef = useRef<string | null>(null);

  const onTranscriptFinalRef = useRef(options.onTranscriptFinal);
  onTranscriptFinalRef.current = options.onTranscriptFinal;

  // Populate browser speechSynthesis voices
  useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const synth = window.speechSynthesis;

    const refreshVoices = () => {
      const list = synth.getVoices().map((v) => ({
        name: v.name,
        lang: v.lang,
        localService: v.localService,
      }));
      setVoices(list);
    };

    refreshVoices();
    synth.addEventListener?.('voiceschanged', refreshVoices);
    return () => {
      synth.removeEventListener?.('voiceschanged', refreshVoices);
    };
  }, []);

  const stopAudioOutput = useCallback(() => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    if (audioPlayerRef.current) {
      audioPlayerRef.current.pause();
      audioPlayerRef.current = null;
    }
    if (audioObjectUrlRef.current) {
      URL.revokeObjectURL(audioObjectUrlRef.current);
      audioObjectUrlRef.current = null;
    }
    setSpeakingId(null);
    setTtsState('idle');
  }, []);

  const stopRecording = useCallback(() => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // Ignore stop errors
      }
      recognitionRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop();
      } catch {
        // Ignore recorder stop errors
      }
    } else if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
      setRecordingState('idle');
    }
    setInterimTranscript('');
  }, []);

  // Ensure microphone and audio never keep running in background on unmount
  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {
          // Ignore
        }
        recognitionRef.current = null;
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try {
          mediaRecorderRef.current.stop();
        } catch {
          // Ignore
        }
      }
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;
      }
      stopAudioOutput();
    };
  }, [stopAudioOutput]);

  const startMediaRecorderFallback = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setSpeechError(
        'Voice recording is unavailable in this browser context. Check microphone permissions or upload an audio file.'
      );
      setRecordingState('idle');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      recordedChunksRef.current = [];

      const mimeType = MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : MediaRecorder.isTypeSupported('audio/ogg')
          ? 'audio/ogg'
          : '';
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) {
          recordedChunksRef.current.push(ev.data);
        }
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;
        mediaRecorderRef.current = null;

        const chunks = recordedChunksRef.current;
        recordedChunksRef.current = [];
        if (chunks.length === 0) {
          setRecordingState('idle');
          return;
        }

        const outMime = recorder.mimeType || 'audio/webm';
        const ext = outMime.includes('ogg') ? '.ogg' : outMime.includes('wav') ? '.wav' : '.webm';
        const blob = new Blob(chunks, { type: outMime });
        setRecordingState('transcribing');

        try {
          const base64 = await fileToBase64(blob);
          const result = await apiClient.transcribeAudio({
            filename: `mic_recording_${Date.now()}${ext}`,
            mimeType: outMime,
            dataBase64: base64,
            language: options.language || 'en-US',
          });
          if (result.ok && result.transcript.trim()) {
            onTranscriptFinalRef.current?.(result.transcript.trim());
          } else {
            setSpeechError(result.message || 'No local Whisper STT server responded.');
          }
        } catch (err) {
          setSpeechError(err instanceof Error ? err.message : 'Audio transcription failed.');
        } finally {
          setRecordingState('idle');
        }
      };

      recorder.start();
      setRecordingState('listening');
    } catch (err) {
      setRecordingState('idle');
      setSpeechError(
        err instanceof Error
          ? err.message
          : 'Microphone access denied or unavailable.'
      );
    }
  }, [options.language]);

  const startRecording = useCallback(async () => {
    setSpeechError(null);
    setInterimTranscript('');

    if (!navigator.mediaDevices?.getUserMedia) {
      setSpeechError('Microphone API is unavailable in this browser context.');
      return;
    }

    const RecognitionCtor = getSpeechRecognitionCtor();
    if (RecognitionCtor) {
      try {
        // Explicit permission check before opening Web Speech recognition
        const permStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        permStream.getTracks().forEach((t) => t.stop());

        const recognition = new RecognitionCtor();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = options.language || 'en-US';
        recognitionRef.current = recognition;

        recognition.onstart = () => {
          setRecordingState('listening');
        };

        recognition.onresult = (event) => {
          let interim = '';
          let finalChunk = '';
          for (let i = event.resultIndex; i < event.results.length; i += 1) {
            const res = event.results[i];
            const transcript = res[0]?.transcript || '';
            if (res.isFinal) {
              finalChunk += `${transcript} `;
            } else {
              interim += transcript;
            }
          }
          setInterimTranscript(interim.trim());
          if (finalChunk.trim()) {
            onTranscriptFinalRef.current?.(finalChunk.trim());
          }
        };

        recognition.onerror = (event) => {
          if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
            setSpeechError('Microphone permission was denied by the browser.');
          } else if (event.error === 'network') {
            recognitionRef.current = null;
            setSpeechError(
              'Browser Web Speech recognition requires online browser service; switching to local microphone audio clip capture...'
            );
            void startMediaRecorderFallback();
            return;
          } else if (event.error !== 'aborted' && event.error !== 'no-speech') {
            setSpeechError(`Speech recognition error: ${event.error}`);
          }
          setRecordingState('idle');
          setInterimTranscript('');
        };

        recognition.onend = () => {
          recognitionRef.current = null;
          setRecordingState((prev) => (prev === 'listening' ? 'idle' : prev));
          setInterimTranscript('');
        };

        recognition.start();
        return;
      } catch (err) {
        setSpeechError(
          err instanceof Error
            ? err.message
            : 'Microphone permission denied or speech recognition unavailable.'
        );
        setRecordingState('idle');
        return;
      }
    }

    await startMediaRecorderFallback();
  }, [options.language, startMediaRecorderFallback]);

  const toggleRecording = useCallback(() => {
    if (recordingState === 'listening') {
      stopRecording();
    } else if (recordingState === 'idle') {
      void startRecording();
    }
  }, [recordingState, startRecording, stopRecording]);

  const speak = useCallback(
    async (id: string, rawText: string) => {
      const cleanText = stripMarkdownForSpeech(rawText);
      if (!cleanText) return;

      stopAudioOutput();
      setSpeechError(null);
      setSpeakingId(id);

      // Prefer local Piper TTS HTTP server if configured in Settings
      if (options.ttsEndpointConfigured) {
        try {
          const synthRes = await apiClient.synthesizeSpeech({
            text: cleanText,
            voice: options.preferredVoice,
            speed: options.rate ?? 1.0,
          });
          if (synthRes.ok && synthRes.audioBase64) {
            const binary = atob(synthRes.audioBase64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i += 1) {
              bytes[i] = binary.charCodeAt(i);
            }
            const blob = new Blob([bytes], { type: synthRes.mimeType || 'audio/wav' });
            const url = URL.createObjectURL(blob);
            audioObjectUrlRef.current = url;
            const audio = new Audio(url);
            audio.playbackRate = Math.min(2, Math.max(0.5, options.rate ?? 1.0));
            audioPlayerRef.current = audio;
            audio.onended = () => stopAudioOutput();
            audio.onerror = () => {
              setSpeechError('Unable to play synthesized local audio.');
              stopAudioOutput();
            };
            await audio.play();
            setTtsState('playing');
            return;
          }
        } catch {
          // Fall back cleanly to browser Web SpeechSynthesis
        }
      }

      if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
        setSpeakingId(null);
        setTtsState('idle');
        setSpeechError('Text-to-speech is not supported in this browser.');
        return;
      }

      const synth = window.speechSynthesis;
      synth.cancel();

      const utterance = new SpeechSynthesisUtterance(cleanText.slice(0, 3500));
      utterance.rate = Math.min(2.0, Math.max(0.5, options.rate ?? 1.0));
      if (options.language) {
        utterance.lang = options.language;
      }
      if (options.preferredVoice) {
        const match = synth.getVoices().find((v) => v.name === options.preferredVoice);
        if (match) utterance.voice = match;
      }

      utterance.onend = () => {
        setSpeakingId(null);
        setTtsState('idle');
      };
      utterance.onerror = () => {
        setSpeakingId(null);
        setTtsState('idle');
      };

      setTtsState('playing');
      synth.speak(utterance);
    },
    [options.language, options.preferredVoice, options.rate, options.ttsEndpointConfigured, stopAudioOutput]
  );

  const pauseOrResumeSpeech = useCallback(() => {
    if (audioPlayerRef.current) {
      if (ttsState === 'playing') {
        audioPlayerRef.current.pause();
        setTtsState('paused');
      } else if (ttsState === 'paused') {
        void audioPlayerRef.current.play();
        setTtsState('playing');
      }
      return;
    }

    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      const synth = window.speechSynthesis;
      if (ttsState === 'playing') {
        synth.pause();
        setTtsState('paused');
      } else if (ttsState === 'paused') {
        synth.resume();
        setTtsState('playing');
      }
    }
  }, [ttsState]);

  return {
    recordingState,
    interimTranscript,
    speechError,
    setSpeechError,
    toggleRecording,
    stopRecording,
    voices,
    speakingId,
    ttsState,
    speak,
    pauseOrResumeSpeech,
    stopAudioOutput,
    webSpeechSupported: Boolean(getSpeechRecognitionCtor()),
  };
}
