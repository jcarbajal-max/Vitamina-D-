import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
} from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Database,
  Eye,
  EyeOff,
  FileText,
  KeyRound,
  Loader2,
  LogOut,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  DOCUMENT_CATEGORIES,
  PUBLICATION_TYPES,
  type DocumentCategory,
  type ExtractedPage,
  type PublicationTypeId,
  type RagDocument,
  type RagLibraryStats,
} from '../types/vitaminD';
import {
  extractDocumentFile,
  type DocumentExtractionResult,
} from '../utils/pdfExtractor';

interface MetadataFormState {
  title: string;
  authors: string;
  publicationYear: string;
  journalOrInstitution: string;
  doi: string;
  pmid: string;
  referenceUrl: string;
  publicationType: PublicationTypeId;
  category: DocumentCategory;
  language: string;
  isHistorical: boolean;
}

const INITIAL_FORM_STATE: MetadataFormState = {
  title: '',
  authors: '',
  publicationYear: String(new Date().getFullYear()),
  journalOrInstitution: '',
  doi: '',
  pmid: '',
  referenceUrl: '',
  publicationType: 'guia_clinica',
  category: 'Investigación científica',
  language: 'es',
  isHistorical: false,
};

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_EXTRACTED_CHARS = 1_500_000;
const BATCH_MAX_PAGES = 15;
const BATCH_MAX_CHARS = 35_000;

type ProcessingStep =
  | 'idle'
  | 'extracting'
  | 'indexing'
  | 'done'
  | 'error';

function getPublicationLabel(typeId: string): string {
  const found = PUBLICATION_TYPES.find((t) => t.id === typeId);
  return found ? `Nivel ${found.tier} · ${found.label}` : typeId;
}

function suggestTitleFromFilename(filename: string): string {
  return filename
    .replace(/\.(pdf|txt|md|markdown)$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function computeSha256Hex(text: string): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return '';
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function buildControlledPageBatches(pages: ExtractedPage[]): ExtractedPage[][] {
  const normalizedPages: ExtractedPage[] = [];

  for (const page of pages) {
    if (page.text.length <= BATCH_MAX_CHARS) {
      normalizedPages.push(page);
      continue;
    }
    // Split oversized single-page text (e.g. long TXT/MD files) safely along paragraph/line breaks
    let remaining = page.text;
    while (remaining.length > 0) {
      if (remaining.length <= BATCH_MAX_CHARS) {
        normalizedPages.push({ pageNumber: page.pageNumber, text: remaining });
        break;
      }
      let splitAt = remaining.lastIndexOf('\n\n', BATCH_MAX_CHARS);
      if (splitAt < BATCH_MAX_CHARS * 0.4) {
        splitAt = remaining.lastIndexOf('\n', BATCH_MAX_CHARS);
      }
      if (splitAt < BATCH_MAX_CHARS * 0.4) {
        splitAt = remaining.lastIndexOf(' ', BATCH_MAX_CHARS);
      }
      if (splitAt <= 0) {
        splitAt = BATCH_MAX_CHARS;
      }
      normalizedPages.push({
        pageNumber: page.pageNumber,
        text: remaining.slice(0, splitAt).trim(),
      });
      remaining = remaining.slice(splitAt).trim();
    }
  }

  const batches: ExtractedPage[][] = [];
  let currentBatch: ExtractedPage[] = [];
  let currentChars = 0;

  for (const page of normalizedPages) {
    if (
      currentBatch.length > 0 &&
      (currentBatch.length >= BATCH_MAX_PAGES ||
        currentChars + page.text.length > BATCH_MAX_CHARS)
    ) {
      batches.push(currentBatch);
      currentBatch = [];
      currentChars = 0;
    }
    currentBatch.push(page);
    currentChars += page.text.length;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

export function AdminKnowledgeView() {
  // Token kept strictly in React memory for the active session
  const [adminToken, setAdminToken] = useState<string | null>(null);
  const [tokenInput, setTokenInput] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [stats, setStats] = useState<RagLibraryStats | null>(null);
  const [documents, setDocuments] = useState<RagDocument[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('todas');

  const [editingDoc, setEditingDoc] = useState<RagDocument | null>(null);
  const [form, setForm] = useState<MetadataFormState>(INITIAL_FORM_STATE);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [extraction, setExtraction] = useState<DocumentExtractionResult | null>(null);
  const [extractProgress, setExtractProgress] = useState<string>('');
  const [indexingProgress, setIndexingProgress] = useState<string>('');
  const [processingStep, setProcessingStep] = useState<ProcessingStep>('idle');
  const [submitMessage, setSubmitMessage] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const fetchStatsAndDocs = useCallback(
    async (token: string, q: string, cat: string) => {
      setListLoading(true);
      setListError(null);
      try {
        const params = new URLSearchParams();
        if (q.trim()) params.set('q', q.trim());
        if (cat && cat !== 'todas') params.set('category', cat);

        const [statsRes, docsRes] = await Promise.all([
          fetch('/api/admin/stats', {
            headers: { Authorization: `Bearer ${token}` },
          }),
          fetch(`/api/admin/documents?${params.toString()}`, {
            headers: { Authorization: `Bearer ${token}` },
          }),
        ]);

        if (statsRes.status === 401 || docsRes.status === 401) {
          setAdminToken(null);
          setAuthError('La sesión administrativa expiró o el token ya no es válido.');
          return;
        }

        const statsData = (await statsRes.json()) as RagLibraryStats & { error?: string };
        if (statsRes.ok) {
          setStats(statsData);
        }

        const docsData = (await docsRes.json()) as {
          documents?: RagDocument[];
          error?: string;
        };
        if (!docsRes.ok) {
          setListError(docsData.error || 'No se pudieron consultar los documentos.');
        } else {
          setDocuments(docsData.documents ?? []);
        }
      } catch {
        setListError('Error de conexión al consultar el repositorio científico.');
      } finally {
        setListLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    if (!adminToken) return;
    const timer = window.setTimeout(() => {
      void fetchStatsAndDocs(adminToken, searchQuery, categoryFilter);
    }, 200);
    return () => window.clearTimeout(timer);
  }, [adminToken, categoryFilter, fetchStatsAndDocs, searchQuery]);

  const handleVerifyToken = async (e: FormEvent) => {
    e.preventDefault();
    const candidate = tokenInput.trim();
    if (!candidate) {
      setAuthError('Ingresa el token administrativo configurado en Cloudflare.');
      return;
    }

    setAuthLoading(true);
    setAuthError(null);

    try {
      const res = await fetch('/api/admin/verify', {
        method: 'GET',
        headers: { Authorization: `Bearer ${candidate}` },
      });
      const data = (await res.json().catch(() => ({}))) as {
        authenticated?: boolean;
        error?: string;
      };

      if (!res.ok || !data.authenticated) {
        setAuthError(data.error || 'Token administrativo inválido.');
        return;
      }

      setAdminToken(candidate);
      setTokenInput('');
    } catch {
      setAuthError('No se pudo conectar con el servidor de Cloudflare Workers.');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogout = () => {
    setAdminToken(null);
    setStats(null);
    setDocuments([]);
    setEditingDoc(null);
    setForm(INITIAL_FORM_STATE);
    setSelectedFile(null);
    setExtraction(null);
    setProcessingStep('idle');
    setSubmitMessage(null);
    setSubmitError(null);
    setConfirmDeleteId(null);
  };

  const handleFileSelected = async (file: File | null) => {
    if (!file) return;
    setSubmitError(null);
    setSubmitMessage(null);
    setExtraction(null);
    setShowPreview(false);

    if (file.size > MAX_UPLOAD_BYTES) {
      setSubmitError('El archivo supera el límite máximo de 20 MB.');
      return;
    }

    setSelectedFile(file);
    setProcessingStep('extracting');
    setExtractProgress('Iniciando lectura del documento...');

    try {
      const result = await extractDocumentFile(file, (curr, total) => {
        setExtractProgress(`Extrayendo texto de la página ${curr} de ${total}...`);
      });

      setExtraction(result);
      setExtractProgress('');
      setProcessingStep('idle');

      setForm((prev) => ({
        ...prev,
        title: prev.title.trim() ? prev.title : suggestTitleFromFilename(file.name),
      }));
    } catch (err) {
      setSelectedFile(null);
      setExtraction(null);
      setExtractProgress('');
      setProcessingStep('error');
      setSubmitError(
        err instanceof Error
          ? err.message
          : 'No se pudo extraer el texto del archivo.'
      );
    }
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0] ?? null;
    void handleFileSelected(file);
  };

  const handleStartEdit = (doc: RagDocument) => {
    setEditingDoc(doc);
    setSelectedFile(null);
    setExtraction(null);
    setSubmitError(null);
    setSubmitMessage(null);
    setProcessingStep('idle');
    setForm({
      title: doc.title,
      authors: doc.authors,
      publicationYear: doc.publication_year ? String(doc.publication_year) : '',
      journalOrInstitution: doc.journal_or_institution,
      doi: doc.doi || '',
      pmid: doc.pmid || '',
      referenceUrl: doc.reference_url || '',
      publicationType: (PUBLICATION_TYPES.some((p) => p.id === doc.publication_type)
        ? doc.publication_type
        : 'revision_narrativa') as PublicationTypeId,
      category: (DOCUMENT_CATEGORIES.includes(doc.category as DocumentCategory)
        ? doc.category
        : 'Investigación científica') as DocumentCategory,
      language: doc.language || 'es',
      isHistorical: doc.is_historical === 1,
    });
  };

  const handleCancelEdit = () => {
    setEditingDoc(null);
    setForm(INITIAL_FORM_STATE);
    setSelectedFile(null);
    setExtraction(null);
    setProcessingStep('idle');
    setSubmitError(null);
    setSubmitMessage(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleSubmitDocument = async (e: FormEvent) => {
    e.preventDefault();
    if (!adminToken) return;

    setSubmitError(null);
    setSubmitMessage(null);

    if (!editingDoc && (!selectedFile || !extraction)) {
      setSubmitError(
        'Debes seleccionar un archivo PDF, TXT o Markdown con texto legible antes de indexar.'
      );
      return;
    }

    if (!form.title.trim() || !form.authors.trim() || !form.journalOrInstitution.trim()) {
      setSubmitError('Título, autores y revista/institución son obligatorios.');
      return;
    }

    setProcessingStep('indexing');
    setIndexingProgress('');

    try {
      const metadataPayload = {
        title: form.title.trim(),
        authors: form.authors.trim(),
        publicationYear: form.publicationYear.trim()
          ? Number(form.publicationYear.trim())
          : null,
        journalOrInstitution: form.journalOrInstitution.trim(),
        doi: form.doi.trim(),
        pmid: form.pmid.trim(),
        referenceUrl: form.referenceUrl.trim(),
        publicationType: form.publicationType,
        category: form.category,
        language: form.language,
        isHistorical: form.isHistorical,
        sourceFormat:
          extraction?.sourceFormat || editingDoc?.source_format || 'pdf',
        originalFilename:
          selectedFile?.name || editingDoc?.original_filename || '',
      };

      if (selectedFile && extraction) {
        if (extraction.totalChars > MAX_EXTRACTED_CHARS) {
          setProcessingStep('error');
          setSubmitError(
            `El texto extraído supera el límite máximo de ${MAX_EXTRACTED_CHARS.toLocaleString('es-ES')} caracteres para mantener la cuota gratuita de Cloudflare.`
          );
          return;
        }

        const batches = buildControlledPageBatches(extraction.pages);
        const fullCombinedText = extraction.pages.map((p) => p.text).join('\n\n');
        const contentHash = await computeSha256Hex(fullCombinedText);
        const totalBatches = batches.length;

        setIndexingProgress(
          totalBatches > 1
            ? `Enviando lote 1 de ${totalBatches} al motor BGE-M3 / Vectorize / D1...`
            : 'Generando embeddings @cf/baai/bge-m3 (1024 dim) y guardando en Vectorize y D1...'
        );

        const firstResponse = await fetch(
          editingDoc
            ? `/api/admin/documents/${encodeURIComponent(editingDoc.id)}`
            : '/api/admin/documents',
          {
            method: editingDoc ? 'PUT' : 'POST',
            headers: {
              Authorization: `Bearer ${adminToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              metadata: metadataPayload,
              pages: batches[0],
              contentHash,
              totalPageCount: extraction.pageCount,
              isFinalBatch: totalBatches === 1,
            }),
          }
        );

        const firstData = (await firstResponse.json().catch(() => ({}))) as {
          error?: string;
          chunksIndexed?: number;
          reindexed?: boolean;
          document?: RagDocument;
        };

        if (firstResponse.status === 401) {
          setAdminToken(null);
          setAuthError('Sesión administrativa expirada.');
          return;
        }

        if (!firstResponse.ok || !firstData.document) {
          setProcessingStep('error');
          setSubmitError(firstData.error || 'No se pudo procesar el documento.');
          return;
        }

        const targetDocId = firstData.document.id;
        let totalChunksIndexed = firstData.chunksIndexed ?? 0;

        for (let idx = 1; idx < totalBatches; idx++) {
          setIndexingProgress(
            `Enviando lote ${idx + 1} de ${totalBatches} al motor BGE-M3 / Vectorize / D1...`
          );

          const batchRes = await fetch(
            `/api/admin/documents/${encodeURIComponent(targetDocId)}/batches`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${adminToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                pages: batches[idx],
                isFinalBatch: idx === totalBatches - 1,
              }),
            }
          );

          const batchData = (await batchRes.json().catch(() => ({}))) as {
            error?: string;
            chunksAdded?: number;
            totalChunks?: number;
          };

          if (!batchRes.ok) {
            if (!editingDoc) {
              // Roll back partial newly created document so no incomplete record remains
              await fetch(`/api/admin/documents/${encodeURIComponent(targetDocId)}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${adminToken}` },
              }).catch(() => undefined);
            }
            setProcessingStep('error');
            setSubmitError(
              batchData.error ||
                `Error al procesar el lote ${idx + 1} de ${totalBatches}.`
            );
            return;
          }

          totalChunksIndexed = batchData.totalChunks ?? totalChunksIndexed + (batchData.chunksAdded ?? 0);
        }

        setProcessingStep('done');
        setIndexingProgress('');
        setSubmitMessage(
          editingDoc
            ? `Documento actualizado y reindexado correctamente (${totalChunksIndexed} fragmentos vectoriales BGE-M3 en ${totalBatches} ${totalBatches === 1 ? 'lote' : 'lotes'}).`
            : `Documento indexado correctamente: ${totalChunksIndexed} fragmentos guardados en Vectorize (@cf/baai/bge-m3, 1024 dim) y D1.`
        );
      } else if (editingDoc) {
        setIndexingProgress('Actualizando metadatos bibliográficos en D1...');
        const response = await fetch(
          `/api/admin/documents/${encodeURIComponent(editingDoc.id)}`,
          {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${adminToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ metadata: metadataPayload }),
          }
        );

        const data = (await response.json().catch(() => ({}))) as {
          error?: string;
        };

        if (response.status === 401) {
          setAdminToken(null);
          setAuthError('Sesión administrativa expirada.');
          return;
        }

        if (!response.ok) {
          setProcessingStep('error');
          setSubmitError(data.error || 'No se pudieron actualizar los metadatos.');
          return;
        }

        setProcessingStep('done');
        setIndexingProgress('');
        setSubmitMessage('Metadatos bibliográficos actualizados en D1.');
      } else {
        setProcessingStep('error');
        setSubmitError('Falta el archivo para indexar.');
        return;
      }

      setEditingDoc(null);
      setForm(INITIAL_FORM_STATE);
      setSelectedFile(null);
      setExtraction(null);
      setShowPreview(false);
      if (fileInputRef.current) fileInputRef.current.value = '';

      await fetchStatsAndDocs(adminToken, searchQuery, categoryFilter);
    } catch {
      setProcessingStep('error');
      setIndexingProgress('');
      setSubmitError('Error de red al guardar el documento en Cloudflare Workers.');
    }
  };

  const handleDeleteDocument = async (docId: string) => {
    if (!adminToken) return;
    setDeletingId(docId);
    setListError(null);

    try {
      const res = await fetch(`/api/admin/documents/${encodeURIComponent(docId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setListError(data.error || 'No se pudo eliminar el documento.');
        return;
      }

      if (editingDoc?.id === docId) {
        handleCancelEdit();
      }
      setConfirmDeleteId(null);
      await fetchStatsAndDocs(adminToken, searchQuery, categoryFilter);
    } catch {
      setListError('Error de conexión al intentar eliminar el documento.');
    } finally {
      setDeletingId(null);
    }
  };

  // Unauthenticated gate view
  if (!adminToken) {
    return (
      <div className="h-full overflow-y-auto bg-slate-50 px-4 sm:px-6 lg:px-8 py-8 flex items-center justify-center">
        <div className="w-full max-w-md bg-white rounded-xl border border-slate-200 p-6 sm:p-7 space-y-5">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-sky-50 border border-sky-200 flex items-center justify-center text-blue-700 shrink-0">
              <KeyRound className="w-5 h-5" aria-hidden="true" />
            </div>
            <div>
              <p className="text-xs font-medium text-sky-700">
                Acceso administrativo protegido
              </p>
              <h2 className="text-lg font-semibold text-slate-900">
                ADMINISTRAR CONOCIMIENTOS
              </h2>
            </div>
          </div>

          <p className="text-sm text-slate-600 leading-relaxed">
            Esta sección permite cargar, actualizar y eliminar documentos científicos de vitamina D en{' '}
            <strong>Cloudflare D1</strong> y{' '}
            <strong>Vectorize</strong> (<code className="text-xs bg-slate-100 px-1 py-0.5 rounded">@cf/baai/bge-m3</code>).
            El texto de los PDF se extrae directamente en tu navegador con PDF.js.
          </p>

          <form onSubmit={handleVerifyToken} className="space-y-4">
            <div>
              <label
                htmlFor="admin-upload-token"
                className="block text-xs font-medium text-slate-700 mb-1.5"
              >
                Token administrativo (ADMIN_UPLOAD_TOKEN)
              </label>
              <div className="relative">
                <input
                  id="admin-upload-token"
                  type={showToken ? 'text' : 'password'}
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  autoComplete="off"
                  placeholder="Ingresa el secreto configurado en Wrangler"
                  className="w-full rounded-lg border border-slate-300 bg-white pl-3.5 pr-10 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600/20"
                />
                <button
                  type="button"
                  onClick={() => setShowToken((prev) => !prev)}
                  aria-label={showToken ? 'Ocultar token' : 'Mostrar token'}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-700"
                >
                  {showToken ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </button>
              </div>
            </div>

            {authError && (
              <div
                role="alert"
                className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs text-red-800 flex items-start gap-2"
              >
                <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                <span>{authError}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={authLoading}
              className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-60 transition-colors"
            >
              {authLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Verificando credenciales...</span>
                </>
              ) : (
                <>
                  <KeyRound className="w-4 h-4" />
                  <span>Acceder al gestor RAG</span>
                </>
              )}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-slate-50 px-4 sm:px-6 lg:px-8 py-6">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Top Header + Session Control */}
        <div className="bg-white rounded-xl border border-slate-200 p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <p className="text-xs font-medium text-sky-700 mb-1">
              Sistema RAG Científico · Workers AI (@cf/baai/bge-m3 · 1024 dim)
            </p>
            <h2 className="text-xl font-semibold text-slate-900 tracking-tight">
              Administración de conocimientos sobre vitamina D
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Carga guías clínicas, revisiones sistemáticas, ECA y documentos en PDF, TXT o Markdown para alimentar las respuestas fundamentadas del chat.
            </p>
          </div>

          <button
            type="button"
            onClick={handleLogout}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0 self-start sm:self-center"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Cerrar sesión</span>
          </button>
        </div>

        {/* Statistics Strip */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="bg-white rounded-xl border border-slate-200 p-4">
            <p className="text-xs text-slate-500">Documentos indexados</p>
            <p className="mt-1 text-2xl font-semibold text-slate-900 tabular-nums">
              {stats?.totalDocuments ?? 0}
            </p>
          </div>
          <div className="bg-white rounded-xl border border-slate-200 p-4">
            <p className="text-xs text-slate-500">Fragmentos en Vectorize</p>
            <p className="mt-1 text-2xl font-semibold text-blue-700 tabular-nums">
              {stats?.totalChunks ?? 0}
            </p>
          </div>
          <div className="bg-white rounded-xl border border-slate-200 p-4">
            <p className="text-xs text-slate-500">Páginas indexadas</p>
            <p className="mt-1 text-2xl font-semibold text-slate-900 tabular-nums">
              {stats?.totalPagesIndexed ?? 0}
            </p>
          </div>
          <div className="bg-white rounded-xl border border-slate-200 p-4">
            <p className="text-xs text-slate-500">Categorías activas</p>
            <p className="mt-1 text-2xl font-semibold text-slate-900 tabular-nums">
              {stats?.byCategory.length ?? 0}
            </p>
          </div>
        </div>

        {stats && !stats.configured && (
          <div
            role="status"
            className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900 flex items-start gap-2.5"
          >
            <AlertCircle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
            <p>
              Algunos bindings de Cloudflare (<strong>DB</strong> o{' '}
              <strong>VECTOR_INDEX</strong>) aún no están enlazados en el entorno actual. Crea los recursos con Wrangler y aplica <code className="bg-amber-100 px-1 rounded">schema.sql</code> antes de indexar documentos.
            </p>
          </div>
        )}

        {/* Upload / Update Form */}
        <section
          aria-labelledby="upload-form-heading"
          className="bg-white rounded-xl border border-slate-200 p-5 sm:p-6 space-y-5"
        >
          <div className="flex items-center justify-between gap-4 border-b border-slate-100 pb-4">
            <div className="flex items-center gap-2.5">
              <Database className="w-5 h-5 text-blue-700 shrink-0" aria-hidden="true" />
              <h3
                id="upload-form-heading"
                className="text-base font-semibold text-slate-900"
              >
                {editingDoc
                  ? `Editando documento: ${editingDoc.title}`
                  : 'Cargar e indexar nuevo documento científico'}
              </h3>
            </div>
            {editingDoc && (
              <button
                type="button"
                onClick={handleCancelEdit}
                className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-900 px-2.5 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50"
              >
                <X className="w-3.5 h-3.5" />
                <span>Cancelar edición</span>
              </button>
            )}
          </div>

          <form onSubmit={handleSubmitDocument} className="space-y-5">
            {/* File Dropzone */}
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                {editingDoc
                  ? 'Reemplazar archivo (opcional: deja vacío para actualizar solo los metadatos)'
                  : 'Archivo científico (.pdf, .txt, .md — máx. 20 MB)'}
              </label>

              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
                className={`rounded-xl border-2 border-dashed p-5 text-center transition-colors ${
                  isDragging
                    ? 'border-blue-600 bg-sky-50'
                    : 'border-slate-300 bg-slate-50/70 hover:border-sky-400'
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.txt,.md,.markdown,application/pdf,text/plain,text/markdown"
                  onChange={(e) => void handleFileSelected(e.target.files?.[0] ?? null)}
                  className="sr-only"
                  id="rag-file-input"
                />

                <div className="flex flex-col items-center gap-2">
                  <Upload className="w-6 h-6 text-blue-700" aria-hidden="true" />
                  <div className="text-sm text-slate-700">
                    <label
                      htmlFor="rag-file-input"
                      className="font-semibold text-blue-700 hover:text-blue-800 cursor-pointer underline underline-offset-2"
                    >
                      Selecciona un archivo
                    </label>{' '}
                    o arrástralo aquí
                  </div>
                  <p className="text-xs text-slate-500">
                    PDF con texto seleccionable (extracción página por página vía PDF.js en tu navegador), TXT o Markdown.
                  </p>
                </div>

                {processingStep === 'extracting' && (
                  <div className="mt-4 inline-flex items-center gap-2 text-xs font-medium text-blue-700 bg-sky-50 border border-sky-200 rounded-lg px-3 py-1.5">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>{extractProgress || 'Extrayendo texto...'}</span>
                  </div>
                )}

                {selectedFile && extraction && (
                  <div className="mt-4 text-left bg-white rounded-lg border border-slate-200 p-3.5 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <FileText className="w-4 h-4 text-blue-700 shrink-0" />
                        <span className="text-xs font-semibold text-slate-900 truncate">
                          {selectedFile.name}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowPreview((p) => !p)}
                        className="text-xs font-medium text-sky-700 hover:text-sky-900"
                      >
                        {showPreview ? 'Ocultar vista previa' : 'Ver vista previa extraída'}
                      </button>
                    </div>
                    <p className="text-xs text-slate-600">
                      Formato: <strong>{extraction.sourceFormat.toUpperCase()}</strong> ·{' '}
                      Páginas con texto: <strong>{extraction.pages.length}</strong> de {extraction.pageCount} ·{' '}
                      Caracteres extraídos: <strong>{extraction.totalChars.toLocaleString('es-ES')}</strong>
                    </p>
                    {showPreview && (
                      <pre className="mt-2 max-h-40 overflow-y-auto rounded bg-slate-50 border border-slate-200 p-2.5 text-[11px] text-slate-700 whitespace-pre-wrap font-mono">
                        {extraction.previewText}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Metadata Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="md:col-span-2">
                <label
                  htmlFor="doc-title"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  Título completo del documento *
                </label>
                <input
                  id="doc-title"
                  type="text"
                  required
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  placeholder="Ej. Vitamin D for the Prevention of Disease: An Endocrine Society Clinical Practice Guideline"
                  className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600/20"
                />
              </div>

              <div>
                <label
                  htmlFor="doc-authors"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  Autores / Grupo de trabajo *
                </label>
                <input
                  id="doc-authors"
                  type="text"
                  required
                  value={form.authors}
                  onChange={(e) => setForm({ ...form, authors: e.target.value })}
                  placeholder="Ej. Demay MB, Pittas AG, Bikle DD, et al."
                  className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600/20"
                />
              </div>

              <div>
                <label
                  htmlFor="doc-journal"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  Revista o institución *
                </label>
                <input
                  id="doc-journal"
                  type="text"
                  required
                  value={form.journalOrInstitution}
                  onChange={(e) =>
                    setForm({ ...form, journalOrInstitution: e.target.value })
                  }
                  placeholder="Ej. Journal of Clinical Endocrinology & Metabolism"
                  className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600/20"
                />
              </div>

              <div>
                <label
                  htmlFor="doc-category"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  Categoría científica *
                </label>
                <select
                  id="doc-category"
                  value={form.category}
                  onChange={(e) =>
                    setForm({ ...form, category: e.target.value as DocumentCategory })
                  }
                  className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600/20"
                >
                  {DOCUMENT_CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor="doc-type"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  Tipo de publicación (Jerarquía de evidencia) *
                </label>
                <select
                  id="doc-type"
                  value={form.publicationType}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      publicationType: e.target.value as PublicationTypeId,
                    })
                  }
                  className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600/20"
                >
                  {PUBLICATION_TYPES.map((type) => (
                    <option key={type.id} value={type.id}>
                      Nivel {type.tier}: {type.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="doc-year"
                    className="block text-xs font-medium text-slate-700 mb-1"
                  >
                    Año
                  </label>
                  <input
                    id="doc-year"
                    type="number"
                    min={1900}
                    max={2100}
                    value={form.publicationYear}
                    onChange={(e) =>
                      setForm({ ...form, publicationYear: e.target.value })
                    }
                    placeholder="2024"
                    className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600/20"
                  />
                </div>

                <div>
                  <label
                    htmlFor="doc-lang"
                    className="block text-xs font-medium text-slate-700 mb-1"
                  >
                    Idioma
                  </label>
                  <select
                    id="doc-lang"
                    value={form.language}
                    onChange={(e) => setForm({ ...form, language: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600/20"
                  >
                    <option value="es">Español (es)</option>
                    <option value="en">Inglés (en)</option>
                    <option value="pt">Portugués (pt)</option>
                    <option value="fr">Francés (fr)</option>
                    <option value="de">Alemán (de)</option>
                    <option value="other">Otro</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="doc-doi"
                    className="block text-xs font-medium text-slate-700 mb-1"
                  >
                    DOI
                  </label>
                  <input
                    id="doc-doi"
                    type="text"
                    value={form.doi}
                    onChange={(e) => setForm({ ...form, doi: e.target.value })}
                    placeholder="10.1210/clinem/dgae290"
                    className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600/20"
                  />
                </div>

                <div>
                  <label
                    htmlFor="doc-pmid"
                    className="block text-xs font-medium text-slate-700 mb-1"
                  >
                    PMID
                  </label>
                  <input
                    id="doc-pmid"
                    type="text"
                    value={form.pmid}
                    onChange={(e) => setForm({ ...form, pmid: e.target.value })}
                    placeholder="38828931"
                    className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600/20"
                  />
                </div>
              </div>

              <div className="md:col-span-2">
                <label
                  htmlFor="doc-url"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  URL de referencia científica (opcional)
                </label>
                <input
                  id="doc-url"
                  type="url"
                  value={form.referenceUrl}
                  onChange={(e) => setForm({ ...form, referenceUrl: e.target.value })}
                  placeholder="https://pubmed.ncbi.nlm.nih.gov/..."
                  className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600/20"
                />
              </div>

              <div className="md:col-span-2">
                <label className="inline-flex items-start gap-2.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={form.isHistorical}
                    onChange={(e) =>
                      setForm({ ...form, isHistorical: e.target.checked })
                    }
                    className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-700 focus:ring-sky-600"
                  />
                  <span className="text-xs text-slate-700 leading-relaxed">
                    <strong>Documento o guía histórica</strong> (ej. Endocrine Society 2011; se conservará para contextualización y comparación, pero se priorizarán guías vigentes en la recuperación RAG).
                  </span>
                </label>
              </div>
            </div>

            {/* Processing & Status Feedback */}
            {processingStep === 'indexing' && (
              <div
                role="status"
                className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-xs text-sky-900 flex items-center gap-2.5"
              >
                <Loader2 className="w-4 h-4 text-blue-700 animate-spin shrink-0" />
                <span>
                  {indexingProgress || (
                    <>
                      Limpiando texto, segmentando fragmentos semánticos, generando embeddings{' '}
                      <code className="font-mono">@cf/baai/bge-m3</code> (1024 dim) y guardando en Vectorize y D1...
                    </>
                  )}
                </span>
              </div>
            )}

            {submitError && (
              <div
                role="alert"
                className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-800 flex items-start gap-2"
              >
                <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                <span>{submitError}</span>
              </div>
            )}

            {submitMessage && (
              <div
                role="status"
                className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-900 flex items-start gap-2"
              >
                <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" />
                <span>{submitMessage}</span>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-end gap-3 pt-2">
              {editingDoc && (
                <button
                  type="button"
                  onClick={handleCancelEdit}
                  className="px-4 py-2.5 rounded-lg border border-slate-300 bg-white text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Cancelar
                </button>
              )}
              <button
                type="submit"
                disabled={processingStep === 'extracting' || processingStep === 'indexing'}
                className="min-h-[44px] inline-flex items-center gap-2 rounded-lg bg-blue-700 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-60 transition-colors"
              >
                {processingStep === 'indexing' ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Procesando e indexando...</span>
                  </>
                ) : (
                  <>
                    <Database className="w-4 h-4" />
                    <span>
                      {editingDoc
                        ? selectedFile
                          ? 'Actualizar y reindexar documento'
                          : 'Guardar cambios de metadatos'
                        : 'Indexar documento en biblioteca RAG'}
                    </span>
                  </>
                )}
              </button>
            </div>
          </form>
        </section>

        {/* Indexed Documents List */}
        <section
          aria-labelledby="indexed-docs-heading"
          className="bg-white rounded-xl border border-slate-200 p-5 sm:p-6 space-y-4"
        >
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div>
              <h3
                id="indexed-docs-heading"
                className="text-base font-semibold text-slate-900"
              >
                Documentos indexados en D1 y Vectorize
              </h3>
              <p className="text-xs text-slate-500">
                Busca por título, autores, revista, DOI o PMID, actualiza metadatos o reindexa documentos.
              </p>
            </div>

            <button
              type="button"
              onClick={() =>
                adminToken && void fetchStatsAndDocs(adminToken, searchQuery, categoryFilter)
              }
              disabled={listLoading}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50 self-start md:self-auto"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${listLoading ? 'animate-spin' : ''}`}
              />
              <span>Actualizar lista</span>
            </button>
          </div>

          <div className="flex flex-col md:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Buscar por título, autor, DOI, PMID..."
                aria-label="Buscar documentos indexados"
                className="w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3.5 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600/20"
              />
            </div>

            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              aria-label="Filtrar por categoría científica"
              className="md:w-72 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600/20"
            >
              <option value="todas">Todas las categorías</option>
              {DOCUMENT_CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
          </div>

          {listError && (
            <div
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-800 flex items-start gap-2"
            >
              <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
              <span>{listError}</span>
            </div>
          )}

          {listLoading && documents.length === 0 ? (
            <div className="py-10 text-center text-sm text-slate-500 flex items-center justify-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin text-blue-700" />
              <span>Consultando documentos en Cloudflare D1...</span>
            </div>
          ) : documents.length === 0 ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-8 text-center">
              <p className="text-sm text-slate-600">
                No hay documentos indexados que coincidan con el filtro actual.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {documents.map((doc) => {
                const isConfirmingDelete = confirmDeleteId === doc.id;
                const isDeleting = deletingId === doc.id;

                return (
                  <article
                    key={doc.id}
                    className="rounded-xl border border-slate-200 bg-white p-4 space-y-3 hover:border-sky-300 transition-colors"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <h4 className="text-sm font-semibold text-slate-900 leading-snug">
                          {doc.title}
                        </h4>
                        <p className="text-xs text-slate-600">
                          {doc.authors} · {doc.journal_or_institution}
                          {doc.publication_year ? ` (${doc.publication_year})` : ''}
                        </p>
                      </div>

                      <div className="text-xs font-medium text-emerald-700 shrink-0">
                        {doc.status === 'indexed' ? 'Indexado' : doc.status}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                      <span className="font-medium text-sky-800">{doc.category}</span>
                      <span>·</span>
                      <span>{getPublicationLabel(doc.publication_type)}</span>
                      <span>·</span>
                      <span>
                        {doc.source_format.toUpperCase()} · {doc.page_count} pág. ·{' '}
                        {doc.chunk_count} fragmentos
                      </span>
                      {doc.doi && (
                        <>
                          <span>·</span>
                          <span>DOI: {doc.doi}</span>
                        </>
                      )}
                      {doc.pmid && (
                        <>
                          <span>·</span>
                          <span>PMID: {doc.pmid}</span>
                        </>
                      )}
                      {doc.is_historical === 1 && (
                        <>
                          <span>·</span>
                          <span className="font-medium text-amber-700">
                            Referencia histórica
                          </span>
                        </>
                      )}
                    </div>

                    <div className="pt-2 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2">
                      <div className="text-[11px] text-slate-400 font-mono">
                        ID: {doc.id}
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleStartEdit(doc)}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-medium text-blue-700 hover:bg-sky-50"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                          <span>Editar / Reindexar</span>
                        </button>

                        {isConfirmingDelete ? (
                          <div className="inline-flex items-center gap-1.5 bg-red-50 border border-red-200 rounded-lg px-2 py-1">
                            <span className="text-xs text-red-800 font-medium">
                              ¿Eliminar?
                            </span>
                            <button
                              type="button"
                              disabled={isDeleting}
                              onClick={() => void handleDeleteDocument(doc.id)}
                              className="px-2 py-0.5 rounded bg-red-700 text-white text-xs font-medium hover:bg-red-800 disabled:opacity-60"
                            >
                              {isDeleting ? 'Eliminando...' : 'Confirmar'}
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(null)}
                              className="px-2 py-0.5 rounded border border-slate-300 bg-white text-xs text-slate-700 hover:bg-slate-50"
                            >
                              Cancelar
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(doc.id)}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-medium text-red-700 hover:bg-red-50"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            <span>Eliminar</span>
                          </button>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
