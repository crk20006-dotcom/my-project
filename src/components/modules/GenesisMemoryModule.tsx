import React, { useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  Check,
  Database,
  Download,
  Eye,
  FileUp,
  History,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { apiClient } from '../../services/apiClient';
import type {
  ConversationSearchHit,
  KnowledgeDocument,
  MemoryCategory,
  MemoryEntry,
  MemoryNamespace,
  MemorySystemStatus,
  RetrievalQueryResponse,
} from '../../types/genesis';

type MemoryTab = 'memory' | 'knowledge' | 'conversations';

export const GenesisMemoryModule: React.FC = () => {
  const [activeTab, setActiveTab] = useState<MemoryTab>('memory');
  const [status, setStatus] = useState<MemorySystemStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // User Memory state
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [namespaceFilter, setNamespaceFilter] = useState<'all' | MemoryNamespace>('all');
  const [categoryFilter, setCategoryFilter] = useState<'all' | MemoryCategory>('all');
  const [memSearch, setMemSearch] = useState('');
  const [loadingMem, setLoadingMem] = useState(true);

  const [memTitle, setMemTitle] = useState('');
  const [memNamespace, setMemNamespace] = useState<MemoryNamespace>('semantic');
  const [memCategory, setMemCategory] = useState<MemoryCategory>('fact');
  const [memContent, setMemContent] = useState('');
  const [memTagsText, setMemTagsText] = useState('');
  const [memImportance, setMemImportance] = useState(3);
  const [memSourceConvId, setMemSourceConvId] = useState<string | null>(null);

  const [selectedMem, setSelectedMem] = useState<MemoryEntry | null>(null);
  const [editingMemId, setEditingMemId] = useState<string | null>(null);
  const [editMemTitle, setEditMemTitle] = useState('');
  const [editMemCategory, setEditMemCategory] = useState<MemoryCategory>('fact');
  const [editMemNamespace, setEditMemNamespace] = useState<MemoryNamespace>('semantic');
  const [editMemContent, setEditMemContent] = useState('');
  const [editMemTagsText, setEditMemTagsText] = useState('');
  const [editMemImportance, setEditMemImportance] = useState(3);

  // Knowledge Base state
  const [docs, setDocs] = useState<KnowledgeDocument[]>([]);
  const [kbSearch, setKbSearch] = useState('');
  const [loadingKb, setLoadingKb] = useState(true);
  const [kbTitle, setKbTitle] = useState('');
  const [kbSourceType, setKbSourceType] = useState('note');
  const [kbSourceName, setKbSourceName] = useState('');
  const [kbContent, setKbContent] = useState('');
  const [kbTagsText, setKbTagsText] = useState('');
  const [selectedDocDetail, setSelectedDocDetail] = useState<KnowledgeDocument | null>(null);
  const [editingDocId, setEditingDocId] = useState<string | null>(null);
  const [editDocTitle, setEditDocTitle] = useState('');
  const [editDocContent, setEditDocContent] = useState('');
  const [editDocTagsText, setEditDocTagsText] = useState('');
  const kbFileRef = useRef<HTMLInputElement | null>(null);

  // Retrieval Inspector state
  const [retrievalQuery, setRetrievalQuery] = useState('');
  const [retrievalResult, setRetrievalResult] = useState<RetrievalQueryResponse | null>(null);
  const [retrievalLoading, setRetrievalLoading] = useState(false);

  // Conversation History Search state
  const [convSearch, setConvSearch] = useState('');
  const [convHits, setConvHits] = useState<ConversationSearchHit[]>([]);
  const [convLoading, setConvLoading] = useState(false);
  const [convSearchedOnce, setConvSearchedOnce] = useState(false);

  const refreshStatus = async () => {
    try {
      const s = await apiClient.getMemoryStatus();
      setStatus(s);
    } catch {
      // Non-fatal status indicator refresh
    }
  };

  const loadMemories = async (
    ns = namespaceFilter,
    cat = categoryFilter,
    q = memSearch
  ) => {
    setLoadingMem(true);
    try {
      const list = await apiClient.listMemory({ namespace: ns, category: cat, q });
      setEntries(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load user memories.');
    } finally {
      setLoadingMem(false);
    }
  };

  const loadKnowledge = async (q = kbSearch) => {
    setLoadingKb(true);
    try {
      const list = await apiClient.listKnowledge({ q });
      setDocs(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load knowledge documents.');
    } finally {
      setLoadingKb(false);
    }
  };

  useEffect(() => {
    void refreshStatus();
    void loadKnowledge('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void loadMemories(namespaceFilter, categoryFilter, memSearch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namespaceFilter, categoryFilter]);

  const handleCreateMemory = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const tags = memTagsText
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      const created = await apiClient.createMemory({
        namespace: memNamespace,
        category: memCategory,
        title: memTitle,
        content: memContent,
        tags,
        importance: memImportance,
        approved: true,
        source_conversation_id: memSourceConvId,
      });
      setEntries((prev) => [created, ...prev]);
      setMemTitle('');
      setMemContent('');
      setMemTagsText('');
      setMemSourceConvId(null);
      setNotice(`Saved approved user memory "${created.title}".`);
      void refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to store memory.');
    }
  };

  const startEditMemory = (entry: MemoryEntry) => {
    setEditingMemId(entry.id);
    setEditMemTitle(entry.title);
    setEditMemNamespace(entry.namespace);
    setEditMemCategory(entry.category || 'fact');
    setEditMemContent(entry.content);
    setEditMemTagsText(entry.tags.join(', '));
    setEditMemImportance(entry.importance);
  };

  const handleSaveMemoryEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingMemId) return;
    setError(null);
    try {
      const updated = await apiClient.updateMemory(editingMemId, {
        title: editMemTitle,
        namespace: editMemNamespace,
        category: editMemCategory,
        content: editMemContent,
        tags: editMemTagsText
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        importance: editMemImportance,
      });
      setEntries((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      if (selectedMem?.id === updated.id) setSelectedMem(updated);
      setEditingMemId(null);
      setNotice(`Updated memory "${updated.title}".`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update memory.');
    }
  };

  const handleDeleteMemory = async (id: string) => {
    setError(null);
    try {
      await apiClient.deleteMemory(id);
      setEntries((prev) => prev.filter((e) => e.id !== id));
      if (selectedMem?.id === id) setSelectedMem(null);
      void refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete memory.');
    }
  };

  const handleKbFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      if (file.size > 200 * 1024) {
        setError('Knowledge file import is limited to 200 KB plain-text files.');
        e.target.value = '';
        return;
      }
      const text = await file.text();
      if (!kbTitle.trim()) {
        setKbTitle(file.name.replace(/\.[^.]+$/, ''));
      }
      setKbSourceName(file.name);
      setKbSourceType(file.name.endsWith('.md') ? 'markdown' : 'document');
      setKbContent(text);
    } catch {
      setError('Could not read selected file as UTF-8 text.');
    }
    e.target.value = '';
  };

  const handleCreateKnowledge = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const tags = kbTagsText
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      const created = await apiClient.createKnowledge({
        title: kbTitle,
        source_type: kbSourceType,
        source_name: kbSourceName,
        content: kbContent,
        tags,
      });
      setDocs((prev) => [created, ...prev]);
      setKbTitle('');
      setKbSourceName('');
      setKbContent('');
      setKbTagsText('');
      setNotice(
        `Indexed knowledge document "${created.title}" across ${created.chunk_count} searchable chunk(s).`
      );
      void refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to index knowledge document.');
    }
  };

  const handleInspectDocument = async (docId: string) => {
    setError(null);
    try {
      const detail = await apiClient.getKnowledgeDocument(docId);
      setSelectedDocDetail(detail);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to inspect document chunks.');
    }
  };

  const handleSaveDocEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingDocId) return;
    setError(null);
    try {
      const updated = await apiClient.updateKnowledge(editingDocId, {
        title: editDocTitle,
        content: editDocContent,
        tags: editDocTagsText
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      });
      setDocs((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
      if (selectedDocDetail?.id === updated.id) {
        await handleInspectDocument(updated.id);
      }
      setEditingDocId(null);
      setNotice(`Re-indexed "${updated.title}" (${updated.chunk_count} chunks).`);
      void refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update knowledge document.');
    }
  };

  const handleDeleteKnowledge = async (id: string) => {
    setError(null);
    try {
      await apiClient.deleteKnowledge(id);
      setDocs((prev) => prev.filter((d) => d.id !== id));
      if (selectedDocDetail?.id === id) setSelectedDocDetail(null);
      void refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete knowledge document.');
    }
  };

  const handleRunRetrievalQuery = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!retrievalQuery.trim()) return;
    setRetrievalLoading(true);
    setError(null);
    try {
      const res = await apiClient.queryRetrieval({
        query: retrievalQuery.trim(),
        include_memory: true,
        include_knowledge: true,
      });
      setRetrievalResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Retrieval query failed.');
    } finally {
      setRetrievalLoading(false);
    }
  };

  const handleSearchConversations = async (e: React.FormEvent) => {
    e.preventDefault();
    setConvLoading(true);
    setConvSearchedOnce(true);
    setError(null);
    try {
      const res = await apiClient.searchConversations(convSearch.trim(), 30);
      setConvHits(res.matches);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Conversation history search failed.');
    } finally {
      setConvLoading(false);
    }
  };

  const handlePromoteConversationHit = (hit: ConversationSearchHit) => {
    setMemTitle(`From chat: ${hit.conversation_title}`.slice(0, 120));
    setMemContent(hit.snippet);
    setMemNamespace('episodic');
    setMemCategory('fact');
    setMemSourceConvId(hit.conversation_id);
    setActiveTab('memory');
    setNotice('Review and edit the snippet below, then click "Approve & Save Memory" to persist.');
  };

  const handleExportSnapshot = () => {
    const payload = {
      exported_at: new Date().toISOString(),
      status,
      user_memories: entries,
      knowledge_documents: docs,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `genesis_memory_knowledge_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="h-full overflow-y-auto px-4 lg:px-8 py-6">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-4 pb-5 border-b border-white/[0.08]">
          <div>
            <h2 className="font-display text-xl font-semibold text-slate-100">
              Genesis Memory & Knowledge System
            </h2>
            <p className="text-sm text-slate-400 mt-1">
              Three strictly separated local stores in SQLite: approved User Memory, indexed Knowledge Base documents, and searchable Conversation History.
            </p>
          </div>
          <button
            type="button"
            onClick={handleExportSnapshot}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-white/[0.1] bg-[#141A24] hover:bg-[#1B2331] text-xs font-medium text-slate-200 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export JSON Snapshot</span>
          </button>
        </div>

        {/* Status Summary Strip */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="rounded-xl border border-white/[0.08] bg-[#11161F] px-4 py-3">
            <div className="text-[11px] text-slate-400">Approved User Memories</div>
            <div className="text-lg font-display font-semibold text-slate-100 tabular-nums mt-0.5">
              {status ? status.total_memories : entries.length}
            </div>
          </div>
          <div className="rounded-xl border border-white/[0.08] bg-[#11161F] px-4 py-3">
            <div className="text-[11px] text-slate-400">Knowledge Docs & Chunks</div>
            <div className="text-lg font-display font-semibold text-slate-100 tabular-nums mt-0.5">
              {status ? `${status.total_knowledge_docs} docs · ${status.total_knowledge_chunks} chunks` : `${docs.length} docs`}
            </div>
          </div>
          <div className="rounded-xl border border-white/[0.08] bg-[#11161F] px-4 py-3">
            <div className="text-[11px] text-slate-400">Conversation History</div>
            <div className="text-lg font-display font-semibold text-slate-100 tabular-nums mt-0.5">
              {status ? `${status.total_conversations} threads · ${status.total_messages} msgs` : '—'}
            </div>
          </div>
          <div className="rounded-xl border border-white/[0.08] bg-[#11161F] px-4 py-3">
            <div className="text-[11px] text-slate-400">Local Retrieval Engine</div>
            <div className="text-sm font-mono font-medium text-emerald-400 mt-1">
              {status?.fts5_enabled ? 'SQLite FTS5 Active' : 'SQLite Keyword'}
            </div>
          </div>
        </div>

        {/* Privacy Notice */}
        <div className="flex items-start gap-2.5 px-4 py-3 rounded-xl border border-white/[0.08] bg-[#0F141C] text-xs text-slate-300">
          <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          <span>
            <strong className="text-slate-100">Privacy Guard Active:</strong> Conversation turns are never automatically promoted into permanent User Memory. Storing raw API keys, passwords, or private key blocks is blocked.
          </span>
        </div>

        {error && (
          <div className="flex items-center justify-between gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/25 text-xs text-red-300">
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)} className="text-red-300 hover:text-white cursor-pointer">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {notice && (
          <div className="flex items-center justify-between gap-2 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/25 text-xs text-emerald-300">
            <span>{notice}</span>
            <button type="button" onClick={() => setNotice(null)} className="text-emerald-300 hover:text-white cursor-pointer">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Three Separated Subsystem Tabs */}
        <div className="flex flex-wrap items-center gap-1 p-1 rounded-xl bg-[#11161F] border border-white/[0.08] w-fit">
          <button
            type="button"
            onClick={() => setActiveTab('memory')}
            className={`inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-lg transition-colors cursor-pointer ${
              activeTab === 'memory'
                ? 'bg-blue-600 text-white'
                : 'text-slate-400 hover:text-slate-100'
            }`}
          >
            <Database className="w-3.5 h-3.5" />
            <span>User Memory</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('knowledge')}
            className={`inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-lg transition-colors cursor-pointer ${
              activeTab === 'knowledge'
                ? 'bg-blue-600 text-white'
                : 'text-slate-400 hover:text-slate-100'
            }`}
          >
            <BookOpen className="w-3.5 h-3.5" />
            <span>Knowledge Base</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('conversations')}
            className={`inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-lg transition-colors cursor-pointer ${
              activeTab === 'conversations'
                ? 'bg-blue-600 text-white'
                : 'text-slate-400 hover:text-slate-100'
            }`}
          >
            <History className="w-3.5 h-3.5" />
            <span>Conversation History</span>
          </button>
        </div>

        {/* TAB 1: USER MEMORY */}
        {activeTab === 'memory' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            <form
              onSubmit={handleCreateMemory}
              className="lg:col-span-5 rounded-xl border border-white/[0.08] bg-[#11161F] p-6 space-y-4"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-100 font-display">
                  <Database className="w-4 h-4 text-blue-400" />
                  <span>Save Approved Memory</span>
                </div>
                {memSourceConvId && (
                  <button
                    type="button"
                    onClick={() => setMemSourceConvId(null)}
                    className="text-[11px] text-amber-300 hover:text-amber-200 cursor-pointer"
                  >
                    Clear chat link
                  </button>
                )}
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1.5">Title</label>
                <input
                  type="text"
                  required
                  value={memTitle}
                  onChange={(e) => setMemTitle(e.target.value)}
                  placeholder="e.g., Preferred Python Virtualenv Path"
                  className="w-full px-3.5 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 focus:outline-none focus:border-blue-500"
                />
              </div>

              <div className="grid grid-cols-3 gap-2.5">
                <div>
                  <label className="block text-xs text-slate-400 mb-1.5">Category</label>
                  <select
                    value={memCategory}
                    onChange={(e) => setMemCategory(e.target.value as MemoryCategory)}
                    className="w-full px-2.5 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-100 focus:outline-none"
                  >
                    <option value="fact">Fact</option>
                    <option value="preference">Preference</option>
                    <option value="instruction">Instruction</option>
                    <option value="constraint">Constraint</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1.5">Namespace</label>
                  <select
                    value={memNamespace}
                    onChange={(e) => setMemNamespace(e.target.value as MemoryNamespace)}
                    className="w-full px-2.5 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-100 focus:outline-none"
                  >
                    <option value="semantic">Semantic</option>
                    <option value="episodic">Episodic</option>
                    <option value="procedural">Procedural</option>
                    <option value="project">Project</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1.5">Priority (1-5)</label>
                  <input
                    type="number"
                    min={1}
                    max={5}
                    value={memImportance}
                    onChange={(e) => setMemImportance(Number(e.target.value))}
                    className="w-full px-2.5 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-100 tabular-nums focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1.5">Approved Fact / Preference / Instruction</label>
                <textarea
                  rows={4}
                  required
                  value={memContent}
                  onChange={(e) => setMemContent(e.target.value)}
                  placeholder="Explicit user-approved fact or instruction for chat context retrieval..."
                  className="w-full px-3.5 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 focus:outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1.5">Tags (comma-separated)</label>
                <input
                  type="text"
                  value={memTagsText}
                  onChange={(e) => setMemTagsText(e.target.value)}
                  placeholder="windows, runtime, preference"
                  className="w-full px-3.5 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 focus:outline-none focus:border-blue-500"
                />
              </div>

              <button
                type="submit"
                className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>Approve & Save Memory</span>
              </button>
            </form>

            <div className="lg:col-span-7 space-y-4">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void loadMemories(namespaceFilter, categoryFilter, memSearch);
                }}
                className="flex gap-2"
              >
                <div className="relative flex-1">
                  <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={memSearch}
                    onChange={(e) => setMemSearch(e.target.value)}
                    placeholder="Search approved memory titles, content, or tags..."
                    className="w-full pl-9 pr-3 py-2 rounded-lg bg-[#11161F] border border-white/[0.1] text-sm text-slate-100 focus:outline-none focus:border-blue-500"
                  />
                </div>
                <button
                  type="submit"
                  className="px-3.5 py-2 rounded-lg border border-white/[0.1] bg-[#161C26] hover:bg-[#1E2634] text-xs font-medium text-slate-200 cursor-pointer"
                >
                  Filter
                </button>
              </form>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-1 p-1 rounded-lg bg-[#11161F] border border-white/[0.08]">
                  {(['all', 'semantic', 'episodic', 'procedural', 'project'] as const).map((ns) => (
                    <button
                      key={ns}
                      type="button"
                      onClick={() => setNamespaceFilter(ns)}
                      className={`px-2.5 py-1 text-xs font-medium rounded-md capitalize transition-colors cursor-pointer ${
                        namespaceFilter === ns
                          ? 'bg-blue-600 text-white'
                          : 'text-slate-400 hover:text-slate-100'
                      }`}
                    >
                      {ns}
                    </button>
                  ))}
                </div>

                <select
                  aria-label="Filter memory by category"
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value as 'all' | MemoryCategory)}
                  className="px-3 py-1.5 rounded-lg bg-[#11161F] border border-white/[0.08] text-xs text-slate-200 focus:outline-none"
                >
                  <option value="all">All Categories</option>
                  <option value="fact">Facts</option>
                  <option value="preference">Preferences</option>
                  <option value="instruction">Instructions</option>
                  <option value="constraint">Constraints</option>
                </select>
              </div>

              {selectedMem && (
                <div className="rounded-xl border border-blue-500/30 bg-[#101722] p-5 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs font-mono text-blue-300">
                      Memory Record · {selectedMem.id}
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelectedMem(null)}
                      className="text-slate-400 hover:text-slate-100 cursor-pointer"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  <h4 className="font-display text-sm font-semibold text-slate-100">
                    {selectedMem.title}
                  </h4>
                  <p className="text-sm text-slate-200 whitespace-pre-wrap leading-relaxed">
                    {selectedMem.content}
                  </p>
                  <div className="text-[11px] text-slate-400 pt-1 tabular-nums">
                    Category: {selectedMem.category || 'fact'} · Namespace: {selectedMem.namespace} · Priority: {selectedMem.importance}/5
                    {selectedMem.source_conversation_id ? ` · Source chat: ${selectedMem.source_conversation_id}` : ''}
                  </div>
                </div>
              )}

              {loadingMem ? (
                <div className="h-32 rounded-xl bg-[#11161F] border border-white/[0.06]" />
              ) : entries.length === 0 ? (
                <div className="p-8 rounded-xl border border-white/[0.08] bg-[#11161F] text-center text-sm text-slate-400">
                  No approved user memories saved for this filter.
                </div>
              ) : (
                <div className="space-y-3">
                  {entries.map((entry) =>
                    editingMemId === entry.id ? (
                      <form
                        key={entry.id}
                        onSubmit={handleSaveMemoryEdit}
                        className="rounded-xl border border-blue-500/40 bg-[#11161F] p-5 space-y-3"
                      >
                        <input
                          type="text"
                          required
                          value={editMemTitle}
                          onChange={(e) => setEditMemTitle(e.target.value)}
                          className="w-full px-3 py-1.5 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 focus:outline-none"
                        />
                        <div className="grid grid-cols-3 gap-2">
                          <select
                            value={editMemCategory}
                            onChange={(e) => setEditMemCategory(e.target.value as MemoryCategory)}
                            className="px-2.5 py-1.5 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-100"
                          >
                            <option value="fact">Fact</option>
                            <option value="preference">Preference</option>
                            <option value="instruction">Instruction</option>
                            <option value="constraint">Constraint</option>
                          </select>
                          <select
                            value={editMemNamespace}
                            onChange={(e) => setEditMemNamespace(e.target.value as MemoryNamespace)}
                            className="px-2.5 py-1.5 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-100"
                          >
                            <option value="semantic">Semantic</option>
                            <option value="episodic">Episodic</option>
                            <option value="procedural">Procedural</option>
                            <option value="project">Project</option>
                          </select>
                          <input
                            type="number"
                            min={1}
                            max={5}
                            value={editMemImportance}
                            onChange={(e) => setEditMemImportance(Number(e.target.value))}
                            className="px-2.5 py-1.5 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-100"
                          />
                        </div>
                        <textarea
                          rows={3}
                          required
                          value={editMemContent}
                          onChange={(e) => setEditMemContent(e.target.value)}
                          className="w-full px-3 py-1.5 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 focus:outline-none"
                        />
                        <input
                          type="text"
                          value={editMemTagsText}
                          onChange={(e) => setEditMemTagsText(e.target.value)}
                          placeholder="Tags (comma-separated)"
                          className="w-full px-3 py-1.5 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-100 focus:outline-none"
                        />
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => setEditingMemId(null)}
                            className="px-3 py-1.5 rounded-lg border border-white/[0.1] text-xs text-slate-300 hover:bg-white/[0.05] cursor-pointer"
                          >
                            Cancel
                          </button>
                          <button
                            type="submit"
                            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white cursor-pointer"
                          >
                            <Check className="w-3.5 h-3.5" />
                            <span>Save Changes</span>
                          </button>
                        </div>
                      </form>
                    ) : (
                      <div
                        key={entry.id}
                        className="rounded-xl border border-white/[0.08] bg-[#11161F] p-5 space-y-2"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <h3 className="font-display text-sm font-semibold text-slate-100">
                              {entry.title}
                            </h3>
                            <div className="text-[11px] text-slate-400 mt-0.5 capitalize tabular-nums">
                              {entry.category || 'fact'} · {entry.namespace} · Priority {entry.importance}/5 ·{' '}
                              {new Date(entry.updated_at).toLocaleDateString()}
                            </div>
                          </div>
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => setSelectedMem(entry)}
                              aria-label={`Inspect ${entry.title}`}
                              className="p-1.5 rounded text-slate-400 hover:text-slate-100 hover:bg-white/[0.06] cursor-pointer"
                            >
                              <Eye className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => startEditMemory(entry)}
                              aria-label={`Edit ${entry.title}`}
                              className="p-1.5 rounded text-slate-400 hover:text-blue-300 hover:bg-blue-500/10 cursor-pointer"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleDeleteMemory(entry.id)}
                              aria-label={`Delete ${entry.title}`}
                              className="p-1.5 rounded text-slate-500 hover:text-red-400 hover:bg-red-500/10 cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                        <p className="text-sm text-slate-300 leading-relaxed line-clamp-4">
                          {entry.content}
                        </p>
                        {entry.tags.length > 0 && (
                          <div className="text-[11px] font-mono text-slate-500 pt-1">
                            Tags: {entry.tags.join(' · ')}
                          </div>
                        )}
                      </div>
                    )
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 2: KNOWLEDGE BASE */}
        {activeTab === 'knowledge' && (
          <div className="space-y-6">
            {/* Retrieval Inspector */}
            <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="font-display text-sm font-semibold text-slate-100">
                    Test Local Retrieval Engine
                  </h3>
                  <p className="text-xs text-slate-400">
                    Inspects exactly which approved User Memories and Knowledge chunks match a query via SQLite FTS5 before chat dispatch.
                  </p>
                </div>
              </div>
              <form onSubmit={handleRunRetrievalQuery} className="flex flex-col sm:flex-row gap-2">
                <input
                  type="text"
                  value={retrievalQuery}
                  onChange={(e) => setRetrievalQuery(e.target.value)}
                  placeholder="Enter a test query (e.g., deployment port, architecture docs)..."
                  className="flex-1 px-3.5 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 focus:outline-none focus:border-blue-500"
                />
                <button
                  type="submit"
                  disabled={retrievalLoading || !retrievalQuery.trim()}
                  className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-xs font-medium text-white cursor-pointer"
                >
                  {retrievalLoading ? 'Querying...' : 'Run Retrieval Query'}
                </button>
              </form>

              {retrievalResult && (
                <div className="pt-2 border-t border-white/[0.06] space-y-2 text-xs">
                  <div className="flex flex-wrap items-center gap-3 text-slate-400 font-mono">
                    <span>Backend: {retrievalResult.retrieval_backend}</span>
                    <span>·</span>
                    <span>
                      Matches: {retrievalResult.memories.length} memory, {retrievalResult.knowledge.length} knowledge chunks
                    </span>
                    <span>·</span>
                    <span>Context budget used: {retrievalResult.total_context_tokens} tokens</span>
                  </div>
                  {retrievalResult.memories.length === 0 && retrievalResult.knowledge.length === 0 ? (
                    <div className="text-slate-400 py-1">
                      No matching memory or knowledge records found for "{retrievalResult.query}". Project Genesis will not fabricate information when no match exists.
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
                      {retrievalResult.memories.map((m) => (
                        <div key={m.id} className="p-3 rounded-lg bg-[#0A0D12] border border-white/[0.08]">
                          <div className="font-medium text-blue-300">
                            User Memory · {m.title} ({m.category})
                          </div>
                          <div className="text-slate-300 mt-1">{m.content}</div>
                        </div>
                      ))}
                      {retrievalResult.knowledge.map((k) => (
                        <div key={k.chunk_id} className="p-3 rounded-lg bg-[#0A0D12] border border-white/[0.08]">
                          <div className="font-medium text-emerald-300">
                            Knowledge · {k.document_title} (chunk #{k.chunk_index})
                          </div>
                          <div className="text-slate-300 mt-1">{k.content}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              {/* Add Document Form */}
              <form
                onSubmit={handleCreateKnowledge}
                className="lg:col-span-5 rounded-xl border border-white/[0.08] bg-[#11161F] p-6 space-y-4"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-100 font-display">
                    <BookOpen className="w-4 h-4 text-blue-400" />
                    <span>Index Knowledge Document</span>
                  </div>
                  <div>
                    <input
                      ref={kbFileRef}
                      type="file"
                      accept=".txt,.md,.json,.csv,.py,.ts,.tsx,.js,.yaml,.yml,.log"
                      onChange={handleKbFileUpload}
                      className="hidden"
                    />
                    <button
                      type="button"
                      onClick={() => kbFileRef.current?.click()}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-white/[0.1] bg-[#161C26] hover:bg-[#1E2634] text-[11px] text-slate-200 cursor-pointer"
                    >
                      <FileUp className="w-3 h-3" />
                      <span>Load Text File</span>
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-slate-400 mb-1.5">Document Title</label>
                  <input
                    type="text"
                    required
                    value={kbTitle}
                    onChange={(e) => setKbTitle(e.target.value)}
                    placeholder="e.g., Genesis Architecture Runbook"
                    className="w-full px-3.5 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 focus:outline-none focus:border-blue-500"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1.5">Source Type</label>
                    <select
                      value={kbSourceType}
                      onChange={(e) => setKbSourceType(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-100"
                    >
                      <option value="note">Note</option>
                      <option value="document">Document</option>
                      <option value="markdown">Markdown</option>
                      <option value="reference">Technical Reference</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1.5">Source Filename / Ref</label>
                    <input
                      type="text"
                      value={kbSourceName}
                      onChange={(e) => setKbSourceName(e.target.value)}
                      placeholder="optional filename"
                      className="w-full px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-100 focus:outline-none"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-slate-400 mb-1.5">
                    Document Text (automatically split into searchable chunks)
                  </label>
                  <textarea
                    rows={6}
                    required
                    value={kbContent}
                    onChange={(e) => setKbContent(e.target.value)}
                    placeholder="Paste documentation, project notes, or reference guides..."
                    className="w-full px-3.5 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 focus:outline-none focus:border-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-xs text-slate-400 mb-1.5">Tags (comma-separated)</label>
                  <input
                    type="text"
                    value={kbTagsText}
                    onChange={(e) => setKbTagsText(e.target.value)}
                    placeholder="docs, guide, setup"
                    className="w-full px-3.5 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 focus:outline-none focus:border-blue-500"
                  />
                </div>

                <button
                  type="submit"
                  className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  <span>Index to Knowledge Base</span>
                </button>
              </form>

              {/* Document List & Chunks */}
              <div className="lg:col-span-7 space-y-4">
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void loadKnowledge(kbSearch);
                  }}
                  className="flex gap-2"
                >
                  <div className="relative flex-1">
                    <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={kbSearch}
                      onChange={(e) => setKbSearch(e.target.value)}
                      placeholder="Search knowledge documents..."
                      className="w-full pl-9 pr-3 py-2 rounded-lg bg-[#11161F] border border-white/[0.1] text-sm text-slate-100 focus:outline-none focus:border-blue-500"
                    />
                  </div>
                  <button
                    type="submit"
                    className="px-3.5 py-2 rounded-lg border border-white/[0.1] bg-[#161C26] hover:bg-[#1E2634] text-xs font-medium text-slate-200 cursor-pointer"
                  >
                    Search
                  </button>
                </form>

                {selectedDocDetail && (
                  <div className="rounded-xl border border-emerald-500/30 bg-[#0F171A] p-5 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <h4 className="font-display text-sm font-semibold text-slate-100">
                          {selectedDocDetail.title}
                        </h4>
                        <div className="text-[11px] text-slate-400">
                          {selectedDocDetail.chunk_count} indexed chunks · {selectedDocDetail.source_type}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setSelectedDocDetail(null)}
                        className="text-slate-400 hover:text-white cursor-pointer"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                    <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                      {(selectedDocDetail.chunks || []).map((chunk) => (
                        <div
                          key={chunk.id}
                          className="p-2.5 rounded-lg bg-[#0A0D12] border border-white/[0.08] text-xs"
                        >
                          <div className="font-mono text-[11px] text-emerald-300 mb-1">
                            Chunk #{chunk.chunk_index} · {chunk.token_estimate} est. tokens
                          </div>
                          <div className="text-slate-300 whitespace-pre-wrap">{chunk.content}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {loadingKb ? (
                  <div className="h-32 rounded-xl bg-[#11161F] border border-white/[0.06]" />
                ) : docs.length === 0 ? (
                  <div className="p-8 rounded-xl border border-white/[0.08] bg-[#11161F] text-center text-sm text-slate-400">
                    No Knowledge Base documents indexed yet. Add technical notes or upload a text file on the left.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {docs.map((doc) =>
                      editingDocId === doc.id ? (
                        <form
                          key={doc.id}
                          onSubmit={handleSaveDocEdit}
                          className="rounded-xl border border-blue-500/40 bg-[#11161F] p-5 space-y-3"
                        >
                          <input
                            type="text"
                            required
                            value={editDocTitle}
                            onChange={(e) => setEditDocTitle(e.target.value)}
                            className="w-full px-3 py-1.5 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100"
                          />
                          <textarea
                            rows={5}
                            required
                            value={editDocContent}
                            onChange={(e) => setEditDocContent(e.target.value)}
                            className="w-full px-3 py-1.5 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100"
                          />
                          <input
                            type="text"
                            value={editDocTagsText}
                            onChange={(e) => setEditDocTagsText(e.target.value)}
                            placeholder="Tags (comma-separated)"
                            className="w-full px-3 py-1.5 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-100"
                          />
                          <div className="flex items-center justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => setEditingDocId(null)}
                              className="px-3 py-1.5 rounded-lg border border-white/[0.1] text-xs text-slate-300 cursor-pointer"
                            >
                              Cancel
                            </button>
                            <button
                              type="submit"
                              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white cursor-pointer"
                            >
                              <Check className="w-3.5 h-3.5" />
                              <span>Save & Re-chunk</span>
                            </button>
                          </div>
                        </form>
                      ) : (
                        <div
                          key={doc.id}
                          className="rounded-xl border border-white/[0.08] bg-[#11161F] p-5 space-y-2"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <h3 className="font-display text-sm font-semibold text-slate-100">
                                {doc.title}
                              </h3>
                              <div className="text-[11px] text-slate-400 mt-0.5 tabular-nums">
                                {doc.source_type}
                                {doc.source_name ? ` (${doc.source_name})` : ''} · {doc.chunk_count} chunks ·{' '}
                                {new Date(doc.updated_at).toLocaleDateString()}
                              </div>
                            </div>
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => void handleInspectDocument(doc.id)}
                                aria-label={`Inspect chunks for ${doc.title}`}
                                className="p-1.5 rounded text-slate-400 hover:text-emerald-300 hover:bg-emerald-500/10 cursor-pointer"
                              >
                                <Eye className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingDocId(doc.id);
                                  setEditDocTitle(doc.title);
                                  setEditDocContent(doc.content);
                                  setEditDocTagsText(doc.tags.join(', '));
                                }}
                                aria-label={`Edit ${doc.title}`}
                                className="p-1.5 rounded text-slate-400 hover:text-blue-300 hover:bg-blue-500/10 cursor-pointer"
                              >
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleDeleteKnowledge(doc.id)}
                                aria-label={`Delete ${doc.title}`}
                                className="p-1.5 rounded text-slate-500 hover:text-red-400 hover:bg-red-500/10 cursor-pointer"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                          <p className="text-sm text-slate-300 leading-relaxed line-clamp-3">
                            {doc.content}
                          </p>
                          {doc.tags.length > 0 && (
                            <div className="text-[11px] font-mono text-slate-500 pt-1">
                              Tags: {doc.tags.join(' · ')}
                            </div>
                          )}
                        </div>
                      )
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: CONVERSATION HISTORY SEARCH */}
        {activeTab === 'conversations' && (
          <div className="space-y-4">
            <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-5 space-y-3">
              <div>
                <h3 className="font-display text-sm font-semibold text-slate-100">
                  Search Stored Conversation History
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Conversation transcripts remain separate from User Memory. If you find an important fact or preference, click <strong className="text-slate-200">Review & Save to Memory</strong> to inspect, edit, and explicitly approve saving it.
                </p>
              </div>
              <form onSubmit={handleSearchConversations} className="flex flex-col sm:flex-row gap-2">
                <div className="relative flex-1">
                  <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    required
                    value={convSearch}
                    onChange={(e) => setConvSearch(e.target.value)}
                    placeholder="Search past conversation titles or message text..."
                    className="w-full pl-9 pr-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 focus:outline-none focus:border-blue-500"
                  />
                </div>
                <button
                  type="submit"
                  disabled={convLoading || !convSearch.trim()}
                  className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-xs font-medium text-white cursor-pointer"
                >
                  {convLoading ? 'Searching...' : 'Search History'}
                </button>
              </form>
            </div>

            {convSearchedOnce && convHits.length === 0 && !convLoading && (
              <div className="p-8 rounded-xl border border-white/[0.08] bg-[#11161F] text-center text-sm text-slate-400">
                No messages matched "{convSearch}".
              </div>
            )}

            {convHits.length > 0 && (
              <div className="space-y-3">
                {convHits.map((hit) => (
                  <div
                    key={hit.message_id}
                    className="rounded-xl border border-white/[0.08] bg-[#11161F] p-4 space-y-2"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-xs text-slate-400">
                        <span className="font-semibold text-slate-200">{hit.conversation_title}</span>
                        <span className="mx-1.5 text-slate-600">·</span>
                        <span className="capitalize">{hit.role}</span>
                        <span className="mx-1.5 text-slate-600">·</span>
                        <span className="tabular-nums">{new Date(hit.created_at).toLocaleString()}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => handlePromoteConversationHit(hit)}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-blue-500/30 bg-blue-500/10 hover:bg-blue-500/20 text-xs font-medium text-blue-300 cursor-pointer"
                      >
                        <Plus className="w-3 h-3" />
                        <span>Review & Save to Memory</span>
                      </button>
                    </div>
                    <p className="text-sm text-slate-300 whitespace-pre-wrap">{hit.snippet}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
