import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { 
  Search, Plus, Bookmark, Trash2, Cloud, CloudOff, 
  RefreshCw, Settings, ChevronLeft, ChevronRight, X 
} from 'lucide-react';

// --- Utility Functions ---
const generateId = () => crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 15);

const formatDate = (timestamp) => {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};

// --- Main Application Component ---
export default function CosmoNotes() {
  // State
  const [notes, setNotes] = useState([]);
  const [selectedNoteId, setSelectedNoteId] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [syncStatus, setSyncStatus] = useState('idle'); // idle, syncing, error, offline
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [noteToDelete, setNoteToDelete] = useState(null);
  const [tursoConfig, setTursoConfig] = useState({ url: '', token: '' });

  // Refs for focus management
  const titleInputRef = useRef(null);
  const contentInputRef = useRef(null);

  // --- Initialization & Local Storage ---
  useEffect(() => {
    const savedNotes = localStorage.getItem('cosmo_notes');
    if (savedNotes) {
      try {
        const parsed = JSON.parse(savedNotes);
        setNotes(parsed);
        // Select first active note if none selected
        if (parsed.length > 0) {
          const activeNotes = parsed.filter(n => !n.deleted);
          if (activeNotes.length > 0) {
            setSelectedNoteId(activeNotes[0].id);
          }
        }
      } catch (e) {
        console.error("Failed to parse notes", e);
      }
    }

    const savedConfig = localStorage.getItem('cosmo_turso_config');
    if (savedConfig) {
      try {
        setTursoConfig(JSON.parse(savedConfig));
      } catch (e) {}
    }
  }, []);

  // Save notes to local storage whenever they change
  useEffect(() => {
    localStorage.setItem('cosmo_notes', JSON.stringify(notes));
  }, [notes]);

  // Save config whenever it changes
  useEffect(() => {
    localStorage.setItem('cosmo_turso_config', JSON.stringify(tursoConfig));
  }, [tursoConfig]);

  // --- Derived State ---
  const activeNotes = useMemo(() => {
    return notes
      .filter(n => !n.deleted)
      .filter(n => n.title.toLowerCase().includes(searchQuery.toLowerCase()) || n.content.toLowerCase().includes(searchQuery.toLowerCase()))
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
      bookmarked: false
    };
    setNotes(prev => [newNote, ...prev]);
    setSelectedNoteId(newNote.id);
    setSearchQuery('');
    
    // Focus title input on new note
    setTimeout(() => {
      if (titleInputRef.current) titleInputRef.current.focus();
    }, 50);
  };

  const handleUpdateNote = (id, updates) => {
    setNotes(prev => prev.map(note => 
      note.id === id 
        ? { ...note, ...updates, updatedAt: Date.now(), isSynced: false } 
        : note
    ));
  };

  const handleDeleteNote = (id) => {
    setNotes(prev => prev.map(note => 
      note.id === id 
        ? { ...note, deleted: true, updatedAt: Date.now(), isSynced: false } 
        : note
    ));
    // Select the next available note
    const currentIndex = activeNotes.findIndex(n => n.id === id);
    const nextNote = activeNotes[currentIndex + 1] || activeNotes[currentIndex - 1];
    setSelectedNoteId(nextNote ? nextNote.id : null);
  };

  const toggleBookmark = (id) => {
    const note = notes.find(n => n.id === id);
    if (note) {
      handleUpdateNote(id, { bookmarked: !note.bookmarked });
    }
  };

  // --- Keyboard Shortcuts ---
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Don't hijack if user is intensely typing in content, unless using modifiers
      const isInputFocused = document.activeElement.tagName === 'TEXTAREA' || document.activeElement.tagName === 'INPUT';

      // New Note: Ctrl+N or Cmd+N
      if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault();
        handleCreateNote();
        return;
      }

      // Navigation: Alt + Arrows (to simulate Fn+Arrow on some physical keyboards)
      if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowRight')) {
        e.preventDefault();
        if (activeNotes.length === 0) return;
        const currentIndex = activeNotes.findIndex(n => n.id === selectedNoteId);
        const nextIndex = currentIndex < activeNotes.length - 1 ? currentIndex + 1 : 0;
        setSelectedNoteId(activeNotes[nextIndex].id);
      }

      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowLeft')) {
        e.preventDefault();
        if (activeNotes.length === 0) return;
        const currentIndex = activeNotes.findIndex(n => n.id === selectedNoteId);
        const prevIndex = currentIndex > 0 ? currentIndex - 1 : activeNotes.length - 1;
        setSelectedNoteId(activeNotes[prevIndex].id);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeNotes, selectedNoteId]);

  // --- Turso Sync Engine ---
  const syncWithTurso = useCallback(async () => {
    if (!tursoConfig.url || !tursoConfig.token) {
      return;
    }

    setSyncStatus('syncing');
    
    // Helper for Turso HTTP API POST
    const runQuery = async (requests) => {
      const response = await fetch(`${tursoConfig.url}/v2/pipeline`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${tursoConfig.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ requests })
      });
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      return await response.json();
    };

    try {
      // 1. Ensure Table Exists
      await runQuery([{
        type: "execute",
        stmt: {
          sql: `CREATE TABLE IF NOT EXISTS notes (
            id TEXT PRIMARY KEY,
            title TEXT,
            content TEXT,
            updatedAt INTEGER,
            deleted INTEGER,
            bookmarked INTEGER
          )`,
          args: []
        }
      }]);

      // 2. Push unsynced local changes
      const unsynced = notes.filter(n => !n.isSynced);
      if (unsynced.length > 0) {
        const pushRequests = unsynced.map(n => ({
          type: "execute",
          stmt: {
            sql: `INSERT INTO notes (id, title, content, updatedAt, deleted, bookmarked) 
                  VALUES (?, ?, ?, ?, ?, ?) 
                  ON CONFLICT(id) DO UPDATE SET 
                  title=excluded.title, content=excluded.content, 
                  updatedAt=excluded.updatedAt, deleted=excluded.deleted, 
                  bookmarked=excluded.bookmarked`,
            args: [
              { type: "text", value: n.id },
              { type: "text", value: n.title },
              { type: "text", value: n.content },
              { type: "integer", value: "" + n.updatedAt },
              { type: "integer", value: "" + (n.deleted ? 1 : 0) },
              { type: "integer", value: "" + (n.bookmarked ? 1 : 0) }
            ]
          }
        }));
        await runQuery(pushRequests);
        
        // Mark local as synced
        setNotes(prev => prev.map(n => unsynced.find(u => u.id === n.id) ? { ...n, isSynced: true } : n));
      }

      // 3. Pull latest changes from Turso
      const pullRes = await runQuery([{
        type: "execute",
        stmt: { sql: "SELECT * FROM notes", args: [] }
      }]);

      const remoteRows = pullRes.results[0].response.result.rows;
      const columns = pullRes.results[0].response.result.cols.map(c => c.name);
      
      const remoteNotes = remoteRows.map(row => {
        const note = {};
        columns.forEach((col, i) => {
          note[col] = row[i].value;
        });
        // Type casting from Turso API format
        return {
          id: note.id,
          title: note.title || '',
          content: note.content || '',
          updatedAt: parseInt(note.updatedAt, 10),
          deleted: parseInt(note.deleted, 10) === 1,
          bookmarked: parseInt(note.bookmarked, 10) === 1,
          isSynced: true
        };
      });

      // 4. Merge Logic (Last Write Wins based on updatedAt)
      setNotes(currentNotes => {
        const merged = [...currentNotes];
        remoteNotes.forEach(remoteNote => {
          const localIdx = merged.findIndex(n => n.id === remoteNote.id);
          if (localIdx > -1) {
            // Conflict resolution
            if (remoteNote.updatedAt > merged[localIdx].updatedAt) {
              merged[localIdx] = remoteNote;
            }
          } else {
            // New from remote
            merged.push(remoteNote);
          }
        });
        return merged;
      });

      setSyncStatus('idle');
    } catch (error) {
      console.error("Sync error:", error);
      setSyncStatus('error');
    }
  }, [notes, tursoConfig]);

  // Auto-sync periodically if configured
  useEffect(() => {
    if (!tursoConfig.url || !tursoConfig.token) return;
    
    // Initial sync
    syncWithTurso();

    // Set interval for auto-sync (every 30 seconds)
    const interval = setInterval(syncWithTurso, 30000);
    return () => clearInterval(interval);
  }, [tursoConfig.url, tursoConfig.token]); // Only run when config changes


  // --- Render ---
  return (
    <div className="flex h-screen w-full bg-[#f4f6f8] text-gray-900 font-sans overflow-hidden">
      
      {/* LEFT PANE: Note Index (Reduced to 28% width for better landscape balance) */}
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
          <button 
            onClick={handleCreateNote}
            className="bg-[#f05a30] text-white p-1.5 rounded-full shadow-sm hover:bg-[#d94d27] transition-all transform hover:scale-105"
            title="New Note (Ctrl+N)"
          >
            <Plus size={18} />
          </button>
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
              className="w-full bg-white text-xs pl-9 pr-4 py-2 rounded-xl border-none shadow-sm focus:ring-2 focus:ring-[#f05a30]/20 outline-none transition-all placeholder:text-gray-400"
            />
          </div>
        </div>

        {/* Note List */}
        <div className="flex-1 overflow-y-auto px-3 pb-6 space-y-2.5 custom-scrollbar">
          {activeNotes.length === 0 ? (
            <div className="text-center text-gray-400 mt-10 px-4">
              <p className="text-xs">No notes found.</p>
              <p className="text-[10px] mt-1 opacity-70">Press Ctrl+N to create one.</p>
            </div>
          ) : (
            activeNotes.map(note => (
              <div 
                key={note.id}
                onClick={() => setSelectedNoteId(note.id)}
                className={`group cursor-pointer rounded-xl p-3.5 transition-all duration-200 border
                  ${selectedNoteId === note.id 
                    ? 'bg-white shadow-[0_4px_12px_rgba(0,0,0,0.05)] border-transparent ring-1 ring-[#f05a30]/20' 
                    : 'bg-white/60 hover:bg-white hover:shadow-sm border-transparent'
                  }
                `}
              >
                <div className="flex justify-between items-start mb-0.5">
                  <h3 className={`font-serif font-semibold text-sm line-clamp-1 pr-2 
                    ${selectedNoteId === note.id ? 'text-gray-900' : 'text-gray-800'}`}>
                    {note.title || 'Untitled Note'}
                  </h3>
                  {note.bookmarked && (
                    <Bookmark size={14} className="text-[#f05a30] fill-[#f05a30] flex-shrink-0" />
                  )}
                </div>
                <p className="text-[12px] text-gray-500 line-clamp-2 leading-relaxed">
                  {note.content || 'No additional text...'}
                </p>
                <div className="mt-2 text-[10px] font-medium text-gray-400 flex justify-between items-center">
                  <span>{formatDate(note.updatedAt)}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* RIGHT PANE: Editor (Increased width) */}
      <div className="flex-1 flex flex-col h-full bg-[#fcfcfc]">
        {selectedNote ? (
          <>
            {/* Editor Header */}
            <div className="h-14 flex justify-between items-center px-8 border-b border-gray-100 bg-[#fcfcfc]/80 backdrop-blur-md">
              <div className="text-[12px] font-medium text-gray-400 flex items-center space-x-2">
                <span>{new Date(selectedNote.updatedAt).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</span>
                <span className="text-gray-300">•</span>
                <div className="flex items-center space-x-1" title="Sync Status">
                  {!tursoConfig.url ? <CloudOff size={13} className="text-gray-300"/> :
                   syncStatus === 'syncing' ? <RefreshCw size={13} className="text-blue-400 animate-spin"/> :
                   syncStatus === 'error' ? <CloudOff size={13} className="text-red-400"/> :
                   <Cloud size={13} className={selectedNote.isSynced ? "text-green-500" : "text-gray-400"} />
                  }
                </div>
              </div>

              <div className="flex items-center space-x-1">
                <button 
                  onClick={() => toggleBookmark(selectedNote.id)}
                  className={`p-2 rounded-lg transition-colors ${selectedNote.bookmarked ? 'text-[#f05a30] bg-orange-50' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'}`}
                  title="Bookmark"
                >
                  <Bookmark size={16} className={selectedNote.bookmarked ? "fill-[#f05a30]" : ""} />
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
                  className="w-full text-3xl font-serif font-bold text-gray-900 placeholder:text-gray-300 border-none outline-none bg-transparent mb-6 focus:ring-0 p-0"
                />
                <textarea
                  ref={contentInputRef}
                  value={selectedNote.content}
                  onChange={(e) => handleUpdateNote(selectedNote.id, { content: e.target.value })}
                  placeholder="Start typing your note here..."
                  className="w-full flex-1 text-[17px] text-gray-700 leading-relaxed placeholder:text-gray-300 border-none outline-none bg-transparent resize-none focus:ring-0 p-0"
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
            <p className="text-[11px] mt-2 opacity-60">Use Alt + Arrows to navigate.</p>
          </div>
        )}
      </div>

      {/* Settings Modal (Turso Config) */}
      {isSettingsOpen && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden transform transition-all">
            <div className="px-6 py-4 border-b border-gray-100 flex justify-between items-center">
              <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2">
                <Cloud size={18} className="text-[#f05a30]" />
                Sync Settings
              </h2>
              <button onClick={() => setIsSettingsOpen(false)} className="p-1.5 text-gray-400 hover:bg-gray-100 rounded-md">
                <X size={18} />
              </button>
            </div>
            <div className="p-6 space-y-5">
              <div className="text-sm text-gray-600 leading-relaxed bg-blue-50/50 p-4 rounded-xl border border-blue-100">
                Configure your <a href="https://turso.tech" target="_blank" rel="noreferrer" className="text-blue-600 font-semibold hover:underline">Turso SQLite</a> database to enable seamless cross-device syncing. Leaves these blank to use the app entirely offline.
              </div>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1.5">Database URL</label>
                  <input 
                    type="url" 
                    value={tursoConfig.url}
                    onChange={(e) => setTursoConfig({...tursoConfig, url: e.target.value})}
                    placeholder="https://your-db-name.turso.io"
                    className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-[#f05a30]/30 outline-none transition-all"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1.5">Auth Token</label>
                  <input 
                    type="password" 
                    value={tursoConfig.token}
                    onChange={(e) => setTursoConfig({...tursoConfig, token: e.target.value})}
                    placeholder="ey..."
                    className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-[#f05a30]/30 outline-none transition-all"
                  />
                </div>
              </div>
            </div>
            <div className="px-6 py-4 bg-gray-50 border-t border-gray-100 flex justify-end gap-3">
              <button 
                onClick={() => setIsSettingsOpen(false)}
                className="px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-200 rounded-lg transition-colors"
              >
                Close
              </button>
              <button 
                onClick={() => {
                  syncWithTurso();
                  setIsSettingsOpen(false);
                }}
                className="px-4 py-2 text-sm font-medium text-white bg-[#f05a30] hover:bg-[#d94d27] rounded-lg transition-colors shadow-sm"
              >
                Save & Sync
              </button>
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
              <p className="text-sm text-gray-500">
                Are you sure you want to delete this note? This action cannot be undone.
              </p>
            </div>
            <div className="px-6 py-4 bg-gray-50 border-t border-gray-100 flex justify-end gap-3">
              <button 
                onClick={() => setNoteToDelete(null)}
                className="px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-200 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={() => {
                  handleDeleteNote(noteToDelete);
                  setNoteToDelete(null);
                }}
                className="px-4 py-2 text-sm font-medium text-white bg-red-500 hover:bg-red-600 rounded-lg transition-colors shadow-sm"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Embedded Styles for custom scrollbar to keep it perfectly clean */}
      <style dangerouslySetInnerHTML={{__html: `
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background-color: rgba(0,0,0,0.1);
          border-radius: 10px;
        }
        .custom-scrollbar:hover::-webkit-scrollbar-thumb {
          background-color: rgba(0,0,0,0.2);
        }
      `}} />
    </div>
  );
}