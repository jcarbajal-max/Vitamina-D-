import { useMemo, useState } from 'react';
import { ExternalLink, MessageSquare, Search } from 'lucide-react';
import { LIBRARY_RESOURCES } from '../utils/vitaminDCalculations';

interface LibraryViewProps {
  onAskAboutResource: (prompt: string) => void;
}

type LibraryFilter = 'todas' | 'guias' | 'agencias' | 'ensayos';

const FILTER_TABS: Array<{ id: LibraryFilter; label: string }> = [
  { id: 'todas', label: 'Todas las fuentes' },
  { id: 'guias', label: 'Guías Clínicas' },
  { id: 'agencias', label: 'Agencias y Organismos' },
  { id: 'ensayos', label: 'Ensayos y PubMed' },
];

export function LibraryView({ onAskAboutResource }: LibraryViewProps) {
  const [filter, setFilter] = useState<LibraryFilter>('todas');
  const [query, setQuery] = useState('');

  const filteredResources = useMemo(() => {
    const q = query.trim().toLowerCase();
    return LIBRARY_RESOURCES.filter((res) => {
      const matchesCategory = filter === 'todas' || res.category === filter;
      const matchesQuery =
        !q ||
        res.title.toLowerCase().includes(q) ||
        res.institution.toLowerCase().includes(q) ||
        res.summary.toLowerCase().includes(q) ||
        res.identifierLabel.toLowerCase().includes(q);
      return matchesCategory && matchesQuery;
    });
  }, [filter, query]);

  return (
    <div className="h-full overflow-y-auto bg-slate-50 px-4 sm:px-6 lg:px-8 py-6">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header & Search */}
        <div className="bg-white rounded-xl border border-slate-200 p-5 sm:p-6 space-y-5">
          <div>
            <p className="text-xs font-medium text-sky-700 mb-1">
              Fuentes Primarias, Guías y Consensos Verificados
            </p>
            <h2 className="text-xl sm:text-2xl font-semibold text-slate-900 tracking-tight">
              Biblioteca científica sobre vitamina D
            </h2>
            <p className="mt-1.5 text-sm text-slate-600 max-w-2xl leading-relaxed">
              Accede directamente a los documentos de referencia de la{' '}
              <strong>NIH Office of Dietary Supplements</strong>,{' '}
              <strong>Endocrine Society (2011 y 2024)</strong>,{' '}
              <strong>NASEM (IOM)</strong>, <strong>OMS</strong> y ensayos clínicos
              indexados en <strong>PubMed</strong>.
            </p>
          </div>

          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
            {/* Filter segmented control */}
            <div
              className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg border border-slate-200"
              role="tablist"
              aria-label="Filtrar fuentes científicas"
            >
              {FILTER_TABS.map((tab) => {
                const active = filter === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setFilter(tab.id)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                      active
                        ? 'bg-white text-blue-700 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>

            {/* Search bar */}
            <div className="relative w-full md:w-72">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar por guía, PMID, DOI..."
                aria-label="Buscar en la biblioteca científica"
                className="w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3.5 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600/20"
              />
            </div>
          </div>
        </div>

        {/* Resource grid */}
        {filteredResources.length === 0 ? (
          <div className="bg-white rounded-xl border border-slate-200 p-8 text-center">
            <p className="text-sm text-slate-600">
              No se encontraron fuentes que coincidan con tu búsqueda.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {filteredResources.map((res) => (
              <article
                key={res.id}
                className="bg-white rounded-xl border border-slate-200 p-5 flex flex-col justify-between gap-4 hover:border-sky-300 transition-colors"
              >
                <div>
                  <h3 className="text-base font-semibold text-slate-900 leading-snug">
                    {res.title}
                  </h3>

                  {/* Clean unboxed metadata with typographic separators */}
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                    <span className="font-medium text-sky-700">{res.institution}</span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono">{res.year}</span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono text-slate-600">{res.identifierLabel}</span>
                  </div>

                  <p className="mt-3 text-sm text-slate-700 leading-relaxed">
                    {res.summary}
                  </p>

                  <div className="mt-3 rounded-lg bg-slate-50 border border-slate-200/80 p-3 text-xs text-slate-700 leading-relaxed">
                    <strong className="text-slate-900">Punto clave:</strong>{' '}
                    {res.keyTakeaway}
                  </div>
                </div>

                <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2.5">
                  <a
                    href={res.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-blue-700 bg-sky-50 border border-sky-200 rounded-lg hover:bg-sky-100 transition-colors whitespace-nowrap"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    <span>Consultar documento</span>
                  </a>

                  <button
                    type="button"
                    onClick={() => onAskAboutResource(res.chatPrompt)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 hover:text-slate-950 hover:bg-slate-100 rounded-lg transition-colors whitespace-nowrap"
                  >
                    <MessageSquare className="w-3.5 h-3.5" />
                    <span>Preguntar a VITAMIN D AI</span>
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
