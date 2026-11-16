import * as pdfjsLib from 'pdfjs-dist';
import type { ExtractedPage } from '../types/vitaminD';

// Configure PDF.js worker using Vite's asset URL resolution
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

export interface DocumentExtractionResult {
  sourceFormat: 'pdf' | 'txt' | 'md';
  pages: ExtractedPage[];
  pageCount: number;
  totalChars: number;
  previewText: string;
}

interface PdfTextItemLike {
  str?: string;
  hasEOL?: boolean;
  transform?: number[];
}

function reconstructPageText(items: unknown[]): string {
  const lines: string[] = [];
  let currentLine = '';
  let lastY: number | null = null;

  for (const rawItem of items) {
    if (!rawItem || typeof rawItem !== 'object') continue;
    const item = rawItem as PdfTextItemLike;
    if (typeof item.str !== 'string') continue;

    const text = item.str;
    const y = Array.isArray(item.transform) && item.transform.length >= 6 ? item.transform[5] : null;

    if (y !== null && lastY !== null && Math.abs(y - lastY) > 4.5) {
      if (currentLine.trim()) {
        lines.push(currentLine.trimEnd());
      }
      currentLine = text;
    } else if (currentLine && text && !currentLine.endsWith(' ') && !text.startsWith(' ')) {
      currentLine += ` ${text}`;
    } else {
      currentLine += text;
    }

    if (item.hasEOL) {
      if (currentLine.trim()) {
        lines.push(currentLine.trimEnd());
      }
      currentLine = '';
      lastY = null;
    } else if (y !== null) {
      lastY = y;
    }
  }

  if (currentLine.trim()) {
    lines.push(currentLine.trimEnd());
  }

  return lines
    .join('\n')
    .replace(/-\n([a-záéíóúñ])/gi, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function extractDocumentFile(
  file: File,
  onProgress?: (currentPage: number, totalPages: number) => void
): Promise<DocumentExtractionResult> {
  const lowerName = file.name.toLowerCase();

  if (lowerName.endsWith('.txt') || lowerName.endsWith('.md') || lowerName.endsWith('.markdown')) {
    const rawText = await file.text();
    const cleaned = rawText
      .replace(/\r\n?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    if (!cleaned) {
      throw new Error('El archivo de texto no contiene contenido legible.');
    }

    const sourceFormat: 'txt' | 'md' = lowerName.endsWith('.txt') ? 'txt' : 'md';
    return {
      sourceFormat,
      pages: [{ pageNumber: null, text: cleaned }],
      pageCount: 1,
      totalChars: cleaned.length,
      previewText: cleaned.slice(0, 600),
    };
  }

  if (!lowerName.endsWith('.pdf') && file.type !== 'application/pdf') {
    throw new Error('Formato no compatible. Sube únicamente archivos PDF (.pdf), TXT (.txt) o Markdown (.md).');
  }

  const buffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
  });

  let pdfDocument: pdfjsLib.PDFDocumentProxy;
  try {
    pdfDocument = await loadingTask.promise;
  } catch (err) {
    const message = err instanceof Error ? err.message.toLowerCase() : '';
    if (message.includes('password') || message.includes('encrypted')) {
      throw new Error('El PDF está protegido con contraseña o cifrado y no se puede extraer su texto.');
    }
    throw new Error('No se pudo leer el archivo PDF. Verifica que no esté dañado.');
  }

  const pages: ExtractedPage[] = [];
  let totalChars = 0;

  try {
    const totalPages = pdfDocument.numPages;
    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      onProgress?.(pageNum, totalPages);
      const page = await pdfDocument.getPage(pageNum);
      const textContent = await page.getTextContent();
      const pageText = reconstructPageText(textContent.items as unknown[]);
      if (pageText.length > 0) {
        pages.push({ pageNumber: pageNum, text: pageText });
        totalChars += pageText.length;
      }
      page.cleanup();
    }
  } finally {
    await pdfDocument.cleanup();
    await loadingTask.destroy();
  }

  if (pages.length === 0 || totalChars < 30) {
    throw new Error(
      'No se encontró texto seleccionable en el PDF (posible documento escaneado como imagen sin OCR). Convierte el texto mediante OCR o súbelo en Markdown/TXT.'
    );
  }

  const previewText = pages
    .map((p) => (p.pageNumber ? `[Pág. ${p.pageNumber}]\n${p.text}` : p.text))
    .join('\n\n')
    .slice(0, 600);

  return {
    sourceFormat: 'pdf',
    pages,
    pageCount: pdfDocument.numPages,
    totalChars,
    previewText,
  };
}
