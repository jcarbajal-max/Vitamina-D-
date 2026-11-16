/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useRef, useState } from 'react';
import {
  BookOpen,
  Database,
  FlaskConical,
  Menu,
  MessageSquare,
  Plus,
  ShieldCheck,
  Sun,
  X,
} from 'lucide-react';
import type { AppSection, ChatMessage, GroundingSource } from './types/vitaminD';
import { consumeSseStream } from './utils/streamClient';
import { ChatView } from './components/ChatView';
import { LabAnalyzerView } from './components/LabAnalyzerView';
import { RiskAssessmentView } from './components/RiskAssessmentView';
import { LibraryView } from './components/LibraryView';
import { AdminKnowledgeView } from './components/AdminKnowledgeView';

const NAV_ITEMS: Array<{
  id: AppSection;
  label: string;
  shortLabel: string;
  icon: typeof MessageSquare;
}> = [
  {
    id: 'chat',
    label: 'Chat científico',
    shortLabel: 'Chat científico',
    icon: MessageSquare,
  },
  {
    id: 'lab',
    label: 'Analizador de laboratorio',
    shortLabel: 'Analizador 25(OH)D',
    icon: FlaskConical,
  },
  {
    id: 'risk',
    label: 'Evaluación de factores de riesgo',
    shortLabel: 'Factores de riesgo',
    icon: ShieldCheck,
  },
  {
    id: 'library',
    label: 'Biblioteca científica',
    shortLabel: 'Biblioteca científica',
    icon: BookOpen,
  },
  {
    id: 'admin',
    label: 'ADMINISTRAR CONOCIMIENTOS',
    shortLabel: 'ADMINISTRAR CONOCIMIENTOS',
    icon: Database,
  },
];

function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export default function App() {
  const [activeSection, setActiveSection] = useState<AppSection>('chat');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const lastSubmittedMessagesRef = useRef<ChatMessage[]>([]);

  const executeChatRequest = useCallback(
    async (conversationHistory: ChatMessage[], assistantMessageId: string) => {
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      setIsStreaming(true);
      setChatError(null);

      const apiMessages = conversationHistory
        .filter((m) => m.text.trim().length > 0)
        .map((m) => ({
          role: m.role,
          text: m.text,
        }));

      await consumeSseStream(
        '/api/chat',
        { messages: apiMessages },
        {
          onChunk: (chunk) => {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMessageId ? { ...m, text: m.text + chunk } : m
              )
            );
          },
          onSources: (sources) => {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMessageId ? { ...m, sources } : m
              )
            );
          },
          onDone: () => {
            setIsStreaming(false);
          },
          onError: (errMsg) => {
            setChatError(errMsg);
            setIsStreaming(false);
            setMessages((prev) =>
              prev.filter(
                (m) => !(m.id === assistantMessageId && m.text.trim().length === 0)
              )
            );
          },
        },
        controller.signal
      );
    },
    []
  );

  const handleSendMessage = useCallback(
    (text: string, contextTag?: string) => {
      const trimmed = text.trim();
      if (!trimmed || isStreaming) return;

      const userMsg: ChatMessage = {
        id: createId(),
        role: 'user',
        text: trimmed,
        timestamp: Date.now(),
        contextTag,
      };
      const assistantMsg: ChatMessage = {
        id: createId(),
        role: 'model',
        text: '',
        timestamp: Date.now(),
      };

      const historyForApi = [...messages, userMsg];
      lastSubmittedMessagesRef.current = historyForApi;
      setMessages([...historyForApi, assistantMsg]);
      setActiveSection('chat');
      setMobileMenuOpen(false);

      void executeChatRequest(historyForApi, assistantMsg.id);
    },
    [executeChatRequest, isStreaming, messages]
  );

  const handleStopStreaming = useCallback(() => {
    abortControllerRef.current?.abort();
    setIsStreaming(false);
  }, []);

  const handleRetryLast = useCallback(() => {
    const history = lastSubmittedMessagesRef.current;
    if (history.length === 0 || isStreaming) return;

    const assistantMsg: ChatMessage = {
      id: createId(),
      role: 'model',
      text: '',
      timestamp: Date.now(),
    };
    setMessages([...history, assistantMsg]);
    void executeChatRequest(history, assistantMsg.id);
  }, [executeChatRequest, isStreaming]);

  const handleNewConversation = useCallback(() => {
    abortControllerRef.current?.abort();
    setIsStreaming(false);
    setChatError(null);
    setMessages([]);
    lastSubmittedMessagesRef.current = [];
    setActiveSection('chat');
    setMobileMenuOpen(false);
  }, []);

  const handleContinueInChat = useCallback(
    (
      userPrompt: string,
      assistantResponse: string,
      sources?: GroundingSource[]
    ) => {
      abortControllerRef.current?.abort();
      setIsStreaming(false);
      setChatError(null);

      const userMsg: ChatMessage = {
        id: createId(),
        role: 'user',
        text: userPrompt,
        timestamp: Date.now(),
        contextTag: 'Contexto importado del módulo clínico-educativo',
      };
      const modelMsg: ChatMessage = {
        id: createId(),
        role: 'model',
        text: assistantResponse,
        sources,
        timestamp: Date.now(),
      };

      setMessages((prev) => [...prev, userMsg, modelMsg]);
      setActiveSection('chat');
      setMobileMenuOpen(false);
    },
    []
  );

  const handleAskFromLibrary = useCallback(
    (prompt: string) => {
      handleSendMessage(prompt, 'Consulta desde Biblioteca científica');
    },
    [handleSendMessage]
  );

  const activeNav =
    NAV_ITEMS.find((item) => item.id === activeSection) ?? NAV_ITEMS[0];

  return (
    <div className="h-screen w-full flex flex-col lg:flex-row bg-slate-50 text-slate-900 overflow-hidden">
      {/* Mobile / Tablet Top Header */}
      <header className="lg:hidden h-14 px-4 bg-white border-b border-slate-200 flex items-center justify-between gap-3 shrink-0 z-30">
        <div className="flex items-center gap-2.5 min-w-0">
          <button
            type="button"
            onClick={() => setMobileMenuOpen(true)}
            aria-label="Abrir menú de navegación"
            className="inline-flex items-center justify-center w-10 h-10 -ml-1.5 rounded-lg text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600"
          >
            <Menu className="w-5 h-5" />
          </button>
          <a
            href="#chat"
            onClick={(e) => {
              e.preventDefault();
              setActiveSection('chat');
            }}
            className="inline-flex items-center gap-2 font-bold text-base tracking-tight text-blue-800 whitespace-nowrap shrink-0"
          >
            <Sun className="w-4 h-4 text-sky-600 shrink-0" aria-hidden="true" />
            <span>VITAMIN D AI</span>
          </a>
        </div>

        <button
          type="button"
          onClick={handleNewConversation}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-blue-700 bg-sky-50 border border-sky-200 rounded-lg hover:bg-sky-100 transition-colors whitespace-nowrap shrink-0"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Nueva consulta</span>
        </button>
      </header>

      {/* Mobile Drawer Backdrop */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 bg-slate-900/40 z-40 lg:hidden"
          onClick={() => setMobileMenuOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Left Navigation Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-72 bg-white border-r border-slate-200 flex flex-col transition-transform duration-200 lg:static lg:translate-x-0 shrink-0 ${
          mobileMenuOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
        aria-label="Navegación principal"
      >
        {/* Sidebar Header with VITAMIN D AI wordmark */}
        <div className="h-16 px-5 border-b border-slate-200 flex items-center justify-between gap-3 shrink-0">
          <a
            href="#chat"
            onClick={(e) => {
              e.preventDefault();
              setActiveSection('chat');
              setMobileMenuOpen(false);
            }}
            className="inline-flex items-center gap-2.5 text-lg font-bold tracking-tight text-blue-800 whitespace-nowrap shrink-0"
          >
            <span className="w-8 h-8 rounded-lg bg-sky-50 border border-sky-200 flex items-center justify-center text-sky-700 shrink-0">
              <Sun className="w-4 h-4" aria-hidden="true" />
            </span>
            <span>VITAMIN D AI</span>
          </a>

          <button
            type="button"
            onClick={() => setMobileMenuOpen(false)}
            aria-label="Cerrar menú"
            className="lg:hidden inline-flex items-center justify-center w-9 h-9 rounded-lg text-slate-500 hover:bg-slate-100"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Primary Action: New Conversation */}
        <div className="p-4 border-b border-slate-100">
          <button
            type="button"
            onClick={handleNewConversation}
            className="w-full inline-flex items-center justify-center gap-2 min-h-[44px] px-4 py-2.5 rounded-lg bg-blue-700 text-white text-sm font-medium hover:bg-blue-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600 whitespace-nowrap"
          >
            <Plus className="w-4 h-4 shrink-0" />
            <span>Nueva conversación</span>
          </button>
        </div>

        {/* Navigation Links */}
        <nav className="flex-1 overflow-y-auto p-3 space-y-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = activeSection === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setActiveSection(item.id);
                  setMobileMenuOpen(false);
                }}
                aria-current={isActive ? 'page' : undefined}
                className={`w-full flex items-center gap-3 min-h-[44px] px-3.5 py-2.5 rounded-lg text-sm font-medium text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600 ${
                  isActive
                    ? 'bg-sky-50 text-blue-800 border border-sky-200/80'
                    : 'text-slate-700 hover:bg-slate-100 hover:text-slate-950 border border-transparent'
                }`}
              >
                <Icon
                  className={`w-4 h-4 shrink-0 ${
                    isActive ? 'text-blue-700' : 'text-slate-500'
                  }`}
                  aria-hidden="true"
                />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Sidebar Educational Disclaimer */}
        <div className="p-4 border-t border-slate-200 bg-slate-50/80">
          <p className="text-xs font-semibold text-slate-800 mb-1">
            Aviso educativo
          </p>
          <p className="text-xs text-slate-600 leading-relaxed">
            VITAMIN D AI es una herramienta educativa basada en literatura
            científica. No diagnostica enfermedades, no prescribe tratamientos y
            no sustituye la evaluación médica presencial.
          </p>
        </div>
      </aside>

      {/* Main Content Workspace */}
      <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
        {/* Desktop Header */}
        <header className="hidden lg:flex h-16 px-8 bg-white border-b border-slate-200 items-center justify-between gap-8 shrink-0">
          <h1 className="text-base font-semibold text-slate-900 whitespace-nowrap shrink-0">
            {activeNav.label}
          </h1>

          <p className="text-xs text-slate-500 truncate">
            Herramienta educativa científica · No sustituye la evaluación médica
          </p>

          <div className="shrink-0">
            <button
              type="button"
              onClick={handleNewConversation}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Nueva conversación</span>
            </button>
          </div>
        </header>

        {/* Mobile/Tablet Educational Notice Strip */}
        <div className="lg:hidden px-4 py-2 bg-sky-50/80 border-b border-sky-200/70 text-[11px] text-sky-950 text-center shrink-0">
          Herramienta educativa científica · No sustituye la evaluación médica.
        </div>

        {/* Active Section Viewport */}
        <main className="flex-1 min-h-0 overflow-hidden">
          {activeSection === 'chat' && (
            <ChatView
              messages={messages}
              isStreaming={isStreaming}
              errorMessage={chatError}
              onSendMessage={(txt) => handleSendMessage(txt)}
              onStopStreaming={handleStopStreaming}
              onRetryLast={handleRetryLast}
              onNewConversation={handleNewConversation}
            />
          )}

          {activeSection === 'lab' && (
            <LabAnalyzerView onContinueInChat={handleContinueInChat} />
          )}

          {activeSection === 'risk' && (
            <RiskAssessmentView onContinueInChat={handleContinueInChat} />
          )}

          {activeSection === 'library' && (
            <LibraryView onAskAboutResource={handleAskFromLibrary} />
          )}

          {activeSection === 'admin' && <AdminKnowledgeView />}
        </main>
      </div>
    </div>
  );
}
