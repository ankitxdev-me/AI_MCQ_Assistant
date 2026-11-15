import React, { useState, useEffect, useRef } from 'react';
import {
  BookOpen,
  ChevronDown,
  ChevronUp,
  Plus,
  Trash2,
  CheckCircle2,
  Sparkles,
  Upload,
  FileText,
} from 'lucide-react';
import { ApiClient } from '../api';
import { CustomKnowledgeItem } from '@ai-mcq/shared-types';

interface CustomKnowledgeCardProps {
  defaultTopic?: string;
}

export const CustomKnowledgeCard: React.FC<CustomKnowledgeCardProps> = ({ defaultTopic }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [notes, setNotes] = useState<CustomKnowledgeItem[]>([]);
  const [content, setContent] = useState('');
  const [topic, setTopic] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchNotes = async () => {
    try {
      const items = await ApiClient.getCustomKnowledge();
      setNotes(items || []);
    } catch (e) {
      console.warn('Failed to fetch custom knowledge notes:', e);
    }
  };

  useEffect(() => {
    fetchNotes();
  }, []);

  const handleSave = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!content.trim()) return;

    setIsLoading(true);
    try {
      const finalTopic = topic.trim() || defaultTopic || 'General Context';
      await ApiClient.saveCustomKnowledge(content.trim(), finalTopic);
      setContent('');
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2500);
      await fetchNotes();
    } catch (err: any) {
      alert(`Failed to save knowledge context: ${err.message || 'Unknown error'}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await ApiClient.deleteCustomKnowledge(id);
      await fetchNotes();
    } catch (err: any) {
      alert(`Failed to delete note: ${err.message || 'Unknown error'}`);
    }
  };

  const handleClearAll = async () => {
    if (!window.confirm('Remove all loaded context notes from AI model?')) return;
    try {
      for (const item of notes) {
        await ApiClient.deleteCustomKnowledge(item.id);
      }
      await fetchNotes();
    } catch (err: any) {
      alert(`Error clearing notes: ${err.message || 'Unknown error'}`);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      if (text) {
        setContent(text);
        if (!topic.trim()) {
          setTopic(file.name.replace(/\.[^/.]+$/, ''));
        }
      }
    };
    reader.readAsText(file);
  };

  const wordCount = content.trim() ? content.trim().split(/\s+/).length : 0;

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm mb-4 overflow-hidden">
      {/* Header bar / Toggle */}
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="w-full flex items-center justify-between p-3 text-left hover:bg-slate-50 transition"
      >
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
            <BookOpen className="h-4 w-4" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-bold text-slate-800">Knowledge & Context Base</span>
              {notes.length > 0 && (
                <span className="px-1.5 py-0.2 rounded-full text-[10px] font-semibold bg-emerald-100 text-emerald-700 flex items-center gap-0.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  {notes.length} Active in AI
                </span>
              )}
            </div>
            <p className="text-[11px] text-slate-500">
              {notes.length > 0
                ? `${notes.length} context note(s) loaded into Gemini (Top Priority)`
                : 'Load study material, formulas & cheat-sheets into AI'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {notes.length > 0 && (
            <span className="hidden sm:inline-flex items-center gap-1 text-[11px] text-emerald-600 font-medium">
              <Sparkles className="h-3 w-3" /> Injected
            </span>
          )}
          {isOpen ? (
            <ChevronUp className="h-4 w-4 text-slate-400" />
          ) : (
            <ChevronDown className="h-4 w-4 text-slate-400" />
          )}
        </div>
      </button>

      {/* Expandable Body */}
      {isOpen && (
        <div className="p-3.5 pt-1 border-t border-slate-100 bg-slate-50/50">
          <div className="mb-2 p-2 rounded-lg bg-indigo-50/60 border border-indigo-100 text-[11px] text-indigo-900 leading-relaxed">
            💡 <strong>Context Priority:</strong> Paste or upload your study notes, module texts, or cheat sheets below. Gemini will strictly consult this knowledge to answer all questions.
          </div>

          <form onSubmit={handleSave} className="space-y-2 mb-3">
            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder={defaultTopic ? `Topic (e.g. ${defaultTopic})` : 'Subject / Topic (optional)'}
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                className="flex-1 px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-500 bg-white"
              />
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileUpload}
                accept=".txt,.md,.json,.csv"
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 text-xs font-medium hover:bg-slate-50 transition shadow-2xs"
                title="Upload .txt, .md, or .json file"
              >
                <Upload className="h-3 w-3 text-slate-500" />
                <span>Upload File</span>
              </button>
            </div>

            <div className="relative">
              <textarea
                rows={5}
                placeholder="Paste or write notes, rules, key answers, definitions, or cheat sheet here..."
                value={content}
                onChange={(e) => setContent(e.target.value)}
                className="w-full px-2.5 py-2 rounded-lg border border-slate-300 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-500 bg-white resize-y leading-relaxed font-sans overflow-y-auto max-h-52"
              />
              {content.length > 0 && (
                <div className="absolute right-2 bottom-2 text-[10px] text-slate-400 bg-white/80 px-1 rounded pointer-events-none">
                  {wordCount} words | {content.length} chars
                </div>
              )}
            </div>

            <div className="flex items-center justify-between pt-1">
              <div className="text-[11px] text-slate-500">
                {saveSuccess && (
                  <span className="inline-flex items-center gap-1 text-emerald-600 font-semibold animate-pulse">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Loaded into Gemini!
                  </span>
                )}
              </div>
              <button
                type="submit"
                disabled={isLoading || !content.trim()}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-medium hover:bg-indigo-700 transition disabled:opacity-50 shadow-sm"
              >
                <Plus className="h-3.5 w-3.5" /> Load Context into AI
              </button>
            </div>
          </form>

          {/* List of active custom knowledge */}
          {notes.length > 0 && (
            <div className="space-y-2 pt-2 border-t border-slate-200/60">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-slate-600 uppercase tracking-wider">
                  Active Context Notes ({notes.length})
                </span>
                <button
                  type="button"
                  onClick={handleClearAll}
                  className="text-[10px] text-rose-600 hover:text-rose-800 font-medium hover:underline"
                >
                  Clear All
                </button>
              </div>

              <div className="max-h-48 overflow-y-auto space-y-1.5 pr-1 scrollbar-thin">
                {notes.map((item) => (
                  <div
                    key={item.id}
                    className="p-2 rounded-lg bg-white border border-slate-200 text-xs flex items-start justify-between gap-2 shadow-2xs"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className="font-semibold text-[11px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700">
                          {item.topic}
                        </span>
                        <span className="text-[10px] text-emerald-600 font-medium flex items-center gap-0.5">
                          <CheckCircle2 className="h-2.5 w-2.5" /> Active
                        </span>
                        <span className="text-[10px] text-slate-400">
                          {new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                      <p className="text-slate-700 whitespace-pre-wrap break-words text-[11px] line-clamp-3">
                        {item.content}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleDelete(item.id)}
                      className="p-1 rounded text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition"
                      title="Delete this note"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

