export type AppSection = 'chat' | 'lab' | 'risk' | 'library' | 'admin';

export interface GroundingSource {
  title: string;
  uri: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'model';
  text: string;
  sources?: GroundingSource[];
  timestamp: number;
  contextTag?: string;
}

export type VitaminDUnit = 'ng/mL' | 'nmol/L';
export type BiologicalSex = 'femenino' | 'masculino' | 'otro';
export type PregnancyLactationState = 'ninguno' | 'embarazo' | 'lactancia';

export interface LabAnalysisInput {
  age: string;
  sex: BiologicalSex;
  value: string;
  unit: VitaminDUnit;
  pregnancyState: PregnancyLactationState;
  symptoms: string[];
  antecedents: string[];
  notes: string;
}

export interface DeterministicLabResult {
  ngMl: number;
  nmolL: number;
  clinicalApproxNmolL: number;
  nasemCategory: {
    label: string;
    rangeLabel: string;
    summary: string;
    tone: 'critical' | 'caution' | 'optimal' | 'warning';
  };
  endocrine2011Category: {
    label: string;
    rangeLabel: string;
    summary: string;
  };
  endocrine2024Note: {
    paradigm: string;
    summary: string;
    empiricalGroupMatch: string | null;
  };
  medicalAttentionReasons: string[];
}

export interface RiskFactorOption {
  id: string;
  category: string;
  label: string;
  description: string;
  mechanism: string;
  evidenceNote: string;
}

export interface LibraryResource {
  id: string;
  title: string;
  institution: string;
  year: string;
  category: 'guias' | 'agencias' | 'ensayos';
  identifierLabel: string;
  summary: string;
  keyTakeaway: string;
  url: string;
  chatPrompt: string;
}

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

export interface ExtractedPage {
  pageNumber: number | null;
  text: string;
}

export interface RagDocument {
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
  source_format: 'pdf' | 'txt' | 'md' | string;
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

export interface RagLibraryStats {
  configured: boolean;
  totalDocuments: number;
  totalChunks: number;
  totalPagesIndexed: number;
  byCategory: Array<{ category: string; count: number }>;
  byPublicationType: Array<{ publication_type: string; count: number }>;
}

