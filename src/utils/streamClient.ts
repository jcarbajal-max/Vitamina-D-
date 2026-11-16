import type { GroundingSource } from '../types/vitaminD';

export interface StreamHandlers {
  onChunk: (text: string) => void;
  onSources?: (sources: GroundingSource[]) => void;
  onDone?: () => void;
  onError: (message: string) => void;
}

export async function consumeSseStream(
  url: string,
  body: unknown,
  handlers: StreamHandlers,
  signal?: AbortSignal
): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    let errorMessage = `Error del servidor (${response.status}).`;
    try {
      const json = (await response.json()) as { error?: string; message?: string };
      if (json.error || json.message) {
        errorMessage = json.error || json.message || errorMessage;
      }
    } catch {
      // Ignore JSON parse error on non-JSON error body
    }
    handlers.onError(errorMessage);
    return;
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('application/json')) {
    try {
      const json = (await response.json()) as {
        text?: string;
        response?: string;
        choices?: Array<{ message?: { content?: string } }>;
        sources?: GroundingSource[];
        error?: string;
      };
      if (json.error) {
        handlers.onError(json.error);
        return;
      }
      const text =
        json.text ||
        json.response ||
        json.choices?.[0]?.message?.content ||
        '';
      if (text) {
        handlers.onChunk(text);
      }
      if (Array.isArray(json.sources) && json.sources.length > 0) {
        handlers.onSources?.(json.sources);
      }
      handlers.onDone?.();
    } catch {
      handlers.onError('No se pudo procesar la respuesta JSON del servidor.');
    }
    return;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    handlers.onError('El navegador no pudo abrir el flujo de respuesta.');
    return;
  }

  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let finished = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n\n');
      buffer = lines.pop() ?? '';

      for (const block of lines) {
        const dataLine = block
          .split('\n')
          .find((line) => line.startsWith('data: '));
        if (!dataLine) continue;

        const rawJson = dataLine.slice(6).trim();
        if (!rawJson) continue;

        try {
          const event = JSON.parse(rawJson) as
            | { type: 'chunk'; text: string }
            | { type: 'sources'; sources: GroundingSource[] }
            | { type: 'done' }
            | { type: 'error'; message: string };

          if (event.type === 'chunk' && event.text) {
            handlers.onChunk(event.text);
          } else if (event.type === 'sources' && Array.isArray(event.sources)) {
            handlers.onSources?.(event.sources);
          } else if (event.type === 'error') {
            finished = true;
            handlers.onError(event.message || 'Ocurrió un error al generar la respuesta.');
            return;
          } else if (event.type === 'done') {
            finished = true;
            handlers.onDone?.();
            return;
          }
        } catch {
          // Ignore malformed partial JSON frames
        }
      }
    }

    if (!finished) {
      handlers.onDone?.();
    }
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      handlers.onDone?.();
      return;
    }
    handlers.onError('Se interrumpió la conexión con el servidor científico.');
  }
}
