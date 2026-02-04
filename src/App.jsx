import { useState, useRef, useEffect } from 'react';
import { Upload, Undo, Save, FolderOpen, Trash2, ArrowLeft, Edit2, Check, X, Camera } from 'lucide-react';

// API-based storage
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

const storage = {
  async get(key) {
    const [type, id] = key.split(':');
    try {
      const response = await fetch(`${API_URL}/${type}s/${id}`);
      if (!response.ok) return null;
      const data = await response.json();
      return { key, value: JSON.stringify(data) };
    } catch (error) {
      console.error('Get error:', error);
      return null;
    }
  },

  async set(key, value) {
    const [type, id] = key.split(':');
    const data = JSON.parse(value);
    try {
      // Check if exists first
      const existing = await fetch(`${API_URL}/${type}s/${id}`);
      const method = existing.ok ? 'PUT' : 'POST';
      const url = existing.ok ? `${API_URL}/${type}s/${id}` : `${API_URL}/${type}s`;

      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...data })
      });

      return { key, value };
    } catch (error) {
      console.error('Set error:', error);
      return null;
    }
  },

  async delete(key) {
    const [type, id] = key.split(':');
    try {
      await fetch(`${API_URL}/${type}s/${id}`, { method: 'DELETE' });
      return { key, deleted: true };
    } catch (error) {
      console.error('Delete error:', error);
      return null;
    }
  },

  async list(prefix) {
    const type = prefix.replace(':', '');
    try {
      const response = await fetch(`${API_URL}/${type}s`);
      const data = await response.json();
      const keys = data.map(item => `${type}:${item.id}`);
      return { keys };
    } catch (error) {
      console.error('List error:', error);
      return { keys: [] };
    }
  }
};

if (typeof window !== 'undefined') {
  window.storage = storage;
}

export default function ClimbingRouteDesigner() {
  const [image, setImage] = useState(null);
  const [currentWallId, setCurrentWallId] = useState(null);
  const [currentWallName, setCurrentWallName] = useState('');
  const [editingWallName, setEditingWallName] = useState(false);
  const [tempWallName, setTempWallName] = useState('');
  const [holds, setHolds] = useState([]);
  const [selectedType, setSelectedType] = useState('start');
  const [lastTap, setLastTap] = useState({ index: null, time: 0 });
  const [routeName, setRouteName] = useState('');
  const [setterName, setSetterName] = useState('');
  const [routeGrade, setRouteGrade] = useState('V0');
  const [routeNotes, setRouteNotes] = useState('');
  const [footRule, setFootRule] = useState('marked');
  const [currentRouteId, setCurrentRouteId] = useState(null);
  const [walls, setWalls] = useState([]);
  const [routes, setRoutes] = useState([]);
  const [showWallLibrary, setShowWallLibrary] = useState(false);
  const [showRouteLibrary, setShowRouteLibrary] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [mode, setMode] = useState('choose'); // 'choose', 'view', 'create'
  const imageRef = useRef(null);
  const fileInputRef = useRef(null);

  const holdTypes = {
    start: { color: 'bg-green-400', border: 'border-green-300', label: 'Start', glow: 'bg-green-400' },
    hand: { color: 'bg-blue-400', border: 'border-blue-300', label: 'Hand', glow: 'bg-blue-400' },
    foot: { color: 'bg-purple-400', border: 'border-purple-300', label: 'Foot', glow: 'bg-purple-400' },
    finish: { color: 'bg-red-400', border: 'border-red-300', label: 'Finish', glow: 'bg-red-400' }
  };

  const vGrades = Array.from({ length: 18 }, (_, i) => `V${i}`);

  useEffect(() => {
    loadWalls();
    loadRoutes();
  }, []);

  const loadWalls = async () => {
    try {
      const result = await window.storage.list('wall:');
      if (result && result.keys) {
        const wallData = [];
        for (const key of result.keys) {
          const data = await window.storage.get(key);
          if (data && data.value) {
            const wall = JSON.parse(data.value);
            wallData.push({ id: key.replace('wall:', ''), ...wall });
          }
        }
        setWalls(wallData.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
      }
    } catch (error) {
      setWalls([]);
    }
  };

  const loadRoutes = async () => {
    try {
      const result = await window.storage.list('route:');
      if (result && result.keys) {
        const routeData = [];
        for (const key of result.keys) {
          const data = await window.storage.get(key);
          if (data && data.value) {
            const route = JSON.parse(data.value);
            routeData.push({ id: key.replace('route:', ''), ...route });
          }
        }
        setRoutes(routeData.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)));
      }
    } catch (error) {
      setRoutes([]);
    }
  };

  const handleImageUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        setImage(event.target.result);
        setCurrentWallName(file.name.replace(/\.[^/.]+$/, ''));
        setHolds([]);
        setCurrentWallId(`${Date.now()}`);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleSaveWall = async () => {
    if (!image || !currentWallId) return;
    const wallData = { image, name: currentWallName || 'Unnamed Wall', createdAt: new Date().toISOString() };
    try {
      await window.storage.set(`wall:${currentWallId}`, JSON.stringify(wallData));
      if (!walls.find(w => w.id === currentWallId)) {
        setWalls([{ id: currentWallId, ...wallData }, ...walls]);
      }
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const handleImageClick = (e) => {
    if (!image) return;
    const rect = imageRef.current.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const xPercent = (x / rect.width) * 100;
    const yPercent = (y / rect.height) * 100;

    let closestHoldIndex = -1;
    let closestDistance = 3;
    holds.forEach((hold, index) => {
      const dx = Math.abs(hold.x - xPercent);
      const dy = Math.abs(hold.y - yPercent);
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestHoldIndex = index;
      }
    });

    const now = Date.now();
    if (closestHoldIndex !== -1) {
      if (lastTap.index === closestHoldIndex && now - lastTap.time < 500) {
        setHolds(holds.filter((_, i) => i !== closestHoldIndex));
        setLastTap({ index: null, time: 0 });
      } else {
        setLastTap({ index: closestHoldIndex, time: now });
        setTimeout(() => {
          setLastTap(prev => {
            if (prev.index === closestHoldIndex && prev.time === now) {
              setHolds(h => [...h, { x: xPercent, y: yPercent, type: selectedType }]);
              return { index: null, time: 0 };
            }
            return prev;
          });
        }, 500);
      }
    } else {
      setHolds([...holds, { x: xPercent, y: yPercent, type: selectedType }]);
      setLastTap({ index: null, time: 0 });
    }
  };

  const handleClear = () => {
    setHolds([]);
    setRouteName('');
    setSetterName('');
    setRouteGrade('V0');
    setRouteNotes('');
    setFootRule('marked');
    setSelectedType('start');
    setCurrentRouteId(null);
  };

  const handleUndo = () => {
    if (holds.length > 0) setHolds(holds.slice(0, -1));
  };

  const handleReset = () => {
    setImage(null);
    setCurrentWallId(null);
    setCurrentWallName('');
    setEditingWallName(false);
    setTempWallName('');
    setHolds([]);
    setRouteName('');
    setSetterName('');
    setRouteGrade('V0');
    setRouteNotes('');
    setFootRule('marked');
    setCurrentRouteId(null);
    setMode('choose');
  };

  const handleSaveRoute = async () => {
    if (!currentWallId) return;
    await handleSaveWall();
    const routeData = {
      name: routeName || 'Untitled Route',
      setter: setterName,
      grade: routeGrade,
      notes: routeNotes,
      footRule,
      holds,
      wallId: currentWallId,
      createdAt: currentRouteId ? routes.find(r => r.id === currentRouteId)?.createdAt : new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    try {
      const routeId = currentRouteId || `${Date.now()}`;
      await window.storage.set(`route:${routeId}`, JSON.stringify(routeData));
      const updatedRoute = { id: routeId, ...routeData };
      if (currentRouteId) {
        setRoutes(routes.map(r => r.id === routeId ? updatedRoute : r));
      } else {
        setRoutes([updatedRoute, ...routes]);
      }
      setCurrentRouteId(routeId);
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const handleLoadWall = async (wallId) => {
    try {
      const result = await window.storage.get(`wall:${wallId}`);
      if (result && result.value) {
        const wallData = JSON.parse(result.value);
        setImage(wallData.image);
        setCurrentWallId(wallId);
        setCurrentWallName(wallData.name);
        setHolds([]);
        setRouteName('');
        setSetterName('');
        setRouteGrade('V0');
        setRouteNotes('');
        setFootRule('marked');
        setCurrentRouteId(null);
        setShowWallLibrary(false);
        setMode('choose');
      }
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const handleLoadRoute = async (routeId) => {
    try {
      const result = await window.storage.get(`route:${routeId}`);
      if (result && result.value) {
        const routeData = JSON.parse(result.value);
        if (routeData.wallId !== currentWallId) {
          const wallResult = await window.storage.get(`wall:${routeData.wallId}`);
          if (wallResult && wallResult.value) {
            const wallData = JSON.parse(wallResult.value);
            setImage(wallData.image);
            setCurrentWallName(wallData.name);
          }
          setCurrentWallId(routeData.wallId);
        }
        setRouteName(routeData.name || '');
        setSetterName(routeData.setter || '');
        setRouteGrade(routeData.grade || 'V0');
        setRouteNotes(routeData.notes || '');
        setFootRule(routeData.footRule || 'marked');
        setHolds(routeData.holds || []);
        setCurrentRouteId(routeId);
        setShowRouteLibrary(false);
        // Set mode based on current mode - if already in create mode, stay there
        if (mode !== 'create') {
          setMode('view');
        }
      }
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const handleEditWallName = () => {
    setTempWallName(currentWallName);
    setEditingWallName(true);
  };

  const handleSaveWallName = async () => {
    if (tempWallName.trim()) {
      setCurrentWallName(tempWallName.trim());
      setEditingWallName(false);
      if (currentWallId) {
        try {
          const result = await window.storage.get(`wall:${currentWallId}`);
          if (result && result.value) {
            const wallData = JSON.parse(result.value);
            wallData.name = tempWallName.trim();
            await window.storage.set(`wall:${currentWallId}`, JSON.stringify(wallData));
            setWalls(walls.map(w => w.id === currentWallId ? { ...w, name: tempWallName.trim() } : w));
          }
        } catch (error) {
          console.error('Error:', error);
        }
      }
    }
  };

  const handleCancelEditWallName = () => {
    setEditingWallName(false);
    setTempWallName('');
  };

  const requestDeleteWall = (wallId) => {
    const wallRoutes = routes.filter(r => r.wallId === wallId);
    const message = wallRoutes.length > 0 ? `Delete wall and ${wallRoutes.length} routes?` : 'Delete this wall?';
    setConfirmDelete({ type: 'wall', id: wallId, message });
  };

  const requestDeleteRoute = (routeId) => {
    setConfirmDelete({ type: 'route', id: routeId, message: 'Delete this route?' });
  };

  const confirmDeleteAction = async () => {
    if (!confirmDelete) return;
    try {
      if (confirmDelete.type === 'wall') {
        await window.storage.delete(`wall:${confirmDelete.id}`);
        const wallRoutes = routes.filter(r => r.wallId === confirmDelete.id);
        for (const route of wallRoutes) await window.storage.delete(`route:${route.id}`);
        setWalls(walls.filter(w => w.id !== confirmDelete.id));
        setRoutes(routes.filter(r => r.wallId !== confirmDelete.id));
        if (currentWallId === confirmDelete.id) handleReset();
      } else {
        await window.storage.delete(`route:${confirmDelete.id}`);
        setRoutes(routes.filter(r => r.id !== confirmDelete.id));
        if (currentRouteId === confirmDelete.id) handleClear();
      }
      setConfirmDelete(null);
    } catch (error) {
      console.error('Error:', error);
      setConfirmDelete(null);
    }
  };

  const getHoldCount = (type) => holds.filter(h => h.type === type).length;
  const getRoutesForWall = (wallId) => routes.filter(r => r.wallId === wallId);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 p-4">
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-6">
          <h1 className="text-3xl font-bold text-white mb-2">🧗 Spray</h1>
          <p className="text-slate-300">Design, save, and manage your climbing routes</p>
        </div>

        {showWallLibrary && (
          <div className="fixed inset-0 bg-black bg-opacity-75 z-50 flex items-center justify-center p-4">
            <div className="bg-slate-800 rounded-lg max-w-2xl w-full flex flex-col" style={{ maxHeight: '85vh', height: '85vh' }}>
              <div className="p-6 border-b border-slate-700">
                <div className="flex justify-between items-center">
                  <h2 className="text-2xl font-bold text-white">Wall Library</h2>
                  <button onClick={() => setShowWallLibrary(false)} className="text-slate-400 hover:text-white text-2xl">×</button>
                </div>
              </div>
              <div className="flex-1 p-6 overflow-y-auto">
                {walls.length === 0 ? <p className="text-slate-400 text-center py-8">No walls yet.</p> : (
                  <div className="space-y-3">
                    {walls.map((wall) => (
                      <div key={wall.id} className="bg-slate-700 rounded-lg p-4 hover:bg-slate-600">
                        <div className="flex gap-4">
                          <img src={wall.image} alt="Wall" className="w-24 h-24 object-cover rounded cursor-pointer" onClick={() => handleLoadWall(wall.id)} />
                          <div className="flex-1 cursor-pointer" onClick={() => handleLoadWall(wall.id)}>
                            <h3 className="text-white font-semibold">{wall.name}</h3>
                            <p className="text-slate-300 text-sm">{getRoutesForWall(wall.id).length} routes</p>
                          </div>
                          <div className="text-red-400 hover:bg-red-900 p-3 cursor-pointer rounded" onClick={() => requestDeleteWall(wall.id)}>
                            <Trash2 size={20} />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {showRouteLibrary && (
          <div className="fixed inset-0 bg-black bg-opacity-75 z-50 flex items-center justify-center p-4">
            <div className="bg-slate-800 rounded-lg max-w-2xl w-full flex flex-col" style={{ maxHeight: '85vh', height: '85vh' }}>
              <div className="p-6 border-b border-slate-700">
                <div className="flex justify-between items-center">
                  <h2 className="text-2xl font-bold text-white">Routes</h2>
                  <button onClick={() => setShowRouteLibrary(false)} className="text-slate-400 hover:text-white text-2xl">×</button>
                </div>
              </div>
              <div className="flex-1 p-6 overflow-y-auto">
                {getRoutesForWall(currentWallId).length === 0 ? <p className="text-slate-400 text-center py-8">No routes yet.</p> : (
                  <div className="space-y-3">
                    {getRoutesForWall(currentWallId).sort((a, b) => parseInt(a.grade.replace('V', '')) - parseInt(b.grade.replace('V', ''))).map((route) => (
                      <div key={route.id} className="bg-slate-700 rounded-lg p-4 hover:bg-slate-600">
                        <div className="flex justify-between items-center gap-3">
                          <div className="flex items-center gap-3 flex-1 cursor-pointer" onClick={() => handleLoadRoute(route.id)}>
                            <span className="text-slate-300 font-semibold">{route.grade}</span>
                            <h3 className="text-white font-semibold truncate">{route.name}</h3>
                          </div>
                          <div className="text-red-400 hover:bg-red-900 p-3 cursor-pointer rounded" onClick={() => requestDeleteRoute(route.id)}>
                            <Trash2 size={20} />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {!image ? (
          <div className="bg-slate-800 rounded-lg p-8 text-center space-y-4">
            <input ref={fileInputRef} type="file" accept="image/*" onChange={handleImageUpload} className="hidden" />
            {walls.length > 0 && (
              <button onClick={() => setShowWallLibrary(true)} className="w-full bg-purple-600 hover:bg-purple-700 text-white font-semibold py-4 px-6 rounded-lg flex items-center justify-center gap-2">
                <Upload size={20} /> Load Wall ({walls.length})
              </button>
            )}
            {walls.length > 0 && <div className="text-slate-400">or</div>}
            <button onClick={() => fileInputRef.current.click()} className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-4 px-6 rounded-lg flex items-center justify-center gap-2">
              <Upload size={20} /> Upload Wall Photo
            </button>
          </div>
        ) : (
          <>
            {mode === 'choose' ? (
              <>
                <div className="text-center mb-4">
                  {editingWallName ? (
                    <div className="flex items-center justify-center gap-2">
                      <input
                        type="text"
                        value={tempWallName}
                        onChange={(e) => setTempWallName(e.target.value)}
                        className="text-2xl font-bold text-white bg-slate-700 px-3 py-1 rounded border border-slate-600 focus:border-blue-400 focus:outline-none text-center"
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleSaveWallName();
                          if (e.key === 'Escape') handleCancelEditWallName();
                        }}
                      />
                      <button onClick={handleSaveWallName} className="text-green-400 hover:text-green-300">
                        <Check size={24} />
                      </button>
                      <button onClick={handleCancelEditWallName} className="text-red-400 hover:text-red-300">
                        <X size={24} />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-center gap-2">
                      <h2 className="text-2xl font-bold text-white">{currentWallName || 'Unnamed Wall'}</h2>
                      <button onClick={handleEditWallName} className="text-slate-400 hover:text-slate-300">
                        <Edit2 size={18} />
                      </button>
                    </div>
                  )}
                </div>

                <button onClick={handleReset} className="w-full bg-slate-700 hover:bg-slate-600 text-white font-semibold py-3 px-4 rounded-lg flex items-center justify-center gap-2 mb-4">
                  <ArrowLeft size={18} /> Change Wall
                </button>

                <div className="grid grid-cols-2 gap-3 mb-4">
                  <button onClick={() => setShowRouteLibrary(true)} className="bg-purple-600 hover:bg-purple-700 text-white font-semibold py-4 px-4 rounded-lg flex items-center justify-center gap-2">
                    <FolderOpen size={20} /> Choose a Route
                  </button>
                  <button onClick={() => { setMode('create'); setHolds([]); setRouteName(''); setSetterName(''); setRouteGrade('V0'); setRouteNotes(''); setFootRule('marked'); setCurrentRouteId(null); setSelectedType('start'); }} className="bg-blue-600 hover:bg-blue-700 text-white font-semibold py-4 px-4 rounded-lg flex items-center justify-center gap-2">
                    <Upload size={20} /> Create/Edit a Route
                  </button>
                </div>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={(e) => {
                    const file = e.target.files[0];
                    if (file) {
                      const reader = new FileReader();
                      reader.onload = async (event) => {
                        setImage(event.target.result);
                        // Save the updated image to the existing wall
                        if (currentWallId) {
                          const wallData = {
                            image: event.target.result,
                            name: currentWallName,
                            createdAt: walls.find(w => w.id === currentWallId)?.createdAt || new Date().toISOString()
                          };
                          try {
                            await window.storage.set(`wall:${currentWallId}`, JSON.stringify(wallData));
                            setWalls(walls.map(w => w.id === currentWallId ? { ...w, ...wallData } : w));
                          } catch (error) {
                            console.error('Error updating wall image:', error);
                          }
                        }
                      };
                      reader.readAsDataURL(file);
                    }
                  }}
                  className="hidden"
                />

                <div className="relative bg-slate-800 rounded-lg overflow-hidden shadow-2xl">
                  <img src={image} alt="Wall" className="w-full h-auto" />
                  <button
                    onClick={() => fileInputRef.current.click()}
                    className="absolute top-4 right-4 bg-slate-700 hover:bg-slate-600 text-white p-3 rounded-lg shadow-lg transition-colors"
                  >
                    <Camera size={20} />
                  </button>
                </div>
              </>
            ) : mode === 'view' ? (
              <>
                <div className="text-center mb-4">
                  <h2 className="text-2xl font-bold text-white">{currentWallName || 'Unnamed Wall'}</h2>
                </div>

                <div className="grid grid-cols-2 gap-3 mb-4">
                  <button onClick={() => { setMode('choose'); setHolds([]); setCurrentRouteId(null); }} className="bg-slate-700 hover:bg-slate-600 text-white font-semibold py-3 px-4 rounded-lg flex items-center justify-center gap-2">
                    <ArrowLeft size={18} /> Back to Wall
                  </button>
                  <button onClick={() => setShowRouteLibrary(true)} className="bg-purple-600 hover:bg-purple-700 text-white font-semibold py-3 px-4 rounded-lg flex items-center justify-center gap-2">
                    <FolderOpen size={18} /> Different Route
                  </button>
                </div>

                <div className="bg-slate-800 rounded-lg p-4 mb-4">
                  <h3 className="text-white font-semibold mb-3">Route Details</h3>
                  <div className="space-y-2 text-slate-300">
                    <div><span className="font-semibold">Name:</span> {routeName || 'Untitled'}</div>
                    {setterName && <div><span className="font-semibold">Setter:</span> {setterName}</div>}
                    <div><span className="font-semibold">Grade:</span> {routeGrade}</div>
                    <div><span className="font-semibold">Foot Rule:</span> {footRule === 'marked' ? 'Marked Holds' : 'Any Feet'}</div>
                    {routeNotes && <div><span className="font-semibold">Notes:</span> {routeNotes}</div>}
                  </div>
                </div>

                <div className="bg-slate-800 rounded-lg p-4 mb-4">
                  <h3 className="text-white font-semibold mb-3">Hold Legend</h3>
                  <div className="grid grid-cols-2 gap-2">
                    {Object.entries(holdTypes).map(([type, config]) => (
                      <div key={type} className="flex items-center gap-2">
                        <div className={`w-4 h-4 rounded-full ${config.color} ${config.border} border-2`}></div>
                        <span className="text-slate-300 text-sm">{config.label} ({getHoldCount(type)})</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="relative bg-slate-800 rounded-lg overflow-hidden shadow-2xl">
                  <img src={image} alt="Wall" className="w-full h-auto" />
                  {holds.map((hold, i) => {
                    const config = holdTypes[hold.type];
                    return (
                      <div key={i} className="absolute pointer-events-none" style={{ left: `${hold.x}%`, top: `${hold.y}%` }}>
                        <div className={`absolute w-6 h-6 -ml-3 -mt-3 ${config.glow} rounded-full opacity-20 animate-pulse`}></div>
                        <div className={`absolute w-5 h-5 -ml-2.5 -mt-2.5 ${config.border} border-2 rounded-full bg-transparent`}></div>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <>
                <div className="text-center mb-4">
                  {editingWallName ? (
                    <div className="flex items-center justify-center gap-2">
                      <input type="text" value={tempWallName} onChange={(e) => setTempWallName(e.target.value)} className="text-2xl font-bold text-white bg-slate-700 px-3 py-1 rounded text-center" autoFocus onKeyDown={(e) => { if (e.key === 'Enter') handleSaveWallName(); if (e.key === 'Escape') { setEditingWallName(false); setTempWallName(''); } }} />
                      <button onClick={handleSaveWallName} className="text-green-400"><Check size={24} /></button>
                      <button onClick={() => { setEditingWallName(false); setTempWallName(''); }} className="text-red-400"><X size={24} /></button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-center gap-2">
                      <h2 className="text-2xl font-bold text-white">{currentWallName || 'Unnamed Wall'}</h2>
                      <button onClick={handleEditWallName} className="text-slate-400"><Edit2 size={18} /></button>
                    </div>
                  )}
                </div>

                <button onClick={() => { setMode('choose'); setHolds([]); setRouteName(''); setSetterName(''); setRouteGrade('V0'); setRouteNotes(''); setFootRule('marked'); setCurrentRouteId(null); }} className="w-full bg-slate-700 hover:bg-slate-600 text-white font-semibold py-3 px-4 rounded-lg flex items-center justify-center gap-2 mb-4">
                  <ArrowLeft size={18} /> Back to Wall
                </button>

                <div className="bg-slate-800 rounded-lg p-4 mb-4">
                  <div className="flex justify-between items-center mb-3">
                    <h3 className="text-white font-semibold">Route Details</h3>
                    {currentRouteId && <span className="text-green-400 text-sm">● Saved</span>}
                  </div>
                  <div className="space-y-3">
                    <input type="text" value={routeName} onChange={(e) => setRouteName(e.target.value)} placeholder="Route Name" className="w-full px-3 py-2 bg-slate-700 text-white rounded-lg" />
                    <input type="text" value={setterName} onChange={(e) => setSetterName(e.target.value)} placeholder="Setter Name" className="w-full px-3 py-2 bg-slate-700 text-white rounded-lg" />
                    <select value={routeGrade} onChange={(e) => setRouteGrade(e.target.value)} className="w-full px-3 py-2 bg-slate-700 text-white rounded-lg">
                      {vGrades.map(g => <option key={g} value={g}>{g}</option>)}
                    </select>
                    <div>
                      <label className="block text-slate-300 text-sm mb-2">Foot Rule</label>
                      <div className="space-y-2">
                        <label className="flex items-center gap-2">
                          <input type="checkbox" checked={footRule === 'marked'} onChange={() => setFootRule('marked')} className="w-4 h-4" />
                          <span className="text-slate-300 text-sm">Marked Holds</span>
                        </label>
                        <label className="flex items-center gap-2">
                          <input type="checkbox" checked={footRule === 'any'} onChange={() => setFootRule('any')} className="w-4 h-4" />
                          <span className="text-slate-300 text-sm">Any Feet</span>
                        </label>
                      </div>
                    </div>
                    <textarea value={routeNotes} onChange={(e) => setRouteNotes(e.target.value)} placeholder="Notes" rows="3" className="w-full px-3 py-2 bg-slate-700 text-white rounded-lg resize-none" />
                  </div>
                </div>

                <div className="bg-slate-800 rounded-lg p-4 mb-4">
                  <h3 className="text-white font-semibold mb-3">Select Hold Type</h3>
                  <div className="grid grid-cols-2 gap-2">
                    {Object.entries(holdTypes).map(([type, config]) => (
                      <button key={type} onClick={() => setSelectedType(type)} className={`py-3 px-4 rounded-lg font-semibold ${selectedType === type ? `${config.color} text-slate-900` : 'bg-slate-700 text-slate-300'}`}>
                        {config.label} {getHoldCount(type) > 0 && `(${getHoldCount(type)})`}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 mb-4">
                  <button onClick={handleUndo} disabled={holds.length === 0} className="bg-yellow-600 hover:bg-yellow-700 disabled:bg-slate-600 text-white font-semibold py-3 px-4 rounded-lg flex items-center justify-center gap-2">
                    <Undo size={18} /> Undo
                  </button>
                  <button onClick={handleClear} className="bg-orange-600 hover:bg-orange-700 text-white font-semibold py-3 px-4 rounded-lg">Clear ({holds.length})</button>
                  <button onClick={handleSaveRoute} className="bg-green-600 hover:bg-green-700 text-white font-semibold py-3 px-4 rounded-lg flex items-center justify-center gap-2">
                    <Save size={18} /> Save
                  </button>
                  <button onClick={() => setShowRouteLibrary(true)} className="bg-purple-600 hover:bg-purple-700 text-white font-semibold py-3 px-4 rounded-lg flex items-center justify-center gap-2">
                    <FolderOpen size={18} /> Routes ({getRoutesForWall(currentWallId).length})
                  </button>
                </div>

                <div className="relative bg-slate-800 rounded-lg overflow-hidden shadow-2xl">
                  <img ref={imageRef} src={image} alt="Wall" className="w-full h-auto cursor-crosshair" onClick={handleImageClick} />
                  {holds.map((hold, i) => {
                    const config = holdTypes[hold.type];
                    return (
                      <div key={i} className="absolute pointer-events-none" style={{ left: `${hold.x}%`, top: `${hold.y}%` }}>
                        <div className={`absolute w-6 h-6 -ml-3 -mt-3 ${config.glow} rounded-full opacity-20 animate-pulse`}></div>
                        <div className={`absolute w-5 h-5 -ml-2.5 -mt-2.5 ${config.border} border-2 rounded-full bg-transparent`}></div>
                      </div>
                    );
                  })}
                </div>

                <div className="mt-4 bg-slate-800 rounded-lg p-4">
                  <p className="text-slate-300 text-sm">Tap to add holds • Double-tap holds to delete</p>
                </div>
              </>
            )}
          </>
        )}
      </div>

      {confirmDelete && (
        <div className="fixed inset-0 bg-black bg-opacity-75 z-[100] flex items-center justify-center p-4">
          <div className="bg-slate-800 rounded-lg max-w-md w-full p-6">
            <h3 className="text-xl font-bold text-white mb-4">Confirm Delete</h3>
            <p className="text-slate-300 mb-6">{confirmDelete.message}</p>
            <div className="flex gap-3">
              <button onClick={() => setConfirmDelete(null)} className="flex-1 bg-slate-700 hover:bg-slate-600 text-white font-semibold py-3 px-4 rounded-lg">Cancel</button>
              <button onClick={confirmDeleteAction} className="flex-1 bg-red-600 hover:bg-red-700 text-white font-semibold py-3 px-4 rounded-lg">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
