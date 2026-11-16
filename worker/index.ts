import type {
  Ai,
  ExportedHandler,
  ReadableStream as CfReadableStream,
  Request as CfRequest,
  Response as CfResponse,
} from '@cloudflare/workers-types';
import { VITAMIN_D_SYSTEM_INSTRUCTION } from './systemPrompt';

export interface Env {
  AI: Ai;
}

const MODEL_NAME = '@cf/google/gemma-4-26b-a4b-it' as const;

const MAX_HISTORY_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 4000;
const MAX_TOTAL_CHARS = 24000;
const MAX_NOTES_CHARS = 1000;
const MAX_ARRAY_ITEMS = 20;
const MAX_REQUEST_BYTES = 128 * 1024;

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
  request: CfRequest
): Promise<{ ok: true; data: T } | { ok: false; response: CfResponse }> {
  const contentLengthHeader = request.headers.get('content-length');
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
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

  if (rawText.length > MAX_REQUEST_BYTES) {
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
  if (lower.includes('auth') || lower.includes('unauthorized') || lower.includes('401') || lower.includes('403')) {
    return {
      status: 503,
      message:
        'El servicio de inteligencia artificial no está autorizado o disponible en este entorno en este momento.',
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
  bodyStream?: unknown
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

  const fullMessages: WorkerAiMessage[] = [
    { role: 'system', content: VITAMIN_D_SYSTEM_INSTRUCTION },
    ...conversationMessages,
  ];

  if (prefersJsonOnly(request, bodyStream)) {
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

  return runWorkersAiResponse(request, env, boundedMessages, parsed.data.stream);
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
    body.stream
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
    body.stream
  );
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

    if (url.pathname.startsWith('/api/')) {
      return jsonResponse({ error: 'Endpoint no encontrado.' }, 404);
    }

    return new Response('Not Found', {
      status: 404,
      headers: SECURITY_HEADERS,
    }) as unknown as CfResponse;
  },
} satisfies ExportedHandler<Env>;
