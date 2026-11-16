export type AppSection = 'chat' | 'lab' | 'risk' | 'library';

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
