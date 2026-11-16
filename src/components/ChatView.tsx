import { useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  Check,
  Copy,
  ExternalLink,
  RotateCcw,
  Square,
  AlertCircle,
} from 'lucide-react';
import type { ChatMessage } from '../types/vitaminD';
import { ScientificMarkdown } from './ScientificMarkdown';

interface ChatViewProps {
  messages: ChatMessage[];
  isStreaming: boolean;
  errorMessage: string | null;
  onSendMessage: (text: string) => void;
  onStopStreaming: () => void;
  onRetryLast: () => void;
  onNewConversation: () => void;
}

const EXAMPLE_QUESTIONS = [
  {
    topic: 'Bioquímica y metabolismo',
    question:
      '¿Cómo ocurre la síntesis cutánea por UVB y las dos hidroxilaciones (CYP2R1 y CYP27B1) hasta formar calcitriol?',
  },
  {
    topic: 'Vitamina D2 vs. D3',
    question:
      '¿Qué diferencias bioquímicas y de potencia clínica existen entre ergocalciferol (D2) y colecalciferol (D3)?',
  },
  {
    topic: 'Guías clínicas 2011 vs. 2024',
    question:
      '¿Qué cambió entre la guía histórica de Endocrine Society 2011 y la actualización de 2024 respecto a umbrales y tamizaje?',
  },
  {
    topic: 'Evidencia de ensayos clínicos',
    question:
      '¿Por qué los grandes ensayos clínicos como VITAL y D-Health mostraron resultados distintos a los estudios observacionales?',
  },
  {
    topic: 'Deficiencia y toxicidad',
    question:
      '¿A partir de qué concentraciones de 25(OH)D aumenta el riesgo de osteomalacia por deficiencia o hipercalcemia por toxicidad?',
  },
  {
    topic: 'Fuentes alimentarias',
    question:
      '¿Qué alimentos aportan vitamina D de forma natural o fortificada y cuáles son las Ingestas Dietéticas de Referencia de NASEM?',
  },
];

export function ChatView({
  messages,
  isStreaming,
  errorMessage,
  onSendMessage,
  onStopStreaming,
  onRetryLast,
  onNewConversation,
}: ChatViewProps) {
  const [input, setInput] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isStreaming, errorMessage]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [input]);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;
    setInput('');
    onSendMessage(trimmed);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 1800);
    } catch {
      // Ignore clipboard failures
    }
  };

  const isEmpty = messages.length === 0;

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Message scroll area */}
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 lg:px-8 py-6">
        <div className="max-w-3xl mx-auto">
          {isEmpty ? (
            <div className="py-4 sm:py-8">
              <div className="mb-8">
                <p className="text-xs font-medium text-sky-700 tracking-wide mb-2">
                  Asistente Científico Especializado
                </p>
                <h2
                  className="text-2xl sm:text-3xl font-semibold text-slate-900 tracking-tight mb-3"
                  style={{ textWrap: 'balance' }}
                >
                  Consulta evidencia verificable sobre vitamina D
                </h2>
                <p className="text-sm sm:text-base text-slate-600 leading-relaxed max-w-2xl">
                  Explora rutas metabólicas, cinética de colecalciferol (D3) y
                  ergocalciferol (D2), síntesis solar por UVB, interpretación de
                  biomarcadores 25(OH)D y diferencias metodológicas entre
                  estudios observacionales, ECA y guías internacionales.
                </p>
              </div>

              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-800">
                  Ejemplos de consulta científica
                </h3>
                <span className="text-xs text-slate-500">
                  Selecciona una pregunta para iniciar
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {EXAMPLE_QUESTIONS.map((item) => (
                  <button
                    key={item.topic}
                    type="button"
                    onClick={() => onSendMessage(item.question)}
                    className="group text-left p-4 rounded-xl border border-slate-200 bg-slate-50/70 hover:bg-sky-50/60 hover:border-sky-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600"
                  >
                    <div className="text-xs font-medium text-sky-700 mb-1.5">
                      {item.topic}
                    </div>
                    <div className="text-sm text-slate-800 leading-snug group-hover:text-slate-950">
                      {item.question}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-6 pb-4">
              {messages.map((msg, index) => {
                const isLastModel =
                  msg.role === 'model' && index === messages.length - 1;
                const showLoadingInBubble =
                  isLastModel && isStreaming && msg.text.trim().length === 0;

                if (msg.role === 'user') {
                  return (
                    <div key={msg.id} className="flex justify-end">
                      <div className="max-w-[88%] sm:max-w-[80%] rounded-2xl bg-sky-50 border border-sky-200/80 px-4 py-3 text-slate-900">
                        {msg.contextTag && (
                          <div className="text-xs font-medium text-sky-800 mb-1.5">
                            {msg.contextTag}
                          </div>
                        )}
                        <p className="text-sm sm:text-[15px] leading-relaxed whitespace-pre-wrap">
                          {msg.text}
                        </p>
                      </div>
                    </div>
                  );
                }

                return (
                  <article
                    key={msg.id}
                    className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-6"
                  >
                    <div className="flex items-center justify-between gap-4 pb-3 mb-4 border-b border-slate-100">
                      <div className="flex items-center gap-2 text-xs text-slate-500">
                        <span className="font-semibold text-blue-700">
                          VITAMIN D AI
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>Síntesis basada en evidencia</span>
                      </div>

                      {msg.text.trim().length > 0 && (
                        <button
                          type="button"
                          onClick={() => handleCopy(msg.id, msg.text)}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-600 hover:text-slate-900 rounded-md hover:bg-slate-100 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600"
                          aria-label="Copiar respuesta"
                        >
                          {copiedId === msg.id ? (
                            <>
                              <Check className="w-3.5 h-3.5 text-sky-700" />
                              <span>Copiado</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-3.5 h-3.5" />
                              <span>Copiar</span>
                            </>
                          )}
                        </button>
                      )}
                    </div>

                    {showLoadingInBubble ? (
                      <div className="flex items-center gap-3 py-2 text-sm text-slate-600">
                        <div className="w-4 h-4 border-2 border-sky-600 border-t-transparent rounded-full animate-spin shrink-0" />
                        <span>Consultando evidencia científica...</span>
                      </div>
                    ) : (
                      <ScientificMarkdown content={msg.text} />
                    )}

                    {msg.sources && msg.sources.length > 0 && (
                      <div className="mt-5 pt-4 border-t border-slate-100">
                        <p className="text-xs font-semibold text-slate-700 mb-2">
                          Fuentes consultadas y verificadas en línea
                        </p>
                        <ul className="space-y-1.5">
                          {msg.sources.map((src) => (
                            <li key={src.uri}>
                              <a
                                href={src.uri}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1.5 text-xs text-sky-700 hover:text-blue-800 hover:underline break-all"
                              >
                                <ExternalLink className="w-3 h-3 shrink-0" />
                                <span>{src.title}</span>
                              </a>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </article>
                );
              })}

              {isStreaming &&
                messages[messages.length - 1]?.role === 'model' &&
                messages[messages.length - 1]?.text.trim().length > 0 && (
                  <div className="flex items-center gap-2.5 text-xs text-slate-500 px-1">
                    <div className="w-3.5 h-3.5 border-2 border-sky-600 border-t-transparent rounded-full animate-spin shrink-0" />
                    <span>Redactando análisis científico...</span>
                  </div>
                )}

              {errorMessage && (
                <div
                  role="alert"
                  className="rounded-xl border border-rose-200 bg-rose-50/70 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                >
                  <div className="flex items-start gap-2.5 text-sm text-rose-900">
                    <AlertCircle className="w-4 h-4 text-rose-700 mt-0.5 shrink-0" />
                    <span>{errorMessage}</span>
                  </div>
                  <button
                    type="button"
                    onClick={onRetryLast}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-rose-800 bg-white border border-rose-200 rounded-lg hover:bg-rose-100/60 transition-colors shrink-0 self-start sm:self-auto"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>Reintentar</span>
                  </button>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          )}
        </div>
      </div>

      {/* Composer */}
      <div className="border-t border-slate-200 bg-slate-50/80 px-4 sm:px-6 lg:px-8 py-3.5">
        <div className="max-w-3xl mx-auto">
          <form
            onSubmit={handleSubmit}
            className="flex items-end gap-2.5 rounded-xl border border-slate-300 bg-white p-2 focus-within:border-sky-600 focus-within:ring-2 focus-within:ring-sky-600/20 transition-all"
          >
            <textarea
              ref={textareaRef}
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Escribe tu consulta científica sobre vitamina D..."
              aria-label="Consulta científica sobre vitamina D"
              className="flex-1 resize-none bg-transparent px-2.5 py-2 text-sm sm:text-[15px] text-slate-900 placeholder:text-slate-400 focus:outline-none max-h-[168px]"
            />

            <div className="flex items-center gap-1.5 shrink-0">
              {messages.length > 0 && !isStreaming && (
                <button
                  type="button"
                  onClick={onNewConversation}
                  title="Nueva conversación"
                  aria-label="Iniciar nueva conversación"
                  className="inline-flex items-center justify-center min-h-[40px] px-3 text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors whitespace-nowrap"
                >
                  Nueva
                </button>
              )}

              {isStreaming ? (
                <button
                  type="button"
                  onClick={onStopStreaming}
                  aria-label="Detener respuesta"
                  className="inline-flex items-center justify-center gap-1.5 min-h-[40px] px-3.5 rounded-lg bg-slate-900 text-white text-xs font-medium hover:bg-slate-800 transition-colors whitespace-nowrap"
                >
                  <Square className="w-3.5 h-3.5 fill-current" />
                  <span>Detener</span>
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!input.trim()}
                  aria-label="Enviar consulta"
                  className="inline-flex items-center justify-center gap-1.5 min-h-[40px] px-4 rounded-lg bg-blue-700 text-white text-xs sm:text-sm font-medium hover:bg-blue-800 disabled:bg-slate-200 disabled:text-slate-400 transition-colors whitespace-nowrap"
                >
                  <span>Enviar</span>
                  <ArrowUp className="w-4 h-4" />
                </button>
              )}
            </div>
          </form>

          <p className="mt-2 text-[11px] text-slate-500 text-center">
            Herramienta educativa basada en evidencia científica. No sustituye la
            evaluación médica ni emite diagnósticos o prescripciones.
          </p>
        </div>
      </div>
    </div>
  );
}
