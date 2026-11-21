import JSZip from 'jszip';
import PptxGenJSModule from 'pptxgenjs';
import { verifyZipMagicBytes } from './fileSafety.ts';

export type SlideLayout =
  | 'title'
  | 'title_content'
  | 'two_column'
  | 'diagram'
  | 'comparison'
  | 'section';

export type PresentationThemeId =
  | 'genesis_dark'
  | 'midnight_slate'
  | 'executive_light'
  | 'blueprint_blue';

export interface SlideDiagramNode {
  id: string;
  label: string;
  role?: string;
}

export interface SlideDiagramEdge {
  from: string;
  to: string;
  label?: string;
}

export interface SlideImageAttachment {
  name: string;
  mimeType: 'image/png' | 'image/jpeg';
  dataUrl: string;
}

export interface PresentationSlide {
  id: string;
  layout: SlideLayout;
  title: string;
  subtitle?: string;
  bullets: string[];
  right_title?: string;
  right_bullets?: string[];
  notes?: string;
  image?: SlideImageAttachment;
  diagram?: {
    kind: 'architecture' | 'flow' | 'matrix';
    nodes: SlideDiagramNode[];
    edges: SlideDiagramEdge[];
  };
}

export interface PresentationDeck {
  title: string;
  subtitle: string;
  author: string;
  theme: PresentationThemeId;
  slides: PresentationSlide[];
}

interface ThemePalette {
  bg: string;
  surface: string;
  border: string;
  title: string;
  text: string;
  muted: string;
  accent: string;
}

export const PRESENTATION_THEMES: Record<PresentationThemeId, ThemePalette> = {
  genesis_dark: {
    bg: '0A0D12',
    surface: '141B26',
    border: '2A3548',
    title: 'F1F5F9',
    text: 'CBD5E1',
    muted: '94A3B8',
    accent: '3B82F6',
  },
  midnight_slate: {
    bg: '0F172A',
    surface: '1E293B',
    border: '334155',
    title: 'F8FAFC',
    text: 'E2E8F0',
    muted: '94A3B8',
    accent: '38BDF8',
  },
  executive_light: {
    bg: 'F8FAFC',
    surface: 'FFFFFF',
    border: 'CBD5E1',
    title: '0F172A',
    text: '334155',
    muted: '64748B',
    accent: '2563EB',
  },
  blueprint_blue: {
    bg: '08182E',
    surface: '0F2747',
    border: '1D4ED8',
    title: 'EFF6FF',
    text: 'DBEAFE',
    muted: '93C5FD',
    accent: '60A5FA',
  },
};

function isValidSlideImage(image: SlideImageAttachment | undefined): image is SlideImageAttachment {
  if (!image || typeof image.dataUrl !== 'string') return false;
  if (image.dataUrl.length > 4_000_000) return false;
  return (
    image.dataUrl.startsWith('data:image/png;base64,') ||
    image.dataUrl.startsWith('data:image/jpeg;base64,')
  );
}

export function normalizePresentationDeck(input: Partial<PresentationDeck>): PresentationDeck {
  const theme: PresentationThemeId =
    input.theme && PRESENTATION_THEMES[input.theme] ? input.theme : 'genesis_dark';
  const slides = Array.isArray(input.slides) && input.slides.length > 0
    ? input.slides.map((s, idx) => ({
        id: s.id || `slide-${idx + 1}`,
        layout: (['title', 'title_content', 'two_column', 'diagram', 'comparison', 'section'].includes(
          s.layout
        )
          ? s.layout
          : 'title_content') as SlideLayout,
        title: String(s.title || `Slide ${idx + 1}`),
        subtitle: typeof s.subtitle === 'string' ? s.subtitle : undefined,
        bullets: Array.isArray(s.bullets) ? s.bullets.map(String) : [],
        right_title: typeof s.right_title === 'string' ? s.right_title : undefined,
        right_bullets: Array.isArray(s.right_bullets) ? s.right_bullets.map(String) : undefined,
        notes: typeof s.notes === 'string' ? s.notes : undefined,
        image: isValidSlideImage(s.image) ? s.image : undefined,
        diagram: s.diagram && Array.isArray(s.diagram.nodes) ? s.diagram : undefined,
      }))
    : [
        {
          id: 'slide-1',
          layout: 'title' as SlideLayout,
          title: input.title || 'Untitled Presentation',
          subtitle: input.subtitle || 'Authored in Genesis Creator Studio',
          bullets: [],
        },
      ];

  return {
    title: String(input.title || 'Untitled Presentation'),
    subtitle: String(input.subtitle || ''),
    author: String(input.author || 'Local Operator'),
    theme,
    slides,
  };
}

export async function exportPresentationAsPptx(rawDeck: PresentationDeck): Promise<Buffer> {
  const deck = normalizePresentationDeck(rawDeck);
  const palette = PRESENTATION_THEMES[deck.theme];
  const PptxCtor =
    (PptxGenJSModule as unknown as { default?: typeof PptxGenJSModule }).default ||
    PptxGenJSModule;

  const pptx = new PptxCtor();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = deck.author;
  pptx.title = deck.title;
  pptx.subject = deck.subtitle || 'Project Genesis Presentation';

  deck.slides.forEach((slideData, idx) => {
    const slide = pptx.addSlide();
    slide.background = { color: palette.bg };

    // Top accent bar
    slide.addShape(pptx.ShapeType.rect, {
      x: 0,
      y: 0,
      w: 13.33,
      h: 0.08,
      fill: { color: palette.accent },
      line: { color: palette.accent, width: 0 },
    });

    if (slideData.layout === 'title' || slideData.layout === 'section') {
      slide.addShape(pptx.ShapeType.roundRect, {
        x: 0.85,
        y: 1.45,
        w: 11.6,
        h: 4.3,
        fill: { color: palette.surface },
        line: { color: palette.border, width: 1.2 },
      });
      slide.addText(slideData.title, {
        x: 1.3,
        y: 2.05,
        w: 10.7,
        h: 1.1,
        fontSize: 34,
        bold: true,
        color: palette.title,
      });
      if (slideData.subtitle) {
        slide.addText(slideData.subtitle, {
          x: 1.3,
          y: 3.2,
          w: 10.7,
          h: 0.65,
          fontSize: 16,
          color: palette.accent,
        });
      }
      if (slideData.bullets.length > 0) {
        slide.addText(
          slideData.bullets.map((b) => ({ text: b, options: { bullet: true } })),
          {
            x: 1.3,
            y: 4.0,
            w: 10.7,
            h: 1.4,
            fontSize: 14,
            color: palette.text,
          }
        );
      }
    } else {
      // Standard slide header
      slide.addText(slideData.title, {
        x: 0.7,
        y: 0.45,
        w: 11.9,
        h: 0.6,
        fontSize: 24,
        bold: true,
        color: palette.title,
      });
      if (slideData.subtitle) {
        slide.addText(slideData.subtitle, {
          x: 0.7,
          y: 1.05,
          w: 11.9,
          h: 0.38,
          fontSize: 12.5,
          color: palette.accent,
        });
      }

      if (slideData.layout === 'two_column' || slideData.layout === 'comparison') {
        const colW = 5.75;
        const leftY = 1.65;
        slide.addShape(pptx.ShapeType.roundRect, {
          x: 0.7,
          y: leftY,
          w: colW,
          h: 4.9,
          fill: { color: palette.surface },
          line: { color: palette.border, width: 1 },
        });
        slide.addShape(pptx.ShapeType.roundRect, {
          x: 6.85,
          y: leftY,
          w: colW,
          h: 4.9,
          fill: { color: palette.surface },
          line: { color: palette.border, width: 1 },
        });

        slide.addText(
          slideData.bullets.length > 0
            ? slideData.bullets.map((b) => ({ text: b, options: { bullet: true, breakLine: true } }))
            : [{ text: 'Add primary column points' }],
          {
            x: 0.95,
            y: leftY + 0.3,
            w: colW - 0.5,
            h: 4.3,
            fontSize: 14,
            color: palette.text,
            valign: 'top',
          }
        );

        if (slideData.right_title) {
          slide.addText(slideData.right_title, {
            x: 7.1,
            y: leftY + 0.25,
            w: colW - 0.5,
            h: 0.45,
            fontSize: 15,
            bold: true,
            color: palette.accent,
          });
        }
        const rightBullets = slideData.right_bullets || [];
        slide.addText(
          rightBullets.length > 0
            ? rightBullets.map((b) => ({ text: b, options: { bullet: true, breakLine: true } }))
            : [{ text: 'Add secondary column points' }],
          {
            x: 7.1,
            y: leftY + (slideData.right_title ? 0.78 : 0.3),
            w: colW - 0.5,
            h: 3.9,
            fontSize: 14,
            color: palette.text,
            valign: 'top',
          }
        );
      } else if (slideData.layout === 'diagram' && slideData.diagram && slideData.diagram.nodes.length > 0) {
        const nodes = slideData.diagram.nodes.slice(0, 6);
        const boxW = Math.min(2.6, 11.4 / nodes.length - 0.35);
        const startX = 0.8;
        const gap = (11.7 - boxW * nodes.length) / Math.max(1, nodes.length - 1);

        nodes.forEach((node, nIdx) => {
          const bx = startX + nIdx * (boxW + gap);
          slide.addShape(pptx.ShapeType.roundRect, {
            x: bx,
            y: 2.1,
            w: boxW,
            h: 1.65,
            fill: { color: palette.surface },
            line: { color: palette.accent, width: 1.5 },
          });
          slide.addText(node.label, {
            x: bx + 0.1,
            y: 2.35,
            w: boxW - 0.2,
            h: 0.7,
            fontSize: 13,
            bold: true,
            align: 'center',
            color: palette.title,
          });
          if (node.role) {
            slide.addText(node.role, {
              x: bx + 0.1,
              y: 3.05,
              w: boxW - 0.2,
              h: 0.45,
              fontSize: 10.5,
              align: 'center',
              color: palette.muted,
            });
          }

          if (nIdx < nodes.length - 1 && gap > 0.15) {
            slide.addShape(pptx.ShapeType.rightArrow, {
              x: bx + boxW + 0.05,
              y: 2.75,
              w: Math.max(0.2, gap - 0.1),
              h: 0.32,
              fill: { color: palette.accent },
              line: { color: palette.accent, width: 0 },
            });
          }
        });

        if (slideData.bullets.length > 0) {
          slide.addText(
            slideData.bullets.map((b) => ({ text: b, options: { bullet: true, breakLine: true } })),
            {
              x: 0.8,
              y: 4.35,
              w: 11.7,
              h: 2.1,
              fontSize: 13.5,
              color: palette.text,
              valign: 'top',
            }
          );
        }
      } else {
        const hasImage = isValidSlideImage(slideData.image);
        const textW = hasImage ? 6.8 : 11.9;
        slide.addShape(pptx.ShapeType.roundRect, {
          x: 0.7,
          y: 1.6,
          w: textW,
          h: 5.0,
          fill: { color: palette.surface },
          line: { color: palette.border, width: 1 },
        });
        slide.addText(
          slideData.bullets.length > 0
            ? slideData.bullets.map((b) => ({ text: b, options: { bullet: true, breakLine: true } }))
            : [{ text: 'Slide content' }],
          {
            x: 0.95,
            y: 1.85,
            w: textW - 0.5,
            h: 4.5,
            fontSize: 15,
            color: palette.text,
            valign: 'top',
          }
        );

        if (hasImage && slideData.image) {
          slide.addImage({
            data: slideData.image.dataUrl,
            x: 7.8,
            y: 1.6,
            w: 4.8,
            h: 4.2,
          });
        }
      }
    }

    if (slideData.notes) {
      slide.addNotes(slideData.notes);
    }

    slide.addText(`${deck.title} · Slide ${idx + 1}/${deck.slides.length}`, {
      x: 0.7,
      y: 7.02,
      w: 11.9,
      h: 0.3,
      fontSize: 9.5,
      color: palette.muted,
      align: 'right',
    });
  });

  const arrayBuffer = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
  return Buffer.isBuffer(arrayBuffer) ? arrayBuffer : Buffer.from(arrayBuffer);
}

export async function importUploadedPptx(filename: string, buf: Buffer): Promise<PresentationDeck> {
  if (!verifyZipMagicBytes(buf)) {
    throw new Error('Invalid .pptx archive signature.');
  }
  const zip = await JSZip.loadAsync(buf);
  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)\.xml/)?.[1] || 0);
      const nb = Number(b.match(/slide(\d+)\.xml/)?.[1] || 0);
      return na - nb;
    });

  if (slideNames.length === 0) {
    throw new Error('No slides found inside .pptx package.');
  }

  const slides: PresentationSlide[] = [];
  for (let i = 0; i < slideNames.length; i++) {
    const entry = zip.file(slideNames[i]);
    if (!entry) continue;
    const raw = await entry.async('string');
    const texts: string[] = [];
    const regex = /<a:t>([\s\S]*?)<\/a:t>/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(raw)) !== null) {
      const cleaned = match[1].trim();
      if (cleaned) texts.push(cleaned);
    }
    slides.push({
      id: `slide-${i + 1}`,
      layout: i === 0 ? 'title' : 'title_content',
      title: texts[0] || `Imported Slide ${i + 1}`,
      bullets: texts.slice(1, 10),
    });
  }

  return normalizePresentationDeck({
    title: filename.replace(/\.pptx$/i, ''),
    subtitle: 'Imported Presentation',
    theme: 'genesis_dark',
    slides,
  });
}

export function buildPresentationFromOutline(
  title: string,
  sourceNotes: string,
  theme: PresentationThemeId = 'genesis_dark'
): PresentationDeck {
  const lines = sourceNotes
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const slides: PresentationSlide[] = [
    {
      id: 'slide-1',
      layout: 'title',
      title: title || 'Genesis Presentation',
      subtitle: 'Structured Presentation Draft',
      bullets: ['Generated locally from project outline'],
    },
  ];

  let currentTitle = '';
  let currentBullets: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,3}\s+(.+)$/);
    if (headingMatch) {
      if (currentTitle) {
        slides.push({
          id: `slide-${slides.length + 1}`,
          layout: 'title_content',
          title: currentTitle,
          bullets: currentBullets.length > 0 ? currentBullets : ['Summary details'],
        });
      }
      currentTitle = headingMatch[1];
      currentBullets = [];
    } else {
      const cleaned = line.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '');
      if (cleaned) currentBullets.push(cleaned.slice(0, 180));
    }
  }

  if (currentTitle || currentBullets.length > 0) {
    slides.push({
      id: `slide-${slides.length + 1}`,
      layout: 'title_content',
      title: currentTitle || 'Key Takeaways',
      bullets: currentBullets.slice(0, 6),
    });
  }

  return normalizePresentationDeck({ title, subtitle: 'Local Draft', theme, slides });
}
