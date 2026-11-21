import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractMarkdownFromDocxBuffer, parseDocumentBlocks } from '../creator/documentStudio.ts';
import type { DocumentExtractionResult } from './interfaces.ts';

const MAX_PDF_PAGES_TO_EXTRACT = 40;
const MAX_EXTRACTED_CHARS = 120_000;

export async function extractPdfTextFromBuffer(
  buf: Buffer,
  filename: string
): Promise<DocumentExtractionResult> {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buf),
    useWorkerFetch: false,
    disableFontFace: true,
    verbosity: 0,
  });

  const doc = await loadingTask.promise;
  try {
    const totalPages = doc.numPages;
    const pagesToRead = Math.min(totalPages, MAX_PDF_PAGES_TO_EXTRACT);
    const pageTexts: string[] = [];
    let totalChars = 0;

    for (let p = 1; p <= pagesToRead; p += 1) {
      const page = await doc.getPage(p);
      try {
        const textContent = await page.getTextContent();
        let lineBuffer = '';
        let lastY: number | null = null;
        const lines: string[] = [];

        for (const item of textContent.items) {
          if (!('str' in item)) continue;
          const textItem = item as { str: string; transform?: number[]; hasEOL?: boolean };
          const currentY = Array.isArray(textItem.transform) ? Math.round(textItem.transform[5]) : null;
          if (lastY !== null && currentY !== null && Math.abs(currentY - lastY) > 3 && lineBuffer.trim()) {
            lines.push(lineBuffer.trim());
            lineBuffer = '';
          }
          lineBuffer += (lineBuffer && !lineBuffer.endsWith(' ') && !textItem.str.startsWith(' ') ? ' ' : '') + textItem.str;
          lastY = currentY;
          if (textItem.hasEOL && lineBuffer.trim()) {
            lines.push(lineBuffer.trim());
            lineBuffer = '';
          }
        }
        if (lineBuffer.trim()) lines.push(lineBuffer.trim());

        const pageBody = lines.join('\n').trim();
        if (pageBody) {
          const section = pagesToRead > 1 ? `## Page ${p}\n\n${pageBody}` : pageBody;
          pageTexts.push(section);
          totalChars += section.length;
        }
        if (totalChars >= MAX_EXTRACTED_CHARS) break;
      } finally {
        page.cleanup();
      }
    }

    const combined = pageTexts.join('\n\n').slice(0, MAX_EXTRACTED_CHARS);
    const words = combined.trim() ? combined.trim().split(/\s+/).length : 0;
    const lines = combined ? combined.split('\n').length : 0;
    const blocks = parseDocumentBlocks(combined);

    return {
      ok: true,
      format: 'pdf',
      filename,
      extracted_text:
        combined || '(PDF contains no selectable text layer — convert scanned pages to PNG/JPG for OCR.)',
      page_count: totalPages,
      metrics: {
        chars: combined.length,
        words,
        lines,
        headings: blocks.filter((b) => b.type === 'heading').length,
        lists: blocks.filter((b) => b.type === 'list').length,
        tables: blocks.filter((b) => b.type === 'table').length,
        code_blocks: blocks.filter((b) => b.type === 'code').length,
      },
      note:
        totalPages > pagesToRead
          ? `Extracted first ${pagesToRead} of ${totalPages} PDF pages cleanly.`
          : combined
            ? undefined
            : 'No embedded text stream found (likely a scanned image-only PDF).',
    };
  } finally {
    const cleanable = doc as unknown as {
      destroy?: () => Promise<void>;
      cleanup?: () => Promise<void> | void;
    };
    if (typeof cleanable.destroy === 'function') {
      await cleanable.destroy();
    } else if (typeof cleanable.cleanup === 'function') {
      await cleanable.cleanup();
    }
  }
}

export async function extractDocumentContent(
  buf: Buffer,
  filename: string,
  ext: string
): Promise<DocumentExtractionResult> {
  const lower = ext.toLowerCase();

  if (lower === '.pdf') {
    return extractPdfTextFromBuffer(buf, filename);
  }

  let text = '';
  let format: 'docx' | 'txt' | 'md' = 'txt';

  if (lower === '.docx') {
    format = 'docx';
    text = (await extractMarkdownFromDocxBuffer(buf)).slice(0, MAX_EXTRACTED_CHARS);
  } else {
    format = lower === '.md' ? 'md' : 'txt';
    text = buf.toString('utf-8').replace(/^\uFEFF/, '').slice(0, MAX_EXTRACTED_CHARS);
  }

  const blocks = parseDocumentBlocks(text);
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const lines = text ? text.split('\n').length : 0;

  return {
    ok: true,
    format,
    filename,
    extracted_text: text,
    metrics: {
      chars: text.length,
      words,
      lines,
      headings: blocks.filter((b) => b.type === 'heading').length,
      lists: blocks.filter((b) => b.type === 'list').length,
      tables: blocks.filter((b) => b.type === 'table').length,
      code_blocks: blocks.filter((b) => b.type === 'code').length,
    },
  };
}
