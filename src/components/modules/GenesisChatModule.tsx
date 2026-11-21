import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  BookmarkPlus,
  Check,
  Copy,
  FileText,
  History,
  Image as ImageIcon,
  Loader2,
  Mic,
  MicOff,
  Paperclip,
  Pause,
  Pencil,
  Play,
  Plus,
  Send,
  Square,
  Trash2,
  Volume2,
  X,
} from 'lucide-react';
import { fileToBase64, useSpeechControls } from '../../hooks/useSpeechControls';
import { apiClient } from '../../services/apiClient';
import type {
  AttachmentMeta,
  Conversation,
  MemoryCategory,
  Message,
  SystemSettings,
} from '../../types/genesis';
import { MarkdownRenderer } from '../common/MarkdownRenderer';

interface GenesisChatModuleProps {
  settings: SystemSettings | null;
}

const MULTIMODAL_EXT_SET = new Set([
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
]);

function isSafeImageDataUrl(url: string | undefined): url is string {
  return Boolean(
    url &&
      url.length <= 2_500_000 &&
      /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(url)
  );
}

export const GenesisChatModule: React.FC<GenesisChatModuleProps> = ({ settings }) => {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingConvs, setLoadingConvs] = useState(true);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [sending, setSending] = useState(false);
  const [processingFiles, setProcessingFiles] = useState(false);
  const [streamingContent, setStreamingContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<AttachmentMeta[]>([]);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');

  const [saveMemMsgId, setSaveMemMsgId] = useState<string | null>(null);
  const [saveMemTitle, setSaveMemTitle] = useState('');
  const [saveMemCategory, setSaveMemCategory] = useState<MemoryCategory>('fact');
  const [saveMemContent, setSaveMemContent] = useState('');
  const [savedMemMsgId, setSavedMemMsgId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const speech = useSpeechControls({
    language: settings?.voice_stt_language || 'en-US',
    preferredVoice: settings?.voice_tts_voice || '',
    rate: settings?.voice_tts_rate ?? 1.0,
    ttsEndpointConfigured: Boolean(settings?.voice_tts_endpoint_url),
    onTranscriptFinal: (text) => {
      setInput((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text));
    },
  });

  const configuredModelId =
    settings?.active_model_id ||
    (settings?.prefer_local_inference ? 'local-inference-http' : 'genesis-core-placeholder');

  const loadConversations = async (selectFirst = true, showLoading = true) => {
    if (showLoading) {
      setLoadingConvs(true);
    }
    try {
      const list = await apiClient.listConversations();
      setConversations(list);
      if (selectFirst && list.length > 0 && !activeId) {
        setActiveId(list[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load conversations.');
    } finally {
      if (showLoading) {
        setLoadingConvs(false);
      }
    }
  };

  useEffect(() => {
    void loadConversations(true, true);
    return () => {
      abortControllerRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    setLoadingMsgs(true);
    setError(null);
    speech.stopAudioOutput();
    apiClient
      .listMessages(activeId)
      .then((msgs) => {
        if (!cancelled) setMessages(msgs);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load messages.');
      })
      .finally(() => {
        if (!cancelled) setLoadingMsgs(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, sending, streamingContent]);

  const activeConversation = conversations.find((c) => c.id === activeId) || null;
  const effectiveModelId = activeConversation?.model_id || configuredModelId;

  const handleNewConversation = async () => {
    setError(null);
    speech.stopAudioOutput();
    try {
      const created = await apiClient.createConversation({
        title: 'New Conversation',
        model_id: configuredModelId,
      });
      setConversations((prev) => [created, ...prev]);
      setActiveId(created.id);
      setHistoryOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create conversation.');
    }
  };

  const handleRenameSubmit = async (id: string) => {
    if (!editingTitle.trim()) {
      setEditingId(null);
      return;
    }
    try {
      const updated = await apiClient.renameConversation(id, editingTitle.trim());
      setConversations((prev) => prev.map((c) => (c.id === id ? updated : c)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename conversation.');
    } finally {
      setEditingId(null);
    }
  };

  const handleDeleteConversation = async (id: string) => {
    try {
      await apiClient.deleteConversation(id);
      const remaining = conversations.filter((c) => c.id !== id);
      setConversations(remaining);
      if (activeId === id) {
        setActiveId(remaining[0]?.id || null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete conversation.');
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setError(null);
    setProcessingFiles(true);

    try {
      for (const file of Array.from(files)) {
        const dotIdx = file.name.lastIndexOf('.');
        const ext = dotIdx >= 0 ? file.name.slice(dotIdx).toLowerCase() : '';

        if (MULTIMODAL_EXT_SET.has(ext)) {
          const base64 = await fileToBase64(file);
          const processed = await apiClient.processMultimodalFile({
            filename: file.name,
            mimeType: file.type || 'application/octet-stream',
            encoding: 'base64',
            data: base64,
            ocr_enabled: settings?.ocr_enabled ?? true,
            language: settings?.voice_stt_language || 'en-US',
          });
          setAttachments((prev) => [...prev, processed.attachment]);
        } else {
          let previewText: string | undefined;
          if (file.size <= 128 * 1024 && !file.type.startsWith('audio/')) {
            previewText = await file.text();
          }
          const validated = await apiClient.validateAttachment({
            name: file.name,
            size: file.size,
            mimeType: file.type || 'application/octet-stream',
            previewText: previewText?.slice(0, 3800),
          });
          setAttachments((prev) => [...prev, { ...validated, mediaKind: 'text' }]);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'File upload or extraction failed.');
    } finally {
      setProcessingFiles(false);
      e.target.value = '';
    }
  };

  const handleStopGeneration = () => {
    abortControllerRef.current?.abort();
  };

  const handleSend = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const trimmed = input.trim();
    if ((!trimmed && attachments.length === 0) || sending || processingFiles) return;

    if (speech.recordingState === 'listening') {
      speech.stopRecording();
    }

    setError(null);
    setSending(true);
    setStreamingContent('');

    const controller = new AbortController();
    abortControllerRef.current = controller;
    let targetId = activeId;

    try {
      if (!targetId) {
        const created = await apiClient.createConversation({
          title: 'New Conversation',
          model_id: configuredModelId,
        });
        setConversations((prev) => [created, ...prev]);
        targetId = created.id;
        setActiveId(created.id);
      }

      const payloadAttachments = [...attachments];
      setInput('');
      setAttachments([]);

      let completedNormally = false;
      const assistantHolder: { message: Message | null } = { message: null };

      await apiClient.sendMessageStream(
        targetId,
        {
          content: trimmed,
          attachments: payloadAttachments,
          model_id: effectiveModelId,
          temperature: settings?.inference_temperature ?? 0.2,
          max_tokens: settings?.inference_max_tokens ?? 512,
          timeout_ms: settings?.inference_timeout_ms ?? 30000,
          use_memory: settings?.chat_use_memory ?? true,
          use_knowledge: settings?.chat_use_knowledge ?? true,
        },
        {
          onStart: (data) => {
            setMessages((prev) => [...prev, data.user_message]);
          },
          onDelta: (data) => {
            setStreamingContent((prev) => (prev ?? '') + data.delta);
          },
          onDone: (data) => {
            completedNormally = true;
            assistantHolder.message = data.assistant_message;
            setStreamingContent(null);
            setMessages((prev) => [...prev, data.assistant_message]);
          },
          onError: (data) => {
            completedNormally = true;
            setStreamingContent(null);
            if (data.assistant_message) {
              assistantHolder.message = data.assistant_message;
              setMessages((prev) => [...prev, data.assistant_message!]);
            }
            if (data.error) {
              setError(data.error);
            }
          },
        },
        controller.signal
      );

      if (!completedNormally && targetId) {
        const synced = await apiClient.listMessages(targetId);
        setMessages(synced);
      } else if (settings?.voice_auto_speak && assistantHolder.message) {
        void speech.speak(assistantHolder.message.id, assistantHolder.message.content);
      }
      await loadConversations(false, false);
    } catch (err) {
      const isAbort = err instanceof DOMException && err.name === 'AbortError';
      if (isAbort && targetId) {
        await new Promise((r) => setTimeout(r, 150));
        try {
          const synced = await apiClient.listMessages(targetId);
          setMessages(synced);
          await loadConversations(false, false);
        } catch {
          // Ignore sync failure on unmount
        }
      } else {
        setError(err instanceof Error ? err.message : 'Failed to dispatch message.');
      }
    } finally {
      abortControllerRef.current = null;
      setStreamingContent(null);
      setSending(false);
    }
  };

  const handleCopyMessage = async (msg: Message) => {
    try {
      await navigator.clipboard.writeText(msg.content);
      setCopiedMsgId(msg.id);
      setTimeout(() => setCopiedMsgId(null), 1600);
    } catch {
      setCopiedMsgId(null);
    }
  };

  const openSaveMemoryPrompt = (msg: Message) => {
    setError(null);
    setSaveMemMsgId(msg.id);
    const defaultTitle =
      activeConversation?.title && activeConversation.title !== 'New Conversation'
        ? activeConversation.title
        : msg.content.slice(0, 48).replace(/\s+/g, ' ').trim() || 'Saved Chat Fact';
    setSaveMemTitle(defaultTitle);
    setSaveMemCategory('fact');
    setSaveMemContent(msg.content.slice(0, 1200));
  };

  const handleConfirmSaveMemory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!saveMemMsgId) return;
    setError(null);
    try {
      await apiClient.createMemory({
        namespace: 'semantic',
        category: saveMemCategory,
        title: saveMemTitle,
        content: saveMemContent,
        tags: ['chat-approved'],
        importance: 3,
        approved: true,
        source_conversation_id: activeId,
      });
      setSavedMemMsgId(saveMemMsgId);
      setSaveMemMsgId(null);
      setTimeout(() => setSavedMemMsgId(null), 2400);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save memory.');
    }
  };

  const historyPanel = (
    <div className="flex flex-col h-full bg-[#0D1219] border-r border-white/[0.08]">
      <div className="p-3 border-b border-white/[0.06] flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-400">Conversations</span>
        <button
          type="button"
          onClick={handleNewConversation}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>New Chat</span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {loadingConvs ? (
          <div className="space-y-2 p-2">
            <div className="h-9 rounded-lg bg-white/[0.04]" />
            <div className="h-9 rounded-lg bg-white/[0.04]" />
          </div>
        ) : conversations.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-slate-500">
            No conversations yet. Start a new thread.
          </div>
        ) : (
          conversations.map((conv) => {
            const isSelected = conv.id === activeId;
            return (
              <div
                key={conv.id}
                className={`group rounded-lg transition-colors ${
                  isSelected
                    ? 'bg-white/[0.07] text-slate-100'
                    : 'text-slate-400 hover:bg-white/[0.04] hover:text-slate-200'
                }`}
              >
                {editingId === conv.id ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void handleRenameSubmit(conv.id);
                    }}
                    className="p-1.5"
                  >
                    <input
                      type="text"
                      value={editingTitle}
                      onChange={(e) => setEditingTitle(e.target.value)}
                      onBlur={() => void handleRenameSubmit(conv.id)}
                      autoFocus
                      className="w-full px-2 py-1 text-xs rounded bg-[#0A0D12] border border-blue-500 text-slate-100 focus:outline-none"
                    />
                  </form>
                ) : (
                  <div className="flex items-center justify-between gap-1 px-2.5 py-2">
                    <button
                      type="button"
                      onClick={() => {
                        setActiveId(conv.id);
                        setHistoryOpen(false);
                      }}
                      className="flex-1 text-left min-w-0 cursor-pointer"
                    >
                      <div className="text-[13px] font-medium truncate">{conv.title}</div>
                      <div className="text-[11px] text-slate-500 tabular-nums mt-0.5">
                        {new Date(conv.updated_at).toLocaleDateString()} · {conv.message_count ?? 0} msgs
                      </div>
                    </button>
                    <div className="flex items-center gap-0.5 opacity-100 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity shrink-0">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(conv.id);
                          setEditingTitle(conv.title);
                        }}
                        aria-label="Rename conversation"
                        className="p-1.5 rounded text-slate-400 hover:text-slate-100 hover:bg-white/[0.08] cursor-pointer"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDeleteConversation(conv.id)}
                        aria-label="Delete conversation"
                        className="p-1.5 rounded text-slate-400 hover:text-red-400 hover:bg-red-500/10 cursor-pointer"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );

  const visibleError = error || speech.speechError;

  return (
    <div className="flex h-full min-h-0 relative">
      {/* Desktop Conversation List */}
      <div className="hidden md:block w-[264px] shrink-0 h-full">{historyPanel}</div>

      {/* Mobile Conversation Drawer */}
      {historyOpen && (
        <div className="fixed inset-0 z-40 md:hidden flex">
          <div className="fixed inset-0 bg-black/70" onClick={() => setHistoryOpen(false)} />
          <div className="relative w-[280px] max-w-[85vw] h-full z-10">{historyPanel}</div>
        </div>
      )}

      {/* Minimal Main Conversation Workspace */}
      <div className="flex-1 flex flex-col min-w-0 h-full bg-[#0A0D12]">
        <div className="px-4 lg:px-6 py-2.5 border-b border-white/[0.08] bg-[#10151E] shrink-0 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              type="button"
              onClick={() => setHistoryOpen(true)}
              className="md:hidden inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-white/[0.1] bg-[#161C26] text-xs text-slate-200 cursor-pointer shrink-0"
            >
              <History className="w-3.5 h-3.5" />
              <span>Conversations</span>
            </button>
            <span className="text-xs font-medium text-slate-200 truncate">
              {activeConversation?.title || 'New Conversation'}
            </span>
          </div>

          <button
            type="button"
            onClick={handleNewConversation}
            className="md:hidden inline-flex items-center gap-1 text-xs font-medium text-blue-400 cursor-pointer shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>New</span>
          </button>
        </div>

        {/* Message Stream */}
        <div className="flex-1 overflow-y-auto px-4 lg:px-8 py-6">
          <div className="max-w-3xl mx-auto space-y-6">
            {loadingMsgs ? (
              <div className="space-y-4">
                <div className="h-24 rounded-xl bg-[#11161F] border border-white/[0.06]" />
                <div className="h-32 rounded-xl bg-[#11161F] border border-white/[0.06]" />
              </div>
            ) : messages.length === 0 && streamingContent === null ? (
              <div className="py-16 text-center border border-white/[0.08] rounded-xl bg-[#11161F] p-8">
                <h2 className="font-display text-lg font-semibold text-slate-100">
                  Genesis Chat
                </h2>
                <p className="text-sm text-slate-400 max-w-md mx-auto mt-2 leading-relaxed">
                  Type or speak a message, or attach images, documents, and audio below. Technical voice and model preferences are in System Settings and Model Manager.
                </p>
              </div>
            ) : (
              <>
                {messages.map((msg) => {
                  const isUser = msg.role === 'user';
                  const isSpeakingThis = speech.speakingId === msg.id;

                  return (
                    <article
                      key={msg.id}
                      className={`rounded-xl border p-4 lg:p-5 ${
                        isUser
                          ? 'bg-[#131923] border-white/[0.1]'
                          : 'bg-[#0F141C] border-white/[0.07]'
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3 mb-2.5 pb-2 border-b border-white/[0.06]">
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span className={`font-semibold ${isUser ? 'text-blue-300' : 'text-slate-200'}`}>
                            {isUser ? settings?.operator_name || 'Local Operator' : 'Genesis'}
                          </span>
                          <span className="text-slate-600" aria-hidden="true">·</span>
                          <span className="text-slate-500 tabular-nums">
                            {new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                          {!isUser && msg.metadata?.partial && (
                            <>
                              <span className="text-slate-600" aria-hidden="true">·</span>
                              <span className="text-amber-300 font-medium">Stopped</span>
                            </>
                          )}
                        </div>

                        <div className="flex items-center gap-1">
                          {!isUser && (
                            <>
                              {isSpeakingThis ? (
                                <>
                                  <button
                                    type="button"
                                    onClick={speech.pauseOrResumeSpeech}
                                    className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-blue-300 bg-blue-500/10 hover:bg-blue-500/20 transition-colors cursor-pointer"
                                    title={speech.ttsState === 'paused' ? 'Resume speech' : 'Pause speech'}
                                  >
                                    {speech.ttsState === 'paused' ? (
                                      <Play className="w-3.5 h-3.5" />
                                    ) : (
                                      <Pause className="w-3.5 h-3.5" />
                                    )}
                                    <span>{speech.ttsState === 'paused' ? 'Resume' : 'Pause'}</span>
                                  </button>
                                  <button
                                    type="button"
                                    onClick={speech.stopAudioOutput}
                                    className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-red-300 hover:bg-red-500/10 transition-colors cursor-pointer"
                                    title="Stop speech"
                                  >
                                    <Square className="w-3 h-3 fill-current" />
                                    <span>Stop</span>
                                  </button>
                                </>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => void speech.speak(msg.id, msg.content)}
                                  className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-slate-400 hover:text-slate-100 hover:bg-white/[0.06] transition-colors cursor-pointer"
                                  title="Read response aloud"
                                >
                                  <Volume2 className="w-3.5 h-3.5" />
                                  <span>Listen</span>
                                </button>
                              )}
                            </>
                          )}

                          <button
                            type="button"
                            onClick={() => openSaveMemoryPrompt(msg)}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-slate-400 hover:text-blue-300 hover:bg-blue-500/10 transition-colors cursor-pointer"
                          >
                            {savedMemMsgId === msg.id ? (
                              <Check className="w-3.5 h-3.5 text-emerald-400" />
                            ) : (
                              <BookmarkPlus className="w-3.5 h-3.5" />
                            )}
                            <span>{savedMemMsgId === msg.id ? 'Saved' : 'Save Memory'}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleCopyMessage(msg)}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-slate-400 hover:text-slate-100 hover:bg-white/[0.06] transition-colors cursor-pointer"
                          >
                            {copiedMsgId === msg.id ? (
                              <Check className="w-3.5 h-3.5 text-emerald-400" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                            <span>{copiedMsgId === msg.id ? 'Copied' : 'Copy'}</span>
                          </button>
                        </div>
                      </div>

                      {saveMemMsgId === msg.id && (
                        <form
                          onSubmit={handleConfirmSaveMemory}
                          className="mb-3 p-3 rounded-lg bg-[#0A0D12] border border-blue-500/30 space-y-2.5 text-xs"
                        >
                          <div className="flex items-center justify-between text-blue-300 font-medium">
                            <span>Approve & Save to User Memory</span>
                            <button
                              type="button"
                              onClick={() => setSaveMemMsgId(null)}
                              className="text-slate-400 hover:text-white cursor-pointer"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                            <input
                              type="text"
                              required
                              value={saveMemTitle}
                              onChange={(e) => setSaveMemTitle(e.target.value)}
                              placeholder="Memory title"
                              className="sm:col-span-2 px-2.5 py-1.5 rounded bg-[#11161F] border border-white/[0.1] text-slate-100 focus:outline-none"
                            />
                            <select
                              value={saveMemCategory}
                              onChange={(e) => setSaveMemCategory(e.target.value as MemoryCategory)}
                              className="px-2.5 py-1.5 rounded bg-[#11161F] border border-white/[0.1] text-slate-100 focus:outline-none"
                            >
                              <option value="fact">Fact</option>
                              <option value="preference">Preference</option>
                              <option value="instruction">Instruction</option>
                              <option value="constraint">Constraint</option>
                            </select>
                          </div>
                          <textarea
                            rows={2}
                            required
                            value={saveMemContent}
                            onChange={(e) => setSaveMemContent(e.target.value)}
                            className="w-full px-2.5 py-1.5 rounded bg-[#11161F] border border-white/[0.1] text-slate-100 focus:outline-none"
                          />
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => setSaveMemMsgId(null)}
                              className="px-2.5 py-1 rounded border border-white/[0.1] text-slate-300 cursor-pointer"
                            >
                              Cancel
                            </button>
                            <button
                              type="submit"
                              className="px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white font-medium cursor-pointer"
                            >
                              Approve & Save
                            </button>
                          </div>
                        </form>
                      )}

                      {isUser ? (
                        <p className="text-[14.5px] leading-relaxed text-slate-200 whitespace-pre-wrap">
                          {msg.content}
                        </p>
                      ) : (
                        <MarkdownRenderer content={msg.content} />
                      )}

                      {msg.attachments && msg.attachments.length > 0 && (
                        <div className="mt-3 pt-3 border-t border-white/[0.06] flex flex-wrap gap-3">
                          {msg.attachments.map((att) => (
                            <div
                              key={att.id}
                              className="inline-flex items-center gap-2.5 px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.08] text-xs text-slate-300"
                            >
                              {isSafeImageDataUrl(att.imageDataUrl) ? (
                                <img
                                  src={att.imageDataUrl}
                                  alt={att.name}
                                  className="w-12 h-12 rounded object-cover border border-white/[0.1]"
                                />
                              ) : (
                                <FileText className="w-4 h-4 text-blue-400 shrink-0" />
                              )}
                              <div className="min-w-0">
                                <div className="font-mono truncate max-w-[200px]">{att.name}</div>
                                <div className="text-[11px] text-slate-500 tabular-nums">
                                  {(att.size / 1024).toFixed(1)} KB
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </article>
                  );
                })}

                {sending && streamingContent !== null && (
                  <article className="rounded-xl border border-blue-500/30 bg-[#0F141C] p-4 lg:p-5">
                    <div className="flex items-center justify-between gap-3 mb-2.5 pb-2 border-b border-white/[0.06]">
                      <span className="text-xs font-semibold text-blue-300">Genesis</span>
                      <span className="text-[11px] text-slate-400">Responding...</span>
                    </div>
                    {streamingContent ? (
                      <MarkdownRenderer content={streamingContent} />
                    ) : (
                      <div className="text-xs text-slate-400">Awaiting response...</div>
                    )}
                  </article>
                )}
              </>
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Composer */}
        <div className="border-t border-white/[0.08] bg-[#0C1017] px-4 lg:px-8 py-4 shrink-0">
          <div className="max-w-3xl mx-auto">
            {visibleError && (
              <div className="mb-3 flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-lg bg-red-500/10 border border-red-500/25 text-xs text-red-300">
                <div className="flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
                  <span>{visibleError}</span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    speech.setSpeechError(null);
                  }}
                  className="text-red-300 hover:text-white cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {speech.recordingState !== 'idle' && (
              <div className="mb-2.5 flex items-center justify-between gap-3 px-3.5 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-200">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse shrink-0" />
                  <span className="font-medium shrink-0">
                    {speech.recordingState === 'listening' ? 'Microphone active — listening' : 'Transcribing audio...'}
                  </span>
                  {speech.interimTranscript && (
                    <span className="text-slate-300 truncate italic">
                      "{speech.interimTranscript}"
                    </span>
                  )}
                </div>
                {speech.recordingState === 'listening' && (
                  <button
                    type="button"
                    onClick={speech.stopRecording}
                    className="px-2.5 py-1 rounded bg-red-600 hover:bg-red-500 text-white font-medium shrink-0 cursor-pointer"
                  >
                    Stop Mic
                  </button>
                )}
              </div>
            )}

            {attachments.length > 0 && (
              <div className="mb-2.5 flex flex-wrap gap-2">
                {attachments.map((att) => (
                  <div
                    key={att.id}
                    className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-[#141A24] border border-white/[0.1] text-xs text-slate-200"
                  >
                    {isSafeImageDataUrl(att.imageDataUrl) ? (
                      <img
                        src={att.imageDataUrl}
                        alt={att.name}
                        className="w-8 h-8 rounded object-cover border border-white/[0.1]"
                      />
                    ) : att.mediaKind === 'image' ? (
                      <ImageIcon className="w-3.5 h-3.5 text-blue-400" />
                    ) : (
                      <FileText className="w-3.5 h-3.5 text-blue-400" />
                    )}
                    <div className="min-w-0">
                      <div className="font-mono truncate max-w-[160px]">{att.name}</div>
                      <div className="text-[11px] text-slate-500 tabular-nums">
                        {(att.size / 1024).toFixed(1)} KB
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setAttachments((prev) => prev.filter((a) => a.id !== att.id))}
                      aria-label={`Remove ${att.name}`}
                      className="text-slate-400 hover:text-white cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <form
              onSubmit={handleSend}
              className="rounded-xl border border-white/[0.1] bg-[#11161F] focus-within:border-blue-500/60 transition-colors p-2.5"
            >
              <textarea
                rows={2}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (!sending && !processingFiles) void handleSend();
                  }
                }}
                placeholder="Message Genesis (Shift+Enter for new line)..."
                className="w-full bg-transparent resize-none px-2 py-1 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none"
              />
              <div className="flex items-center justify-between gap-3 pt-2 border-t border-white/[0.06] mt-1">
                <div className="flex items-center gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept=".png,.jpg,.jpeg,.webp,.pdf,.docx,.txt,.md,.json,.csv,.py,.ts,.tsx,.js,.yaml,.yml,.log,.wav,.mp3,.ogg,.webm,.m4a"
                    onChange={handleFileSelect}
                    className="hidden"
                  />
                  <button
                    type="button"
                    disabled={sending || processingFiles}
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/[0.08] bg-[#161C26] hover:bg-[#1D2532] disabled:opacity-40 text-xs font-medium text-slate-300 transition-colors cursor-pointer"
                  >
                    {processingFiles ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-400" />
                    ) : (
                      <Paperclip className="w-3.5 h-3.5" />
                    )}
                    <span>{processingFiles ? 'Processing...' : 'Attach'}</span>
                  </button>

                  <button
                    type="button"
                    disabled={sending || speech.recordingState === 'transcribing'}
                    onClick={speech.toggleRecording}
                    aria-label={speech.recordingState === 'listening' ? 'Stop voice recording' : 'Start voice input'}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors cursor-pointer ${
                      speech.recordingState === 'listening'
                        ? 'border-red-500/40 bg-red-500/15 text-red-200 hover:bg-red-500/25'
                        : 'border-white/[0.08] bg-[#161C26] hover:bg-[#1D2532] text-slate-300'
                    }`}
                  >
                    {speech.recordingState === 'listening' ? (
                      <MicOff className="w-3.5 h-3.5 text-red-400" />
                    ) : (
                      <Mic className="w-3.5 h-3.5" />
                    )}
                    <span>
                      {speech.recordingState === 'listening'
                        ? 'Listening'
                        : speech.recordingState === 'transcribing'
                          ? 'Transcribing...'
                          : 'Voice'}
                    </span>
                  </button>
                </div>

                {sending ? (
                  <button
                    type="button"
                    onClick={handleStopGeneration}
                    className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-xs font-medium text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Square className="w-3 h-3 fill-current" />
                    <span>Stop</span>
                  </button>
                ) : (
                  <button
                    type="submit"
                    disabled={(!input.trim() && attachments.length === 0) || processingFiles}
                    className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-xs font-medium text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>Send</span>
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
};

