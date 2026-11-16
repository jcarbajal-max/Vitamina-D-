import { useRef, useState } from 'react';
import {
  CheckSquare,
  ExternalLink,
  MessageSquarePlus,
  RotateCcw,
  ShieldAlert,
} from 'lucide-react';
import type { GroundingSource } from '../types/vitaminD';
import { RISK_FACTOR_OPTIONS } from '../utils/vitaminDCalculations';
import { consumeSseStream } from '../utils/streamClient';
import { ScientificMarkdown } from './ScientificMarkdown';

interface RiskAssessmentViewProps {
  onContinueInChat: (
    userPrompt: string,
    assistantResponse: string,
    sources?: GroundingSource[]
  ) => void;
}

export function RiskAssessmentView({ onContinueInChat }: RiskAssessmentViewProps) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [additionalContext, setAdditionalContext] = useState('');
  const [aiAnalysis, setAiAnalysis] = useState('');
  const [aiSources, setAiSources] = useState<GroundingSource[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const selectedFactors = RISK_FACTOR_OPTIONS.filter((opt) =>
    selectedIds.includes(opt.id)
  );

  const toggleFactor = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const handleReset = () => {
    abortRef.current?.abort();
    setSelectedIds([]);
    setAdditionalContext('');
    setAiAnalysis('');
    setAiSources([]);
    setErrorMsg(null);
    setIsAnalyzing(false);
  };

  const handleAnalyzeWithAI = async () => {
    if (selectedFactors.length === 0) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setAiAnalysis('');
    setAiSources([]);
    setErrorMsg(null);
    setIsAnalyzing(true);

    await consumeSseStream(
      '/api/risk-interpret',
      {
        selectedFactors: selectedFactors.map((f) => ({
          label: f.label,
          category: f.category,
          mechanism: f.mechanism,
        })),
        additionalContext,
      },
      {
        onChunk: (chunk) => setAiAnalysis((prev) => prev + chunk),
        onSources: (sources) => setAiSources(sources),
        onDone: () => setIsAnalyzing(false),
        onError: (msg) => {
          setErrorMsg(msg);
          setIsAnalyzing(false);
        },
      },
      controller.signal
    );
  };

  const handleTransferToChat = () => {
    if (selectedFactors.length === 0 || !aiAnalysis.trim()) return;
    const summaryPrompt = `Factores educativos identificados sobre vitamina D: ${selectedFactors
      .map((f) => f.label)
      .join('; ')}.${additionalContext.trim() ? ` Contexto: ${additionalContext.trim()}` : ''}`;
    onContinueInChat(summaryPrompt, aiAnalysis, aiSources);
  };

  return (
    <div className="h-full overflow-y-auto bg-slate-50 px-4 sm:px-6 lg:px-8 py-6">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <div className="bg-white rounded-xl border border-slate-200 p-5 sm:p-6">
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
            <div>
              <p className="text-xs font-medium text-sky-700 mb-1">
                Cuestionario Educativo · Determinantes Fisiológicos y Ambientales
              </p>
              <h2 className="text-xl sm:text-2xl font-semibold text-slate-900 tracking-tight">
                Evaluación de factores relacionados con deficiencia de vitamina D
              </h2>
              <p className="mt-1.5 text-sm text-slate-600 max-w-2xl leading-relaxed">
                Identifica factores biológicos, dietéticos, ambientales o farmacológicos
                descritos en la literatura médica. Este cuestionario{' '}
                <strong>no calcula puntuaciones clínicas no validadas</strong> ni
                predice concentraciones séricas exactas; su finalidad es exclusivamente
                educativa.
              </p>
            </div>
            <button
              type="button"
              onClick={handleReset}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors shrink-0 self-start"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Reiniciar selección</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Checklist */}
          <div className="lg:col-span-7 bg-white rounded-xl border border-slate-200 p-5 sm:p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="text-base font-semibold text-slate-900">
                Marca los factores presentes
              </h3>
              <span className="text-xs font-mono tabular-nums text-slate-500">
                {selectedFactors.length} de {RISK_FACTOR_OPTIONS.length} seleccionados
              </span>
            </div>

            <div className="space-y-3">
              {RISK_FACTOR_OPTIONS.map((factor) => {
                const isSelected = selectedIds.includes(factor.id);
                return (
                  <label
                    key={factor.id}
                    className={`block rounded-xl border p-4 cursor-pointer transition-colors ${
                      isSelected
                        ? 'border-sky-500 bg-sky-50/60'
                        : 'border-slate-200 bg-white hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleFactor(factor.id)}
                        className="mt-1 h-4 w-4 rounded border-slate-300 text-blue-700 focus:ring-sky-600 shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium text-sky-700 mb-0.5">
                          {factor.category}
                        </div>
                        <div className="text-sm font-semibold text-slate-900 leading-snug">
                          {factor.label}
                        </div>
                        <p className="mt-1 text-xs sm:text-sm text-slate-600 leading-relaxed">
                          {factor.description}
                        </p>
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>

            <div className="pt-2">
              <label
                htmlFor="risk-context"
                className="block text-sm font-medium text-slate-800 mb-1.5"
              >
                Contexto adicional (opcional)
              </label>
              <textarea
                id="risk-context"
                rows={2}
                value={additionalContext}
                onChange={(e) => setAdditionalContext(e.target.value)}
                placeholder="Ej. ciudad o latitud aproximada, estación del año, medicamentos específicos..."
                className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600/20"
              />
            </div>
          </div>

          {/* Identified Factors & Scientific Analysis */}
          <div className="lg:col-span-5 space-y-6">
            <div className="bg-white rounded-xl border border-slate-200 p-5 sm:p-6 space-y-4">
              <div className="flex items-center gap-2 text-slate-900">
                <CheckSquare className="w-4 h-4 text-blue-700" />
                <h3 className="text-base font-semibold">
                  Factores identificados ({selectedFactors.length})
                </h3>
              </div>

              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5 text-xs text-slate-600 leading-relaxed">
                <strong>Criterio metodológico:</strong> No se asigna ningún puntaje
                numérico ni porcentaje de probabilidad porque la evidencia científica
                no respalda un índice único validado para estimar la 25(OH)D sérica
                sin medición directa en laboratorio.
              </div>

              {selectedFactors.length === 0 ? (
                <p className="text-sm text-slate-500 py-4 text-center">
                  Selecciona uno o más factores en la lista para consultar su
                  mecanismo bioquímico y respaldo científico.
                </p>
              ) : (
                <>
                  <div className="space-y-3">
                    {selectedFactors.map((factor) => (
                      <div
                        key={factor.id}
                        className="rounded-lg border border-slate-200 bg-white p-3.5 space-y-1.5"
                      >
                        <div className="text-xs font-medium text-sky-700">
                          {factor.category}
                        </div>
                        <div className="text-sm font-semibold text-slate-900">
                          {factor.label}
                        </div>
                        <p className="text-xs text-slate-700 leading-relaxed">
                          <strong>Mecanismo:</strong> {factor.mechanism}
                        </p>
                        <p className="text-xs text-slate-500 leading-relaxed">
                          <strong>Evidencia:</strong> {factor.evidenceNote}
                        </p>
                      </div>
                    ))}
                  </div>

                  <button
                    type="button"
                    onClick={handleAnalyzeWithAI}
                    disabled={isAnalyzing}
                    className="w-full inline-flex items-center justify-center gap-2 min-h-[44px] px-4 py-2.5 rounded-lg bg-blue-700 text-white text-sm font-medium hover:bg-blue-800 disabled:bg-slate-200 disabled:text-slate-400 transition-colors"
                  >
                    <ShieldAlert className="w-4 h-4" />
                    <span>
                      {isAnalyzing
                        ? 'Sintetizando evidencia científica...'
                        : 'Analizar factores con VITAMIN D AI'}
                    </span>
                  </button>
                </>
              )}
            </div>

            {(isAnalyzing || aiAnalysis || errorMsg) && (
              <div className="bg-white rounded-xl border border-slate-200 p-5 sm:p-6">
                <div className="flex flex-wrap items-center justify-between gap-2 pb-3 mb-4 border-b border-slate-100">
                  <div>
                    <p className="text-xs font-medium text-blue-700">
                      VITAMIN D AI · Síntesis Educativa
                    </p>
                    <h3 className="text-base font-semibold text-slate-900">
                      Análisis de los factores seleccionados
                    </h3>
                  </div>

                  {aiAnalysis.trim().length > 0 && !isAnalyzing && (
                    <button
                      type="button"
                      onClick={handleTransferToChat}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-700 bg-sky-50 border border-sky-200 rounded-lg hover:bg-sky-100 transition-colors"
                    >
                      <MessageSquarePlus className="w-3.5 h-3.5" />
                      <span>Llevar al Chat</span>
                    </button>
                  )}
                </div>

                {errorMsg && (
                  <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900 mb-3">
                    {errorMsg}
                  </div>
                )}

                {isAnalyzing && !aiAnalysis && (
                  <div className="flex items-center gap-3 py-3 text-sm text-slate-600">
                    <div className="w-4 h-4 border-2 border-sky-600 border-t-transparent rounded-full animate-spin shrink-0" />
                    <span>Evaluando interacción fisiológica y literatura...</span>
                  </div>
                )}

                {aiAnalysis && <ScientificMarkdown content={aiAnalysis} />}

                {aiSources.length > 0 && (
                  <div className="mt-4 pt-3 border-t border-slate-100">
                    <p className="text-xs font-semibold text-slate-700 mb-2">
                      Fuentes consultadas
                    </p>
                    <ul className="space-y-1.5">
                      {aiSources.map((src) => (
                        <li key={src.uri}>
                          <a
                            href={src.uri}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 text-xs text-sky-700 hover:underline break-all"
                          >
                            <ExternalLink className="w-3 h-3 shrink-0" />
                            <span>{src.title}</span>
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
