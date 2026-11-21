import type { DatabaseSync } from 'node:sqlite';
import { hasFts5Support } from '../db.ts';
import { inspectTokensServer } from './interfaces.ts';

export interface RetrievedMemoryItem {
  id: string;
  namespace: string;
  category: string;
  title: string;
  content: string;
  importance: number;
  score: number;
}

export interface RetrievedKnowledgeChunk {
  chunk_id: string;
  document_id: string;
  document_title: string;
  source_type: string;
  chunk_index: number;
  content: string;
  score: number;
}

export interface RetrievalResult {
  queried: boolean;
  query: string;
  retrieval_backend: 'sqlite_fts5' | 'sqlite_like';
  memories: RetrievedMemoryItem[];
  knowledge: RetrievedKnowledgeChunk[];
  total_context_tokens: number;
}

export interface RetrievalOptions {
  includeMemory?: boolean;
  includeKnowledge?: boolean;
  maxMemoryItems?: number;
  maxKnowledgeChunks?: number;
  contextLength?: number;
}

export interface KnowledgeRetriever {
  readonly backendName: string;
  retrieve(query: string, options?: RetrievalOptions): RetrievalResult;
}

const SECRET_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: 'OpenAI-style API key', regex: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { label: 'Google/Gemini API key', regex: /\bAIza[0-9A-Za-z_-]{20,}\b/ },
  { label: 'GitHub personal access token', regex: /\bghp_[A-Za-z0-9]{20,}\b/ },
  { label: 'AWS access key ID', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'Private key block', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    label: 'Credential assignment',
    regex: /\b(?:password|passcode|api[_-]?key|secret[_-]?key|access[_-]?token)\s*[:=]\s*['"]?[^\s'"]{6,}/i,
  },
];

export function detectSensitiveSecret(text: string): string | null {
  if (!text) return null;
  for (const item of SECRET_PATTERNS) {
    if (item.regex.test(text)) {
      return item.label;
    }
  }
  return null;
}

export function chunkKnowledgeText(
  rawContent: string,
  chunkSize = 600,
  overlap = 80,
  maxChunks = 80
): Array<{ chunk_index: number; content: string; token_estimate: number }> {
  const normalized = rawContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!normalized) return [];

  const chunks: Array<{ chunk_index: number; content: string; token_estimate: number }> = [];
  let cursor = 0;
  let index = 0;

  while (cursor < normalized.length && chunks.length < maxChunks) {
    let end = Math.min(normalized.length, cursor + chunkSize);
    if (end < normalized.length) {
      const breakSearch = normalized.slice(cursor, end);
      const lastPara = breakSearch.lastIndexOf('\n\n');
      const lastLine = breakSearch.lastIndexOf('\n');
      const lastSpace = breakSearch.lastIndexOf(' ');
      if (lastPara > chunkSize * 0.45) {
        end = cursor + lastPara;
      } else if (lastLine > chunkSize * 0.55) {
        end = cursor + lastLine;
      } else if (lastSpace > chunkSize * 0.65) {
        end = cursor + lastSpace;
      }
    }

    const slice = normalized.slice(cursor, end).trim();
    if (slice) {
      chunks.push({
        chunk_index: index++,
        content: slice,
        token_estimate: inspectTokensServer(slice).token_count,
      });
    }

    if (end >= normalized.length) break;
    cursor = Math.max(cursor + 1, end - overlap);
  }

  return chunks;
}

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'what',
  'when',
  'where',
  'which',
  'about',
  'into',
  'your',
  'have',
  'does',
  'how',
  'are',
  'was',
  'were',
  'can',
  'you',
  'use',
]);

export function extractQueryTerms(query: string): string[] {
  const matches = query.toLowerCase().match(/[a-z0-9_]{2,}/g) || [];
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const term of matches) {
    if (!seen.has(term)) {
      seen.add(term);
      unique.push(term);
    }
  }
  const meaningful = unique.filter((t) => !STOP_WORDS.has(t));
  return (meaningful.length > 0 ? meaningful : unique).slice(0, 10);
}

function buildFtsMatchExpression(terms: string[]): string {
  return terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
}

export class SqliteKeywordRetriever implements KnowledgeRetriever {
  readonly backendName = 'sqlite_keyword';
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  retrieve(query: string, options: RetrievalOptions = {}): RetrievalResult {
    const trimmedQuery = (query || '').trim();
    const includeMemory = options.includeMemory !== false;
    const includeKnowledge = options.includeKnowledge !== false;
    const maxMemoryItems = Math.min(6, Math.max(0, options.maxMemoryItems ?? 3));
    const maxKnowledgeChunks = Math.min(6, Math.max(0, options.maxKnowledgeChunks ?? 3));
    const contextLength = Math.max(128, options.contextLength ?? 8192);
    const ftsAvailable = hasFts5Support(this.db);
    const backend: 'sqlite_fts5' | 'sqlite_like' = ftsAvailable ? 'sqlite_fts5' : 'sqlite_like';

    if (!trimmedQuery || (!includeMemory && !includeKnowledge)) {
      return {
        queried: false,
        query: trimmedQuery,
        retrieval_backend: backend,
        memories: [],
        knowledge: [],
        total_context_tokens: 0,
      };
    }

    const terms = extractQueryTerms(trimmedQuery);
    if (terms.length === 0) {
      return {
        queried: true,
        query: trimmedQuery,
        retrieval_backend: backend,
        memories: [],
        knowledge: [],
        total_context_tokens: 0,
      };
    }

    // Reserve at most ~20% of small contexts (min 120, max 480 tokens) so both memory & knowledge fit safely
    const totalTokenBudget = Math.min(480, Math.max(120, Math.floor(contextLength * 0.2)));
    const memoryTokenBudget = includeKnowledge ? Math.floor(totalTokenBudget * 0.45) : totalTokenBudget;
    let usedTokens = 0;
    const memories: RetrievedMemoryItem[] = [];
    const knowledge: RetrievedKnowledgeChunk[] = [];

    const matchExpr = buildFtsMatchExpression(terms);

    if (includeMemory && maxMemoryItems > 0) {
      let memRows: Array<{
        id: string;
        namespace: string;
        category: string;
        title: string;
        content: string;
        importance: number;
        score: number;
      }> = [];

      if (ftsAvailable && matchExpr) {
        try {
          memRows = this.db
            .prepare(
              `SELECT m.id, m.namespace, m.category, m.title, m.content, m.importance,
                      (-bm25(memory_entries_fts) + (m.importance * 0.15)) AS score
               FROM memory_entries_fts f
               JOIN memory_entries m ON m.id = f.memory_id
               WHERE memory_entries_fts MATCH ? AND m.approved = 1
               ORDER BY score DESC
               LIMIT ?`
            )
            .all(matchExpr, maxMemoryItems) as typeof memRows;
        } catch {
          memRows = [];
        }
      }

      if (memRows.length === 0 && !ftsAvailable) {
        const likeClauses = terms
          .map(() => '(LOWER(title) LIKE ? OR LOWER(content) LIKE ? OR LOWER(tags_json) LIKE ?)')
          .join(' OR ');
        const params: string[] = [];
        for (const t of terms) {
          const pat = `%${t}%`;
          params.push(pat, pat, pat);
        }
        memRows = this.db
          .prepare(
            `SELECT id, namespace, category, title, content, importance, importance * 0.25 AS score
             FROM memory_entries
             WHERE approved = 1 AND (${likeClauses})
             ORDER BY importance DESC, updated_at DESC
             LIMIT ?`
          )
          .all(...params, maxMemoryItems) as typeof memRows;
      }

      for (const r of memRows) {
        const snippet = r.content.slice(0, 320);
        const est = inspectTokensServer(`${r.title}: ${snippet}`, contextLength).token_count + 6;
        if (usedTokens + est > memoryTokenBudget && memories.length > 0) break;
        if (usedTokens + est > totalTokenBudget && memories.length > 0) break;
        usedTokens += est;
        memories.push({
          id: r.id,
          namespace: r.namespace,
          category: r.category || 'fact',
          title: r.title,
          content: snippet,
          importance: r.importance,
          score: Number((r.score || 0).toFixed(3)),
        });
      }
    }

    if (includeKnowledge && maxKnowledgeChunks > 0) {
      let chunkRows: Array<{
        chunk_id: string;
        document_id: string;
        document_title: string;
        source_type: string;
        chunk_index: number;
        content: string;
        score: number;
      }> = [];

      if (ftsAvailable && matchExpr) {
        try {
          chunkRows = this.db
            .prepare(
              `SELECT c.id AS chunk_id, c.document_id, d.title AS document_title,
                      d.source_type, c.chunk_index, c.content,
                      (-bm25(knowledge_chunks_fts)) AS score
               FROM knowledge_chunks_fts f
               JOIN knowledge_chunks c ON c.id = f.chunk_id
               JOIN knowledge_documents d ON d.id = c.document_id
               WHERE knowledge_chunks_fts MATCH ?
               ORDER BY score DESC
               LIMIT ?`
            )
            .all(matchExpr, maxKnowledgeChunks) as typeof chunkRows;
        } catch {
          chunkRows = [];
        }
      }

      if (chunkRows.length === 0 && !ftsAvailable) {
        const likeClauses = terms
          .map(() => '(LOWER(d.title) LIKE ? OR LOWER(c.content) LIKE ? OR LOWER(d.tags_json) LIKE ?)')
          .join(' OR ');
        const params: string[] = [];
        for (const t of terms) {
          const pat = `%${t}%`;
          params.push(pat, pat, pat);
        }
        chunkRows = this.db
          .prepare(
            `SELECT c.id AS chunk_id, c.document_id, d.title AS document_title,
                    d.source_type, c.chunk_index, c.content, 1.0 AS score
             FROM knowledge_chunks c
             JOIN knowledge_documents d ON d.id = c.document_id
             WHERE (${likeClauses})
             ORDER BY d.updated_at DESC, c.chunk_index ASC
             LIMIT ?`
          )
          .all(...params, maxKnowledgeChunks) as typeof chunkRows;
      }

      for (const r of chunkRows) {
        let snippet = r.content.slice(0, 480);
        let est =
          inspectTokensServer(`${r.document_title}: ${snippet}`, contextLength).token_count + 8;
        if (usedTokens + est > totalTokenBudget) {
          if (knowledge.length === 0 && totalTokenBudget - usedTokens >= 40) {
            const availTokens = Math.max(24, totalTokenBudget - usedTokens - 12);
            snippet = snippet.slice(0, availTokens * 3);
            est = inspectTokensServer(`${r.document_title}: ${snippet}`, contextLength).token_count + 8;
          } else {
            break;
          }
        }
        usedTokens += est;
        knowledge.push({
          chunk_id: r.chunk_id,
          document_id: r.document_id,
          document_title: r.document_title,
          source_type: r.source_type || 'note',
          chunk_index: r.chunk_index,
          content: snippet,
          score: Number((r.score || 0).toFixed(3)),
        });
      }
    }

    return {
      queried: true,
      query: trimmedQuery,
      retrieval_backend: backend,
      memories,
      knowledge,
      total_context_tokens: usedTokens,
    };
  }
}

export function formatRetrievedSystemContext(retrieval: RetrievalResult): string | undefined {
  if (retrieval.memories.length === 0 && retrieval.knowledge.length === 0) {
    return undefined;
  }

  const lines: string[] = [
    'Use the following verified local User Memory and Knowledge Base excerpts only when relevant. Do not invent facts beyond what is explicitly provided.',
  ];

  if (retrieval.memories.length > 0) {
    lines.push('', '[Approved User Memory]');
    for (const m of retrieval.memories) {
      lines.push(`- (${m.category}/${m.namespace}) ${m.title}: ${m.content}`);
    }
  }

  if (retrieval.knowledge.length > 0) {
    lines.push('', '[Knowledge Base Excerpts]');
    for (const k of retrieval.knowledge) {
      lines.push(`- (${k.document_title} #chunk-${k.chunk_index}): ${k.content}`);
    }
  }

  return lines.join('\n');
}

export function searchConversationHistory(
  db: DatabaseSync,
  query: string,
  limit = 20
): Array<{
  message_id: string;
  conversation_id: string;
  conversation_title: string;
  role: string;
  snippet: string;
  created_at: string;
}> {
  const trimmed = (query || '').trim();
  if (!trimmed) return [];
  const pat = `%${trimmed.toLowerCase()}%`;
  const rows = db
    .prepare(
      `SELECT m.id AS message_id, m.conversation_id, c.title AS conversation_title,
              m.role, m.content, m.created_at
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE LOWER(m.content) LIKE ? OR LOWER(c.title) LIKE ?
       ORDER BY m.created_at DESC
       LIMIT ?`
    )
    .all(pat, pat, Math.min(50, Math.max(1, limit))) as Array<{
    message_id: string;
    conversation_id: string;
    conversation_title: string;
    role: string;
    content: string;
    created_at: string;
  }>;

  return rows.map((r) => ({
    message_id: r.message_id,
    conversation_id: r.conversation_id,
    conversation_title: r.conversation_title,
    role: r.role,
    snippet: r.content.slice(0, 260),
    created_at: r.created_at,
  }));
}
