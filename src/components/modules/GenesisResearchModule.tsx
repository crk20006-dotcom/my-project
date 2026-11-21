import React, { useEffect, useState } from 'react';
import { BookOpen, Globe, Link2, Plus, Save, Search, Trash2 } from 'lucide-react';
import { apiClient } from '../../services/apiClient';
import type {
  ResearchProject,
  ResearchSource,
  WorldSourceRecord,
} from '../../types/genesis';

export const GenesisResearchModule: React.FC = () => {
  const [projects, setProjects] = useState<ResearchProject[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'draft' | 'archived'>('all');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [worldProvider, setWorldProvider] = useState<'wikipedia' | 'arxiv'>('arxiv');
  const [worldQuery, setWorldQuery] = useState('');
  const [worldUrl, setWorldUrl] = useState('');
  const [worldLoading, setWorldLoading] = useState(false);
  const [worldResults, setWorldResults] = useState<WorldSourceRecord[]>([]);
  const [worldMetaNote, setWorldMetaNote] = useState<string | null>(null);

  const [editTitle, setEditTitle] = useState('');
  const [editSummary, setEditSummary] = useState('');
  const [editStatus, setEditStatus] = useState<'active' | 'draft' | 'archived'>('active');
  const [editNotes, setEditNotes] = useState('');
  const [editTags, setEditTags] = useState('');
  const [editSources, setEditSources] = useState<ResearchSource[]>([]);

  const [newSourceTitle, setNewSourceTitle] = useState('');
  const [newSourceRef, setNewSourceRef] = useState('');

  const loadProjects = async () => {
    setLoading(true);
    try {
      const list = await apiClient.listResearch();
      setProjects(list);
      if (list.length > 0 && !selectedId) {
        selectProject(list[0]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load research projects.');
    } finally {
      setLoading(false);
    }
  };

  const selectProject = (proj: ResearchProject) => {
    setSelectedId(proj.id);
    setEditTitle(proj.title);
    setEditSummary(proj.summary);
    setEditStatus(proj.status);
    setEditNotes(proj.notes);
    setEditTags(proj.tags.join(', '));
    setEditSources(proj.sources || []);
  };

  useEffect(() => {
    void loadProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCreate = async () => {
    setError(null);
    try {
      const created = await apiClient.createResearch({
        title: 'Untitled Research Study',
        summary: 'Research scope and technical objectives.',
        status: 'draft',
        tags: ['genesis-research'],
        sources: [],
        notes: '',
      });
      setProjects((prev) => [created, ...prev]);
      selectProject(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project.');
    }
  };

  const handleSave = async () => {
    if (!selectedId) return;
    setSaving(true);
    setError(null);
    try {
      const tags = editTags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      const updated = await apiClient.updateResearch(selectedId, {
        title: editTitle,
        summary: editSummary,
        status: editStatus,
        tags,
        sources: editSources,
        notes: editNotes,
      });
      setProjects((prev) => prev.map((p) => (p.id === selectedId ? { ...p, ...updated } : p)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save research project.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await apiClient.deleteResearch(id);
      const remaining = projects.filter((p) => p.id !== id);
      setProjects(remaining);
      if (selectedId === id) {
        if (remaining[0]) {
          selectProject(remaining[0]);
        } else {
          setSelectedId(null);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete project.');
    }
  };

  const handleAddSource = () => {
    if (!newSourceTitle.trim() || !newSourceRef.trim()) return;
    setEditSources((prev) => [
      ...prev,
      {
        id: `src-${Date.now()}`,
        title: newSourceTitle.trim(),
        reference: newSourceRef.trim(),
        note: '',
        retrieved_at: new Date().toISOString(),
      },
    ]);
    setNewSourceTitle('');
    setNewSourceRef('');
  };

  const handleWorldSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!worldQuery.trim()) return;
    setWorldLoading(true);
    setError(null);
    setWorldMetaNote(null);
    try {
      const res = await apiClient.searchWorldSources({
        provider: worldProvider,
        query: worldQuery.trim(),
        limit: 5,
      });
      if (!res.ok) {
        setWorldResults([]);
        setWorldMetaNote(
          `Offline or upstream unavailable (${res.provider}) at ${res.retrieved_at}: ${res.error || 'Request failed'}`
        );
      } else {
        setWorldResults(res.results);
        setWorldMetaNote(
          `Retrieved ${res.results.length} attributed source(s) via ${res.provider} at ${new Date(res.retrieved_at).toLocaleString()}.`
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'World Intelligence search failed.');
    } finally {
      setWorldLoading(false);
    }
  };

  const handleFetchWorldUrl = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!worldUrl.trim()) return;
    setWorldLoading(true);
    setError(null);
    setWorldMetaNote(null);
    try {
      const res = await apiClient.fetchWorldUrl(worldUrl.trim());
      if (!res.ok) {
        setWorldResults([]);
        setWorldMetaNote(
          `Retrieval blocked or unavailable (${res.retrieved_at}): ${res.error || 'Failed to fetch URL'}`
        );
      } else {
        setWorldResults(res.items);
        setWorldMetaNote(
          `Parsed ${res.source_kind.toUpperCase()} source "${res.title}" (${res.items.length} item(s)) at ${new Date(res.retrieved_at).toLocaleString()}.`
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch public URL.');
    } finally {
      setWorldLoading(false);
    }
  };

  const handleCiteWorldRecord = (record: WorldSourceRecord) => {
    if (!selectedId) {
      setError('Select or create a Research Study first before citing a source.');
      return;
    }
    setEditSources((prev) => [
      ...prev,
      {
        id: `src-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        title: record.title,
        reference: record.url,
        url: record.url,
        published_at: record.published_at,
        retrieved_at: record.retrieved_at,
        attribution: record.attribution,
        note: record.snippet.slice(0, 260),
      },
    ]);
    setNotice(`Added "${record.title}" to active study citations. Click "Save Changes" to persist.`);
  };

  const visibleProjects =
    statusFilter === 'all' ? projects : projects.filter((p) => p.status === statusFilter);

  return (
    <div className="h-full overflow-y-auto px-4 lg:px-8 py-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4 pb-5 border-b border-white/[0.08]">
          <div>
            <h2 className="font-display text-xl font-semibold text-slate-100">
              Research Workspace & World Intelligence
            </h2>
            <p className="text-sm text-slate-400 mt-1">
              Organize research studies, retrieve public/scientific sources & RSS feeds with attribution timestamps, and persist citations in SQLite.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void handleCreate()}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white transition-colors cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>New Research Study</span>
          </button>
        </div>

        {error && (
          <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/25 text-xs text-red-300">
            {error}
          </div>
        )}
        {notice && (
          <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/25 text-xs text-emerald-300">
            {notice}
          </div>
        )}

        {/* World Intelligence Connector */}
        <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-display text-sm font-semibold text-slate-100">
              <Globe className="w-4 h-4 text-blue-400" />
              <span>World Intelligence Retrieval (Public APIs, RSS/Atom Feeds & Web Pages)</span>
            </div>
            <span className="text-[11px] text-slate-400">
              Free connectors · SSRF-protected · 20 req/min rate limit
            </span>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <form onSubmit={handleWorldSearch} className="flex flex-wrap sm:flex-nowrap gap-2">
              <select
                value={worldProvider}
                onChange={(e) => setWorldProvider(e.target.value as 'wikipedia' | 'arxiv')}
                className="px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-100 focus:outline-none"
              >
                <option value="arxiv">arXiv Preprints</option>
                <option value="wikipedia">Wikipedia API</option>
              </select>
              <input
                type="text"
                value={worldQuery}
                onChange={(e) => setWorldQuery(e.target.value)}
                placeholder="Search scientific papers or topics..."
                className="flex-1 min-w-[160px] px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-100 focus:outline-none focus:border-blue-500"
              />
              <button
                type="submit"
                disabled={worldLoading || !worldQuery.trim()}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-xs font-medium text-white cursor-pointer"
              >
                <Search className="w-3.5 h-3.5" />
                <span>{worldLoading ? 'Searching...' : 'Search'}</span>
              </button>
            </form>

            <form onSubmit={handleFetchWorldUrl} className="flex flex-wrap sm:flex-nowrap gap-2">
              <input
                type="url"
                value={worldUrl}
                onChange={(e) => setWorldUrl(e.target.value)}
                placeholder="https://... (RSS feed, Atom XML, or public webpage)"
                className="flex-1 min-w-[200px] px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] font-mono text-xs text-slate-100 focus:outline-none focus:border-blue-500"
              />
              <button
                type="submit"
                disabled={worldLoading || !worldUrl.trim()}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-white/[0.1] bg-[#161C26] hover:bg-[#1E2634] disabled:opacity-50 text-xs font-medium text-slate-200 cursor-pointer"
              >
                <Link2 className="w-3.5 h-3.5" />
                <span>Fetch URL / RSS</span>
              </button>
            </form>
          </div>

          {worldMetaNote && (
            <div className="text-xs text-slate-300 bg-[#0A0D12] border border-white/[0.08] rounded-lg px-3 py-2">
              {worldMetaNote}
            </div>
          )}

          {worldResults.length > 0 && (
            <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
              {worldResults.map((item) => (
                <div
                  key={item.id}
                  className="p-3 rounded-lg bg-[#0A0D12] border border-white/[0.08] flex flex-col sm:flex-row sm:items-start justify-between gap-3"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="text-xs font-semibold text-slate-100">{item.title}</div>
                    <div className="text-[11px] font-mono text-blue-300 truncate">{item.url}</div>
                    <p className="text-xs text-slate-400 line-clamp-2">{item.snippet || 'No excerpt returned.'}</p>
                    <div className="text-[11px] text-slate-500">
                      Source: {item.attribution} ·{' '}
                      {item.published_at
                        ? `Published: ${new Date(item.published_at).toLocaleDateString()} · `
                        : ''}
                      Retrieved: {new Date(item.retrieved_at).toLocaleString()}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleCiteWorldRecord(item)}
                    className="px-3 py-1.5 rounded-lg border border-blue-500/35 bg-blue-500/10 hover:bg-blue-500/20 text-xs font-medium text-blue-300 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    Cite in Active Study
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left Column */}
          <div className="lg:col-span-4 space-y-3">
            <div className="flex items-center gap-1 p-1 rounded-lg bg-[#11161F] border border-white/[0.08]">
              {(['all', 'active', 'draft', 'archived'] as const).map((status) => (
                <button
                  key={status}
                  type="button"
                  onClick={() => setStatusFilter(status)}
                  className={`flex-1 py-1.5 text-xs font-medium rounded-md capitalize transition-colors cursor-pointer ${
                    statusFilter === status ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-100'
                  }`}
                >
                  {status}
                </button>
              ))}
            </div>

            <div className="space-y-2">
              {loading ? (
                <div className="h-24 rounded-xl bg-[#11161F] border border-white/[0.06]" />
              ) : visibleProjects.length === 0 ? (
                <div className="p-6 rounded-xl border border-white/[0.08] bg-[#11161F] text-xs text-slate-400">
                  No research studies match this filter.
                </div>
              ) : (
                visibleProjects.map((proj) => (
                  <div
                    key={proj.id}
                    className={`p-4 rounded-xl border transition-colors ${
                      proj.id === selectedId
                        ? 'bg-[#141B26] border-blue-500/50'
                        : 'bg-[#11161F] border-white/[0.08]'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => selectProject(proj)}
                        className="text-left flex-1 min-w-0 cursor-pointer"
                      >
                        <div className="font-display text-sm font-semibold text-slate-100 truncate">
                          {proj.title}
                        </div>
                        <div className="text-xs text-slate-400 mt-1 line-clamp-2">{proj.summary}</div>
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(proj.id)}
                        aria-label={`Delete ${proj.title}`}
                        className="p-1.5 rounded text-slate-500 hover:text-red-400 hover:bg-red-500/10 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <div className="text-[11px] text-slate-500 mt-2.5 capitalize tabular-nums">
                      {proj.status} · {proj.sources?.length ?? 0} sources
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Right Editor */}
          <div className="lg:col-span-8">
            {selectedId ? (
              <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-6 space-y-5">
                <div className="flex items-center justify-between gap-4 pb-4 border-b border-white/[0.08]">
                  <div className="flex items-center gap-2 text-xs text-slate-400">
                    <BookOpen className="w-4 h-4 text-blue-400" />
                    <span>Research Notebook</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleSave()}
                    disabled={saving}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white cursor-pointer"
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>{saving ? 'Saving...' : 'Save Changes'}</span>
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="sm:col-span-2">
                    <label className="block text-xs text-slate-400 mb-1.5">Study Title</label>
                    <input
                      type="text"
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      className="w-full px-3.5 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 focus:outline-none focus:border-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1.5">Status</label>
                    <select
                      value={editStatus}
                      onChange={(e) => setEditStatus(e.target.value as 'active' | 'draft' | 'archived')}
                      className="w-full px-3.5 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 focus:outline-none focus:border-blue-500"
                    >
                      <option value="active">Active</option>
                      <option value="draft">Draft</option>
                      <option value="archived">Archived</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-slate-400 mb-1.5">Abstract / Summary</label>
                  <input
                    type="text"
                    value={editSummary}
                    onChange={(e) => setEditSummary(e.target.value)}
                    className="w-full px-3.5 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 focus:outline-none focus:border-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-xs text-slate-400 mb-1.5">Tags (comma-separated)</label>
                  <input
                    type="text"
                    value={editTags}
                    onChange={(e) => setEditTags(e.target.value)}
                    className="w-full px-3.5 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 focus:outline-none focus:border-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-xs text-slate-400 mb-1.5">Research Notes</label>
                  <textarea
                    rows={7}
                    value={editNotes}
                    onChange={(e) => setEditNotes(e.target.value)}
                    placeholder="Document hypotheses, training architecture observations, or evaluation protocols..."
                    className="w-full px-3.5 py-2.5 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 leading-relaxed focus:outline-none focus:border-blue-500"
                  />
                </div>

                <div className="pt-3 border-t border-white/[0.08] space-y-3">
                  <div className="text-xs font-medium text-slate-300">Citations & References</div>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input
                      type="text"
                      value={newSourceTitle}
                      onChange={(e) => setNewSourceTitle(e.target.value)}
                      placeholder="Source title"
                      className="flex-1 px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-100 focus:outline-none"
                    />
                    <input
                      type="text"
                      value={newSourceRef}
                      onChange={(e) => setNewSourceRef(e.target.value)}
                      placeholder="Local path, paper ID, or reference"
                      className="flex-1 px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-100 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={handleAddSource}
                      className="px-3.5 py-2 rounded-lg border border-white/[0.1] bg-[#161C26] hover:bg-[#1E2634] text-xs font-medium text-slate-200 whitespace-nowrap cursor-pointer"
                    >
                      Add Reference
                    </button>
                  </div>

                  {editSources.length > 0 && (
                    <div className="divide-y divide-white/[0.06] border border-white/[0.07] rounded-lg bg-[#0A0D12]">
                      {editSources.map((src) => (
                        <div key={src.id} className="px-3.5 py-2.5 flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-xs font-medium text-slate-200 truncate">{src.title}</div>
                            <div className="text-[11px] font-mono text-slate-500 truncate">{src.reference}</div>
                            {(src.published_at || src.retrieved_at || src.attribution) && (
                              <div className="text-[10px] text-slate-500 mt-0.5">
                                {src.attribution ? `${src.attribution} · ` : ''}
                                {src.published_at
                                  ? `Published ${new Date(src.published_at).toLocaleDateString()} · `
                                  : ''}
                                {src.retrieved_at
                                  ? `Retrieved ${new Date(src.retrieved_at).toLocaleString()}`
                                  : ''}
                              </div>
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={() => setEditSources((prev) => prev.filter((s) => s.id !== src.id))}
                            className="text-xs text-slate-500 hover:text-red-400 cursor-pointer shrink-0"
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="p-8 rounded-xl border border-white/[0.08] bg-[#11161F] text-center text-sm text-slate-400">
                Select a research study or create a new one.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
