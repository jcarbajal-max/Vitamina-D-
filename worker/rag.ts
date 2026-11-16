import type {
  Ai,
  D1Database,
  R2Bucket,
  Vectorize,
  VectorizeVector,
} from '@cloudflare/workers-types';

export const EMBEDDING_MODEL = '@cf/baai/bge-m3' as const;
export const EMBEDDING_DIMENSIONS = 1024;

export const DOCUMENT_CATEGORIES = [
  'Bioquímica y fisiología',
  'Metabolismo de vitamina D',
  'Vitamina D2 y D3',
  'Calcidiol y calcitriol',
  'Diagnóstico y laboratorio',
  'Deficiencia y toxicidad',
  'Nutrición y prevención',
  'Suplementación y farmacología',
  'Salud ósea y metabolismo mineral',
  'Enfermedad renal',
  'Vitamina D y sistema inmunológico',
  'Vitamina D y reumatología',
  'Investigación científica',
] as const;

export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

export const PUBLICATION_TYPES = [
  { id: 'guia_clinica', label: 'Guía clínica institucional', tier: 1 },
  { id: 'revision_sistematica', label: 'Revisión sistemática / Metaanálisis', tier: 2 },
  { id: 'ensayo_clinico', label: 'Ensayo clínico controlado (ECA / RCT)', tier: 3 },
  { id: 'estudio_observacional', label: 'Estudio observacional', tier: 4 },
  { id: 'revision_narrativa', label: 'Revisión narrativa / Estudio experimental', tier: 5 },
] as const;

export type PublicationTypeId = (typeof PUBLICATION_TYPES)[number]['id'];

export interface DocumentMetadataInput {
  title: string;
  authors: string;
  publicationYear: number | null;
  journalOrInstitution: string;
  doi: string;
  pmid: string;
  referenceUrl: string;
  publicationType: PublicationTypeId;
  isHistorical: boolean;
  category: DocumentCategory;
  language: string;
  sourceFormat: 'pdf' | 'txt' | 'md';
  originalFilename: string;
}

export interface PageTextInput {
  pageNumber: number | null;
  text: string;
}

export interface DocumentChunkRecord {
  id: string;
  documentId: string;
  chunkIndex: number;
  pageNumber: number | null;
  sectionTitle: string;
  content: string;
  charCount: number;
}

export interface StoredDocumentRow {
  id: string;
  title: string;
  authors: string;
  publication_year: number | null;
  journal_or_institution: string;
  doi: string;
  pmid: string;
  reference_url: string;
  publication_type: string;
  evidence_tier: number;
  is_historical: number;
  category: string;
  language: string;
  source_format: string;
  original_filename: string;
  r2_key: string;
  content_hash: string;
  page_count: number;
  chunk_count: number;
  status: string;
  error_message: string;
  created_at: string;
  updated_at: string;
}

export interface RetrievedChunkWithDoc {
  chunkId: string;
  documentId: string;
  chunkIndex: number;
  pageNumber: number | null;
  sectionTitle: string;
  content: string;
  score: number;
  adjustedScore: number;
  document: StoredDocumentRow;
}

export interface GroundingSource {
  title: string;
  uri: string;
}

export function getEvidenceTierForType(publicationType: string): number {
  const found = PUBLICATION_TYPES.find((p) => p.id === publicationType);
  return found ? found.tier : 5;
}

export function getPublicationTypeLabel(publicationType: string): string {
  const found = PUBLICATION_TYPES.find((p) => p.id === publicationType);
  return found ? found.label : 'Documento científico';
}

export function isValidCategory(category: string): category is DocumentCategory {
  return (DOCUMENT_CATEGORIES as readonly string[]).includes(category);
}

export function isValidPublicationType(type: string): type is PublicationTypeId {
  return PUBLICATION_TYPES.some((p) => p.id === type);
}

export function timingSafeEqualStrings(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  const maxLen = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < maxLen; i++) {
    const x = i < aBytes.length ? aBytes[i] : 0;
    const y = i < bBytes.length ? bBytes[i] : 0;
    diff |= x ^ y;
  }
  return diff === 0;
}

export function cleanExtractedText(raw: string): string {
  return raw
    .normalize('NFC')
    // Remove null bytes and non-printable control characters except newline/tab
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    // Replace common PDF ligatures
    .replace(/\uFB01/g, 'fi')
    .replace(/\uFB02/g, 'fl')
    .replace(/\uFB00/g, 'ff')
    .replace(/\uFB03/g, 'ffi')
    .replace(/\uFB04/g, 'ffl')
    // Normalize non-breaking spaces and smart dashes
    .replace(/\u00A0/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // Rejoin words broken by hyphen at line ends
    .replace(/([A-Za-zÁÉÍÓÚÜÑáéíóúüñ])-\n([a-zA-Záéíóúüñ])/g, '$1$2')
    // Collapse excessive horizontal whitespace
    .replace(/[ \t]{2,}/g, ' ')
    // Collapse 3+ blank lines to 2
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function detectSectionHeading(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 120) return null;

  const mdMatch = /^#{1,4}\s+(.+)$/.exec(trimmed);
  if (mdMatch) {
    return mdMatch[1].trim().slice(0, 100);
  }

  // Numbered scientific headings (e.g., "1. Introducción", "2.1 Metabolismo")
  if (/^\d+(\.\d+)*\.?\s+[A-ZÁÉÍÓÚÑ][^\n]{2,80}$/.test(trimmed)) {
    return trimmed.slice(0, 100);
  }

  // Common biomedical section headers
  if (
    /^(abstract|resumen|introduction|introducción|background|antecedentes|methods|métodos|results|resultados|discussion|discusión|conclusions|conclusiones|recommendations|recomendaciones|clinical implications|references|referencias)$/i.test(
      trimmed.replace(/[:.]+$/, '')
    )
  ) {
    return trimmed.replace(/[:.]+$/, '');
  }

  return null;
}

export function buildSemanticChunks(
  docId: string,
  pages: PageTextInput[],
  targetChars = 1000,
  overlapChars = 180
): DocumentChunkRecord[] {
  const chunks: DocumentChunkRecord[] = [];
  let currentSection = '';
  let chunkIndex = 0;

  // Build paragraph blocks preserving page numbers and detected headings
  interface Block {
    pageNumber: number | null;
    sectionTitle: string;
    text: string;
  }

  const blocks: Block[] = [];

  for (const page of pages) {
    const cleanedPage = cleanExtractedText(page.text);
    if (!cleanedPage) continue;

    const rawParagraphs = cleanedPage.split(/\n{2,}/);
    for (const rawPara of rawParagraphs) {
      const lines = rawPara.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length === 0) continue;

      // Check if first line is a section heading
      const heading = detectSectionHeading(lines[0]);
      if (heading) {
        currentSection = heading;
        const remainder = lines.slice(1).join(' ').trim();
        if (remainder) {
          blocks.push({
            pageNumber: page.pageNumber,
            sectionTitle: currentSection,
            text: remainder,
          });
        }
        continue;
      }

      const joined = lines.join(' ').trim();
      if (joined.length > 0) {
        blocks.push({
          pageNumber: page.pageNumber,
          sectionTitle: currentSection,
          text: joined,
        });
      }
    }
  }

  if (blocks.length === 0) return [];

  let bufferText = '';
  let bufferPage: number | null = blocks[0].pageNumber;
  let bufferSection = blocks[0].sectionTitle;

  const flushChunk = () => {
    const finalContent = bufferText.trim();
    if (finalContent.length < 30 && chunks.length > 0) {
      // Merge tiny trailing fragment into previous chunk if within reasonable size
      const prev = chunks[chunks.length - 1];
      if (prev.content.length + finalContent.length + 1 <= targetChars + 350) {
        prev.content = `${prev.content}\n\n${finalContent}`;
        prev.charCount = prev.content.length;
        return;
      }
    }
    if (!finalContent) return;

    chunks.push({
      id: `${docId}_${chunkIndex}`,
      documentId: docId,
      chunkIndex,
      pageNumber: bufferPage,
      sectionTitle: bufferSection,
      content: finalContent,
      charCount: finalContent.length,
    });
    chunkIndex += 1;
  };

  const getOverlapTail = (text: string): string => {
    if (text.length <= overlapChars) return text;
    const slice = text.slice(text.length - overlapChars);
    const firstSpace = slice.indexOf(' ');
    return firstSpace > 0 ? slice.slice(firstSpace + 1).trim() : slice.trim();
  };

  for (const block of blocks) {
    // Split oversized single paragraphs along sentence boundaries
    if (block.text.length > targetChars) {
      if (bufferText.trim().length > 0) {
        flushChunk();
        bufferText = getOverlapTail(bufferText);
      }

      const sentences = block.text.split(/(?<=[.!?])\s+/);
      bufferPage = block.pageNumber;
      bufferSection = block.sectionTitle;

      for (const sentence of sentences) {
        if (!sentence.trim()) continue;
        if (bufferText.length > 0 && bufferText.length + sentence.length + 1 > targetChars) {
          flushChunk();
          const tail = getOverlapTail(bufferText);
          bufferText = tail ? `${tail} ${sentence}` : sentence;
          bufferPage = block.pageNumber;
          bufferSection = block.sectionTitle;
        } else {
          bufferText = bufferText ? `${bufferText} ${sentence}` : sentence;
        }
      }
      continue;
    }

    const sectionChanged =
      block.sectionTitle && bufferSection && block.sectionTitle !== bufferSection;

    if (
      bufferText.length > 0 &&
      (bufferText.length + block.text.length + 2 > targetChars ||
        (sectionChanged && bufferText.length >= Math.floor(targetChars * 0.45)))
    ) {
      flushChunk();
      const tail = sectionChanged ? '' : getOverlapTail(bufferText);
      bufferText = tail ? `${tail}\n\n${block.text}` : block.text;
      bufferPage = block.pageNumber;
      bufferSection = block.sectionTitle;
    } else {
      if (!bufferText) {
        bufferPage = block.pageNumber;
        bufferSection = block.sectionTitle;
      }
      bufferText = bufferText ? `${bufferText}\n\n${block.text}` : block.text;
    }
  }

  if (bufferText.trim().length > 0) {
    flushChunk();
  }

  return chunks;
}

export async function sha256Hex(text: string): Promise<string> {
  const encoded = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function createShortDocumentId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 24);
}

export async function generateBgeM3Embeddings(
  ai: Ai,
  texts: string[]
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const allEmbeddings: number[][] = [];
  const batchSize = 20;

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const result = (await ai.run(EMBEDDING_MODEL, {
      text: batch,
      truncate_inputs: true,
    })) as {
      data?: number[][];
      response?: number[][];
      shape?: number[];
    };

    const vectors = Array.isArray(result?.data)
      ? result.data
      : Array.isArray(result?.response)
        ? result.response
        : null;

    if (!vectors || vectors.length !== batch.length) {
      throw new Error('La respuesta de embeddings BGE-M3 no tuvo el formato esperado.');
    }

    for (const vec of vectors) {
      if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(
          `Dimensión de embedding incompatible: esperada ${EMBEDDING_DIMENSIONS}, recibida ${Array.isArray(vec) ? vec.length : 0}.`
        );
      }
      allEmbeddings.push(vec);
    }
  }

  return allEmbeddings;
}

export async function upsertChunksToVectorize(
  vectorIndex: Vectorize,
  chunks: DocumentChunkRecord[],
  embeddings: number[][],
  meta: DocumentMetadataInput,
  evidenceTier: number
): Promise<void> {
  if (chunks.length === 0) return;

  // Verify index dimension compatibility when describe() is available
  try {
    const info = await vectorIndex.describe();
    if (info && typeof info.dimensions === 'number' && info.dimensions !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `El índice Vectorize tiene ${info.dimensions} dimensiones, pero BGE-M3 requiere ${EMBEDDING_DIMENSIONS}.`
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('dimensiones')) throw err;
    // Ignore describe() errors in environments where describe is unsupported
  }

  const vectors: VectorizeVector[] = chunks.map((chunk, idx) => ({
    id: chunk.id,
    values: embeddings[idx],
    metadata: {
      document_id: chunk.documentId,
      chunk_index: chunk.chunkIndex,
      page_number: chunk.pageNumber ?? 0,
      category: meta.category,
      evidence_tier: evidenceTier,
      publication_year: meta.publicationYear ?? 0,
      is_historical: meta.isHistorical ? 1 : 0,
    },
  }));

  const batchSize = 100;
  for (let i = 0; i < vectors.length; i += batchSize) {
    await vectorIndex.upsert(vectors.slice(i, i + batchSize));
  }
}

export async function deleteVectorsByChunkIds(
  vectorIndex: Vectorize | undefined,
  chunkIds: string[]
): Promise<void> {
  if (!vectorIndex || chunkIds.length === 0) return;
  const batchSize = 100;
  for (let i = 0; i < chunkIds.length; i += batchSize) {
    await vectorIndex.deleteByIds(chunkIds.slice(i, i + batchSize));
  }
}

export async function findDuplicateDocument(
  db: D1Database,
  contentHash: string,
  doi: string,
  pmid: string,
  excludeId?: string
): Promise<StoredDocumentRow | null> {
  const normalizedDoi = doi.trim().toLowerCase();
  const normalizedPmid = pmid.trim();

  const candidates = await db
    .prepare(
      `SELECT * FROM documents
       WHERE content_hash = ?1
          OR (?2 != '' AND LOWER(doi) = ?2)
          OR (?3 != '' AND pmid = ?3)
       LIMIT 1`
    )
    .bind(contentHash, normalizedDoi, normalizedPmid)
    .first<StoredDocumentRow>();

  if (!candidates) return null;
  if (excludeId && candidates.id === excludeId) return null;
  return candidates;
}

export async function insertDocumentAndChunks(
  db: D1Database,
  doc: StoredDocumentRow,
  chunks: DocumentChunkRecord[]
): Promise<void> {
  const statements = [
    db
      .prepare(
        `INSERT INTO documents (
          id, title, authors, publication_year, journal_or_institution,
          doi, pmid, reference_url, publication_type, evidence_tier, is_historical,
          category, language, source_format, original_filename, r2_key,
          content_hash, page_count, chunk_count, status, error_message,
          created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)`
      )
      .bind(
        doc.id,
        doc.title,
        doc.authors,
        doc.publication_year,
        doc.journal_or_institution,
        doc.doi,
        doc.pmid,
        doc.reference_url,
        doc.publication_type,
        doc.evidence_tier,
        doc.is_historical,
        doc.category,
        doc.language,
        doc.source_format,
        doc.original_filename,
        doc.r2_key,
        doc.content_hash,
        doc.page_count,
        doc.chunk_count,
        doc.status,
        doc.error_message,
        doc.created_at,
        doc.updated_at
      ),
  ];

  for (const chunk of chunks) {
    statements.push(
      db
        .prepare(
          `INSERT INTO document_chunks (
            id, document_id, chunk_index, page_number, section_title,
            content, char_count, created_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
        )
        .bind(
          chunk.id,
          chunk.documentId,
          chunk.chunkIndex,
          chunk.pageNumber,
          chunk.sectionTitle,
          chunk.content,
          chunk.charCount,
          doc.created_at
        )
    );
  }

  // D1 batch supports up to ~100 statements comfortably per batch
  const batchSize = 50;
  for (let i = 0; i < statements.length; i += batchSize) {
    await db.batch(statements.slice(i, i + batchSize));
  }
}

export function buildDocumentCitationUrl(doc: StoredDocumentRow): string {
  if (doc.reference_url && /^https?:\/\//i.test(doc.reference_url)) {
    return doc.reference_url;
  }
  if (doc.pmid) {
    return `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(doc.pmid)}/`;
  }
  if (doc.doi) {
    const cleanDoi = doc.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
    return `https://doi.org/${cleanDoi}`;
  }
  return '';
}

export function detectQueryTopicAndRelevance(
  query: string,
  hasPriorVitaminDContext: boolean
): {
  isLikelyVitaminDRelated: boolean;
  detectedTopic: string;
} {
  const lower = query.toLowerCase();

  const vitaminDKeywords = [
    'vitamina d',
    'vitamin d',
    'colecalciferol',
    'cholecalciferol',
    'ergocalciferol',
    'calcidiol',
    'calcifediol',
    'calcitriol',
    '25(oh)d',
    '25-oh-d',
    '25-hidroxi',
    '1,25(oh)2d',
    '7-dehidrocolesterol',
    'previtamina d',
    'secosteroide',
    'cyp2r1',
    'cyp27b1',
    'cyp24a1',
    'vdr',
    'vdbp',
    'uvb',
    'raquitismo',
    'osteomalacia',
    'osteoporosis',
    'osteopenia',
    'paratohormona',
    'pth',
    'hipercalcemia',
    'hipercalciuria',
    'hipocalcemia',
    'calbindin',
    'fgf23',
    'ng/ml',
    'nmol/l',
    'nasem',
    'endocrine society',
    'demay',
    'holick',
    'vital',
    'd-health',
    'd2d',
    'vida trial',
    'ui/día',
    'ui/dia',
    'suplement',
    'deficiencia',
    'insuficiencia',
    'reumat',
    'artritis',
    'lupus',
    'esclerosis',
    'autoinmun',
    'renal',
    'erc',
    'kdigo',
    'óseo',
    'oseo',
    'calcio',
    'fósforo',
    'fosforo',
    'embarazo',
    'lactancia',
    'malabsorci',
    'celiaqu',
    'bariátric',
    'bariatric',
    'sarcoidosis',
    'fototipo',
    'melanina',
    'bibliografía',
    'bibliografia',
    'guía',
    'guia',
    'dosis',
    'ensayo',
    'estudio',
    'metaanálisis',
    'metaanalisis',
  ];

  const matched = vitaminDKeywords.some((kw) => lower.includes(kw));

  let detectedTopic = 'General sobre vitamina D';
  if (/bioqu|síntesis|sintesis|uvb|cyp2|vdr|vdbp|metabol/i.test(lower)) {
    detectedTopic = 'Bioquímica y metabolismo de la vitamina D';
  } else if (/25\(oh\)d|ng\/ml|nmol\/l|laboratorio|diagnóstico|diagnostico|pth/i.test(lower)) {
    detectedTopic = 'Diagnóstico e interpretación de 25(OH)D';
  } else if (/reumat|artritis|lupus|espondil|fibromialg/i.test(lower)) {
    detectedTopic = 'Vitamina D y reumatología';
  } else if (/inmun|autoinmun|infecci|respiratori|citoquin|linfocit/i.test(lower)) {
    detectedTopic = 'Vitamina D y sistema inmunológico';
  } else if (/renal|erc|riñón|rinon|diálisis|dialisis|kdigo/i.test(lower)) {
    detectedTopic = 'Vitamina D y enfermedad renal';
  } else if (/óseo|oseo|osteopor|osteomalac|raquit|fractur|mineral/i.test(lower)) {
    detectedTopic = 'Salud ósea y metabolismo mineral';
  } else if (/suplement|d2|d3|colecalciferol|ergocalciferol|dosis|farmac|toxicidad|hipercalcemia/i.test(lower)) {
    detectedTopic = 'Suplementación, farmacología y seguridad';
  } else if (/aliment|nutric|fortific|dieta|ingesta|idr|nasem/i.test(lower)) {
    detectedTopic = 'Nutrición y prevención';
  } else if (/guía|guia|endocrine|vital|d2d|d-health|ensayo|metaan/i.test(lower)) {
    detectedTopic = 'Evidencia científica y guías clínicas';
  }

  // Clearly off-topic patterns (only applied when no vitamin D keywords matched)
  const offTopicPattern =
    /\b(escribe un poema|receta de|pastel de|programa en (python|javascript|java|c\+\+)|resuelve esta ecuación|quién ganó el mundial|fútbol|traduce este código|cuéntame un chiste|capital de|clima en|horóscopo)\b/i;

  const isOffTopic = !matched && offTopicPattern.test(query.trim());
  const isFollowUp =
    hasPriorVitaminDContext &&
    query.trim().length <= 180 &&
    !isOffTopic;

  return {
    isLikelyVitaminDRelated: matched || isFollowUp || !isOffTopic,
    detectedTopic,
  };
}

export async function retrieveRelevantRagContext(
  ai: Ai,
  db: D1Database | undefined,
  vectorIndex: Vectorize | undefined,
  queryText: string
): Promise<{
  chunks: RetrievedChunkWithDoc[];
  sources: GroundingSource[];
  ragAvailable: boolean;
}> {
  if (!db) {
    return { chunks: [], sources: [], ragAvailable: false };
  }

  let rankedMatches: Array<{ id: string; score: number }> = [];

  if (vectorIndex) {
    try {
      const [queryVector] = await generateBgeM3Embeddings(ai, [queryText]);
      const vectorResults = await vectorIndex.query(queryVector, {
        topK: 16,
        returnMetadata: 'all',
      });

      if (Array.isArray(vectorResults?.matches)) {
        rankedMatches = vectorResults.matches
          .filter((m) => typeof m.id === 'string' && typeof m.score === 'number' && m.score >= 0.32)
          .map((m) => ({ id: m.id, score: m.score }));
      }
    } catch {
      // Fall back to D1 keyword search if Vectorize fails or is unavailable locally
    }
  }

  interface JoinedRow extends StoredDocumentRow {
    chunk_id: string;
    document_id: string;
    chunk_index: number;
    page_number: number | null;
    section_title: string;
    content: string;
  }

  let rows: JoinedRow[] = [];
  const scoreMap = new Map<string, number>();

  if (rankedMatches.length > 0) {
    for (const m of rankedMatches) {
      scoreMap.set(m.id, m.score);
    }

    const placeholders = rankedMatches.map((_, idx) => `?${idx + 1}`).join(', ');
    const sql = `
      SELECT
        c.id AS chunk_id,
        c.document_id,
        c.chunk_index,
        c.page_number,
        c.section_title,
        c.content,
        d.*
      FROM document_chunks c
      INNER JOIN documents d ON d.id = c.document_id
      WHERE c.id IN (${placeholders})
        AND d.status = 'indexed'
    `;

    try {
      const res = await db
        .prepare(sql)
        .bind(...rankedMatches.map((m) => m.id))
        .all<JoinedRow>();
      rows = Array.isArray(res.results) ? res.results : [];
    } catch {
      rows = [];
    }
  }

  // Fallback keyword search in D1 when Vectorize had no matches (e.g., local Miniflare dev)
  if (rows.length === 0) {
    const terms = queryText
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s()-]/gu, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 4)
      .slice(0, 5);

    if (terms.length > 0) {
      const likeClauses = terms
        .map((_, idx) => `(LOWER(c.content) LIKE ?${idx + 1} OR LOWER(d.title) LIKE ?${idx + 1})`)
        .join(' OR ');
      const sql = `
        SELECT
          c.id AS chunk_id,
          c.document_id,
          c.chunk_index,
          c.page_number,
          c.section_title,
          c.content,
          d.*
        FROM document_chunks c
        INNER JOIN documents d ON d.id = c.document_id
        WHERE d.status = 'indexed' AND (${likeClauses})
        ORDER BY d.evidence_tier ASC, d.is_historical ASC, d.publication_year DESC
        LIMIT 12
      `;
      try {
        const res = await db
          .prepare(sql)
          .bind(...terms.map((t) => `%${t}%`))
          .all<JoinedRow>();
        rows = Array.isArray(res.results) ? res.results : [];
      } catch {
        rows = [];
      }
    }
  }

  if (rows.length === 0) {
    return { chunks: [], sources: [], ragAvailable: true };
  }

  // Re-rank combining semantic similarity + evidence hierarchy (tier 1..5) + current vs historical
  const scored: RetrievedChunkWithDoc[] = rows.map((row) => {
    const baseScore = scoreMap.get(row.chunk_id) ?? 0.55;
    const tierBoost = (6 - Math.min(5, Math.max(1, row.evidence_tier))) * 0.035;
    const historicalPenalty = row.is_historical === 1 ? -0.06 : 0.02;
    const adjustedScore = baseScore + tierBoost + historicalPenalty;

    return {
      chunkId: row.chunk_id,
      documentId: row.document_id,
      chunkIndex: row.chunk_index,
      pageNumber: row.page_number,
      sectionTitle: row.section_title,
      content: row.content,
      score: baseScore,
      adjustedScore,
      document: row,
    };
  });

  scored.sort((a, b) => b.adjustedScore - a.adjustedScore);

  // Cap max 2 chunks per document and 6 total chunks to preserve diversity
  const selected: RetrievedChunkWithDoc[] = [];
  const docCount = new Map<string, number>();

  for (const item of scored) {
    const count = docCount.get(item.documentId) ?? 0;
    if (count >= 2) continue;
    docCount.set(item.documentId, count + 1);
    selected.push(item);
    if (selected.length >= 6) break;
  }

  const seenUrls = new Set<string>();
  const sources: GroundingSource[] = [];

  for (const item of selected) {
    const uri = buildDocumentCitationUrl(item.document);
    if (uri && !seenUrls.has(uri)) {
      seenUrls.add(uri);
      const yearLabel = item.document.publication_year
        ? ` (${item.document.publication_year})`
        : '';
      sources.push({
        title: `${item.document.title}${yearLabel} — ${item.document.journal_or_institution}`,
        uri,
      });
    }
  }

  return {
    chunks: selected,
    sources,
    ragAvailable: true,
  };
}

export function formatRagContextForPrompt(
  detectedTopic: string,
  chunks: RetrievedChunkWithDoc[]
): string {
  if (chunks.length === 0) {
    return `[CONTEXTO DE BIBLIOTECA CIENTÍFICA — BÚSQUEDA RAG]
Tema detectado: ${detectedTopic}
Resultado de recuperación: No se encontraron fragmentos suficientemente relevantes en la biblioteca documental indexada para esta consulta específica.
Instrucción obligatoria: Puedes responder usando conocimiento científico sólido del modelo sobre vitamina D, pero DEBES indicar explícitamente al inicio o en la sección de fuentes que no se recuperaron documentos pertinentes en la biblioteca documental y que la respuesta se basa en conocimiento general del modelo. No inventes referencias ni presentes documentos no consultados como fuentes recuperadas.`;
  }

  const formattedChunks = chunks.map((item, idx) => {
    const d = item.document;
    const typeLabel = getPublicationTypeLabel(d.publication_type);
    const statusLabel =
      d.is_historical === 1
        ? 'GUÍA O DOCUMENTO HISTÓRICO (NO utilizar como estándar universal vigente)'
        : 'Documento vigente / evidencia publicada';
    const refUrl = buildDocumentCitationUrl(d);

    return `---
[Fuente ${idx + 1}]
- Título: ${d.title}
- Autores: ${d.authors}
- Año: ${d.publication_year ?? 'No especificado'}
- Revista / Institución: ${d.journal_or_institution}
- Tipo y jerarquía de evidencia: ${typeLabel} (Nivel ${d.evidence_tier}/5)
- Estado: ${statusLabel}
- Categoría: ${d.category}
- DOI: ${d.doi || 'No registrado'}
- PMID: ${d.pmid || 'No registrado'}
- URL verificable: ${refUrl || 'No registrada'}
- Ubicación en documento: ${item.pageNumber ? `Página ${item.pageNumber}` : 'Página no especificada'}${item.sectionTitle ? ` · Sección: ${item.sectionTitle}` : ''}
- Extracto textual recuperado:
"""
${item.content}
"""`;
  });

  return `[CONTEXTO DE BIBLIOTECA CIENTÍFICA — BÚSQUEDA RAG]
Tema detectado: ${detectedTopic}
Se recuperaron ${chunks.length} fragmentos científicos de la biblioteca ordenados por relevancia semántica y jerarquía de evidencia:

${formattedChunks.join('\n\n')}

Instrucciones obligatorias para el uso de estas fuentes:
1. Prioriza la evidencia de guías clínicas vigentes (Nivel 1), revisiones sistemáticas/metaanálisis (Nivel 2) y ensayos clínicos controlados (Nivel 3) por encima de estudios observacionales o narrativos.
2. Si aparece un documento marcado como HISTÓRICO, explícalo únicamente como contexto histórico comparativo y nunca como guía vigente.
3. Si las fuentes recuperadas solo cubren una parte de la pregunta, complementa con conocimiento científico general del modelo aclarando explícitamente qué parte proviene de los documentos recuperados y qué parte del conocimiento general.
4. En la sección "Bibliografía consultada" al final, cita únicamente las fuentes que realmente utilizaste, mostrando título, autores/institución, año, página/sección (si existe), DOI o PMID y enlace verificable.`;
}
