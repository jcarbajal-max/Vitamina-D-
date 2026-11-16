import type {
  DeterministicLabResult,
  LabAnalysisInput,
  LibraryResource,
  RiskFactorOption,
} from '../types/vitaminD';

// Exact molecular weight conversion: MW of 25(OH)D3 = 400.64 g/mol -> 1 ng/mL = 2.496 nmol/L
export const NG_ML_TO_NMOL_L_EXACT = 2.496;
export const NG_ML_TO_NMOL_L_CLINICAL = 2.5;

export function convertToNgMl(value: number, unit: 'ng/mL' | 'nmol/L'): number {
  if (unit === 'ng/mL') return value;
  return value / NG_ML_TO_NMOL_L_EXACT;
}

export function convertToNmolL(value: number, unit: 'ng/mL' | 'nmol/L'): number {
  if (unit === 'nmol/L') return value;
  return value * NG_ML_TO_NMOL_L_EXACT;
}

export const SYMPTOM_OPTIONS = [
  { id: 'ninguno', label: 'Sin síntomas específicos reportados' },
  { id: 'fatiga', label: 'Fatiga o cansancio persistente' },
  { id: 'dolor_oseo', label: 'Dolor óseo difuso o lumbar' },
  { id: 'debilidad_muscular', label: 'Debilidad muscular proximal (dificultad al levantarse o subir escaleras)' },
  { id: 'calambres', label: 'Calambres musculares, espasmos o parestesias' },
  { id: 'fracturas', label: 'Antecedente de fracturas por fragilidad' },
  { id: 'hipercalcemia', label: 'Náuseas, vómitos, sed excesiva o micción frecuente (poliuria)' },
] as const;

export const ANTECEDENT_OPTIONS = [
  { id: 'renal', label: 'Enfermedad renal crónica (ERC)' },
  { id: 'malabsorcion', label: 'Malabsorción intestinal, celiaquía, EII o cirugía bariátrica' },
  { id: 'hepatica', label: 'Enfermedad hepática crónica' },
  { id: 'osteoporosis', label: 'Osteopenia, osteoporosis o hiperparatiroidismo' },
  { id: 'granulomatosis', label: 'Sarcoidosis u otra enfermedad granulomatosa' },
  { id: 'farmacos', label: 'Uso crónico de glucocorticoides o anticonvulsivos' },
  { id: 'suplementacion', label: 'Consumo actual de suplementos de vitamina D' },
] as const;

export function evaluateLabDeterministically(input: LabAnalysisInput): DeterministicLabResult | null {
  const raw = Number(input.value);
  if (!Number.isFinite(raw) || raw < 0 || raw > 1000 || input.value.trim() === '') {
    return null;
  }

  const ngMl = convertToNgMl(raw, input.unit);
  const nmolL = convertToNmolL(raw, input.unit);
  const clinicalApproxNmolL = input.unit === 'ng/mL' ? raw * NG_ML_TO_NMOL_L_CLINICAL : raw;
  const ageNum = Number(input.age);

  let nasemCategory: DeterministicLabResult['nasemCategory'];
  if (ngMl < 12) {
    nasemCategory = {
      label: 'Riesgo de deficiencia (NASEM / IOM 2011)',
      rangeLabel: '< 12 ng/mL (< 30 nmol/L)',
      summary:
        'Nivel asociado en la literatura con mayor riesgo de alteraciones de la mineralización ósea (raquitismo en población pediátrica u osteomalacia en adultos) e hiperparatiroidismo secundario.',
      tone: 'critical',
    };
  } else if (ngMl < 20) {
    nasemCategory = {
      label: 'Riesgo de inadecuación en parte de la población (NASEM / IOM 2011)',
      rangeLabel: '12 a < 20 ng/mL (30 a < 50 nmol/L)',
      summary:
        'Zona intermedia poblacional: puede ser suficiente para algunos individuos, pero conlleva riesgo de inadecuación para otros según la ingesta de calcio y las demandas óseas.',
      tone: 'caution',
    };
  } else if (ngMl <= 50) {
    nasemCategory = {
      label: 'Suficiencia poblacional para salud ósea (NASEM / IOM 2011)',
      rangeLabel: '20 a 50 ng/mL (50 a 125 nmol/L)',
      summary:
        'La NASEM (antes IOM) estableció 20 ng/mL (50 nmol/L) como el nivel que cubre las necesidades de salud ósea de aproximadamente el 97.5% de la población sana.',
      tone: 'optimal',
    };
  } else {
    nasemCategory = {
      label: 'Por encima del rango poblacional de precaución (NASEM / IOM 2011)',
      rangeLabel: '> 50 ng/mL (> 125 nmol/L)',
      summary:
        'La NASEM advirtió que valores sostenidos superiores a 50 ng/mL no tienen beneficio poblacional comprobado y requieren precaución; concentraciones > 100–150 ng/mL aumentan el riesgo de toxicidad.',
      tone: 'warning',
    };
  }

  let endocrine2011Category: DeterministicLabResult['endocrine2011Category'];
  if (ngMl < 20) {
    endocrine2011Category = {
      label: 'Deficiencia (Criterio histórico 2011)',
      rangeLabel: '< 20 ng/mL (< 50 nmol/L)',
      summary:
        'La guía de 2011 (Holick et al.) clasificaba cualquier valor inferior a 20 ng/mL como deficiencia clínica en poblaciones en riesgo.',
    };
  } else if (ngMl < 30) {
    endocrine2011Category = {
      label: 'Insuficiencia (Criterio histórico 2011)',
      rangeLabel: '20 a 29 ng/mL (50 a 74 nmol/L)',
      summary:
        'La guía de 2011 consideraba este intervalo como insuficiencia, proponiendo 30 ng/mL (75 nmol/L) como objetivo clínico para pacientes con riesgo óseo.',
    };
  } else if (ngMl <= 100) {
    endocrine2011Category = {
      label: 'Suficiencia (Criterio histórico 2011)',
      rangeLabel: '30 a 100 ng/mL (75 a 250 nmol/L)',
      summary:
        'Intervalo clasificado como suficiente en la guía histórica de 2011, aunque la actualización de 2024 abandonó este umbral universal para población general sana.',
    };
  } else {
    endocrine2011Category = {
      label: 'Exceso / Riesgo potencial de toxicidad (Criterio 2011)',
      rangeLabel: '> 100 ng/mL (> 250 nmol/L)',
      summary:
        'Valores por encima de 100 ng/mL requieren descartar ingesta excesiva de suplementos y evaluar calcio sérico/urinario; > 150 ng/mL se asocia clásicamente a toxicidad.',
    };
  }

  let empiricalGroupMatch: string | null = null;
  if (input.pregnancyState === 'embarazo') {
    empiricalGroupMatch =
      'Gestación: La guía Endocrine Society 2024 sugiere suplementación empírica de vitamina D durante el embarazo (por su potencial para reducir preeclampsia, mortalidad intrauterina, parto pretérmino y recién nacidos pequeños para la edad gestacional) sin requerir tamizaje universal previo en gestantes sanas.';
  } else if (Number.isFinite(ageNum) && ageNum >= 1 && ageNum <= 18) {
    empiricalGroupMatch =
      'Edad de 1 a 18 años: La guía Endocrine Society 2024 sugiere suplementación empírica para prevenir el raquitismo nutricional y reducir el riesgo potencial de infecciones respiratorias, sin recomendar tamizaje rutinario en población pediátrica sana.';
  } else if (Number.isFinite(ageNum) && ageNum >= 75) {
    empiricalGroupMatch =
      'Edad ≥ 75 años: La guía Endocrine Society 2024 sugiere suplementación empírica en adultos mayores de 75 años debido a la posible reducción de la mortalidad observada en ensayos, sin necesidad de medición rutinaria previa en población general.';
  } else if (Number.isFinite(ageNum) && ageNum >= 19 && ageNum <= 74) {
    empiricalGroupMatch =
      'Adulto de 19 a 74 años: La guía Endocrine Society 2024 sugiere NO realizar tamizaje rutinario de 25(OH)D ni suplementación empírica por encima de la IDR (600–800 UI/día) en personas sanas sin indicaciones clínicas específicas (salvo prediabetes de alto riesgo u otras indicaciones médicas).';
  }

  const medicalAttentionReasons: string[] = [];
  if (ngMl < 12) {
    medicalAttentionReasons.push(
      'Concentración inferior a 12 ng/mL (30 nmol/L), rango asociado a mayor riesgo de desmineralización ósea.'
    );
  }
  if (ngMl > 100) {
    medicalAttentionReasons.push(
      'Concentración superior a 100 ng/mL (250 nmol/L): requiere evaluación médica para descartar exceso de suplementación o hipercalcemia.'
    );
  }
  if (input.symptoms.includes('hipercalcemia')) {
    medicalAttentionReasons.push(
      'Presencia de náuseas, vómitos, sed intensa o poliuria, síntomas compatibles con posible alteración del calcio que requieren valoración clínica oportuna.'
    );
  }
  if (input.symptoms.includes('fracturas')) {
    medicalAttentionReasons.push(
      'Antecedente de fracturas por fragilidad: requiere estudio médico integral del metabolismo óseo.'
    );
  }
  if (input.symptoms.includes('dolor_oseo') || input.symptoms.includes('debilidad_muscular') || input.symptoms.includes('calambres')) {
    medicalAttentionReasons.push(
      'Síntomas musculoesqueléticos o neuromusculares reportados que deben ser valorados en consulta médica.'
    );
  }
  if (input.pregnancyState !== 'ninguno') {
    medicalAttentionReasons.push(
      'Embarazo o lactancia: cualquier interpretación de laboratorio y ajuste nutricional debe realizarse junto con el equipo obstétrico o médico.'
    );
  }
  if (
    input.antecedents.some((a) =>
      ['renal', 'malabsorcion', 'hepatica', 'osteoporosis', 'granulomatosis', 'farmacos'].includes(a)
    )
  ) {
    medicalAttentionReasons.push(
      'Antecedentes clínicos o fármacos que modifican el metabolismo de la vitamina D (renal, hepático, malabsorción, osteoporosis, granulomatosis o medicación crónica).'
    );
  }

  return {
    ngMl,
    nmolL,
    clinicalApproxNmolL,
    nasemCategory,
    endocrine2011Category,
    endocrine2024Note: {
      paradigm: 'Guía de Práctica Clínica Endocrine Society 2024 (Demay et al., JCEM)',
      summary:
        'A diferencia de 2011, la actualización de 2024 dejó de respaldar puntos de corte universales de "suficiencia/insuficiencia" de 25(OH)D (como 30 ng/mL) en población sana, priorizando el enfoque clínico basado en ensayos aleatorizados.',
      empiricalGroupMatch,
    },
    medicalAttentionReasons,
  };
}

export const RISK_FACTOR_OPTIONS: RiskFactorOption[] = [
  {
    id: 'baja_exposicion_solar',
    category: 'Síntesis cutánea y ambiente',
    label: 'Baja exposición solar directa o latitudes altas (> 35° N/S en invierno)',
    description:
      'Permanecer la mayor parte del día en interiores, vivir en zonas con baja radiación UVB estacional o utilizar vestimenta que cubre casi toda la superficie corporal.',
    mechanism:
      'La radiación UVB (290–315 nm) fotolisa el 7-dehidrocolesterol epidérmico a previtamina D3. Sin UVB suficiente (ángulo cenital solar bajo o barreras físicas), la síntesis cutánea es mínima o nula.',
    evidenceNote:
      'Estudios fotobiológicos y observacionales documentan variaciones estacionales marcadas de 25(OH)D sérica.',
  },
  {
    id: 'fototipo_alto',
    category: 'Síntesis cutánea y ambiente',
    label: 'Piel con mayor pigmentación (fototipos V–VI)',
    description:
      'Mayor contenido de melanina epidérmica en comparación con fototipos claros.',
    mechanism:
      'La melanina actúa como filtro competitivo natural absorbiendo fotones UVB, lo que requiere tiempos de exposición solar más prolongados para sintetizar cantidades equivalentes de previtamina D3.',
    evidenceNote:
      'Respaldado por estudios fisiológicos y encuestas poblacionales (NHANES), aunque la biodisponibilidad y proteína transportadora (DBP) también varían entre poblaciones.',
  },
  {
    id: 'edad_avanzada',
    category: 'Fisiología y ciclo vital',
    label: 'Edad igual o superior a 65–75 años',
    description:
      'Envejecimiento fisiológico con menor reserva cutánea y menor exposición al aire libre.',
    mechanism:
      'Disminución progresiva de la concentración de 7-dehidrocolesterol en la epidermis y menor capacidad de hidroxilación renal (1α-hidroxilasa) con el avance de la edad.',
    evidenceNote:
      'La guía Endocrine Society 2024 identifica a los adultos ≥ 75 años como grupo específico para suplementación empírica basada en datos de ECA sobre mortalidad.',
  },
  {
    id: 'embarazo_lactancia',
    category: 'Fisiología y ciclo vital',
    label: 'Embarazo o lactancia actual',
    description:
      'Aumento de las demandas fisiológicas de calcio y metabolismo placentario de la vitamina D.',
    mechanism:
      'La placenta expresa CYP27B1 y regula la transferencia materno-fetal de 25(OH)D; la deficiencia materna grave repercute en las reservas neonatales.',
    evidenceNote:
      'Endocrine Society 2024 sugiere suplementación empírica durante el embarazo según revisiones sistemáticas de ensayos clínicos.',
  },
  {
    id: 'imc_elevado',
    category: 'Composición corporal',
    label: 'Índice de masa corporal elevado (obesidad)',
    description:
      'Mayor volumen de distribución de compuestos liposolubles en tejido adiposo.',
    mechanism:
      'Secuestro volumétrico y dilución del colecalciferol y la 25(OH)D en el compartimento adiposo, además de posible menor 25-hidroxilación hepática.',
    evidenceNote:
      'Metaanálisis de ensayos clínicos (p. ej., análisis secundarios de VITAL) muestran menor incremento sérico de 25(OH)D ante una misma dosis oral en personas con IMC ≥ 30 kg/m².',
  },
  {
    id: 'malabsorcion',
    category: 'Tracto gastrointestinal y metabolismo',
    label: 'Síndromes de malabsorción o cirugía bariátrica',
    description:
      'Enfermedad celíaca activa, enfermedad inflamatoria intestinal, insuficiencia pancreática o bypass gástrico.',
    mechanism:
      'Al ser una vitamina liposoluble, su absorción intestinal depende de sales biliares, formación de micelas e integridad de la mucosa del intestino delgado proximal.',
    evidenceNote:
      'Evidencia clínica consistente indica mayor prevalencia de niveles bajos y necesidad de seguimiento médico especializado.',
  },
  {
    id: 'renal_hepatica',
    category: 'Tracto gastrointestinal y metabolismo',
    label: 'Enfermedad hepática crónica o enfermedad renal crónica (ERC)',
    description:
      'Alteración crónica de la función hepática o filtración glomerular reducida.',
    mechanism:
      'El hígado realiza la 25-hidroxilación (CYP2R1) y el riñón ejecuta la 1α-hidroxilación (CYP27B1) para generar 1,25(OH)2D (calcitriol) activa.',
    evidenceNote:
      'Guías nefrológicas (KDIGO) y endocrinológicas señalan que la ERC requiere evaluación médica específica del eje mineral óseo (PTH, calcio, fósforo, 25(OH)D).',
  },
  {
    id: 'dieta_restrictiva',
    category: 'Nutrición y dieta',
    label: 'Bajo consumo de fuentes dietéticas o alimentos fortificados',
    description:
      'Dieta sin pescados azules, huevo ni lácteos/bebidas vegetales fortificadas con vitamina D.',
    mechanism:
      'Pocos alimentos contienen vitamina D de forma natural; sin fortificación ni síntesis solar, la ingesta dietética suele ser inferior a los requerimientos recomendados (600–800 UI/día según NASEM).',
    evidenceNote:
      'Datos nutricionales de NIH ODS y NASEM muestran que las dietas restrictivas sin fortificación dependen casi exclusivamente de síntesis UVB o suplementación.',
  },
  {
    id: 'farmacos_cyp',
    category: 'Interacciones farmacológicas',
    label: 'Medicación que acelera el catabolismo o altera el metabolismo óseo',
    description:
      'Uso crónico de glucocorticoides sistémicos, anticonvulsivos inductores (fenitoína, carbamazepina, fenobarbital), rifampicina o ciertos antirretrovirales.',
    mechanism:
      'Activación de receptores nucleares (PXR) que inducen enzimas CYP24A1 y CYP3A4, acelerando la degradación de 25(OH)D y 1,25(OH)2D hacia metabolitos inactivos (ácido calcitroico).',
    evidenceNote:
      'Mecanismo farmacocinético bien documentado; requiere coordinación médica para evaluar salud ósea.',
  },
];

export const LIBRARY_RESOURCES: LibraryResource[] = [
  {
    id: 'nih-ods',
    title: 'Vitamin D — Fact Sheet for Health Professionals',
    institution: 'NIH Office of Dietary Supplements (ODS)',
    year: 'Actualización continua',
    category: 'agencias',
    identifierLabel: 'NIH ODS · Revisión técnica',
    summary:
      'Síntesis exhaustiva sobre fisiología, fuentes alimentarias, biodisponibilidad de D2 frente a D3, valores de referencia dietética, grupos en riesgo e interacciones farmacológicas.',
    keyTakeaway:
      'Detalla las Ingestas Dietéticas de Referencia (IDR) de 600 UI/día (1–70 años) y 800 UI/día (>70 años), así como el límite máximo tolerable (UL) de 4,000 UI/día en adultos.',
    url: 'https://ods.od.nih.gov/factsheets/VitaminD-HealthProfessional/',
    chatPrompt:
      'Según la hoja técnica del NIH Office of Dietary Supplements, ¿cuáles son las diferencias bioquímicas y de potencia entre la vitamina D2 y la vitamina D3?',
  },
  {
    id: 'endocrine-2024',
    title: 'Vitamin D for the Prevention of Disease: An Endocrine Society Clinical Practice Guideline',
    institution: 'Endocrine Society (Demay MB et al.)',
    year: '2024',
    category: 'guias',
    identifierLabel: 'JCEM 2024 · DOI: 10.1210/clinem/dgae290',
    summary:
      'Actualización oficial de la guía clínica basada en revisiones sistemáticas de ensayos clínicos aleatorizados. Evalúa la suplementación empírica frente al tamizaje en población general sin indicación médica.',
    keyTakeaway:
      'Sugiere NO realizar tamizaje rutinario de 25(OH)D en adultos sanos de 19–74 años y abandona los umbrales universales de 30 ng/mL para personas sanas; recomienda suplementación empírica en 1–18 años, ≥75 años, embarazo y prediabetes de alto riesgo.',
    url: 'https://academic.oup.com/jcem/article/109/8/1907/7685305',
    chatPrompt:
      'Explica en detalle qué cambió en la guía de la Endocrine Society de 2024 (Demay et al.) en comparación con la guía histórica de 2011.',
  },
  {
    id: 'endocrine-2011',
    title: 'Evaluation, Treatment, and Prevention of Vitamin D Deficiency: An Endocrine Society Clinical Practice Guideline',
    institution: 'Endocrine Society (Holick MF et al.)',
    year: '2011',
    category: 'guias',
    identifierLabel: 'JCEM 2011 · DOI: 10.1210/jc.2011-0385',
    summary:
      'Documento histórico que popularizó las categorías clínicas de deficiencia (<20 ng/mL), insuficiencia (21–29 ng/mL) y suficiencia (≥30 ng/mL) para poblaciones en riesgo.',
    keyTakeaway:
      'Contexto histórico indispensable para entender por qué muchos informes de laboratorio aún muestran 30 ng/mL como referencia, pese a la revisión metodológica de 2024.',
    url: 'https://academic.oup.com/jcem/article/96/7/1911/2833671',
    chatPrompt:
      '¿Por qué muchos laboratorios clínicos siguen marcando 30 ng/mL como umbral de referencia a partir de la guía de 2011, y qué debate científico existe al respecto?',
  },
  {
    id: 'nasem-2011',
    title: 'Dietary Reference Intakes for Calcium and Vitamin D',
    institution: 'National Academies of Sciences, Engineering, and Medicine (NASEM / IOM)',
    year: '2011',
    category: 'agencias',
    identifierLabel: 'NASEM / National Academies Press · PMID: 21796828',
    summary:
      'Informe fundamental que estableció las ingestas dietéticas de referencia para EE. UU. y Canadá basándose en evidencia rigurosa sobre salud ósea.',
    keyTakeaway:
      'Estableció 20 ng/mL (50 nmol/L) como umbral poblacional suficiente para el 97.5% de la población y <12 ng/mL (30 nmol/L) como riesgo de deficiencia.',
    url: 'https://nap.nationalacademies.org/catalog/13050/dietary-reference-intakes-for-calcium-and-vitamin-d',
    chatPrompt:
      '¿Cómo determinó la NASEM (antes IOM) el punto de corte de 20 ng/mL (50 nmol/L) y por qué advirtió sobre niveles sostenidos mayores a 50 ng/mL?',
  },
  {
    id: 'who-elena',
    title: 'Vitamin D Supplementation & Nutritional Requirements',
    institution: 'Organización Mundial de la Salud (OMS / WHO eLENA)',
    year: 'Vigencia continua',
    category: 'agencias',
    identifierLabel: 'WHO eLENA · Salud Pública Global',
    summary:
      'Biblioteca electrónica de evidencia para acciones nutricionales (eLENA) de la OMS, con revisiones sobre prevención del raquitismo nutricional, gestación y poblaciones lactantes.',
    keyTakeaway:
      'Enfatiza la vigilancia de deficiencia grave en lactantes, niños pequeños y embarazadas en contextos de riesgo nutricional, evitando suplementación rutinaria indiscriminada sin indicación.',
    url: 'https://www.who.int/tools/elena/interventions/vitamind-infants',
    chatPrompt:
      '¿Qué enfoque adopta la OMS (WHO eLENA) respecto a la suplementación de vitamina D en lactantes y embarazo?',
  },
  {
    id: 'vital-trial',
    title: 'Vitamin D Supplements and Prevention of Cancer and Cardiovascular Disease (VITAL Trial)',
    institution: 'PubMed / NEJM (Manson JE et al.)',
    year: '2019',
    category: 'ensayos',
    identifierLabel: 'NEJM 2019 · PMID: 30415629 · DOI: 10.1056/NEJMoa1809944',
    summary:
      'Ensayo clínico aleatorizado, doble ciego y controlado con placebo en 25,871 adultos estadounidenses evaluando 2,000 UI/día de vitamina D3 durante una mediana de 5.3 años.',
    keyTakeaway:
      'No redujo significativamente la incidencia total de cáncer invasivo ni eventos cardiovasculares mayores frente a placebo en población general mayoritariamente repleta al inicio.',
    url: 'https://pubmed.ncbi.nlm.nih.gov/30415629/',
    chatPrompt:
      '¿Qué demostró el ensayo clínico VITAL (Manson et al., 2019) y por qué sus resultados contrastan con estudios observacionales previos?',
  },
  {
    id: 'd2d-trial',
    title: 'Vitamin D Supplementation and Prevention of Type 2 Diabetes (D2d Trial)',
    institution: 'PubMed / NEJM (Pittas AG et al.)',
    year: '2019',
    category: 'ensayos',
    identifierLabel: 'NEJM 2019 · PMID: 31173679 · DOI: 10.1056/NEJMoa1900906',
    summary:
      'Ensayo clínico aleatorizado en 2,423 adultos con prediabetes evaluando 4,000 UI/día de vitamina D3 frente a placebo.',
    keyTakeaway:
      'En el análisis primario no alcanzó significación estadística convencional (HR 0.88; p=0.12), aunque metaanálisis posteriores en prediabetes de alto riesgo informaron reducciones modestas del riesgo de progresión.',
    url: 'https://pubmed.ncbi.nlm.nih.gov/31173679/',
    chatPrompt:
      'Analiza los hallazgos del ensayo D2d y por qué la Endocrine Society 2024 incluyó la prediabetes de alto riesgo en sus recomendaciones.',
  },
  {
    id: 'pubmed-portal',
    title: 'PubMed — Búsqueda directa de literatura biomédica sobre Vitamina D',
    institution: 'National Library of Medicine (NCBI / PubMed)',
    year: 'Base de datos indexada',
    category: 'ensayos',
    identifierLabel: 'NCBI PubMed · Literatura revisada por pares',
    summary:
      'Portal oficial de consulta de resúmenes, ensayos clínicos aleatorizados (RCTs), revisiones sistemáticas Cochrane y metaanálisis sobre metabolismo y clínica de la vitamina D.',
    keyTakeaway:
      'Permite verificar directamente PMID, DOI, diseño experimental, tamaño muestral y conflictos de interés de cualquier estudio.',
    url: 'https://pubmed.ncbi.nlm.nih.gov/?term=vitamin+D+25-hydroxyvitamin+D+randomized+controlled+trial',
    chatPrompt:
      '¿Cómo distinguir metodológicamente un estudio observacional de un ensayo clínico aleatorizado o metaanálisis al leer artículos en PubMed sobre vitamina D?',
  },
];
