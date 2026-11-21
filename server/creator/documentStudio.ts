import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { verifyZipMagicBytes } from './fileSafety.ts';

export type DocumentBlock =
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'code'; language: string; text: string }
  | { type: 'quote'; text: string }
  | { type: 'divider' };

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

function parseTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => stripInlineMarkdown(cell));
}

function isTableSeparator(line: string): boolean {
  const cleaned = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  if (!cleaned.includes('-')) return false;
  return cleaned.split('|').every((part) => /^\s*:?-{2,}:?\s*$/.test(part));
}

export function parseDocumentBlocks(markdownText: string): DocumentBlock[] {
  const lines = markdownText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const blocks: DocumentBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    if (/^```/.test(trimmed)) {
      const lang = trimmed.slice(3).trim();
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        codeLines.push(lines[i]);
        i += 1;
      }
      i += 1;
      blocks.push({ type: 'code', language: lang, text: codeLines.join('\n') });
      continue;
    }

    if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
      blocks.push({ type: 'divider' });
      i += 1;
      continue;
    }

    const hMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (hMatch) {
      blocks.push({
        type: 'heading',
        level: hMatch[1].length as 1 | 2 | 3,
        text: stripInlineMarkdown(hMatch[2]),
      });
      i += 1;
      continue;
    }

    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(stripInlineMarkdown(lines[i].trim().replace(/^>\s?/, '')));
        i += 1;
      }
      blocks.push({ type: 'quote', text: quoteLines.join(' ') });
      continue;
    }

    // Markdown table
    if (trimmed.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headers = parseTableRow(trimmed);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().includes('|') && !isTableSeparator(lines[i])) {
        rows.push(parseTableRow(lines[i]));
        i += 1;
      }
      blocks.push({ type: 'table', headers, rows });
      continue;
    }

    // Unordered or ordered list
    if (/^[-*]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
      const ordered = /^\d+\.\s+/.test(trimmed);
      const items: string[] = [];
      while (i < lines.length) {
        const cur = lines[i].trim();
        if (ordered && /^\d+\.\s+/.test(cur)) {
          items.push(stripInlineMarkdown(cur.replace(/^\d+\.\s+/, '')));
          i += 1;
        } else if (!ordered && /^[-*]\s+/.test(cur)) {
          items.push(stripInlineMarkdown(cur.replace(/^[-*]\s+/, '')));
          i += 1;
        } else {
          break;
        }
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    // Paragraph
    const paraLines: string[] = [];
    while (i < lines.length) {
      const cur = lines[i].trim();
      if (
        !cur ||
        /^#{1,3}\s+/.test(cur) ||
        /^```/.test(cur) ||
        /^[-*]\s+/.test(cur) ||
        /^\d+\.\s+/.test(cur) ||
        cur.startsWith('>') ||
        /^---+$/.test(cur) ||
        (cur.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]))
      ) {
        break;
      }
      paraLines.push(stripInlineMarkdown(cur));
      i += 1;
    }
    if (paraLines.length > 0) {
      blocks.push({ type: 'paragraph', text: paraLines.join(' ') });
    }
  }

  return blocks;
}

export function exportDocumentAsMarkdown(title: string, content: string): Buffer {
  const normalized = content.trim().startsWith('#') ? content : `# ${title}\n\n${content}`;
  return Buffer.from(normalized, 'utf-8');
}

export function exportDocumentAsText(title: string, content: string): Buffer {
  const blocks = parseDocumentBlocks(content);
  const out: string[] = [title.toUpperCase(), '='.repeat(Math.min(60, Math.max(12, title.length))), ''];

  for (const block of blocks) {
    if (block.type === 'heading') {
      out.push(block.text);
      out.push(block.level === 1 ? '='.repeat(block.text.length) : '-'.repeat(block.text.length));
      out.push('');
    } else if (block.type === 'paragraph') {
      out.push(block.text, '');
    } else if (block.type === 'quote') {
      out.push(`> ${block.text}`, '');
    } else if (block.type === 'list') {
      block.items.forEach((item, idx) => {
        out.push(block.ordered ? `${idx + 1}. ${item}` : `• ${item}`);
      });
      out.push('');
    } else if (block.type === 'table') {
      out.push(block.headers.join(' | '));
      out.push(block.headers.map((h) => '-'.repeat(Math.max(3, h.length))).join('-+-'));
      for (const row of block.rows) {
        out.push(row.join(' | '));
      }
      out.push('');
    } else if (block.type === 'code') {
      out.push(`[${block.language || 'code'}]`, block.text, '');
    } else if (block.type === 'divider') {
      out.push('------------------------------------------------------------', '');
    }
  }

  return Buffer.from(out.join('\n'), 'utf-8');
}

function buildInlineRuns(text: string, baseColor = '1E293B'): TextRun[] {
  const runs: TextRun[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      runs.push(
        new TextRun({
          text: text.slice(lastIndex, match.index),
          size: 22,
          color: baseColor,
        })
      );
    }
    const token = match[0];
    if (token.startsWith('**')) {
      runs.push(
        new TextRun({
          text: token.slice(2, -2),
          bold: true,
          size: 22,
          color: baseColor,
        })
      );
    } else {
      runs.push(
        new TextRun({
          text: token.slice(1, -1),
          font: 'Courier New',
          size: 20,
          color: '0F172A',
        })
      );
    }
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    runs.push(
      new TextRun({
        text: text.slice(lastIndex),
        size: 22,
        color: baseColor,
      })
    );
  }
  return runs.length > 0 ? runs : [new TextRun({ text, size: 22, color: baseColor })];
}

export async function exportDocumentAsDocx(
  title: string,
  author: string,
  content: string
): Promise<Buffer> {
  const blocks = parseDocumentBlocks(content);
  const children: Array<Paragraph | Table> = [];

  const firstIsH1 = blocks[0]?.type === 'heading' && blocks[0].level === 1;
  if (!firstIsH1) {
    children.push(
      new Paragraph({
        text: title,
        heading: HeadingLevel.TITLE,
        spacing: { after: 180 },
      })
    );
  }

  for (const block of blocks) {
    if (block.type === 'heading') {
      const heading =
        block.level === 1
          ? HeadingLevel.HEADING_1
          : block.level === 2
            ? HeadingLevel.HEADING_2
            : HeadingLevel.HEADING_3;
      children.push(
        new Paragraph({
          text: block.text,
          heading,
          spacing: { before: 220, after: 100 },
        })
      );
    } else if (block.type === 'paragraph') {
      children.push(
        new Paragraph({
          children: buildInlineRuns(block.text),
          spacing: { after: 120 },
        })
      );
    } else if (block.type === 'quote') {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: block.text, italics: true, color: '475569', size: 22 })],
          indent: { left: 480 },
          spacing: { after: 120 },
        })
      );
    } else if (block.type === 'list') {
      block.items.forEach((item, idx) => {
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: block.ordered ? `${idx + 1}. ` : '• ',
                bold: true,
                size: 22,
                color: '2563EB',
              }),
              new TextRun({ text: item, size: 22, color: '1E293B' }),
            ],
            indent: { left: 360 },
            spacing: { after: 60 },
          })
        );
      });
    } else if (block.type === 'table') {
      const colCount = Math.max(
        block.headers.length,
        ...block.rows.map((r) => r.length),
        1
      );
      const headerRow = new TableRow({
        tableHeader: true,
        children: Array.from({ length: colCount }, (_, idx) => {
          return new TableCell({
            shading: { type: ShadingType.CLEAR, fill: 'E2E8F0' },
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: block.headers[idx] || '',
                    bold: true,
                    size: 20,
                    color: '0F172A',
                  }),
                ],
                alignment: AlignmentType.LEFT,
              }),
            ],
          });
        }),
      });

      const bodyRows = block.rows.map(
        (r) =>
          new TableRow({
            children: Array.from({ length: colCount }, (_, idx) => {
              return new TableCell({
                children: [
                  new Paragraph({
                    children: [new TextRun({ text: r[idx] || '', size: 20, color: '1E293B' })],
                  }),
                ],
              });
            }),
          })
      );

      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          borders: {
            top: { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' },
            bottom: { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' },
            left: { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' },
            right: { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' },
            insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' },
            insideVertical: { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' },
          },
          rows: [headerRow, ...bodyRows],
        })
      );
      children.push(new Paragraph({ text: '', spacing: { after: 100 } }));
    } else if (block.type === 'code') {
      for (const codeLine of block.text.split('\n')) {
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: codeLine || ' ',
                font: 'Courier New',
                size: 19,
                color: '0F172A',
              }),
            ],
            shading: { type: ShadingType.CLEAR, fill: 'F1F5F9' },
            indent: { left: 240 },
            spacing: { after: 20 },
          })
        );
      }
      children.push(new Paragraph({ text: '', spacing: { after: 100 } }));
    } else if (block.type === 'divider') {
      children.push(
        new Paragraph({
          text: '____________________________________________________________',
          spacing: { before: 80, after: 120 },
        })
      );
    }
  }

  const doc = new Document({
    creator: author || 'Project Genesis Creator Studio',
    title,
    sections: [{ children }],
  });

  return Packer.toBuffer(doc);
}

function wrapLines(
  text: string,
  maxWidth: number,
  font: { widthOfTextAtSize: (t: string, size: number) => number },
  fontSize: number
): string[] {
  const safeText = text.replace(/[^\x20-\x7E]/g, ' ');
  const words = safeText.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];
  const result: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
      current = candidate;
    } else {
      if (current) result.push(current);
      current = word;
    }
  }
  if (current) result.push(current);
  return result;
}

export async function exportDocumentAsPdf(
  title: string,
  author: string,
  content: string
): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(title);
  pdfDoc.setAuthor(author || 'Project Genesis Creator Studio');

  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontMono = await pdfDoc.embedFont(StandardFonts.Courier);

  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const margin = 52;
  const contentWidth = pageWidth - margin * 2;
  const bottomLimit = 56;

  let page = pdfDoc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  const ensureSpace = (needed: number) => {
    if (y - needed < bottomLimit) {
      page = pdfDoc.addPage([pageWidth, pageHeight]);
      y = pageHeight - margin;
    }
  };

  // Header metadata line
  const safeTitle = title.replace(/[^\x20-\x7E]/g, ' ');
  page.drawText('PROJECT GENESIS · CREATOR STUDIO', {
    x: margin,
    y,
    size: 8.5,
    font: fontBold,
    color: rgb(0.23, 0.51, 0.96),
  });
  y -= 20;

  const blocks = parseDocumentBlocks(content);
  const firstIsH1 = blocks[0]?.type === 'heading' && blocks[0].level === 1;
  if (!firstIsH1) {
    for (const line of wrapLines(safeTitle, contentWidth, fontBold, 18)) {
      ensureSpace(24);
      page.drawText(line, { x: margin, y, size: 18, font: fontBold, color: rgb(0.06, 0.09, 0.16) });
      y -= 22;
    }
    y -= 6;
  }

  for (const block of blocks) {
    if (block.type === 'heading') {
      const size = block.level === 1 ? 16 : block.level === 2 ? 13 : 11.5;
      const lineGap = size + 5;
      y -= 6;
      for (const line of wrapLines(block.text, contentWidth, fontBold, size)) {
        ensureSpace(lineGap + 4);
        page.drawText(line, { x: margin, y, size, font: fontBold, color: rgb(0.06, 0.09, 0.16) });
        y -= lineGap;
      }
      y -= 4;
    } else if (block.type === 'paragraph') {
      for (const line of wrapLines(block.text, contentWidth, fontRegular, 10.5)) {
        ensureSpace(15);
        page.drawText(line, { x: margin, y, size: 10.5, font: fontRegular, color: rgb(0.15, 0.2, 0.28) });
        y -= 14.5;
      }
      y -= 6;
    } else if (block.type === 'quote') {
      for (const line of wrapLines(block.text, contentWidth - 18, fontRegular, 10)) {
        ensureSpace(15);
        page.drawRectangle({ x: margin + 2, y: y - 2, width: 2, height: 12, color: rgb(0.23, 0.51, 0.96) });
        page.drawText(line, { x: margin + 12, y, size: 10, font: fontRegular, color: rgb(0.3, 0.36, 0.45) });
        y -= 14;
      }
      y -= 6;
    } else if (block.type === 'list') {
      block.items.forEach((item, idx) => {
        const prefix = block.ordered ? `${idx + 1}.` : '•';
        const wrapped = wrapLines(item, contentWidth - 22, fontRegular, 10.5);
        wrapped.forEach((line, wIdx) => {
          ensureSpace(15);
          if (wIdx === 0) {
            page.drawText(prefix, { x: margin + 6, y, size: 10.5, font: fontBold, color: rgb(0.23, 0.51, 0.96) });
          }
          page.drawText(line, { x: margin + 20, y, size: 10.5, font: fontRegular, color: rgb(0.15, 0.2, 0.28) });
          y -= 14.5;
        });
      });
      y -= 6;
    } else if (block.type === 'table') {
      const colCount = Math.max(block.headers.length, 1);
      const colWidth = contentWidth / colCount;
      const rowHeight = 20;

      ensureSpace(rowHeight * 2);
      // Header row
      page.drawRectangle({
        x: margin,
        y: y - rowHeight + 4,
        width: contentWidth,
        height: rowHeight,
        color: rgb(0.9, 0.93, 0.97),
        borderColor: rgb(0.75, 0.8, 0.88),
        borderWidth: 0.75,
      });
      block.headers.forEach((h, cIdx) => {
        const cellText = (h || '').replace(/[^\x20-\x7E]/g, ' ').slice(0, 28);
        page.drawText(cellText, {
          x: margin + cIdx * colWidth + 6,
          y: y - 10,
          size: 9.5,
          font: fontBold,
          color: rgb(0.06, 0.09, 0.16),
        });
      });
      y -= rowHeight;

      for (const row of block.rows) {
        ensureSpace(rowHeight);
        page.drawRectangle({
          x: margin,
          y: y - rowHeight + 4,
          width: contentWidth,
          height: rowHeight,
          borderColor: rgb(0.82, 0.86, 0.91),
          borderWidth: 0.5,
        });
        for (let cIdx = 0; cIdx < colCount; cIdx++) {
          const cellText = (row[cIdx] || '').replace(/[^\x20-\x7E]/g, ' ').slice(0, 32);
          page.drawText(cellText, {
            x: margin + cIdx * colWidth + 6,
            y: y - 10,
            size: 9,
            font: fontRegular,
            color: rgb(0.15, 0.2, 0.28),
          });
        }
        y -= rowHeight;
      }
      y -= 10;
    } else if (block.type === 'code') {
      const codeLines = block.text.split('\n');
      for (const cl of codeLines) {
        ensureSpace(14);
        const safeCl = cl.replace(/[^\x20-\x7E]/g, ' ').slice(0, 92);
        page.drawRectangle({
          x: margin,
          y: y - 3,
          width: contentWidth,
          height: 13,
          color: rgb(0.95, 0.96, 0.98),
        });
        page.drawText(safeCl, { x: margin + 6, y, size: 9, font: fontMono, color: rgb(0.1, 0.14, 0.22) });
        y -= 13;
      }
      y -= 8;
    } else if (block.type === 'divider') {
      ensureSpace(14);
      page.drawLine({
        start: { x: margin, y },
        end: { x: margin + contentWidth, y },
        thickness: 0.75,
        color: rgb(0.8, 0.84, 0.9),
      });
      y -= 12;
    }
  }

  // Page numbers
  const pages = pdfDoc.getPages();
  pages.forEach((p, idx) => {
    p.drawText(`Page ${idx + 1} of ${pages.length}`, {
      x: pageWidth - margin - 60,
      y: 26,
      size: 8.5,
      font: fontRegular,
      color: rgb(0.45, 0.5, 0.58),
    });
  });

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

function decodeXmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

export async function extractMarkdownFromDocxBuffer(buf: Buffer): Promise<string> {
  if (!verifyZipMagicBytes(buf)) {
    throw new Error('Invalid .docx archive signature.');
  }
  const zip = await JSZip.loadAsync(buf);
  const docEntry = zip.file('word/document.xml');
  if (!docEntry) {
    throw new Error('Missing word/document.xml inside .docx file.');
  }
  const xmlBytes = await docEntry.async('uint8array');
  if (xmlBytes.byteLength > 10 * 1024 * 1024) {
    throw new Error('DOCX XML exceeds 10 MB safety limit.');
  }
  const xml = new TextDecoder('utf-8').decode(xmlBytes);

  const paragraphs: string[] = [];
  const pRegex = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  let pMatch: RegExpExecArray | null;
  while ((pMatch = pRegex.exec(xml)) !== null) {
    const pXml = pMatch[1];
    const styleMatch = pXml.match(/<w:pStyle\s+w:val="([^"]+)"/);
    const style = styleMatch?.[1] || '';

    const textParts: string[] = [];
    const tRegex = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
    let tMatch: RegExpExecArray | null;
    while ((tMatch = tRegex.exec(pXml)) !== null) {
      textParts.push(decodeXmlEntities(tMatch[1]));
    }
    const line = textParts.join('').trim();
    if (!line) continue;

    if (/Heading1|Title/i.test(style)) {
      paragraphs.push(`# ${line}`);
    } else if (/Heading2/i.test(style)) {
      paragraphs.push(`## ${line}`);
    } else if (/Heading3/i.test(style)) {
      paragraphs.push(`### ${line}`);
    } else {
      paragraphs.push(line);
    }
  }

  return paragraphs.join('\n\n') || '# Imported Document\n\n(No readable text paragraphs found.)';
}
