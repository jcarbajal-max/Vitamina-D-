-- VITAMIN D AI — Cloudflare D1 Schema for Scientific Library & RAG
-- Execute locally or remotely via:
--   npx wrangler d1 execute vitamin-d-ai-db --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  authors TEXT NOT NULL,
  publication_year INTEGER,
  journal_or_institution TEXT NOT NULL,
  doi TEXT NOT NULL DEFAULT '',
  pmid TEXT NOT NULL DEFAULT '',
  reference_url TEXT NOT NULL DEFAULT '',
  publication_type TEXT NOT NULL,
  evidence_tier INTEGER NOT NULL DEFAULT 5,
  is_historical INTEGER NOT NULL DEFAULT 0,
  category TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'es',
  source_format TEXT NOT NULL,
  original_filename TEXT NOT NULL DEFAULT '',
  r2_key TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL UNIQUE,
  page_count INTEGER NOT NULL DEFAULT 0,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'indexed',
  error_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  page_number INTEGER,
  section_title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  char_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_documents_category ON documents(category);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
CREATE INDEX IF NOT EXISTS idx_documents_doi ON documents(doi);
CREATE INDEX IF NOT EXISTS idx_documents_pmid ON documents(pmid);
CREATE INDEX IF NOT EXISTS idx_documents_evidence_tier ON documents(evidence_tier);
CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON document_chunks(document_id);
