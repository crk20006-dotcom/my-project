import React, { useMemo, useRef } from 'react';
import { Eye, Code2 } from 'lucide-react';
import type { SupportedCodeLanguage } from '../../types/genesis';

interface CodeHighlightEditorProps {
  language: SupportedCodeLanguage;
  value: string;
  onChange: (next: string) => void;
  showHtmlPreview?: boolean;
  onToggleHtmlPreview?: () => void;
}

type TokenKind = 'plain' | 'keyword' | 'string' | 'comment' | 'number' | 'tag' | 'type';

interface TokenSegment {
  text: string;
  kind: TokenKind;
}

const KEYWORD_MAP: Record<SupportedCodeLanguage, Set<string>> = {
  python: new Set([
    'def', 'class', 'return', 'import', 'from', 'as', 'if', 'elif', 'else', 'for', 'while',
    'in', 'try', 'except', 'finally', 'with', 'async', 'await', 'yield', 'pass', 'break',
    'continue', 'True', 'False', 'None', 'and', 'or', 'not', 'is', 'lambda', 'raise',
  ]),
  javascript: new Set([
    'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'switch',
    'case', 'break', 'continue', 'try', 'catch', 'finally', 'throw', 'async', 'await',
    'class', 'extends', 'new', 'import', 'export', 'default', 'from', 'true', 'false',
    'null', 'undefined', 'typeof', 'instanceof',
  ]),
  typescript: new Set([
    'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'switch',
    'case', 'break', 'continue', 'try', 'catch', 'finally', 'throw', 'async', 'await',
    'class', 'extends', 'implements', 'interface', 'type', 'enum', 'import', 'export',
    'default', 'from', 'as', 'readonly', 'private', 'public', 'true', 'false', 'null',
    'undefined', 'string', 'number', 'boolean', 'unknown', 'void', 'never',
  ]),
  c: new Set([
    'int', 'char', 'float', 'double', 'void', 'long', 'short', 'unsigned', 'signed', 'const',
    'static', 'struct', 'typedef', 'enum', 'union', 'sizeof', 'return', 'if', 'else', 'for',
    'while', 'do', 'switch', 'case', 'break', 'continue', 'NULL',
  ]),
  cpp: new Set([
    'int', 'char', 'float', 'double', 'void', 'bool', 'auto', 'const', 'constexpr', 'static',
    'struct', 'class', 'public', 'private', 'protected', 'virtual', 'override', 'template',
    'typename', 'namespace', 'using', 'return', 'if', 'else', 'for', 'while', 'switch',
    'case', 'break', 'continue', 'nullptr', 'true', 'false', 'std', 'include',
  ]),
  html: new Set(['<!doctype', 'html', 'head', 'body', 'main', 'section', 'div', 'span', 'h1', 'h2', 'p', 'style', 'meta', 'title', 'script', 'link']),
  css: new Set(['root', 'important', 'media', 'keyframes', 'from', 'to', 'px', 'rem', 'em', 'vh', 'vw']),
};

function tokenizeLine(line: string, language: SupportedCodeLanguage): TokenSegment[] {
  if (!line) return [{ text: ' ', kind: 'plain' }];

  const segments: TokenSegment[] = [];
  const keywords = KEYWORD_MAP[language] || new Set<string>();
  let i = 0;

  const pushSegment = (text: string, kind: TokenKind) => {
    const last = segments[segments.length - 1];
    if (last && last.kind === kind) {
      last.text += text;
    } else {
      segments.push({ text, kind });
    }
  };

  while (i < line.length) {
    // Line comments
    if (
      (language === 'python' && line[i] === '#') ||
      ((language === 'javascript' || language === 'typescript' || language === 'c' || language === 'cpp') &&
        line[i] === '/' &&
        line[i + 1] === '/') ||
      ((language === 'c' || language === 'cpp' || language === 'css') &&
        line[i] === '/' &&
        line[i + 1] === '*') ||
      (language === 'html' && line.slice(i, i + 4) === '<!--')
    ) {
      pushSegment(line.slice(i), 'comment');
      break;
    }

    // C/C++ preprocessor directives
    if ((language === 'c' || language === 'cpp') && i === line.search(/\S/) && line[i] === '#') {
      pushSegment(line.slice(i), 'tag');
      break;
    }

    // HTML tags
    if (language === 'html' && line[i] === '<') {
      const endTag = line.indexOf('>', i);
      if (endTag !== -1) {
        pushSegment(line.slice(i, endTag + 1), 'tag');
        i = endTag + 1;
        continue;
      }
    }

    // Strings (' " `)
    if (line[i] === '"' || line[i] === "'" || line[i] === '`') {
      const quote = line[i];
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === '\\') {
          j += 2;
          continue;
        }
        if (line[j] === quote) {
          j += 1;
          break;
        }
        j += 1;
      }
      pushSegment(line.slice(i, j), 'string');
      i = j;
      continue;
    }

    // Numbers
    if (/[0-9]/.test(line[i]) && (i === 0 || !/[A-Za-z0-9_]/.test(line[i - 1]))) {
      let j = i + 1;
      while (j < line.length && /[0-9._xXa-fA-F]/.test(line[j])) j += 1;
      pushSegment(line.slice(i, j), 'number');
      i = j;
      continue;
    }

    // Identifiers / keywords
    if (/[A-Za-z_@]/.test(line[i])) {
      let j = i + 1;
      while (j < line.length && /[A-Za-z0-9_-]/.test(line[j])) j += 1;
      const word = line.slice(i, j);
      if (keywords.has(word) || word.startsWith('@')) {
        pushSegment(word, 'keyword');
      } else if (/^[A-Z][A-Za-z0-9_]*$/.test(word)) {
        pushSegment(word, 'type');
      } else {
        pushSegment(word, 'plain');
      }
      i = j;
      continue;
    }

    pushSegment(line[i], 'plain');
    i += 1;
  }

  return segments;
}

function tokenClassName(kind: TokenKind): string {
  switch (kind) {
    case 'keyword':
      return 'text-blue-400 font-medium';
    case 'string':
      return 'text-emerald-300';
    case 'comment':
      return 'text-slate-500 italic';
    case 'number':
      return 'text-amber-300';
    case 'tag':
      return 'text-cyan-300';
    case 'type':
      return 'text-indigo-300';
    default:
      return 'text-slate-200';
  }
}

export const CodeHighlightEditor: React.FC<CodeHighlightEditorProps> = ({
  language,
  value,
  onChange,
  showHtmlPreview = false,
  onToggleHtmlPreview,
}) => {
  const preRef = useRef<HTMLPreElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const lines = useMemo(() => value.split('\n'), [value]);
  const tokenizedLines = useMemo(
    () => lines.map((line) => tokenizeLine(line, language)),
    [lines, language]
  );

  const syncScroll = () => {
    const ta = textareaRef.current;
    if (!ta) return;
    if (preRef.current) {
      preRef.current.scrollTop = ta.scrollTop;
      preRef.current.scrollLeft = ta.scrollLeft;
    }
    if (gutterRef.current) {
      gutterRef.current.scrollTop = ta.scrollTop;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.currentTarget;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const indent = language === 'python' || language === 'c' || language === 'cpp' ? '    ' : '  ';
      const nextValue = value.slice(0, start) + indent + value.slice(end);
      onChange(nextValue);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + indent.length;
      });
    }
  };

  return (
    <div className="rounded-xl border border-white/[0.08] bg-[#080B10] overflow-hidden">
      <div className="flex items-center justify-between px-3.5 py-2 border-b border-white/[0.08] bg-[#0E131B]">
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <Code2 className="w-3.5 h-3.5 text-blue-400" />
          <span className="font-mono uppercase text-[11px] text-slate-200">{language}</span>
          <span className="text-slate-600">·</span>
          <span className="tabular-nums">{lines.length} lines</span>
        </div>
        {language === 'html' && onToggleHtmlPreview && (
          <button
            type="button"
            onClick={onToggleHtmlPreview}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs cursor-pointer transition-colors ${
              showHtmlPreview
                ? 'bg-blue-600 text-white'
                : 'bg-[#161C26] text-slate-300 hover:bg-[#1E2634]'
            }`}
          >
            <Eye className="w-3.5 h-3.5" />
            <span>{showHtmlPreview ? 'Code Editor' : 'Sandboxed Preview'}</span>
          </button>
        )}
      </div>

      {language === 'html' && showHtmlPreview ? (
        <div className="bg-white h-[400px]">
          <iframe
            title="Sandboxed HTML Prototype Preview"
            sandbox=""
            srcDoc={value}
            className="w-full h-full border-0"
          />
        </div>
      ) : (
        <div className="relative flex h-[400px] overflow-hidden">
          {/* Line numbers gutter */}
          <div
            ref={gutterRef}
            aria-hidden="true"
            className="w-12 shrink-0 py-3 px-2 bg-[#0B0F15] border-r border-white/[0.06] font-mono text-[12.5px] leading-6 text-right text-slate-600 select-none overflow-hidden tabular-nums"
          >
            {lines.map((_, idx) => (
              <div key={idx}>{idx + 1}</div>
            ))}
          </div>

          {/* Synchronized highlight layer + transparent editable textarea */}
          <div className="relative flex-1 min-w-0 h-full overflow-hidden">
            <pre
              ref={preRef}
              aria-hidden="true"
              className="absolute inset-0 m-0 py-3 px-3.5 font-mono text-[13px] leading-6 whitespace-pre overflow-hidden pointer-events-none"
            >
              {tokenizedLines.map((segs, lIdx) => (
                <div key={lIdx}>
                  {segs.map((seg, sIdx) => (
                    <span key={sIdx} className={tokenClassName(seg.kind)}>
                      {seg.text}
                    </span>
                  ))}
                </div>
              ))}
            </pre>

            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onScroll={syncScroll}
              onKeyDown={handleKeyDown}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              aria-label={`${language} source editor`}
              className="relative z-10 w-full h-full py-3 px-3.5 bg-transparent text-transparent caret-blue-400 font-mono text-[13px] leading-6 resize-none focus:outline-none overflow-auto whitespace-pre selection:bg-blue-500/30"
            />
          </div>
        </div>
      )}
    </div>
  );
};
