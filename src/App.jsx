import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Search, Plus, Bookmark, Trash2, Cloud, CloudOff,
  RefreshCw, Settings, X, Download
} from 'lucide-react';

const generateId = () => crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 15);

const formatDate = (timestamp) => {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};

const stripHtml = (html) => {
  if (!html) return '';
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.textContent || div.innerText || '';
};

export default function CosmoNotes() {
  const [notes, setNotes] = useState([]);
  const [selectedNoteId, setSelectedNoteId] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [syncStatus, setSyncStatus] = useState('idle');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [noteToDelete, setNoteToDelete] = useState(null);
  const [tursoConfig, setTursoConfig] = useState({ url: '', token: '' });

  const [installPrompt, setInstallPrompt] = useState(null);

  const titleInputRef = useRef(null);
  const editorRef = useRef(null);

  // --- Initialization & Local Storage ---
  useEffect(() => {
    const savedNotes = localStorage.getItem('cosmo_notes');
    if (savedNotes) {
      try {
        const parsed = JSON.parse(savedNotes);
        setNotes(parsed);
        if (parsed.length > 0) {
          const active = parsed.filter(n => !n.deleted);
          if (active.length > 0) setSelectedNoteId(active[0].id);
        }
      } catch (e) {
        console.error('Failed to parse notes', e);
      }
    }
    const savedConfig = localStorage.getItem('cosmo_turso_config');
    if (savedConfig) {
      try { setTursoConfig(JSON.parse(savedConfig)); } catch (e) {}
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('cosmo_notes', JSON.stringify(notes));
  }, [notes]);

  useEffect(() => {
    localStorage.setItem('cosmo_turso_config', JSON.stringify(tursoConfig));
  }, [tursoConfig]);

  // Capture PWA install prompt
  useEffect(() => {
    const handler = (e) => { e.preventDefault(); setInstallPrompt(e); };
    const installed = () => setInstallPrompt(null);
    window.addEventListener('beforeinstallprompt', handler);
    window.addEventListener('appinstalled', installed);
    return () => {
      window.removeEventListener('beforeinstallprompt', handler);
      window.removeEventListener('appinstalled', installed);
    };
  }, []);

  const handleInstall = async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    if (outcome === 'accepted') setInstallPrompt(null);
  };

  // Sync editor DOM content when the selected note changes
  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.innerHTML = selectedNote?.content || '';
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNoteId]);

  // --- Derived State ---
  const activeNotes = useMemo(() => {
    return notes
      .filter(n => !n.deleted)
      .filter(n => {
        const plain = stripHtml(n.content).toLowerCase();
        const q = searchQuery.toLowerCase();
        return n.title.toLowerCase().includes(q) || plain.includes(q);
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [notes, searchQuery]);

  const selectedNote = useMemo(() => {
    return notes.find(n => n.id === selectedNoteId) || null;
  }, [notes, selectedNoteId]);

  // --- Actions ---
  const handleCreateNote = () => {
    const newNote = {
      id: generateId(),
      title: '',
      content: '',
      updatedAt: Date.now(),
      isSynced: false,
      deleted: false,
      bookmarked: false,
    };
    setNotes(prev => [newNote, ...prev]);
    setSelectedNoteId(newNote.id);
    setSearchQuery('');
    setTimeout(() => { if (titleInputRef.current) titleInputRef.current.focus(); }, 50);
  };

  const handleUpdateNote = (id, updates) => {
    setNotes(prev => prev.map(note =>
      note.id === id ? { ...note, ...updates, updatedAt: Date.now(), isSynced: false } : note
    ));
  };

  const handleDeleteNote = (id) => {
    setNotes(prev => prev.map(note =>
      note.id === id ? { ...note, deleted: true, updatedAt: Date.now(), isSynced: false } : note
    ));
    const currentIndex = activeNotes.findIndex(n => n.id === id);
    const nextNote = activeNotes[currentIndex + 1] || activeNotes[currentIndex - 1];
    setSelectedNoteId(nextNote ? nextNote.id : null);
  };

  const toggleBookmark = (id) => {
    const note = notes.find(n => n.id === id);
    if (note) handleUpdateNote(id, { bookmarked: !note.bookmarked });
  };

  // --- Rich Text Formatting ---
  const formatText = (command, value = null) => {
    document.execCommand(command, false, value);
    editorRef.current?.focus();
  };

  const handleContentInput = () => {
    if (editorRef.current && selectedNote) {
      handleUpdateNote(selectedNote.id, { content: editorRef.current.innerHTML });
    }
  };

  // --- Keyboard Shortcuts ---
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault();
        handleCreateNote();
        return;
      }
      if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowRight')) {
        e.preventDefault();
        if (activeNotes.length === 0) return;
        const idx = activeNotes.findIndex(n => n.id === selectedNoteId);
        setSelectedNoteId(activeNotes[idx < activeNotes.length - 1 ? idx + 1 : 0].id);
      }
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowLeft')) {
        e.preventDefault();
        if (activeNotes.length === 0) return;
        const idx = activeNotes.findIndex(n => n.id === selectedNoteId);
        setSelectedNoteId(activeNotes[idx > 0 ? idx - 1 : activeNotes.length - 1].id);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeNotes, selectedNoteId]);

  // --- Turso Sync Engine ---
  const syncWithTurso = useCallback(async () => {
    if (!tursoConfig.url || !tursoConfig.token) return;
    setSyncStatus('syncing');
    const runQuery = async (requests) => {
      const response = await fetch(`${tursoConfig.url}/v2/pipeline`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${tursoConfig.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests }),
      });
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      return await response.json();
    };
    try {
      await runQuery([{ type: 'execute', stmt: { sql: `CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, title TEXT, content TEXT, updatedAt INTEGER, deleted INTEGER, bookmarked INTEGER)`, args: [] } }]);
      const unsynced = notes.filter(n => !n.isSynced);
      if (unsynced.length > 0) {
        await runQuery(unsynced.map(n => ({
          type: 'execute',
          stmt: {
            sql: `INSERT INTO notes (id, title, content, updatedAt, deleted, bookmarked) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, content=excluded.content, updatedAt=excluded.updatedAt, deleted=excluded.deleted, bookmarked=excluded.bookmarked`,
            args: [
              { type: 'text', value: n.id }, { type: 'text', value: n.title }, { type: 'text', value: n.content },
              { type: 'integer', value: '' + n.updatedAt }, { type: 'integer', value: '' + (n.deleted ? 1 : 0) }, { type: 'integer', value: '' + (n.bookmarked ? 1 : 0) },
            ],
          },
        })));
        setNotes(prev => prev.map(n => unsynced.find(u => u.id === n.id) ? { ...n, isSynced: true } : n));
      }
      const pullRes = await runQuery([{ type: 'execute', stmt: { sql: 'SELECT * FROM notes', args: [] } }]);
      const cols = pullRes.results[0].response.result.cols.map(c => c.name);
      const remoteNotes = pullRes.results[0].response.result.rows.map(row => {
        const n = {};
        cols.forEach((col, i) => { n[col] = row[i].value; });
        return { id: n.id, title: n.title || '', content: n.content || '', updatedAt: parseInt(n.updatedAt, 10), deleted: parseInt(n.deleted, 10) === 1, bookmarked: parseInt(n.bookmarked, 10) === 1, isSynced: true };
      });
      setNotes(current => {
        const merged = [...current];
        remoteNotes.forEach(r => {
          const i = merged.findIndex(n => n.id === r.id);
          if (i > -1) { if (r.updatedAt > merged[i].updatedAt) merged[i] = r; }
          else merged.push(r);
        });
        return merged;
      });
      setSyncStatus('idle');
    } catch (error) {
      console.error('Sync error:', error);
      setSyncStatus('error');
    }
  }, [notes, tursoConfig]);

  useEffect(() => {
    if (!tursoConfig.url || !tursoConfig.token) return;
    syncWithTurso();
    const interval = setInterval(syncWithTurso, 30000);
    return () => clearInterval(interval);
  }, [tursoConfig.url, tursoConfig.token]);

  // --- Render ---
  return (
    <div className="flex h-screen w-full bg-[#f4f6f8] text-gray-900 font-serif overflow-hidden">

      {/* LEFT PANE */}
      <div className="w-[28%] min-w-[260px] flex flex-col bg-[#f4f6f8] border-r border-gray-200 h-full relative z-10 shadow-[2px_0_10px_rgba(0,0,0,0.02)]">

        {/* Header */}
        <div className="pt-5 pb-3 px-5 flex justify-between items-center bg-white border-b border-gray-100">
          <div className="flex items-center space-x-2">
            <button
              onClick={() => setIsSettingsOpen(true)}
              className="p-1.5 -ml-1.5 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors"
              title="Settings & Sync"
            >
              <Settings size={18} />
            </button>
            <h1 className="text-lg font-semibold tracking-tight text-gray-800">Notes</h1>
          </div>
          <div className="flex items-center gap-1.5">
            {installPrompt && (
              <button
                onClick={handleInstall}
                className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-[#8B1A2D] transition-colors"
                title="Install App"
              >
                <Download size={16} />
              </button>
            )}
            <button
              onClick={handleCreateNote}
              className="bg-[#8B1A2D] text-white p-1.5 rounded-full shadow-sm hover:bg-[#7A1526] transition-all transform hover:scale-105"
              title="New Note (Ctrl+N)"
            >
              <Plus size={18} />
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="px-4 py-3 bg-[#f4f6f8]">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" size={16} />
            <input
              type="text"
              placeholder="Search..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-white font-sans text-xs pl-9 pr-4 py-2 rounded-xl border-none shadow-sm focus:ring-2 focus:ring-[#8B1A2D]/15 outline-none transition-all placeholder:text-gray-400"
            />
          </div>
        </div>

        {/* Note List */}
        <div className="flex-1 overflow-y-auto px-3 pb-6 space-y-2 custom-scrollbar">
          {activeNotes.length === 0 ? (
            <div className="text-center text-gray-400 mt-10 px-4">
              <p className="text-xs font-sans">No notes found.</p>
              <p className="text-[10px] mt-1 opacity-70 font-sans">Press Ctrl+N to create one.</p>
            </div>
          ) : (
            activeNotes.map(note => (
              <div
                key={note.id}
                onClick={() => setSelectedNoteId(note.id)}
                className={`group cursor-pointer rounded-lg p-3.5 transition-all duration-200 border
                  ${selectedNoteId === note.id
                    ? 'bg-white shadow-[0_2px_8px_rgba(0,0,0,0.07)] border-transparent ring-1 ring-gray-100'
                    : 'bg-white/60 hover:bg-white hover:shadow-[0_1px_4px_rgba(0,0,0,0.06)] border-transparent'
                  }`}
              >
                <div className="flex justify-between items-start mb-0.5">
                  <h3 className={`font-serif font-semibold text-sm line-clamp-1 pr-2
                    ${selectedNoteId === note.id ? 'text-gray-900' : 'text-gray-800'}`}>
                    {note.title || 'Untitled Note'}
                  </h3>
                  {note.bookmarked && (
                    <Bookmark size={14} className="text-[#8B1A2D] fill-[#8B1A2D] flex-shrink-0" />
                  )}
                </div>
                <p className="text-[12px] text-gray-500 line-clamp-2 leading-relaxed font-sans">
                  {stripHtml(note.content) || 'No additional text...'}
                </p>
                <div className="mt-2 text-[10px] font-medium text-gray-400 font-sans">
                  <span>{formatDate(note.updatedAt)}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* RIGHT PANE */}
      <div className="flex-1 flex flex-col h-full bg-[#fcfcfc]">
        {selectedNote ? (
          <>
            {/* Editor Header */}
            <div className="h-14 flex justify-between items-center px-8 border-b border-gray-100 bg-[#fcfcfc]/80 backdrop-blur-md">
              <div className="text-[12px] font-medium text-gray-400 flex items-center space-x-2 font-sans">
                <span>{new Date(selectedNote.updatedAt).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</span>
                <span className="text-gray-300">•</span>
                <div className="flex items-center space-x-1" title="Sync Status">
                  {!tursoConfig.url ? <CloudOff size={13} className="text-gray-300" /> :
                   syncStatus === 'syncing' ? <RefreshCw size={13} className="text-blue-400 animate-spin" /> :
                   syncStatus === 'error' ? <CloudOff size={13} className="text-red-400" /> :
                   <Cloud size={13} className={selectedNote.isSynced ? 'text-green-500' : 'text-gray-400'} />}
                </div>
              </div>
              <div className="flex items-center space-x-1">
                <button
                  onClick={() => toggleBookmark(selectedNote.id)}
                  className={`p-2 rounded-lg transition-colors ${selectedNote.bookmarked ? 'text-[#8B1A2D] bg-rose-50' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'}`}
                  title="Bookmark"
                >
                  <Bookmark size={16} className={selectedNote.bookmarked ? 'fill-[#8B1A2D]' : ''} />
                </button>
                <button
                  onClick={() => setNoteToDelete(selectedNote.id)}
                  className="p-2 rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-500 transition-colors"
                  title="Delete Note"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>

            {/* Editor Body */}
            <div className="flex-1 overflow-y-auto px-10 py-8 custom-scrollbar">
              <div className="max-w-3xl mx-auto h-full flex flex-col">
                <input
                  ref={titleInputRef}
                  type="text"
                  value={selectedNote.title}
                  onChange={(e) => handleUpdateNote(selectedNote.id, { title: e.target.value })}
                  placeholder="Note Title"
                  className="w-full text-3xl font-serif font-bold text-gray-900 placeholder:text-gray-300 border-none outline-none bg-transparent mb-4 focus:ring-0 p-0"
                />

                {/* Format Toolbar */}
                <div className="flex items-center gap-0.5 mb-4 pb-3 border-b border-gray-100 font-sans">
                  <button
                    onMouseDown={(e) => { e.preventDefault(); formatText('bold'); }}
                    className="px-2.5 py-1 text-sm font-bold text-gray-500 hover:bg-gray-100 hover:text-gray-800 rounded transition-colors"
                    title="Bold (Ctrl+B)"
                  >B</button>
                  <button
                    onMouseDown={(e) => { e.preventDefault(); formatText('italic'); }}
                    className="px-2.5 py-1 text-sm italic text-gray-500 hover:bg-gray-100 hover:text-gray-800 rounded transition-colors"
                    title="Italic (Ctrl+I)"
                  >I</button>
                  <div className="w-px h-4 bg-gray-200 mx-1" />
                  <button
                    onMouseDown={(e) => { e.preventDefault(); formatText('formatBlock', 'H2'); }}
                    className="px-2.5 py-1 text-xs font-bold tracking-wide text-gray-500 hover:bg-gray-100 hover:text-gray-800 rounded transition-colors"
                    title="Heading"
                  >H</button>
                  <button
                    onMouseDown={(e) => { e.preventDefault(); formatText('formatBlock', 'P'); }}
                    className="px-2.5 py-1 text-xs text-gray-500 hover:bg-gray-100 hover:text-gray-800 rounded transition-colors"
                    title="Normal text"
                  >¶</button>
                </div>

                {/* Content Editor */}
                <div
                  ref={editorRef}
                  contentEditable
                  suppressContentEditableWarning
                  onInput={handleContentInput}
                  className="note-editor flex-1 text-[17px] font-serif text-gray-700 leading-relaxed outline-none bg-transparent"
                  data-placeholder="Start typing your note here..."
                />
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-gray-400 bg-[#fcfcfc]">
            <div className="w-14 h-14 bg-gray-50 rounded-full flex items-center justify-center mb-4 border border-gray-100">
              <Plus size={20} className="text-gray-300" />
            </div>
            <p className="text-base font-serif">Select a note or create a new one.</p>
            <p className="text-[11px] mt-2 opacity-60 font-sans">Use Alt + Arrows to navigate.</p>
          </div>
        )}
      </div>

      {/* Settings Modal */}
      {isSettingsOpen && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden transform transition-all">
            <div className="px-6 py-4 border-b border-gray-100 flex justify-between items-center">
              <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2">
                <Cloud size={18} className="text-[#8B1A2D]" />
                Sync Settings
              </h2>
              <button onClick={() => setIsSettingsOpen(false)} className="p-1.5 text-gray-400 hover:bg-gray-100 rounded-md">
                <X size={18} />
              </button>
            </div>
            <div className="p-6 space-y-5">
              <div className="text-sm text-gray-600 leading-relaxed bg-blue-50/50 p-4 rounded-xl border border-blue-100 font-sans">
                Configure your <a href="https://turso.tech" target="_blank" rel="noreferrer" className="text-blue-600 font-semibold hover:underline">Turso SQLite</a> database to enable seamless cross-device syncing. Leave these blank to use the app entirely offline.
              </div>
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1.5 font-sans">Database URL</label>
                  <input
                    type="url"
                    value={tursoConfig.url}
                    onChange={(e) => setTursoConfig({ ...tursoConfig, url: e.target.value })}
                    placeholder="https://your-db-name.turso.io"
                    className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm font-sans focus:ring-2 focus:ring-[#8B1A2D]/20 outline-none transition-all"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1.5 font-sans">Auth Token</label>
                  <input
                    type="password"
                    value={tursoConfig.token}
                    onChange={(e) => setTursoConfig({ ...tursoConfig, token: e.target.value })}
                    placeholder="ey..."
                    className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm font-sans focus:ring-2 focus:ring-[#8B1A2D]/20 outline-none transition-all"
                  />
                </div>
              </div>
            </div>
            <div className="px-6 py-4 bg-gray-50 border-t border-gray-100 flex justify-end gap-3">
              <button
                onClick={() => setIsSettingsOpen(false)}
                className="px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-200 rounded-lg transition-colors font-sans"
              >
                Close
              </button>
              <button
                onClick={() => { syncWithTurso(); setIsSettingsOpen(false); }}
                className="px-4 py-2 text-sm font-medium text-white bg-[#8B1A2D] hover:bg-[#7A1526] rounded-lg transition-colors shadow-sm font-sans"
              >
                Save & Sync
              </button>
            </div>
            <div className="px-6 py-3 flex justify-center">
              <img src="/chewy-studios.png" alt="Chewy Studios" className="h-10 opacity-70" />
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {noteToDelete && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm overflow-hidden transform transition-all">
            <div className="p-6 text-center">
              <div className="w-12 h-12 rounded-full bg-red-50 flex items-center justify-center mx-auto mb-4">
                <Trash2 size={24} className="text-red-500" />
              </div>
              <h3 className="text-lg font-bold text-gray-900 mb-2">Delete Note</h3>
              <p className="text-sm text-gray-500 font-sans">
                Are you sure you want to delete this note? This action cannot be undone.
              </p>
            </div>
            <div className="px-6 py-4 bg-gray-50 border-t border-gray-100 flex justify-end gap-3">
              <button
                onClick={() => setNoteToDelete(null)}
                className="px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-200 rounded-lg transition-colors font-sans"
              >
                Cancel
              </button>
              <button
                onClick={() => { handleDeleteNote(noteToDelete); setNoteToDelete(null); }}
                className="px-4 py-2 text-sm font-medium text-white bg-red-500 hover:bg-red-600 rounded-lg transition-colors shadow-sm font-sans"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      <style dangerouslySetInnerHTML={{ __html: `
        .custom-scrollbar::-webkit-scrollbar { width: 6px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background-color: rgba(0,0,0,0.1); border-radius: 10px; }
        .custom-scrollbar:hover::-webkit-scrollbar-thumb { background-color: rgba(0,0,0,0.2); }
        .note-editor:empty:before { content: attr(data-placeholder); color: #d1d5db; pointer-events: none; }
        .note-editor h2 { font-size: 1.35rem; font-weight: 700; margin: 0.75rem 0 0.25rem 0; color: #111827; }
        .note-editor p { margin: 0; min-height: 1.5em; }
        .note-editor strong { font-weight: 700; }
        .note-editor em { font-style: italic; }
      ` }} />
    </div>
  );
}
