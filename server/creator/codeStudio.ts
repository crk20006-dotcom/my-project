import vm from 'node:vm';
import { inspectTokensServer } from '../ai/interfaces.ts';
import { detectSensitiveSecret } from '../ai/memoryRetrieval.ts';

export type SupportedCodeLanguage =
  | 'python'
  | 'javascript'
  | 'typescript'
  | 'html'
  | 'css'
  | 'c'
  | 'cpp';

export const SUPPORTED_CODE_LANGUAGES: SupportedCodeLanguage[] = [
  'python',
  'javascript',
  'typescript',
  'html',
  'css',
  'c',
  'cpp',
];

export interface CodeDiagnostic {
  line: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  rule: string;
}

export interface CodeAnalysisResult {
  language: SupportedCodeLanguage;
  metrics: {
    lines: number;
    non_empty_lines: number;
    comment_lines: number;
    bytes: number;
    baseline_tokens: number;
    symbols_detected: string[];
    max_nesting_depth: number;
  };
  diagnostics: CodeDiagnostic[];
  explanation: string[];
  refactoring_suggestions: string[];
  sandbox_runnable: boolean;
}

export interface RestrictedCodeRunResult {
  ok: boolean;
  requires_approval?: boolean;
  stdout: string[];
  result: string;
  duration_ms: number;
  error?: string;
}

function checkBalancedDelimiters(code: string): CodeDiagnostic[] {
  const diagnostics: CodeDiagnostic[] = [];
  const stack: Array<{ char: string; line: number }> = [];
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const closers = new Set([')', ']', '}']);

  let line = 1;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let escaped = false;

  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '\n') {
      line += 1;
      escaped = false;
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (!inDouble && !inBacktick && ch === "'" && code[i - 1] !== '\\') {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && !inBacktick && ch === '"' && code[i - 1] !== '\\') {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && ch === '`') {
      inBacktick = !inBacktick;
      continue;
    }
    if (inSingle || inDouble || inBacktick) {
      continue;
    }

    if (pairs[ch]) {
      stack.push({ char: ch, line });
    } else if (closers.has(ch)) {
      const top = stack.pop();
      if (!top) {
        diagnostics.push({
          line,
          severity: 'error',
          message: `Unmatched closing delimiter '${ch}'.`,
          rule: 'balanced-delimiters',
        });
      } else if (pairs[top.char] !== ch) {
        diagnostics.push({
          line,
          severity: 'error',
          message: `Mismatched delimiter: opened '${top.char}' at line ${top.line}, closed with '${ch}'.`,
          rule: 'balanced-delimiters',
        });
      }
    }
  }

  for (const unclosed of stack) {
    diagnostics.push({
      line: unclosed.line,
      severity: 'error',
      message: `Unclosed '${unclosed.char}' opened at line ${unclosed.line}.`,
      rule: 'balanced-delimiters',
    });
  }

  return diagnostics;
}

export function analyzeCode(languageInput: string, code: string): CodeAnalysisResult {
  const language = (SUPPORTED_CODE_LANGUAGES.includes(languageInput as SupportedCodeLanguage)
    ? languageInput
    : 'python') as SupportedCodeLanguage;

  const lines = code.split(/\r?\n/);
  const nonEmptyLines = lines.filter((l) => l.trim().length > 0);
  const tokenInfo = inspectTokensServer(code, 16384);
  const diagnostics: CodeDiagnostic[] = [];
  const symbols: string[] = [];
  const refactoring: string[] = [];
  let commentLines = 0;
  let maxDepth = 0;
  let currentDepth = 0;

  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx];
    const trimmed = raw.trim();
    const lineNum = idx + 1;

    if (
      trimmed.startsWith('#') ||
      trimmed.startsWith('//') ||
      trimmed.startsWith('/*') ||
      trimmed.startsWith('*') ||
      trimmed.startsWith('<!--')
    ) {
      commentLines += 1;
    }

    for (const ch of raw) {
      if (ch === '{') {
        currentDepth += 1;
        if (currentDepth > maxDepth) maxDepth = currentDepth;
      } else if (ch === '}') {
        currentDepth = Math.max(0, currentDepth - 1);
      }
    }

    if (language === 'python') {
      const indentMatch = raw.match(/^( +|\t+)/);
      if (indentMatch && raw.startsWith(' ') && raw.includes('\t')) {
        diagnostics.push({
          line: lineNum,
          severity: 'error',
          message: 'Mixed tabs and spaces in indentation.',
          rule: 'py-indentation',
        });
      }
      const pySym = trimmed.match(/^(?:async\s+)?(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (pySym) {
        symbols.push(pySym[1]);
        if (!trimmed.endsWith(':') && !trimmed.includes('#')) {
          diagnostics.push({
            line: lineNum,
            severity: 'warning',
            message: `Declaration '${pySym[1]}' may be missing a trailing ':' or spans multiple lines.`,
            rule: 'py-colon',
          });
        }
      }
      if (/^except\s*:\s*$/.test(trimmed)) {
        diagnostics.push({
          line: lineNum,
          severity: 'warning',
          message: "Bare 'except:' catches system-exiting exceptions; catch a specific exception type.",
          rule: 'py-bare-except',
        });
      }
      if (/\b(?:eval|exec)\s*\(/.test(trimmed)) {
        diagnostics.push({
          line: lineNum,
          severity: 'warning',
          message: 'Dynamic eval()/exec() detected; prefer explicit parsers or safe dispatch.',
          rule: 'security-dynamic-eval',
        });
      }
      const leadingSpaces = raw.match(/^ */)?.[0].length || 0;
      const pyDepth = Math.floor(leadingSpaces / 4);
      if (pyDepth > maxDepth) maxDepth = pyDepth;
    }

    if (language === 'javascript' || language === 'typescript') {
      const jsFn = trimmed.match(
        /^(?:export\s+)?(?:async\s+)?(?:function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/
      );
      if (jsFn) symbols.push(jsFn[1]);
      const constFn = trimmed.match(/^(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s+)?(?:\(|[A-Za-z_])/);
      if (constFn) symbols.push(constFn[1]);

      if (/\bvar\s+/.test(trimmed)) {
        diagnostics.push({
          line: lineNum,
          severity: 'warning',
          message: "Prefer 'const' or 'let' over 'var' for block scoping.",
          rule: 'js-no-var',
        });
      }
      if (language === 'typescript' && /:\s*any\b/.test(trimmed)) {
        diagnostics.push({
          line: lineNum,
          severity: 'warning',
          message: "Explicit 'any' weakens type safety; use 'unknown' or a narrower interface.",
          rule: 'ts-no-any',
        });
      }
      if (/\b(?:eval|new\s+Function)\s*\(/.test(trimmed)) {
        diagnostics.push({
          line: lineNum,
          severity: 'warning',
          message: 'Dynamic code evaluation detected; blocked in Genesis sandbox.',
          rule: 'security-dynamic-eval',
        });
      }
    }

    if (language === 'c' || language === 'cpp') {
      const cSym = trimmed.match(
        /^(?:[A-Za-z_][A-Za-z0-9_:*&<> ]+\s+)([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*\{?/
      );
      if (cSym && !['if', 'for', 'while', 'switch', 'return'].includes(cSym[1])) {
        symbols.push(cSym[1]);
      }
      const unsafeMatch = trimmed.match(/\b(gets|strcpy|strcat|sprintf|vsprintf)\s*\(/);
      if (unsafeMatch) {
        diagnostics.push({
          line: lineNum,
          severity: 'warning',
          message: `Bounded alternative recommended for '${unsafeMatch[1]}()' (e.g., fgets/snprintf/strncpy) to prevent buffer overflow.`,
          rule: 'c-bounded-buffers',
        });
      }
      if (language === 'cpp' && /^using\s+namespace\s+std\s*;/.test(trimmed)) {
        diagnostics.push({
          line: lineNum,
          severity: 'info',
          message: "Avoid 'using namespace std;' in headers; qualify 'std::' explicitly.",
          rule: 'cpp-namespace-hygiene',
        });
      }
    }

    if (language === 'html') {
      const idMatch = trimmed.match(/<([a-zA-Z][a-zA-Z0-9-]*)\b/);
      if (idMatch && !symbols.includes(`<${idMatch[1]}>`) && symbols.length < 15) {
        symbols.push(`<${idMatch[1]}>`);
      }
      if (/<img\b(?![^>]*\balt=)/i.test(trimmed)) {
        diagnostics.push({
          line: lineNum,
          severity: 'warning',
          message: '<img> tag is missing an alt attribute for accessibility.',
          rule: 'html-img-alt',
        });
      }
      if (/<script\b/i.test(trimmed)) {
        diagnostics.push({
          line: lineNum,
          severity: 'info',
          message: 'Inline <script> tags are disabled inside Genesis sandboxed HTML preview.',
          rule: 'html-sandbox-preview',
        });
      }
    }

    if (language === 'css') {
      const selMatch = trimmed.match(/^([.#a-zA-Z@][^{]+)\{/);
      if (selMatch && symbols.length < 20) {
        symbols.push(selMatch[1].trim());
      }
      if (trimmed.includes('!important')) {
        diagnostics.push({
          line: lineNum,
          severity: 'info',
          message: "Avoid '!important' when specificity can be kept clean.",
          rule: 'css-specificity',
        });
      }
    }
  }

  // Real JS syntax parsing via Node vm.Script
  if (language === 'javascript') {
    try {
      new vm.Script(code);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'JavaScript syntax error';
      diagnostics.push({
        line: 1,
        severity: 'error',
        message: `JS Syntax Parse Error: ${msg}`,
        rule: 'js-vm-parse',
      });
    }
  } else if (language !== 'html') {
    diagnostics.push(...checkBalancedDelimiters(code));
  }

  const secretHit = detectSensitiveSecret(code);
  if (secretHit) {
    diagnostics.push({
      line: 1,
      severity: 'error',
      message: `Potential hardcoded secret detected (${secretHit}). Move secrets to environment variables.`,
      rule: 'secret-hygiene',
    });
  }

  if (language === 'c' && /\bmalloc\s*\(/.test(code) && !/\bfree\s*\(/.test(code)) {
    diagnostics.push({
      line: 1,
      severity: 'warning',
      message: 'Dynamic allocation via malloc() detected without a matching free() in this file.',
      rule: 'c-memory-lifecycle',
    });
  }

  if (language === 'c' || language === 'cpp') {
    if (/\bmain\s*\(/.test(code) && !/#include\s*[<"]/.test(code)) {
      diagnostics.push({
        line: 1,
        severity: 'info',
        message: 'Program defines main() without any #include directives.',
        rule: 'c-headers',
      });
    }
  }

  if (maxDepth >= 4) {
    refactoring.push(
      `Maximum nesting depth is ${maxDepth}; extract helper functions or use early returns to simplify control flow.`
    );
  }
  if (nonEmptyLines.length > 0 && commentLines === 0) {
    refactoring.push('Add brief docstrings or inline comments explaining public interfaces and invariants.');
  }
  if (diagnostics.some((d) => d.severity === 'error')) {
    refactoring.push('Resolve reported syntax/delimiter errors before exporting or executing.');
  }
  if (diagnostics.some((d) => d.severity === 'warning')) {
    refactoring.push('Address static security/hygiene warnings (e.g., exception handling, bounded functions, or strict types).');
  }
  if (refactoring.length === 0) {
    refactoring.push('Structure looks clean. Consider adding unit tests and edge-case validation.');
  }

  const explanation = [
    `Language: ${language.toUpperCase()} · ${lines.length} total lines (${nonEmptyLines.length} non-empty, ${commentLines} comments).`,
    symbols.length > 0
      ? `Detected symbols/blocks: ${symbols.slice(0, 12).join(', ')}${symbols.length > 12 ? ` (+${symbols.length - 12} more)` : ''}.`
      : 'No top-level functions, classes, or selectors detected yet.',
    `Token budget estimate: ${tokenInfo.token_count} baseline tokens (${tokenInfo.byte_count} UTF-8 bytes).`,
  ];

  return {
    language,
    metrics: {
      lines: lines.length,
      non_empty_lines: nonEmptyLines.length,
      comment_lines: commentLines,
      bytes: tokenInfo.byte_count,
      baseline_tokens: tokenInfo.token_count,
      symbols_detected: symbols,
      max_nesting_depth: maxDepth,
    },
    diagnostics,
    explanation,
    refactoring_suggestions: refactoring,
    sandbox_runnable: language === 'javascript',
  };
}

export function runRestrictedJavaScript(code: string, approved: boolean): RestrictedCodeRunResult {
  if (!approved) {
    return {
      ok: false,
      requires_approval: true,
      stdout: [],
      result: '',
      duration_ms: 0,
      error: 'Explicit operator approval (approved: true) is required before executing code in the sandbox.',
    };
  }

  if (!code.trim()) {
    return {
      ok: false,
      stdout: [],
      result: '',
      duration_ms: 0,
      error: 'Code snippet is empty.',
    };
  }

  if (code.length > 16000) {
    return {
      ok: false,
      stdout: [],
      result: '',
      duration_ms: 0,
      error: 'Code exceeds 16 KB restricted sandbox execution limit.',
    };
  }

  const secret = detectSensitiveSecret(code);
  if (secret) {
    return {
      ok: false,
      stdout: [],
      result: '',
      duration_ms: 0,
      error: `Blocked by secret hygiene check (${secret}).`,
    };
  }

  const blockedPatterns = [
    /\brequire\s*\(/,
    /\bprocess\b/,
    /\bglobalThis\b/,
    /\bchild_process\b/,
    /\bimport\s*\(/,
    /\beval\s*\(/,
    /\bFunction\s*\(/,
    /\bfetch\s*\(/,
  ];
  for (const pat of blockedPatterns) {
    if (pat.test(code)) {
      return {
        ok: false,
        stdout: [],
        result: '',
        duration_ms: 0,
        error: `Blocked by restricted sandbox policy: disallowed symbol matching ${pat.source}.`,
      };
    }
  }

  const stdout: string[] = [];
  const capture = (...args: unknown[]) => {
    if (stdout.length < 100) {
      stdout.push(
        args
          .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
          .join(' ')
          .slice(0, 500)
      );
    }
  };

  const sandbox = {
    console: { log: capture, warn: capture, error: capture },
    Math,
    JSON,
    Date,
    Array,
    Object,
    String,
    Number,
    Boolean,
  };

  const started = Date.now();
  try {
    const context = vm.createContext(sandbox);
    const script = new vm.Script(code, { filename: 'genesis-creator-sandbox.js' });
    const raw = script.runInContext(context, { timeout: 1200 });
    const duration_ms = Date.now() - started;
    const formatted =
      raw === undefined
        ? '(undefined)'
        : typeof raw === 'string'
          ? raw
          : JSON.stringify(raw, null, 2);
    return {
      ok: true,
      stdout,
      result: formatted.slice(0, 4000),
      duration_ms,
    };
  } catch (err) {
    return {
      ok: false,
      stdout,
      result: '',
      duration_ms: Date.now() - started,
      error: err instanceof Error ? err.message : 'Sandbox runtime error.',
    };
  }
}

export function generateStarterTemplate(language: SupportedCodeLanguage, topic = 'Genesis Module'): string {
  const safeName = topic.replace(/[^a-zA-Z0-9_ ]/g, '').trim() || 'Genesis Module';
  switch (language) {
    case 'python':
      return `"""${safeName} — Local Python Module."""\nfrom dataclasses import dataclass\n\n\n@dataclass\nclass TaskResult:\n    name: str\n    status: str\n\n\ndef run_pipeline(item: str) -> TaskResult:\n    cleaned = item.strip()\n    return TaskResult(name=cleaned or "default", status="ready")\n\n\nif __name__ == "__main__":\n    print(run_pipeline("${safeName}"))\n`;
    case 'javascript':
      return `// ${safeName} — JavaScript Module\nfunction processItems(items) {\n  if (!Array.isArray(items)) return [];\n  return items.map((item, idx) => ({ index: idx, label: String(item).trim() }));\n}\n\nconst output = processItems(["Genesis", "Creator", "Studio"]);\nconsole.log("Processed:", output.length);\noutput;\n`;
    case 'typescript':
      return `// ${safeName} — TypeScript Module\nexport interface CreatorMetric {\n  label: string;\n  value: number;\n}\n\nexport function summarizeMetrics(metrics: CreatorMetric[]): number {\n  return metrics.reduce((acc, item) => acc + item.value, 0);\n}\n`;
    case 'html':
      return `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8" />\n  <title>${safeName}</title>\n  <style>\n    body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; padding: 2rem; }\n    .card { max-width: 640px; border: 1px solid #334155; border-radius: 12px; padding: 1.5rem; background: #1e293b; }\n  </style>\n</head>\n<body>\n  <main class="card">\n    <h1>${safeName}</h1>\n    <p>Sandboxed local HTML prototype authored in Genesis Creator Studio.</p>\n  </main>\n</body>\n</html>\n`;
    case 'css':
      return `/* ${safeName} — Stylesheet */\n:root {\n  --surface-bg: #0f172a;\n  --surface-card: #111827;\n  --accent: #3b82f6;\n}\n\n.genesis-panel {\n  background-color: var(--surface-card);\n  border: 1px solid rgba(255, 255, 255, 0.08);\n  border-radius: 12px;\n  padding: 1.25rem;\n}\n`;
    case 'c':
      return `/* ${safeName} — C99 Source */\n#include <stdio.h>\n#include <string.h>\n\nint main(void) {\n    char title[64];\n    snprintf(title, sizeof(title), "%s", "${safeName}");\n    printf("Project Genesis C Module: %s\\n", title);\n    return 0;\n}\n`;
    case 'cpp':
      return `// ${safeName} — C++17 Source\n#include <iostream>\n#include <string>\n#include <vector>\n\nint main() {\n    const std::string title = "${safeName}";\n    std::vector<std::string> stages = {"Parse", "Analyze", "Export"};\n    std::cout << title << " (" << stages.size() << " stages)" << std::endl;\n    return 0;\n}\n`;
  }
}
