import { useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  ExternalLink,
  FlaskConical,
  MessageSquarePlus,
  RotateCcw,
} from 'lucide-react';
import type {
  BiologicalSex,
  GroundingSource,
  LabAnalysisInput,
  PregnancyLactationState,
  VitaminDUnit,
} from '../types/vitaminD';
import {
  ANTECEDENT_OPTIONS,
  SYMPTOM_OPTIONS,
  evaluateLabDeterministically,
} from '../utils/vitaminDCalculations';
import { consumeSseStream } from '../utils/streamClient';
import { ScientificMarkdown } from './ScientificMarkdown';

interface LabAnalyzerViewProps {
  onContinueInChat: (userPrompt: string, assistantResponse: string, sources?: GroundingSource[]) => void;
}

const INITIAL_INPUT: LabAnalysisInput = {
  age: '34',
  sex: 'femenino',
  value: '18',
  unit: 'ng/mL',
  pregnancyState: 'ninguno',
  symptoms: [],
  antecedents: [],
  notes: '',
};

export function LabAnalyzerView({ onContinueInChat }: LabAnalyzerViewProps) {
  const [form, setForm] = useState<LabAnalysisInput>(INITIAL_INPUT);
  const [aiReport, setAiReport] = useState<string>('');
  const [aiSources, setAiSources] = useState<GroundingSource[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const deterministic = useMemo(() => evaluateLabDeterministically(form), [form]);

  const toggleSymptom = (id: string) => {
    setForm((prev) => {
      if (id === 'ninguno') {
        return { ...prev, symptoms: prev.symptoms.includes('ninguno') ? [] : ['ninguno'] };
      }
      const cleaned = prev.symptoms.filter((s) => s !== 'ninguno');
      const exists = cleaned.includes(id);
      return {
        ...prev,
        symptoms: exists ? cleaned.filter((s) => s !== id) : [...cleaned, id],
      };
    });
  };

  const toggleAntecedent = (id: string) => {
    setForm((prev) => {
      const exists = prev.antecedents.includes(id);
      return {
        ...prev,
        antecedents: exists
          ? prev.antecedents.filter((a) => a !== id)
          : [...prev.antecedents, id],
      };
    });
  };

  const handleUnitChange = (nextUnit: VitaminDUnit) => {
    setForm((prev) => ({ ...prev, unit: nextUnit }));
  };

  const handleReset = () => {
    abortRef.current?.abort();
    setForm({
      age: '',
      sex: 'femenino',
      value: '',
      unit: 'ng/mL',
      pregnancyState: 'ninguno',
      symptoms: [],
      antecedents: [],
      notes: '',
    });
    setAiReport('');
    setAiSources([]);
    setAiError(null);
    setIsAnalyzing(false);
  };

  const handleInterpretWithAI = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!deterministic) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setAiReport('');
    setAiSources([]);
    setAiError(null);
    setIsAnalyzing(true);

    const symptomLabels = SYMPTOM_OPTIONS.filter((s) =>
      form.symptoms.includes(s.id)
    ).map((s) => s.label);
    const antecedentLabels = ANTECEDENT_OPTIONS.filter((a) =>
      form.antecedents.includes(a.id)
    ).map((a) => a.label);

    await consumeSseStream(
      '/api/lab-interpret',
      {
        ...form,
        symptoms: symptomLabels,
        antecedents: antecedentLabels,
        ngMl: deterministic.ngMl,
        nmolL: deterministic.nmolL,
      },
      {
        onChunk: (chunk) => setAiReport((prev) => prev + chunk),
        onSources: (sources) => setAiSources(sources),
        onDone: () => setIsAnalyzing(false),
        onError: (msg) => {
          setAiError(msg);
          setIsAnalyzing(false);
        },
      },
      controller.signal
    );
  };

  const handleTransferToChat = () => {
    if (!deterministic || !aiReport.trim()) return;
    const promptSummary = `Interpretación educativa de laboratorio de 25(OH)D: ${form.value} ${form.unit} (${deterministic.ngMl.toFixed(1)} ng/mL | ${deterministic.nmolL.toFixed(1)} nmol/L), edad ${form.age || 'no especificada'}, sexo ${form.sex}${form.pregnancyState !== 'ninguno' ? `, ${form.pregnancyState}` : ''}.`;
    onContinueInChat(promptSummary, aiReport, aiSources);
  };

  const markerPercent = deterministic
    ? Math.min(100, Math.max(0, (deterministic.ngMl / 120) * 100))
    : 0;

  return (
    <div className="h-full overflow-y-auto bg-slate-50 px-4 sm:px-6 lg:px-8 py-6">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header section */}
        <div className="bg-white rounded-xl border border-slate-200 p-5 sm:p-6">
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
            <div>
              <p className="text-xs font-medium text-sky-700 mb-1">
                Conversión y Criterios Comparados · 25(OH)D Sérica
              </p>
              <h2 className="text-xl sm:text-2xl font-semibold text-slate-900 tracking-tight">
                Analizador educativo de laboratorio
              </h2>
              <p className="mt-1.5 text-sm text-slate-600 max-w-2xl leading-relaxed">
                Convierte resultados entre <span className="font-mono">ng/mL</span> y{' '}
                <span className="font-mono">nmol/L</span>, contrasta los criterios de{' '}
                <strong>NASEM (IOM 2011)</strong> con la evolución de{' '}
                <strong>Endocrine Society (2011 vs. 2024)</strong> y genera una
                explicación científica personalizada sin emitir diagnósticos ni prescripciones.
              </p>
            </div>
            <button
              type="button"
              onClick={handleReset}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors shrink-0 self-start"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Limpiar datos</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Form Column */}
          <form
            onSubmit={handleInterpretWithAI}
            className="lg:col-span-5 bg-white rounded-xl border border-slate-200 p-5 sm:p-6 space-y-5"
          >
            <h3 className="text-base font-semibold text-slate-900">
              Datos del resultado y contexto
            </h3>

            {/* Biomarker value + unit */}
            <div>
              <label
                htmlFor="lab-value"
                className="block text-sm font-medium text-slate-800 mb-1.5"
              >
                Resultado de 25-hidroxivitamina D [25(OH)D]
              </label>
              <div className="flex gap-2">
                <input
                  id="lab-value"
                  type="number"
                  step="0.1"
                  min="0"
                  max="1000"
                  required
                  value={form.value}
                  onChange={(e) => setForm({ ...form, value: e.target.value })}
                  placeholder="Ej. 18.5"
                  className="flex-1 min-w-0 rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm font-mono tabular-nums text-slate-900 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600/20"
                />
                <div
                  className="inline-flex rounded-lg border border-slate-300 bg-slate-100 p-0.5 shrink-0"
                  role="group"
                  aria-label="Unidad de laboratorio"
                >
                  {(['ng/mL', 'nmol/L'] as const).map((unitOption) => (
                    <button
                      key={unitOption}
                      type="button"
                      onClick={() => handleUnitChange(unitOption)}
                      className={`px-3 py-2 text-xs font-mono font-medium rounded-md transition-colors whitespace-nowrap ${
                        form.unit === unitOption
                          ? 'bg-white text-blue-700 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {unitOption}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Age & Sex */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label
                  htmlFor="lab-age"
                  className="block text-sm font-medium text-slate-800 mb-1.5"
                >
                  Edad (años)
                </label>
                <input
                  id="lab-age"
                  type="number"
                  min="0"
                  max="120"
                  value={form.age}
                  onChange={(e) => setForm({ ...form, age: e.target.value })}
                  placeholder="Ej. 34"
                  className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm font-mono tabular-nums text-slate-900 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600/20"
                />
              </div>

              <div>
                <label
                  htmlFor="lab-sex"
                  className="block text-sm font-medium text-slate-800 mb-1.5"
                >
                  Sexo biológico
                </label>
                <select
                  id="lab-sex"
                  value={form.sex}
                  onChange={(e) =>
                    setForm({ ...form, sex: e.target.value as BiologicalSex })
                  }
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600/20"
                >
                  <option value="femenino">Femenino</option>
                  <option value="masculino">Masculino</option>
                  <option value="otro">Otro / Prefiere no indicar</option>
                </select>
              </div>
            </div>

            {/* Pregnancy / Lactation */}
            <div>
              <label
                htmlFor="lab-pregnancy"
                className="block text-sm font-medium text-slate-800 mb-1.5"
              >
                Embarazo o lactancia
              </label>
              <select
                id="lab-pregnancy"
                value={form.pregnancyState}
                onChange={(e) =>
                  setForm({
                    ...form,
                    pregnancyState: e.target.value as PregnancyLactationState,
                  })
                }
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600/20"
              >
                <option value="ninguno">No aplica</option>
                <option value="embarazo">Embarazo actual</option>
                <option value="lactancia">Lactancia actual</option>
              </select>
            </div>

            {/* Symptoms */}
            <div>
              <span className="block text-sm font-medium text-slate-800 mb-2">
                Síntomas reportados
              </span>
              <div className="space-y-2">
                {SYMPTOM_OPTIONS.map((symptom) => {
                  const checked = form.symptoms.includes(symptom.id);
                  return (
                    <label
                      key={symptom.id}
                      className={`flex items-start gap-2.5 p-2.5 rounded-lg border text-xs sm:text-sm cursor-pointer transition-colors ${
                        checked
                          ? 'border-sky-400 bg-sky-50/70 text-slate-900'
                          : 'border-slate-200 bg-white hover:bg-slate-50 text-slate-700'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleSymptom(symptom.id)}
                        className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-700 focus:ring-sky-600"
                      />
                      <span className="leading-snug">{symptom.label}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            {/* Antecedents */}
            <div>
              <span className="block text-sm font-medium text-slate-800 mb-2">
                Antecedentes médicos o farmacológicos relevantes
              </span>
              <div className="space-y-2">
                {ANTECEDENT_OPTIONS.map((ant) => {
                  const checked = form.antecedents.includes(ant.id);
                  return (
                    <label
                      key={ant.id}
                      className={`flex items-start gap-2.5 p-2.5 rounded-lg border text-xs sm:text-sm cursor-pointer transition-colors ${
                        checked
                          ? 'border-sky-400 bg-sky-50/70 text-slate-900'
                          : 'border-slate-200 bg-white hover:bg-slate-50 text-slate-700'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleAntecedent(ant.id)}
                        className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-700 focus:ring-sky-600"
                      />
                      <span className="leading-snug">{ant.label}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            {/* Additional notes */}
            <div>
              <label
                htmlFor="lab-notes"
                className="block text-sm font-medium text-slate-800 mb-1.5"
              >
                Notas adicionales (opcional)
              </label>
              <textarea
                id="lab-notes"
                rows={2}
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="Ej. suplementación reciente, estación del año, otros valores de calcio o PTH..."
                className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600/20"
              />
            </div>

            <button
              type="submit"
              disabled={!deterministic || isAnalyzing}
              className="w-full inline-flex items-center justify-center gap-2 min-h-[44px] px-4 py-2.5 rounded-lg bg-blue-700 text-white text-sm font-medium hover:bg-blue-800 disabled:bg-slate-200 disabled:text-slate-400 transition-colors"
            >
              <FlaskConical className="w-4 h-4" />
              <span>
                {isAnalyzing
                  ? 'Generando interpretación científica...'
                  : 'Interpretar con VITAMIN D AI'}
              </span>
            </button>
          </form>

          {/* Deterministic Criteria & AI Output Column */}
          <div className="lg:col-span-7 space-y-6">
            {deterministic ? (
              <>
                {/* Unit Conversion + Linear Reference Scale */}
                <div className="bg-white rounded-xl border border-slate-200 p-5 sm:p-6">
                  <div className="flex flex-wrap items-baseline justify-between gap-4 pb-5 border-b border-slate-100">
                    <div>
                      <p className="text-xs font-medium text-slate-500 mb-1">
                        Concentración equivalente en ng/mL
                      </p>
                      <div className="flex items-baseline">
                        <span className="text-3xl font-mono font-semibold tabular-nums text-slate-900">
                          {deterministic.ngMl.toFixed(1)}
                        </span>
                        <span className="text-xs font-mono uppercase text-slate-500 ml-1.5">
                          ng/mL
                        </span>
                      </div>
                    </div>

                    <div className="text-slate-300 hidden sm:block" aria-hidden="true">
                      <ArrowRight className="w-5 h-5" />
                    </div>

                    <div>
                      <p className="text-xs font-medium text-slate-500 mb-1">
                        Conversión exacta (× 2.496)
                      </p>
                      <div className="flex items-baseline">
                        <span className="text-3xl font-mono font-semibold tabular-nums text-blue-700">
                          {deterministic.nmolL.toFixed(1)}
                        </span>
                        <span className="text-xs font-mono uppercase text-slate-500 ml-1.5">
                          nmol/L
                        </span>
                      </div>
                    </div>
                  </div>

                  <p className="mt-3 text-xs text-slate-500 font-mono tabular-nums">
                    Factor molecular exacto: 1 ng/mL = 2.496 nmol/L (aproximación clínica habitual × 2.5:{' '}
                    {deterministic.clinicalApproxNmolL.toFixed(1)} nmol/L).
                  </p>

                  {/* Linear reference scale */}
                  <div className="mt-5">
                    <div className="flex items-center justify-between text-xs text-slate-600 mb-2">
                      <span>Escala de referencia poblacional (ng/mL)</span>
                      <span className="font-mono tabular-nums">
                        {deterministic.ngMl.toFixed(1)} ng/mL
                      </span>
                    </div>
                    <div className="relative h-3.5 rounded-full overflow-hidden flex border border-slate-200">
                      <div
                        className="bg-rose-200 h-full"
                        style={{ width: '10%' }}
                        title="< 12 ng/mL"
                      />
                      <div
                        className="bg-amber-200 h-full"
                        style={{ width: '6.67%' }}
                        title="12 - 20 ng/mL"
                      />
                      <div
                        className="bg-sky-200 h-full"
                        style={{ width: '25%' }}
                        title="20 - 50 ng/mL"
                      />
                      <div
                        className="bg-slate-200 h-full"
                        style={{ width: '41.67%' }}
                        title="50 - 100 ng/mL"
                      />
                      <div
                        className="bg-rose-300 h-full"
                        style={{ width: '16.66%' }}
                        title="> 100 ng/mL"
                      />
                      <div
                        className="absolute top-0 bottom-0 w-1 bg-slate-950"
                        style={{ left: `calc(${markerPercent}% - 2px)` }}
                      />
                    </div>
                    <div className="mt-1.5 flex justify-between text-[11px] font-mono tabular-nums text-slate-500">
                      <span>0</span>
                      <span>12</span>
                      <span>20</span>
                      <span>50</span>
                      <span>100</span>
                      <span>120+</span>
                    </div>
                  </div>
                </div>

                {/* Comparative Scientific Criteria */}
                <div className="bg-white rounded-xl border border-slate-200 p-5 sm:p-6 space-y-4">
                  <h3 className="text-base font-semibold text-slate-900">
                    Comparación entre criterios científicos
                  </h3>

                  <div className="space-y-3">
                    {/* NASEM */}
                    <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                        <span className="text-sm font-semibold text-slate-900">
                          {deterministic.nasemCategory.label}
                        </span>
                        <span className="text-xs font-mono tabular-nums text-slate-600">
                          {deterministic.nasemCategory.rangeLabel}
                        </span>
                      </div>
                      <p className="text-xs sm:text-sm text-slate-700 leading-relaxed">
                        {deterministic.nasemCategory.summary}
                      </p>
                    </div>

                    {/* Endocrine Society 2011 */}
                    <div className="rounded-lg border border-slate-200 bg-white p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                        <span className="text-sm font-semibold text-slate-900">
                          Endocrine Society (2011): {deterministic.endocrine2011Category.label}
                        </span>
                        <span className="text-xs font-mono tabular-nums text-slate-600">
                          {deterministic.endocrine2011Category.rangeLabel}
                        </span>
                      </div>
                      <p className="text-xs sm:text-sm text-slate-600 leading-relaxed">
                        {deterministic.endocrine2011Category.summary}
                      </p>
                    </div>

                    {/* Endocrine Society 2024 */}
                    <div className="rounded-lg border border-sky-200 bg-sky-50/60 p-4">
                      <div className="text-sm font-semibold text-sky-950 mb-1">
                        {deterministic.endocrine2024Note.paradigm}
                      </div>
                      <p className="text-xs sm:text-sm text-sky-900/90 leading-relaxed">
                        {deterministic.endocrine2024Note.summary}
                      </p>
                      {deterministic.endocrine2024Note.empiricalGroupMatch && (
                        <p className="mt-2 pt-2 border-t border-sky-200/80 text-xs sm:text-sm text-sky-950 leading-relaxed">
                          {deterministic.endocrine2024Note.empiricalGroupMatch}
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                {/* Deterministic Medical Attention Flags */}
                {deterministic.medicalAttentionReasons.length > 0 && (
                  <div className="rounded-xl border border-amber-300 bg-amber-50/70 p-5">
                    <div className="flex items-start gap-3">
                      <AlertTriangle className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
                      <div>
                        <h3 className="text-sm font-semibold text-amber-950 mb-1.5">
                          Situaciones que ameritan evaluación médica presencial
                        </h3>
                        <ul className="space-y-1 text-xs sm:text-sm text-amber-900 list-disc pl-4">
                          {deterministic.medicalAttentionReasons.map((reason) => (
                            <li key={reason}>{reason}</li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </div>
                )}

                {/* VITAMIN D AI Interpretation Panel */}
                {(isAnalyzing || aiReport || aiError) && (
                  <div className="bg-white rounded-xl border border-slate-200 p-5 sm:p-6">
                    <div className="flex flex-wrap items-center justify-between gap-3 pb-3 mb-4 border-b border-slate-100">
                      <div>
                        <p className="text-xs font-medium text-blue-700">
                          VITAMIN D AI · Explicación Educativa
                        </p>
                        <h3 className="text-base font-semibold text-slate-900">
                          Síntesis científica del resultado
                        </h3>
                      </div>

                      {aiReport.trim().length > 0 && !isAnalyzing && (
                        <button
                          type="button"
                          onClick={handleTransferToChat}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-700 bg-sky-50 border border-sky-200 rounded-lg hover:bg-sky-100 transition-colors"
                        >
                          <MessageSquarePlus className="w-3.5 h-3.5" />
                          <span>Continuar en el Chat científico</span>
                        </button>
                      )}
                    </div>

                    {aiError && (
                      <div className="rounded-lg border border-rose-200 bg-rose-50 p-3.5 text-sm text-rose-900 mb-3">
                        {aiError}
                      </div>
                    )}

                    {isAnalyzing && !aiReport && (
                      <div className="flex items-center gap-3 py-4 text-sm text-slate-600">
                        <div className="w-4 h-4 border-2 border-sky-600 border-t-transparent rounded-full animate-spin shrink-0" />
                        <span>
                          Analizando biomarcador, criterios NASEM/Endocrine Society y contexto...
                        </span>
                      </div>
                    )}

                    {aiReport && <ScientificMarkdown content={aiReport} />}

                    {aiSources.length > 0 && (
                      <div className="mt-5 pt-4 border-t border-slate-100">
                        <p className="text-xs font-semibold text-slate-700 mb-2">
                          Fuentes verificadas
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
              </>
            ) : (
              <div className="bg-white rounded-xl border border-slate-200 p-8 text-center">
                <p className="text-sm text-slate-600">
                  Ingresa un valor numérico válido de <span className="font-mono">25(OH)D</span> entre{' '}
                  <span className="font-mono">0</span> y <span className="font-mono">1000</span> para ver
                  la conversión exacta de unidades y el análisis comparativo de guías.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
