import type {
  Ai,
  D1Database,
  ExportedHandler,
  ReadableStream as CfReadableStream,
  Request as CfRequest,
  Response as CfResponse,
  Vectorize,
} from '@cloudflare/workers-types';
import { VITAMIN_D_SYSTEM_INSTRUCTION } from './systemPrompt';
import {
  DOCUMENT_CATEGORIES,
  EMBEDDING_DIMENSIONS,
  PUBLICATION_TYPES,
  appendDocumentChunks,
  buildSemanticChunks,
  cleanExtractedText,
  createShortDocumentId,
  deleteVectorsByChunkIds,
  detectQueryTopicAndRelevance,
  findDuplicateDocument,
  formatRagContextForPrompt,
  generateBgeM3Embeddings,
  getEvidenceTierForType,
  insertDocumentAndChunks,
  isValidCategory,
  isValidPublicationType,
  retrieveRelevantRagContext,
  sha256Hex,
  timingSafeEqualStrings,
  upsertChunksToVectorize,
  type DocumentMetadataInput,
  type GroundingSource,
  type PageTextInput,
  type StoredDocumentRow,
} from './rag';

export interface Env {
  AI: Ai;
  DB?: D1Database;
  VECTOR_INDEX?: Vectorize;
  ADMIN_UPLOAD_TOKEN?: string;
}

const MODEL_NAME = '@cf/google/gemma-4-26b-a4b-it' as const;

const MAX_HISTORY_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 4000;
const MAX_TOTAL_CHARS = 24000;
const MAX_NOTES_CHARS = 1000;
const MAX_ARRAY_ITEMS = 20;
const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_ADMIN_BATCH_BYTES = 2 * 1024 * 1024; // 2 MB max JSON/text payload per controlled batch
const MAX_BATCH_TEXT_CHARS = 120_000; // Controlled batch limit to stay well inside free-tier subrequest/CPU budgets

type WorkerAiMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

interface IncomingChatMessage {
  role?: unknown;
  text?: unknown;
  content?: unknown;
}

interface LabInterpretBody {
  age?: unknown;
  sex?: unknown;
  value?: unknown;
  unit?: unknown;
  pregnancyState?: unknown;
  symptoms?: unknown;
  antecedents?: unknown;
  notes?: unknown;
}

interface RiskInterpretBody {
  selectedFactors?: unknown;
  additionalContext?: unknown;
}

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
};

function jsonResponse(data: unknown, status = 200): CfResponse {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...SECURITY_HEADERS,
    },
  }) as unknown as CfResponse;
}

function sanitizeShortText(value: unknown, maxLen: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLen);
}

function sanitizeStringList(value: unknown, maxItems: number, maxItemLen: number): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      const cleaned = item.trim().slice(0, maxItemLen);
      if (cleaned.length > 0) {
        result.push(cleaned);
      }
    }
    if (result.length >= maxItems) break;
  }
  return result;
}

async function parseJsonBody<T>(
  request: CfRequest,
  maxBytes = MAX_REQUEST_BYTES
): Promise<{ ok: true; data: T } | { ok: false; response: CfResponse }> {
  const contentLengthHeader = request.headers.get('content-length');
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      return {
        ok: false,
        response: jsonResponse(
          { error: 'La solicitud excede el tamaño máximo permitido.' },
          413
        ),
      };
    }
  }

  let rawText = '';
  try {
    rawText = await request.text();
  } catch {
    return {
      ok: false,
      response: jsonResponse({ error: 'No se pudo leer el cuerpo de la solicitud.' }, 400),
    };
  }

  if (rawText.length > maxBytes) {
    return {
      ok: false,
      response: jsonResponse(
        { error: 'La solicitud excede el tamaño máximo permitido.' },
        413
      ),
    };
  }

  if (!rawText.trim()) {
    return {
      ok: false,
      response: jsonResponse({ error: 'El cuerpo JSON de la solicitud está vacío.' }, 400),
    };
  }

  try {
    const parsed = JSON.parse(rawText) as T;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        ok: false,
        response: jsonResponse({ error: 'Formato JSON inválido.' }, 400),
      };
    }
    return { ok: true, data: parsed };
  } catch {
    return {
      ok: false,
      response: jsonResponse({ error: 'JSON malformado en la solicitud.' }, 400),
    };
  }
}

function extractTextFromAiPayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const obj = payload as {
    response?: unknown;
    text?: unknown;
    choices?: Array<{
      delta?: { content?: unknown };
      message?: { content?: unknown };
      text?: unknown;
    }>;
  };

  const deltaContent = obj.choices?.[0]?.delta?.content;
  if (typeof deltaContent === 'string') return deltaContent;

  const messageContent = obj.choices?.[0]?.message?.content;
  if (typeof messageContent === 'string') return messageContent;

  const choiceText = obj.choices?.[0]?.text;
  if (typeof choiceText === 'string') return choiceText;

  if (typeof obj.response === 'string') return obj.response;
  if (typeof obj.text === 'string') return obj.text;

  return '';
}

function formatAiErrorMessage(error: unknown): { status: number; message: string } {
  const rawMessage = error instanceof Error ? error.message : String(error ?? '');
  const lower = rawMessage.toLowerCase();

  if (lower.includes('rate limit') || lower.includes('429') || lower.includes('quota')) {
    return {
      status: 429,
      message:
        'Límite de solicitudes alcanzado temporalmente. Espere unos segundos e inténtelo nuevamente.',
    };
  }
  if (
    lower.includes('auth') ||
    lower.includes('unauthorized') ||
    lower.includes('401') ||
    lower.includes('403') ||
    lower.includes('remote')
  ) {
    return {
      status: 503,
      message:
        'El servicio de inteligencia artificial no está disponible o autorizado en este entorno en este momento.',
    };
  }
  return {
    status: 500,
    message:
      'No fue posible completar la consulta científica en este momento. Por favor, inténtelo nuevamente.',
  };
}

function prefersJsonOnly(request: CfRequest, bodyStream?: unknown): boolean {
  if (bodyStream === false) return true;
  const accept = (request.headers.get('accept') || '').toLowerCase();
  return accept.includes('application/json') && !accept.includes('text/event-stream');
}

async function runWorkersAiResponse(
  request: CfRequest,
  env: Env,
  conversationMessages: WorkerAiMessage[],
  options?: {
    bodyStream?: unknown;
    extraSystemContext?: string;
    sources?: GroundingSource[];
  }
): Promise<CfResponse> {
  if (!env?.AI || typeof env.AI.run !== 'function') {
    return jsonResponse(
      {
        error:
          'El servicio de inteligencia artificial no está disponible en este entorno.',
      },
      503
    );
  }

  const systemContent = options?.extraSystemContext
    ? `${VITAMIN_D_SYSTEM_INSTRUCTION}\n\n${options.extraSystemContext}`
    : VITAMIN_D_SYSTEM_INSTRUCTION;

  const fullMessages: WorkerAiMessage[] = [
    { role: 'system', content: systemContent },
    ...conversationMessages,
  ];

  const sources = options?.sources ?? [];

  if (prefersJsonOnly(request, options?.bodyStream)) {
    try {
      const result = await env.AI.run(MODEL_NAME, {
        messages: fullMessages,
        max_tokens: 2048,
        temperature: 0.2,
        chat_template_kwargs: {
          enable_thinking: false,
        },
      });

      const text = extractTextFromAiPayload(result).trim();
      if (!text) {
        return jsonResponse(
          { error: 'El modelo no devolvió contenido en la respuesta.' },
          502
        );
      }

      return jsonResponse({
        type: 'message',
        role: 'model',
        text,
        response: text,
        sources,
      });
    } catch (error) {
      const formatted = formatAiErrorMessage(error);
      return jsonResponse({ error: formatted.message }, formatted.status);
    }
  }

  let aiStream: CfReadableStream;
  try {
    aiStream = await env.AI.run(MODEL_NAME, {
      messages: fullMessages,
      stream: true,
      max_tokens: 2048,
      temperature: 0.2,
      chat_template_kwargs: {
        enable_thinking: false,
      },
    });
  } catch (error) {
    const formatted = formatAiErrorMessage(error);
    return jsonResponse({ error: formatted.message }, formatted.status);
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8');

  const sseStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (payload: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      const reader = aiStream.getReader();
      let buffer = '';
      let emittedChars = 0;

      const processLine = (rawLine: string) => {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) return;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') return;

        try {
          const parsed = JSON.parse(payload);
          const textChunk = extractTextFromAiPayload(parsed);
          if (textChunk.length > 0) {
            emittedChars += textChunk.length;
            emit({ type: 'chunk', text: textChunk });
          }
        } catch {
          // Ignore non-JSON frames or keepalives
        }
      };

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            processLine(line);
          }
        }

        buffer += decoder.decode();
        if (buffer.trim().length > 0) {
          for (const line of buffer.split(/\r?\n/)) {
            processLine(line);
          }
        }

        if (emittedChars === 0) {
          emit({
            type: 'error',
            message: 'No se recibió respuesta del modelo científico. Inténtelo nuevamente.',
          });
        } else {
          if (sources.length > 0) {
            emit({ type: 'sources', sources });
          }
          emit({ type: 'done' });
        }
      } catch (err) {
        const formatted = formatAiErrorMessage(err);
        emit({ type: 'error', message: formatted.message });
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // Ignore lock release errors
        }
        controller.close();
      }
    },
  });

  return new Response(sseStream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Content-Type-Options': 'nosniff',
    },
  }) as unknown as CfResponse;
}

async function handleChat(request: CfRequest, env: Env): Promise<CfResponse> {
  const parsed = await parseJsonBody<{
    messages?: IncomingChatMessage[];
    stream?: unknown;
  }>(request);
  if (!parsed.ok) return parsed.response;

  const rawMessages = parsed.data.messages;
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return jsonResponse(
      { error: 'Debe enviar al menos un mensaje válido.' },
      400
    );
  }

  const normalized: WorkerAiMessage[] = [];

  for (const item of rawMessages) {
    if (!item || typeof item !== 'object') continue;
    const rawRole = item.role;
    const rawContent =
      typeof item.text === 'string'
        ? item.text
        : typeof item.content === 'string'
          ? item.content
          : '';

    const trimmed = rawContent.trim();
    if (!trimmed) continue;

    if (trimmed.length > MAX_MESSAGE_CHARS) {
      return jsonResponse(
        {
          error: `Cada mensaje no puede superar los ${MAX_MESSAGE_CHARS} caracteres.`,
        },
        400
      );
    }

    // Never trust client-supplied 'system' roles
    if (rawRole === 'user') {
      normalized.push({ role: 'user', content: trimmed });
    } else if (rawRole === 'model' || rawRole === 'assistant') {
      normalized.push({ role: 'assistant', content: trimmed });
    }
  }

  const recentMessages = normalized.slice(-MAX_HISTORY_MESSAGES);
  if (recentMessages.length === 0 || !recentMessages.some((m) => m.role === 'user')) {
    return jsonResponse(
      { error: 'Debe enviar al menos un mensaje válido del usuario.' },
      400
    );
  }

  // Enforce total context character budget while preserving most recent messages
  const boundedMessages: WorkerAiMessage[] = [];
  let totalChars = 0;
  for (let i = recentMessages.length - 1; i >= 0; i--) {
    const msg = recentMessages[i];
    if (boundedMessages.length > 0 && totalChars + msg.content.length > MAX_TOTAL_CHARS) {
      break;
    }
    boundedMessages.unshift(msg);
    totalChars += msg.content.length;
  }

  // 1. Detect topic & enrich short follow-up queries with prior user turn for better retrieval
  const userMessages = boundedMessages.filter((m) => m.role === 'user');
  const latestUserQuery = userMessages[userMessages.length - 1]?.content ?? '';
  const priorUserQuery =
    userMessages.length > 1 ? userMessages[userMessages.length - 2]?.content ?? '' : '';

  const { isLikelyVitaminDRelated, detectedTopic } = detectQueryTopicAndRelevance(
    latestUserQuery,
    userMessages.length > 1
  );

  const retrievalQuery =
    latestUserQuery.length < 90 && priorUserQuery
      ? `${priorUserQuery.slice(0, 220)} ${latestUserQuery}`
      : latestUserQuery;

  // 2. Execute RAG retrieval (BGE-M3 embedding -> Vectorize -> D1) when query is in domain
  let extraSystemContext = '';
  let sources: GroundingSource[] = [];

  if (isLikelyVitaminDRelated && env?.AI) {
    const ragResult = await retrieveRelevantRagContext(
      env.AI,
      env.DB,
      env.VECTOR_INDEX,
      retrievalQuery
    );
    extraSystemContext = formatRagContextForPrompt(detectedTopic, ragResult.chunks);
    sources = ragResult.sources;
  } else if (!isLikelyVitaminDRelated) {
    extraSystemContext = `[CONTROL DE ESPECIALIZACIÓN]
La consulta del usuario parece ajena al ámbito científico de la vitamina D. Recházala amablemente recordando que VITAMIN D AI se especializa exclusivamente en vitamina D y orienta al usuario hacia temas relacionados (bioquímica, 25(OH)D, suplementación, salud ósea, nefrología, inmunología o reumatología vinculada a la vitamina D).`;
  }

  return runWorkersAiResponse(request, env, boundedMessages, {
    bodyStream: parsed.data.stream,
    extraSystemContext,
    sources,
  });
}

async function handleLabInterpret(request: CfRequest, env: Env): Promise<CfResponse> {
  const parsed = await parseJsonBody<LabInterpretBody & { stream?: unknown }>(request);
  if (!parsed.ok) return parsed.response;

  const body = parsed.data;
  const rawVal = Number(body.value);
  if (!Number.isFinite(rawVal) || rawVal < 0 || rawVal > 1000) {
    return jsonResponse(
      { error: 'Ingrese un resultado numérico válido de 25(OH)D entre 0 y 1000.' },
      400
    );
  }

  const unit = body.unit === 'nmol/L' ? 'nmol/L' : 'ng/mL';
  const ngMl = unit === 'ng/mL' ? rawVal : rawVal / 2.496;
  const nmolL = unit === 'nmol/L' ? rawVal : rawVal * 2.496;

  const ageStr = sanitizeShortText(body.age, 10);
  const ageNum = ageStr ? Number(ageStr) : NaN;
  const safeAge =
    Number.isFinite(ageNum) && ageNum >= 0 && ageNum <= 120
      ? `${ageNum} años`
      : 'No especificada';

  const safeSex = sanitizeShortText(body.sex, 30) || 'No especificado';
  const safePregnancy = sanitizeShortText(body.pregnancyState, 30) || 'No especificado';
  const safeSymptoms = sanitizeStringList(body.symptoms, MAX_ARRAY_ITEMS, 120);
  const safeAntecedents = sanitizeStringList(body.antecedents, MAX_ARRAY_ITEMS, 140);
  const safeNotes = sanitizeShortText(body.notes, MAX_NOTES_CHARS);

  const structuredLabPrompt = `Solicito una interpretación educativa científica (SIN emitir diagnóstico médico ni prescribir tratamientos ni dosis terapéuticas individualizadas) para los siguientes datos de laboratorio de 25-hidroxivitamina D [25(OH)D]:

- Valor ingresado: ${rawVal} ${unit}
- Conversión exacta (1 ng/mL = 2.496 nmol/L): ${ngMl.toFixed(1)} ng/mL | ${nmolL.toFixed(1)} nmol/L
- Edad: ${safeAge}
- Sexo biológico: ${safeSex}
- Embarazo o lactancia: ${safePregnancy}
- Síntomas reportados: ${safeSymptoms.length > 0 ? safeSymptoms.join(', ') : 'Ninguno reportado'}
- Antecedentes relevantes: ${safeAntecedents.length > 0 ? safeAntecedents.join(', ') : 'Ninguno reportado'}
- Notas adicionales: ${safeNotes || 'Ninguna'}

Por favor estructura tu explicación educativa en secciones claras:
1. Qué mide exactamente el biomarcador 25(OH)D (calcidiol) y significado de la conversión obtenida.
2. Comparación científica del valor según:
   - Criterio poblacional de NASEM / IOM (2011).
   - Criterio histórico de Endocrine Society (2011).
   - Cambio de enfoque en la actualización clínica de Endocrine Society (2024, Demay et al., JCEM), indicando cómo aplica a este grupo etario o estado fisiológico.
3. Contexto de los síntomas y antecedentes reportados (por qué ciertos antecedentes modifican la hidroxilación, absorción o catabolismo, o requieren medir otros parámetros como calcio sérico, PTH, fósforo o función renal en consulta).
4. Señales de alerta o motivos por los que se recomienda evaluación médica presencial, y preguntas útiles que el usuario podría plantear a su médico.`;

  return runWorkersAiResponse(
    request,
    env,
    [{ role: 'user', content: structuredLabPrompt }],
    { bodyStream: parsed.data.stream }
  );
}

async function handleRiskInterpret(request: CfRequest, env: Env): Promise<CfResponse> {
  const parsed = await parseJsonBody<RiskInterpretBody & { stream?: unknown }>(request);
  if (!parsed.ok) return parsed.response;

  const body = parsed.data;
  const rawFactors = Array.isArray(body.selectedFactors) ? body.selectedFactors : [];
  const sanitizedFactors: Array<{ label: string; category: string }> = [];

  for (const factor of rawFactors) {
    if (!factor || typeof factor !== 'object') continue;
    const f = factor as { label?: unknown; category?: unknown };
    const label = sanitizeShortText(f.label, 160);
    const category = sanitizeShortText(f.category, 80);
    if (label && category) {
      sanitizedFactors.push({ label, category });
    }
    if (sanitizedFactors.length >= MAX_ARRAY_ITEMS) break;
  }

  if (sanitizedFactors.length === 0) {
    return jsonResponse(
      { error: 'Seleccione al menos un factor válido para analizar.' },
      400
    );
  }

  const safeContext = sanitizeShortText(body.additionalContext, MAX_NOTES_CHARS);
  const factorsList = sanitizedFactors
    .map((f, idx) => `${idx + 1}. [${f.category}] ${f.label}`)
    .join('\n');

  const riskPrompt = `Un usuario completó un cuestionario educativo sobre determinantes relacionados con niveles bajos o alterados de vitamina D. NO calcules ni inventes puntuaciones clínicas ni porcentajes de riesgo no validados.

Factores identificados por el usuario:
${factorsList}

Contexto adicional proporcionado: ${safeContext || 'Ninguno'}

Por favor ofrece un análisis científico educativo que incluya:
1. Explicación fisiológica y bioquímica de cómo interactúan los factores identificados sobre la síntesis cutánea, absorción intestinal, distribución tisular o metabolismo hepático/renal de la vitamina D.
2. Qué tipo de evidencia respalda estos factores (diferenciando estudios fotobiológicos/observacionales de ensayos clínicos aleatorizados y guías como NASEM, NIH ODS y Endocrine Society 2024).
3. Qué información adicional sería relevante considerar y en qué situaciones conviene comentarlo con un profesional de la salud (sin diagnosticar ni prescribir tratamientos).`;

  return runWorkersAiResponse(
    request,
    env,
    [{ role: 'user', content: riskPrompt }],
    { bodyStream: parsed.data.stream }
  );
}

// ============================================================================
// ADMIN AUTHENTICATION & RAG KNOWLEDGE MANAGEMENT (/api/admin/*)
// ============================================================================

function extractAdminTokenFromRequest(request: CfRequest): string {
  const auth = request.headers.get('authorization') || '';
  if (/^bearer\s+/i.test(auth)) {
    return auth.replace(/^bearer\s+/i, '').trim();
  }
  return (request.headers.get('x-admin-token') || '').trim();
}

function requireAdminAuth(request: CfRequest, env: Env): CfResponse | null {
  const expectedToken = (env.ADMIN_UPLOAD_TOKEN || '').trim();
  if (!expectedToken) {
    return jsonResponse(
      {
        error:
          'El secreto ADMIN_UPLOAD_TOKEN no está configurado en el servidor de Cloudflare Workers.',
      },
      503
    );
  }

  const providedToken = extractAdminTokenFromRequest(request);
  if (!providedToken || !timingSafeEqualStrings(providedToken, expectedToken)) {
    return jsonResponse(
      { error: 'Token administrativo inválido o no autorizado.' },
      401
    );
  }

  return null;
}

function requireRagStorageBindings(env: Env): CfResponse | null {
  if (!env.DB) {
    return jsonResponse(
      { error: 'La base de datos Cloudflare D1 (binding DB) no está configurada.' },
      503
    );
  }
  if (!env.AI || typeof env.AI.run !== 'function') {
    return jsonResponse(
      { error: 'El servicio Cloudflare Workers AI (binding AI) no está disponible.' },
      503
    );
  }
  if (!env.VECTOR_INDEX) {
    return jsonResponse(
      { error: 'El índice Cloudflare Vectorize (binding VECTOR_INDEX) no está configurado.' },
      503
    );
  }
  return null;
}

interface ParsedUploadPayload {
  metadata: DocumentMetadataInput;
  pages: PageTextInput[];
  contentHash: string;
  totalPageCount: number | null;
  isFinalBatch: boolean;
}

function validateAndNormalizeMetadata(
  raw: Record<string, unknown>,
  fallbackFilename = ''
): { ok: true; data: DocumentMetadataInput } | { ok: false; error: string } {
  const title = sanitizeShortText(raw.title, 300);
  const authors = sanitizeShortText(raw.authors, 400);
  const journalOrInstitution = sanitizeShortText(raw.journalOrInstitution, 240);
  const doi = sanitizeShortText(raw.doi, 160).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  const pmid = sanitizeShortText(raw.pmid, 40).replace(/[^\d]/g, '');
  const referenceUrl = sanitizeShortText(raw.referenceUrl, 500);
  const category = sanitizeShortText(raw.category, 100);
  const publicationType = sanitizeShortText(raw.publicationType, 60);
  const language = sanitizeShortText(raw.language, 20) || 'es';
  const sourceFormatRaw = sanitizeShortText(raw.sourceFormat, 10).toLowerCase();
  const originalFilename =
    sanitizeShortText(raw.originalFilename, 240) || fallbackFilename;

  if (!title) return { ok: false, error: 'El título del documento es obligatorio.' };
  if (!authors) return { ok: false, error: 'Los autores o institución son obligatorios.' };
  if (!journalOrInstitution) {
    return { ok: false, error: 'La revista o institución es obligatoria.' };
  }
  if (!isValidCategory(category)) {
    return { ok: false, error: 'Seleccione una categoría científica válida.' };
  }
  if (!isValidPublicationType(publicationType)) {
    return { ok: false, error: 'Seleccione un tipo de publicación válido.' };
  }
  if (referenceUrl && !/^https?:\/\/.+/i.test(referenceUrl)) {
    return {
      ok: false,
      error: 'La URL de referencia debe comenzar con http:// o https://.',
    };
  }

  let publicationYear: number | null = null;
  if (raw.publicationYear !== undefined && raw.publicationYear !== null && String(raw.publicationYear).trim() !== '') {
    const yearNum = Number(raw.publicationYear);
    if (!Number.isInteger(yearNum) || yearNum < 1900 || yearNum > 2100) {
      return { ok: false, error: 'Ingrese un año de publicación válido (1900–2100).' };
    }
    publicationYear = yearNum;
  }

  const sourceFormat: 'pdf' | 'txt' | 'md' =
    sourceFormatRaw === 'pdf'
      ? 'pdf'
      : sourceFormatRaw === 'md' || sourceFormatRaw === 'markdown'
        ? 'md'
        : 'txt';

  return {
    ok: true,
    data: {
      title,
      authors,
      publicationYear,
      journalOrInstitution,
      doi,
      pmid,
      referenceUrl,
      publicationType,
      isHistorical: Boolean(raw.isHistorical),
      category,
      language,
      sourceFormat,
      originalFilename,
    },
  };
}

function normalizePagesPayload(
  rawPages: unknown,
  rawFullText: unknown
): PageTextInput[] {
  if (Array.isArray(rawPages) && rawPages.length > 0) {
    const pages: PageTextInput[] = [];
    for (const item of rawPages) {
      if (!item || typeof item !== 'object') continue;
      const p = item as { pageNumber?: unknown; text?: unknown };
      if (typeof p.text !== 'string') continue;
      const cleaned = cleanExtractedText(p.text);
      if (!cleaned) continue;
      const pageNum =
        typeof p.pageNumber === 'number' && Number.isInteger(p.pageNumber) && p.pageNumber > 0
          ? p.pageNumber
          : null;
      pages.push({ pageNumber: pageNum, text: cleaned });
    }
    if (pages.length > 0) return pages;
  }

  if (typeof rawFullText === 'string' && rawFullText.trim().length > 0) {
    return [{ pageNumber: null, text: cleanExtractedText(rawFullText) }];
  }

  return [];
}

async function parseAdminDocumentUpload(
  request: CfRequest
): Promise<{ ok: true; data: ParsedUploadPayload } | { ok: false; response: CfResponse }> {
  const contentType = (request.headers.get('content-type') || '').toLowerCase();

  if (contentType.includes('multipart/form-data')) {
    let formData: FormData;
    try {
      formData = await (request as unknown as Request).formData();
    } catch {
      return {
        ok: false,
        response: jsonResponse(
          { error: 'No se pudo procesar el formulario multipart.' },
          400
        ),
      };
    }

    const metadataRaw = formData.get('metadata');
    if (typeof metadataRaw !== 'string') {
      return {
        ok: false,
        response: jsonResponse(
          { error: 'Faltan los metadatos bibliográficos del documento.' },
          400
        ),
      };
    }

    let metadataObj: Record<string, unknown>;
    try {
      metadataObj = JSON.parse(metadataRaw) as Record<string, unknown>;
    } catch {
      return {
        ok: false,
        response: jsonResponse({ error: 'Metadatos JSON inválidos.' }, 400),
      };
    }

    const metaValidation = validateAndNormalizeMetadata(metadataObj);
    if (!metaValidation.ok) {
      return {
        ok: false,
        response: jsonResponse({ error: metaValidation.error }, 400),
      };
    }

    let parsedPagesRaw: unknown = null;
    const pagesField = formData.get('pages');
    if (typeof pagesField === 'string' && pagesField.trim()) {
      if (pagesField.length > MAX_ADMIN_BATCH_BYTES) {
        return {
          ok: false,
          response: jsonResponse(
            { error: 'El lote de texto excede el tamaño máximo permitido (2 MB).' },
            413
          ),
        };
      }
      try {
        parsedPagesRaw = JSON.parse(pagesField);
      } catch {
        return {
          ok: false,
          response: jsonResponse({ error: 'Formato de páginas extraídas inválido.' }, 400),
        };
      }
    }

    const fullTextField = formData.get('text');
    const pages = normalizePagesPayload(
      parsedPagesRaw,
      typeof fullTextField === 'string' ? fullTextField : ''
    );

    const rawHash = sanitizeShortText(formData.get('contentHash'), 80).toLowerCase();
    const contentHash = /^[a-f0-9]{64}$/.test(rawHash) ? rawHash : '';
    const totalPagesRaw = Number(formData.get('totalPageCount'));
    const totalPageCount =
      Number.isInteger(totalPagesRaw) && totalPagesRaw > 0 ? totalPagesRaw : null;
    const isFinalBatch = formData.get('isFinalBatch') !== 'false';

    return {
      ok: true,
      data: {
        metadata: metaValidation.data,
        pages,
        contentHash,
        totalPageCount,
        isFinalBatch,
      },
    };
  }

  const parsed = await parseJsonBody<{
    metadata?: Record<string, unknown>;
    pages?: unknown;
    text?: unknown;
    contentHash?: unknown;
    totalPageCount?: unknown;
    isFinalBatch?: unknown;
  }>(request, MAX_ADMIN_BATCH_BYTES);
  if (!parsed.ok) return parsed;

  const metaValidation = validateAndNormalizeMetadata(parsed.data.metadata || {});
  if (!metaValidation.ok) {
    return {
      ok: false,
      response: jsonResponse({ error: metaValidation.error }, 400),
    };
  }

  const pages = normalizePagesPayload(parsed.data.pages, parsed.data.text);
  const rawHash = sanitizeShortText(parsed.data.contentHash, 80).toLowerCase();
  const contentHash = /^[a-f0-9]{64}$/.test(rawHash) ? rawHash : '';
  const totalPagesRaw = Number(parsed.data.totalPageCount);
  const totalPageCount =
    Number.isInteger(totalPagesRaw) && totalPagesRaw > 0 ? totalPagesRaw : null;
  const isFinalBatch = parsed.data.isFinalBatch !== false;

  return {
    ok: true,
    data: {
      metadata: metaValidation.data,
      pages,
      contentHash,
      totalPageCount,
      isFinalBatch,
    },
  };
}

async function handleAdminStats(env: Env): Promise<CfResponse> {
  if (!env.DB) {
    return jsonResponse({
      configured: false,
      totalDocuments: 0,
      totalChunks: 0,
      totalPagesIndexed: 0,
      byCategory: [],
      byPublicationType: [],
      embeddingDimensions: EMBEDDING_DIMENSIONS,
    });
  }

  try {
    const totals = await env.DB.prepare(
      `SELECT
        COUNT(*) AS total_documents,
        COALESCE(SUM(chunk_count), 0) AS total_chunks,
        COALESCE(SUM(page_count), 0) AS total_pages
       FROM documents`
    ).first<{ total_documents: number; total_chunks: number; total_pages: number }>();

    const catRes = await env.DB.prepare(
      `SELECT category, COUNT(*) AS count FROM documents GROUP BY category ORDER BY count DESC`
    ).all<{ category: string; count: number }>();

    const typeRes = await env.DB.prepare(
      `SELECT publication_type, COUNT(*) AS count FROM documents GROUP BY publication_type ORDER BY count DESC`
    ).all<{ publication_type: string; count: number }>();

    return jsonResponse({
      configured: true,
      totalDocuments: totals?.total_documents ?? 0,
      totalChunks: totals?.total_chunks ?? 0,
      totalPagesIndexed: totals?.total_pages ?? 0,
      byCategory: catRes.results ?? [],
      byPublicationType: typeRes.results ?? [],
      categories: DOCUMENT_CATEGORIES,
      publicationTypes: PUBLICATION_TYPES,
    });
  } catch {
    return jsonResponse(
      { error: 'No se pudieron consultar las estadísticas en D1. Verifica que schema.sql esté aplicado.' },
      500
    );
  }
}

async function handleAdminListDocuments(request: CfRequest, env: Env): Promise<CfResponse> {
  if (!env.DB) {
    return jsonResponse(
      { error: 'La base de datos D1 (binding DB) no está configurada.' },
      503
    );
  }

  const url = new URL(request.url);
  const query = (url.searchParams.get('q') || '').trim().toLowerCase();
  const category = (url.searchParams.get('category') || '').trim();

  const conditions: string[] = [];
  const params: string[] = [];

  if (category && category !== 'todas') {
    params.push(category);
    conditions.push(`category = ?${params.length}`);
  }
  if (query) {
    params.push(`%${query}%`);
    const idx = params.length;
    conditions.push(
      `(LOWER(title) LIKE ?${idx} OR LOWER(authors) LIKE ?${idx} OR LOWER(journal_or_institution) LIKE ?${idx} OR LOWER(doi) LIKE ?${idx} OR LOWER(pmid) LIKE ?${idx})`
    );
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `SELECT * FROM documents ${whereClause} ORDER BY created_at DESC LIMIT 200`;

  try {
    const stmt = env.DB.prepare(sql);
    const res =
      params.length > 0
        ? await stmt.bind(...params).all<StoredDocumentRow>()
        : await stmt.all<StoredDocumentRow>();

    return jsonResponse({ documents: res.results ?? [] });
  } catch {
    return jsonResponse(
      { error: 'Error al consultar los documentos en D1. Verifica que schema.sql haya sido ejecutado.' },
      500
    );
  }
}

async function handleAdminCreateDocument(request: CfRequest, env: Env): Promise<CfResponse> {
  const missingBindings = requireRagStorageBindings(env);
  if (missingBindings) return missingBindings;

  const parsed = await parseAdminDocumentUpload(request);
  if (!parsed.ok) return parsed.response;

  const { metadata, pages, contentHash: providedHash, totalPageCount, isFinalBatch } = parsed.data;
  if (pages.length === 0) {
    return jsonResponse(
      {
        error:
          'No se encontró texto extraíble en el documento. Verifica que el PDF no sea solo imagen escaneada sin OCR.',
      },
      400
    );
  }

  const combinedText = pages.map((p) => p.text).join('\n\n');
  if (combinedText.length > MAX_BATCH_TEXT_CHARS) {
    return jsonResponse(
      {
        error: `Cada lote de texto no puede superar ${MAX_BATCH_TEXT_CHARS.toLocaleString('es-ES')} caracteres. Envía el documento en lotes más pequeños.`,
      },
      413
    );
  }

  const contentHash = providedHash || (await sha256Hex(combinedText));

  try {
    const duplicate = await findDuplicateDocument(
      env.DB!,
      contentHash,
      metadata.doi,
      metadata.pmid
    );
    if (duplicate) {
      return jsonResponse(
        {
          error: `Documento duplicado detectado ("${duplicate.title}"). Ya existe con el mismo contenido, DOI o PMID; utiliza la opción de actualizar si deseas reemplazarlo.`,
          duplicateId: duplicate.id,
        },
        409
      );
    }
  } catch {
    return jsonResponse(
      { error: 'No se pudo verificar duplicados en D1. Confirma que schema.sql esté aplicado.' },
      500
    );
  }

  const docId = createShortDocumentId();
  const chunks = buildSemanticChunks(docId, pages, 1000, 180, 0);
  if (chunks.length === 0) {
    return jsonResponse(
      { error: 'No se pudieron generar fragmentos semánticos válidos del documento.' },
      400
    );
  }

  const evidenceTier = getEvidenceTierForType(metadata.publicationType);
  const now = new Date().toISOString();
  let vectorsUpserted = false;

  try {
    // 1. Generate BGE-M3 embeddings (1024 dimensions)
    const embeddings = await generateBgeM3Embeddings(
      env.AI,
      chunks.map((c) => c.content)
    );

    // 2. Upsert vectors into Vectorize (compact filter metadata only)
    await upsertChunksToVectorize(
      env.VECTOR_INDEX!,
      chunks,
      embeddings,
      metadata,
      evidenceTier
    );
    vectorsUpserted = true;

    // 3. Persist document metadata and text chunks permanently in D1 (no R2 dependency)
    const docRow: StoredDocumentRow = {
      id: docId,
      title: metadata.title,
      authors: metadata.authors,
      publication_year: metadata.publicationYear,
      journal_or_institution: metadata.journalOrInstitution,
      doi: metadata.doi,
      pmid: metadata.pmid,
      reference_url: metadata.referenceUrl,
      publication_type: metadata.publicationType,
      evidence_tier: evidenceTier,
      is_historical: metadata.isHistorical ? 1 : 0,
      category: metadata.category,
      language: metadata.language,
      source_format: metadata.sourceFormat,
      original_filename: metadata.originalFilename,
      r2_key: '',
      content_hash: contentHash,
      page_count:
        totalPageCount ??
        (pages.filter((p) => p.pageNumber !== null).length || pages.length),
      chunk_count: chunks.length,
      status: isFinalBatch ? 'indexed' : 'indexing',
      error_message: '',
      created_at: now,
      updated_at: now,
    };

    await insertDocumentAndChunks(env.DB!, docRow, chunks);

    return jsonResponse(
      {
        document: docRow,
        chunksIndexed: chunks.length,
      },
      201
    );
  } catch (err) {
    if (vectorsUpserted) {
      try {
        await deleteVectorsByChunkIds(
          env.VECTOR_INDEX,
          chunks.map((c) => c.id)
        );
      } catch {
        // Ignore cleanup failures
      }
    }

    const msg =
      err instanceof Error ? err.message : 'Error al procesar e indexar el documento.';
    return jsonResponse({ error: msg }, 500);
  }
}

async function handleAdminAppendDocumentBatch(
  request: CfRequest,
  env: Env,
  docId: string
): Promise<CfResponse> {
  const missingBindings = requireRagStorageBindings(env);
  if (missingBindings) return missingBindings;

  const existing = await env.DB!.prepare('SELECT * FROM documents WHERE id = ?1 LIMIT 1')
    .bind(docId)
    .first<StoredDocumentRow>();

  if (!existing) {
    return jsonResponse({ error: 'Documento no encontrado para agregar lote.' }, 404);
  }

  const parsed = await parseJsonBody<{
    pages?: unknown;
    isFinalBatch?: unknown;
  }>(request, MAX_ADMIN_BATCH_BYTES);
  if (!parsed.ok) return parsed.response;

  const pages = normalizePagesPayload(parsed.data.pages, undefined);
  if (pages.length === 0) {
    return jsonResponse({ error: 'El lote no contiene páginas con texto válido.' }, 400);
  }

  const batchText = pages.map((p) => p.text).join('\n\n');
  if (batchText.length > MAX_BATCH_TEXT_CHARS) {
    return jsonResponse(
      {
        error: `Cada lote no puede superar ${MAX_BATCH_TEXT_CHARS.toLocaleString('es-ES')} caracteres.`,
      },
      413
    );
  }

  const isFinalBatch = parsed.data.isFinalBatch !== false;
  const maxChunkRes = await env.DB!.prepare(
    'SELECT COALESCE(MAX(chunk_index), -1) AS max_idx, COUNT(*) AS existing_count FROM document_chunks WHERE document_id = ?1'
  )
    .bind(docId)
    .first<{ max_idx: number; existing_count: number }>();

  const startChunkIndex = (maxChunkRes?.max_idx ?? -1) + 1;
  const existingCount = maxChunkRes?.existing_count ?? existing.chunk_count;

  const newChunks = buildSemanticChunks(docId, pages, 1000, 180, startChunkIndex);
  if (newChunks.length === 0) {
    if (isFinalBatch) {
      await env.DB!.prepare(
        `UPDATE documents SET status = 'indexed', updated_at = ?1 WHERE id = ?2`
      )
        .bind(new Date().toISOString(), docId)
        .run();
    }
    return jsonResponse({
      documentId: docId,
      chunksAdded: 0,
      totalChunks: existingCount,
      status: isFinalBatch ? 'indexed' : existing.status,
    });
  }

  const metadata: DocumentMetadataInput = {
    title: existing.title,
    authors: existing.authors,
    publicationYear: existing.publication_year,
    journalOrInstitution: existing.journal_or_institution,
    doi: existing.doi,
    pmid: existing.pmid,
    referenceUrl: existing.reference_url,
    publicationType: (PUBLICATION_TYPES.some((p) => p.id === existing.publication_type)
      ? existing.publication_type
      : 'revision_narrativa') as DocumentMetadataInput['publicationType'],
    isHistorical: existing.is_historical === 1,
    category: (DOCUMENT_CATEGORIES.includes(existing.category as DocumentMetadataInput['category'])
      ? existing.category
      : 'Investigación científica') as DocumentMetadataInput['category'],
    language: existing.language || 'es',
    sourceFormat: (existing.source_format === 'pdf' || existing.source_format === 'md'
      ? existing.source_format
      : 'txt'),
    originalFilename: existing.original_filename,
  };

  let vectorsUpserted = false;
  try {
    const embeddings = await generateBgeM3Embeddings(
      env.AI,
      newChunks.map((c) => c.content)
    );

    await upsertChunksToVectorize(
      env.VECTOR_INDEX!,
      newChunks,
      embeddings,
      metadata,
      existing.evidence_tier
    );
    vectorsUpserted = true;

    const now = new Date().toISOString();
    const newTotalChunks = existingCount + newChunks.length;
    await appendDocumentChunks(
      env.DB!,
      docId,
      newChunks,
      newTotalChunks,
      isFinalBatch ? 'indexed' : 'indexing',
      now
    );

    const updated = await env.DB!.prepare('SELECT * FROM documents WHERE id = ?1')
      .bind(docId)
      .first<StoredDocumentRow>();

    return jsonResponse({
      document: updated,
      chunksAdded: newChunks.length,
      totalChunks: newTotalChunks,
    });
  } catch (err) {
    if (vectorsUpserted) {
      try {
        await deleteVectorsByChunkIds(
          env.VECTOR_INDEX,
          newChunks.map((c) => c.id)
        );
      } catch {
        // Ignore cleanup failures
      }
    }
    const msg =
      err instanceof Error ? err.message : 'Error al procesar el lote de fragmentos.';
    return jsonResponse({ error: msg }, 500);
  }
}

async function handleAdminUpdateDocument(
  request: CfRequest,
  env: Env,
  docId: string
): Promise<CfResponse> {
  if (!env.DB) {
    return jsonResponse(
      { error: 'La base de datos D1 (binding DB) no está configurada.' },
      503
    );
  }

  const existing = await env.DB.prepare('SELECT * FROM documents WHERE id = ?1 LIMIT 1')
    .bind(docId)
    .first<StoredDocumentRow>();

  if (!existing) {
    return jsonResponse({ error: 'Documento no encontrado.' }, 404);
  }

  const parsed = await parseAdminDocumentUpload(request);
  if (!parsed.ok) return parsed.response;

  const { metadata, pages, contentHash: providedHash, totalPageCount, isFinalBatch } = parsed.data;
  const hasNewContent = pages.length > 0;
  const evidenceTier = getEvidenceTierForType(metadata.publicationType);
  const now = new Date().toISOString();

  if (!hasNewContent) {
    // Metadata-only update: verify no DOI/PMID collision and update D1
    const duplicate = await findDuplicateDocument(
      env.DB,
      existing.content_hash,
      metadata.doi,
      metadata.pmid,
      docId
    );
    if (duplicate) {
      return jsonResponse(
        { error: `El DOI o PMID ya pertenece a otro documento ("${duplicate.title}").` },
        409
      );
    }

    await env.DB.prepare(
      `UPDATE documents SET
        title = ?1, authors = ?2, publication_year = ?3, journal_or_institution = ?4,
        doi = ?5, pmid = ?6, reference_url = ?7, publication_type = ?8,
        evidence_tier = ?9, is_historical = ?10, category = ?11, language = ?12,
        updated_at = ?13
       WHERE id = ?14`
    )
      .bind(
        metadata.title,
        metadata.authors,
        metadata.publicationYear,
        metadata.journalOrInstitution,
        metadata.doi,
        metadata.pmid,
        metadata.referenceUrl,
        metadata.publicationType,
        evidenceTier,
        metadata.isHistorical ? 1 : 0,
        metadata.category,
        metadata.language,
        now,
        docId
      )
      .run();

    const updated = await env.DB.prepare('SELECT * FROM documents WHERE id = ?1')
      .bind(docId)
      .first<StoredDocumentRow>();

    return jsonResponse({ document: updated, reindexed: false });
  }

  // Full re-index with new extracted text (first controlled batch)
  const missingBindings = requireRagStorageBindings(env);
  if (missingBindings) return missingBindings;

  const combinedText = pages.map((p) => p.text).join('\n\n');
  if (combinedText.length > MAX_BATCH_TEXT_CHARS) {
    return jsonResponse(
      {
        error: `Cada lote de texto no puede superar ${MAX_BATCH_TEXT_CHARS.toLocaleString('es-ES')} caracteres.`,
      },
      413
    );
  }

  const newHash = providedHash || (await sha256Hex(combinedText));

  const duplicate = await findDuplicateDocument(
    env.DB,
    newHash,
    metadata.doi,
    metadata.pmid,
    docId
  );
  if (duplicate) {
    return jsonResponse(
      { error: `El nuevo contenido, DOI o PMID ya existe en "${duplicate.title}".` },
      409
    );
  }

  const newChunks = buildSemanticChunks(docId, pages, 1000, 180, 0);
  if (newChunks.length === 0) {
    return jsonResponse(
      { error: 'No se pudieron extraer fragmentos semánticos del nuevo documento.' },
      400
    );
  }

  const oldChunksRes = await env.DB.prepare(
    'SELECT id FROM document_chunks WHERE document_id = ?1'
  )
    .bind(docId)
    .all<{ id: string }>();
  const oldChunkIds = (oldChunksRes.results ?? []).map((r) => r.id);

  try {
    const embeddings = await generateBgeM3Embeddings(
      env.AI,
      newChunks.map((c) => c.content)
    );

    await deleteVectorsByChunkIds(env.VECTOR_INDEX, oldChunkIds);
    await upsertChunksToVectorize(
      env.VECTOR_INDEX!,
      newChunks,
      embeddings,
      metadata,
      evidenceTier
    );

    const statements = [
      env.DB.prepare('DELETE FROM document_chunks WHERE document_id = ?1').bind(docId),
      env.DB.prepare(
        `UPDATE documents SET
          title = ?1, authors = ?2, publication_year = ?3, journal_or_institution = ?4,
          doi = ?5, pmid = ?6, reference_url = ?7, publication_type = ?8,
          evidence_tier = ?9, is_historical = ?10, category = ?11, language = ?12,
          source_format = ?13, original_filename = ?14, r2_key = '', content_hash = ?15,
          page_count = ?16, chunk_count = ?17, status = ?18, error_message = '',
          updated_at = ?19
         WHERE id = ?20`
      ).bind(
        metadata.title,
        metadata.authors,
        metadata.publicationYear,
        metadata.journalOrInstitution,
        metadata.doi,
        metadata.pmid,
        metadata.referenceUrl,
        metadata.publicationType,
        evidenceTier,
        metadata.isHistorical ? 1 : 0,
        metadata.category,
        metadata.language,
        metadata.sourceFormat,
        metadata.originalFilename || existing.original_filename,
        newHash,
        totalPageCount ??
          (pages.filter((p) => p.pageNumber !== null).length || pages.length),
        newChunks.length,
        isFinalBatch ? 'indexed' : 'indexing',
        now,
        docId
      ),
    ];

    for (const chunk of newChunks) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO document_chunks (
            id, document_id, chunk_index, page_number, section_title,
            content, char_count, created_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
        ).bind(
          chunk.id,
          chunk.documentId,
          chunk.chunkIndex,
          chunk.pageNumber,
          chunk.sectionTitle,
          chunk.content,
          chunk.charCount,
          now
        )
      );
    }

    const batchSize = 50;
    for (let i = 0; i < statements.length; i += batchSize) {
      await env.DB.batch(statements.slice(i, i + batchSize));
    }

    const updated = await env.DB.prepare('SELECT * FROM documents WHERE id = ?1')
      .bind(docId)
      .first<StoredDocumentRow>();

    return jsonResponse({
      document: updated,
      reindexed: true,
      chunksIndexed: newChunks.length,
    });
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : 'Error al actualizar y reindexar el documento.';
    return jsonResponse({ error: msg }, 500);
  }
}

async function handleAdminDeleteDocument(env: Env, docId: string): Promise<CfResponse> {
  if (!env.DB) {
    return jsonResponse(
      { error: 'La base de datos D1 (binding DB) no está configurada.' },
      503
    );
  }

  const existing = await env.DB.prepare('SELECT * FROM documents WHERE id = ?1 LIMIT 1')
    .bind(docId)
    .first<StoredDocumentRow>();

  if (!existing) {
    return jsonResponse({ error: 'Documento no encontrado.' }, 404);
  }

  const chunkRes = await env.DB.prepare(
    'SELECT id FROM document_chunks WHERE document_id = ?1'
  )
    .bind(docId)
    .all<{ id: string }>();

  const chunkIds = (chunkRes.results ?? []).map((r) => r.id);

  try {
    await deleteVectorsByChunkIds(env.VECTOR_INDEX, chunkIds);

    await env.DB.batch([
      env.DB.prepare('DELETE FROM document_chunks WHERE document_id = ?1').bind(docId),
      env.DB.prepare('DELETE FROM documents WHERE id = ?1').bind(docId),
    ]);

    return jsonResponse({ deleted: true, id: docId, deletedChunks: chunkIds.length });
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : 'No se pudo eliminar el documento.';
    return jsonResponse({ error: msg }, 500);
  }
}

export default {
  async fetch(request: CfRequest, env: Env): Promise<CfResponse> {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      if (request.method !== 'GET') {
        return jsonResponse({ error: 'Método no permitido.' }, 405);
      }
      return jsonResponse({
        status: 'ok',
        service: 'VITAMIN D AI',
        runtime: 'cloudflare-workers',
        rag: {
          ai: Boolean(env?.AI),
          d1: Boolean(env?.DB),
          vectorize: Boolean(env?.VECTOR_INDEX),
        },
      });
    }

    if (url.pathname === '/api/chat') {
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'Método no permitido.' }, 405);
      }
      return handleChat(request, env);
    }

    if (url.pathname === '/api/lab-interpret') {
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'Método no permitido.' }, 405);
      }
      return handleLabInterpret(request, env);
    }

    if (url.pathname === '/api/risk-interpret') {
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'Método no permitido.' }, 405);
      }
      return handleRiskInterpret(request, env);
    }

    // Protected Admin RAG routes (/api/admin/*)
    if (url.pathname.startsWith('/api/admin/')) {
      const authError = requireAdminAuth(request, env);
      if (authError) return authError;

      if (url.pathname === '/api/admin/verify') {
        if (request.method !== 'GET') {
          return jsonResponse({ error: 'Método no permitido.' }, 405);
        }
        return jsonResponse({ authenticated: true });
      }

      if (url.pathname === '/api/admin/stats') {
        if (request.method !== 'GET') {
          return jsonResponse({ error: 'Método no permitido.' }, 405);
        }
        return handleAdminStats(env);
      }

      if (url.pathname === '/api/admin/documents') {
        if (request.method === 'GET') {
          return handleAdminListDocuments(request, env);
        }
        if (request.method === 'POST') {
          return handleAdminCreateDocument(request, env);
        }
        return jsonResponse({ error: 'Método no permitido.' }, 405);
      }

      const batchMatch = /^\/api\/admin\/documents\/([a-zA-Z0-9_-]+)\/batches$/.exec(
        url.pathname
      );
      if (batchMatch) {
        if (request.method !== 'POST') {
          return jsonResponse({ error: 'Método no permitido.' }, 405);
        }
        return handleAdminAppendDocumentBatch(request, env, batchMatch[1]);
      }

      const docMatch = /^\/api\/admin\/documents\/([a-zA-Z0-9_-]+)$/.exec(
        url.pathname
      );
      if (docMatch) {
        if (request.method === 'PUT') {
          return handleAdminUpdateDocument(request, env, docMatch[1]);
        }
        if (request.method === 'DELETE') {
          return handleAdminDeleteDocument(env, docMatch[1]);
        }
        return jsonResponse({ error: 'Método no permitido.' }, 405);
      }

      return jsonResponse({ error: 'Endpoint administrativo no encontrado.' }, 404);
    }

    if (url.pathname.startsWith('/api/')) {
      return jsonResponse({ error: 'Endpoint no encontrado.' }, 404);
    }

    return new Response('Not Found', {
      status: 404,
      headers: SECURITY_HEADERS,
    }) as unknown as CfResponse;
  },
} satisfies ExportedHandler<Env>;
