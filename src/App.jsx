import { useState, useRef, useEffect } from 'react';
import { Upload, Undo, Save, FolderOpen, Trash2, ArrowLeft, Edit2, Check, X, Camera, Info } from 'lucide-react';

// API-based storage
const API_URL = '/api';

// Read persisted UI state from sessionStorage (returns null if nothing saved yet)
function getSavedState() {
  try {
    const saved = sessionStorage.getItem('sprayAppState');
    return saved ? JSON.parse(saved) : null;
  } catch {
    return null;
  }
}

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

// ─── Perspective De-warp Editor ───────────────────────────────────────────────
function WallEditor({ src, onConfirm, onCancel }) {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const [imgSize, setImgSize] = useState({ w: 1, h: 1 });
  // Corners in image-pixel space: TL, TR, BR, BL
  const [corners, setCorners] = useState(null);
  const [dragging, setDragging] = useState(null); // index 0-3
  const [previewUrl, setPreviewUrl] = useState(null);
  const [isPreviewing, setIsPreviewing] = useState(false);

  // Load the image and initialise corners
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      setImgSize({ w, h });
      setCorners([
        { x: 0, y: 0 },
        { x: w, y: 0 },
        { x: w, y: h },
        { x: 0, y: h },
      ]);
    };
    img.src = src;
  }, [src]);

  // Map image-pixel coords → CSS % inside the container
  const toCss = (pt) => ({
    left: `${(pt.x / imgSize.w) * 100}%`,
    top: `${(pt.y / imgSize.h) * 100}%`,
  });

  const getEventPt = (e) => {
    const rect = containerRef.current.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: Math.max(0, Math.min(imgSize.w, ((clientX - rect.left) / rect.width) * imgSize.w)),
      y: Math.max(0, Math.min(imgSize.h, ((clientY - rect.top) / rect.height) * imgSize.h)),
    };
  };

  const onPointerDown = (i, e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(i);
  };
  const onPointerMove = (e) => {
    if (dragging === null) return;
    e.preventDefault();
    const pt = getEventPt(e);
    setCorners(c => c.map((corner, i) => i === dragging ? pt : corner));
  };
  const onPointerUp = () => setDragging(null);

  // ── Homography helper ───────────────────────────────────────────────────────
  // Solves for the 3×3 homography H mapping src quad → dst rect using DLT.
  function computeHomography(srcPts, dstPts) {
    // Build 8×8 system Ah = b (we normalise h[8]=1)
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [sx, sy] = [srcPts[i].x, srcPts[i].y];
      const [dx, dy] = [dstPts[i].x, dstPts[i].y];
      A.push([-sx, -sy, -1, 0, 0, 0, sx * dx, sy * dx]);
      b.push(-dx);
      A.push([0, 0, 0, -sx, -sy, -1, sx * dy, sy * dy]);
      b.push(-dy);
    }
    // Gaussian elimination
    const n = 8;
    const aug = A.map((row, i) => [...row, b[i]]);
    for (let col = 0; col < n; col++) {
      let maxRow = col;
      for (let row = col + 1; row < n; row++)
        if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) maxRow = row;
      [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
      for (let row = col + 1; row < n; row++) {
        const f = aug[row][col] / aug[col][col];
        for (let k = col; k <= n; k++) aug[row][k] -= f * aug[col][k];
      }
    }
    const h = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
      h[i] = aug[i][n];
      for (let j = i + 1; j < n; j++) h[i] -= aug[i][j] * h[j];
      h[i] /= aug[i][i];
    }
    return [...h, 1]; // 9 elements, row-major
  }

  function applyH(H, x, y) {
    const w = H[6] * x + H[7] * y + H[8];
    return {
      x: (H[0] * x + H[1] * y + H[2]) / w,
      y: (H[3] * x + H[4] * y + H[5]) / w
    };
  }

  // ── Warp & return ──────────────────────────────────────────────────────────
  const doWarp = (forPreview = false) => {
    const img = new Image();
    img.onload = () => {
      // Output size = bounding box of the dragged quad
      const xs = corners.map(c => c.x), ys = corners.map(c => c.y);
      const outW = Math.round(Math.max(...xs) - Math.min(...xs));
      const outH = Math.round(Math.max(...ys) - Math.min(...ys));

      // dst: the clean output rectangle (inverse warp iterates over these pixels)
      // src: the dragged corners in image-pixel space
      // H maps each output pixel → source pixel
      const rect = [
        { x: 0, y: 0 },
        { x: outW, y: 0 },
        { x: outW, y: outH },
        { x: 0, y: outH },
      ];

      // H maps rect pixels → corners (inverse warp: for each dst pixel, find src pixel)
      const H = computeHomography(rect, corners);

      const canvas = canvasRef.current;
      // Draw source image on a full-size offscreen canvas for pixel sampling
      const srcCanvas = document.createElement('canvas');
      srcCanvas.width = imgSize.w;
      srcCanvas.height = imgSize.h;
      const srcCtx = srcCanvas.getContext('2d');
      srcCtx.drawImage(img, 0, 0);
      const srcData = srcCtx.getImageData(0, 0, imgSize.w, imgSize.h);

      // Set output canvas size and get context
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext('2d');

      // Write warped pixels to destination
      const dstData = ctx.createImageData(outW, outH);
      for (let dy = 0; dy < outH; dy++) {
        for (let dx = 0; dx < outW; dx++) {
          const sp = applyH(H, dx, dy);
          const sx = Math.round(sp.x), sy = Math.round(sp.y);
          if (sx < 0 || sy < 0 || sx >= imgSize.w || sy >= imgSize.h) continue;
          const si = (sy * imgSize.w + sx) * 4;
          const di = (dy * outW + dx) * 4;
          dstData.data[di] = srcData.data[si];
          dstData.data[di + 1] = srcData.data[si + 1];
          dstData.data[di + 2] = srcData.data[si + 2];
          dstData.data[di + 3] = srcData.data[si + 3];
        }
      }

      ctx.putImageData(dstData, 0, 0);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
      if (forPreview) { setPreviewUrl(dataUrl); setIsPreviewing(true); }
      else onConfirm(dataUrl);
    };
    img.src = src;
  };

  const cornerLabels = ['TL', 'TR', 'BR', 'BL'];
  const cornerColors = ['#22c55e', '#3b82f6', '#f97316', '#a855f7'];

  return (
    <div className="fixed inset-0 bg-black bg-opacity-90 z-[200] flex flex-col items-center justify-start overflow-y-auto p-4">
      <div className="w-full max-w-2xl">
        <h2 className="text-white text-xl font-bold text-center mb-1">Straighten Wall</h2>
        <p className="text-slate-400 text-sm text-center mb-4">
          Drag the four corner handles to match the corners of your climbing wall, then tap <strong className="text-white">Apply</strong>.
        </p>

        {isPreviewing && previewUrl ? (
          <div className="space-y-4">
            <img src={previewUrl} alt="Preview" className="w-full rounded-lg" />
            <div className="grid grid-cols-2 gap-3">
              <button onClick={() => setIsPreviewing(false)} className="bg-slate-700 hover:bg-slate-600 text-white font-semibold py-3 rounded-lg">← Re-adjust</button>
              <button onClick={() => onConfirm(previewUrl)} className="bg-green-600 hover:bg-green-700 text-white font-semibold py-3 rounded-lg">Use This ✓</button>
            </div>
          </div>
        ) : (
          <>
            <div
              ref={containerRef}
              className="relative select-none touch-none"
              onMouseMove={onPointerMove}
              onMouseUp={onPointerUp}
              onTouchMove={onPointerMove}
              onTouchEnd={onPointerUp}
              style={{ cursor: dragging !== null ? 'none' : 'default' }}
            >
              <img src={src} alt="Wall" className="w-full h-auto rounded-lg block" draggable={false} />

              {/* Quad outline */}
              {corners && (
                <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox={`0 0 ${imgSize.w} ${imgSize.h}`} preserveAspectRatio="none">
                  <polygon
                    points={corners.map(c => `${c.x},${c.y}`).join(' ')}
                    fill="rgba(59,130,246,0.15)"
                    stroke="#3b82f6"
                    strokeWidth={Math.max(2, imgSize.w * 0.004)}
                    strokeDasharray={`${imgSize.w * 0.015} ${imgSize.w * 0.008}`}
                  />
                </svg>
              )}

              {/* Corner handles */}
              {corners && corners.map((c, i) => (
                <div
                  key={i}
                  onMouseDown={(e) => onPointerDown(i, e)}
                  onTouchStart={(e) => onPointerDown(i, e)}
                  className="absolute flex items-center justify-center rounded-full font-bold text-white text-xs shadow-lg"
                  style={{
                    left: toCss(c).left,
                    top: toCss(c).top,
                    transform: 'translate(-50%, -50%)',
                    width: 36, height: 36,
                    background: cornerColors[i],
                    border: '3px solid white',
                    cursor: 'grab',
                    touchAction: 'none',
                    zIndex: 10,
                    boxShadow: dragging === i ? `0 0 0 4px ${cornerColors[i]}88` : '0 2px 8px rgba(0,0,0,0.6)',
                  }}
                >
                  {cornerLabels[i]}
                </div>
              ))}
            </div>

            <canvas ref={canvasRef} className="hidden" />

            <div className="grid grid-cols-3 gap-3 mt-4">
              <button onClick={onCancel} className="bg-slate-700 hover:bg-slate-600 text-white font-semibold py-3 rounded-lg">Skip</button>
              <button onClick={() => doWarp(true)} className="bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 rounded-lg">Preview</button>
              <button onClick={() => doWarp(false)} className="bg-green-600 hover:bg-green-700 text-white font-semibold py-3 rounded-lg">Apply ✓</button>
            </div>
            <p className="text-slate-500 text-xs text-center mt-2">Tap <strong className="text-slate-400">Skip</strong> to use the original photo without adjustments.</p>
          </>
        )}
      </div>
    </div>
  );
}
// ──────────────────────────────────────────────────────────────────────────────

export default function ClimbingRouteDesigner() {
  const saved = getSavedState();

  const [image, setImage] = useState(saved?.image ?? null);
  const [pendingImage, setPendingImage] = useState(null); // awaiting de-warp editor
  const [pendingImageMeta, setPendingImageMeta] = useState(null);
  const [currentWallId, setCurrentWallId] = useState(saved?.currentWallId ?? null);
  const [currentWallName, setCurrentWallName] = useState(saved?.currentWallName ?? '');
  const [editingWallName, setEditingWallName] = useState(false);
  const [tempWallName, setTempWallName] = useState('');
  const [holds, setHolds] = useState(saved?.holds ?? []);
  const [selectedType, setSelectedType] = useState(saved?.selectedType ?? 'start');
  const [lastTap, setLastTap] = useState({ index: null, time: 0 });
  const [routeName, setRouteName] = useState(saved?.routeName ?? '');
  const [setterName, setSetterName] = useState(saved?.setterName ?? '');
  const [routeGrade, setRouteGrade] = useState(saved?.routeGrade ?? '');
  const [routeNotes, setRouteNotes] = useState(saved?.routeNotes ?? '');
  const [footRule, setFootRule] = useState(saved?.footRule ?? 'marked');
  const [currentRouteId, setCurrentRouteId] = useState(saved?.currentRouteId ?? null);
  const [ascents, setAscents] = useState([]);
  const [saveWarning, setSaveWarning] = useState([]);
  const [showHoldInfo, setShowHoldInfo] = useState(false);
  const [showAscentModal, setShowAscentModal] = useState(false);
  const [showViewAscents, setShowViewAscents] = useState(false);
  const [ascentClimberName, setAscentClimberName] = useState('');
  const [ascentDate, setAscentDate] = useState('');
  const [walls, setWalls] = useState([]);
  const [routes, setRoutes] = useState([]);
  const [showWallLibrary, setShowWallLibrary] = useState(false);
  const [showRouteLibrary, setShowRouteLibrary] = useState(false);
  const [expandedGrades, setExpandedGrades] = useState(new Set());
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [mode, setMode] = useState(saved?.mode ?? 'choose'); // 'choose', 'view', 'create'
  const imageRef = useRef(null);
  const fileInputRef = useRef(null);
  const routeListRef = useRef(null);

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
    // If a route was restored from sessionStorage, fetch its ascents from the
    // API — ascents are not persisted in sessionStorage, so they'd otherwise
    // be empty until the user manually re-selects the route.
    if (saved?.currentRouteId) {
      window.storage.get(`route:${saved.currentRouteId}`).then(result => {
        if (result && result.value) {
          const routeData = JSON.parse(result.value);
          setAscents(routeData.ascents || []);
        }
      }).catch(() => { });
    }
  }, []);

  // Persist UI state to sessionStorage whenever it changes so tab-discards can restore it
  useEffect(() => {
    try {
      // Don't save raw base64 blobs — only save /uploads/ paths (already persisted on server)
      const imageToSave = image?.startsWith('data:') ? null : image;
      const stateToSave = {
        image: imageToSave,
        currentWallId,
        currentWallName,
        holds,
        selectedType,
        routeName,
        setterName,
        routeGrade,
        routeNotes,
        footRule,
        currentRouteId,
        mode,
      };
      sessionStorage.setItem('sprayAppState', JSON.stringify(stateToSave));
    } catch (e) {
      // Silently ignore storage errors (e.g. private browsing quota)
      console.warn('sessionStorage unavailable:', e);
    }
  }, [image, currentWallId, currentWallName, holds, selectedType,
    routeName, setterName, routeGrade, routeNotes, footRule, currentRouteId, mode]);

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
        const newId = `${Date.now()}`;
        setPendingImageMeta({ name: file.name.replace(/\.[^/.]+$/, ''), id: newId });
        setPendingImage(event.target.result);
      };
      reader.readAsDataURL(file);
    }
  };

  const commitPendingImage = async (dataUrl) => {
    setImage(dataUrl);
    setCurrentWallName(pendingImageMeta?.name || 'Unnamed Wall');
    setHolds([]);
    setCurrentWallId(pendingImageMeta?.id || `${Date.now()}`);
    // If replacing an existing wall's photo, persist it immediately
    if (pendingImageMeta?.isReplacement && pendingImageMeta?.id) {
      try {
        const wallData = {
          image: dataUrl,
          name: pendingImageMeta.name,
          createdAt: walls.find(w => w.id === pendingImageMeta.id)?.createdAt || new Date().toISOString()
        };
        await window.storage.set(`wall:${pendingImageMeta.id}`, JSON.stringify(wallData));
        setWalls(walls.map(w => w.id === pendingImageMeta.id ? { ...w, ...wallData } : w));
      } catch (error) {
        console.error('Error updating wall image:', error);
      }
    }
    setPendingImage(null);
    setPendingImageMeta(null);
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
    setShowHoldInfo(false);
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
  };

  const handleNewRoute = () => {
    setHolds([]);
    setRouteName('');
    setSetterName('');
    setRouteGrade('');
    setRouteNotes('');
    setFootRule('marked');
    setSelectedType('start');
    setCurrentRouteId(null);
    setSaveWarning([]);
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
    setRouteGrade('');
    setRouteNotes('');
    setFootRule('marked');
    setCurrentRouteId(null);
    setMode('choose');
  };

  const handleSaveRoute = async () => {
    if (!currentWallId) return;
    const warnings = [];
    if (!holds.some(h => h.type === 'start')) warnings.push('At least one start hold is required');
    if (!holds.some(h => h.type === 'finish')) warnings.push('At least one finish hold is required');
    if (!routeName.trim()) warnings.push('A route name is required');
    if (!setterName.trim()) warnings.push('A setter name is required');
    if (!routeGrade) warnings.push('A grade must be selected');
    if (warnings.length > 0) { setSaveWarning(warnings); return; }
    setSaveWarning([]);
    await handleSaveWall();
    const routeData = {
      name: routeName || 'Untitled Route',
      setter: setterName,
      grade: routeGrade,
      notes: routeNotes,
      footRule,
      holds,
      wallId: currentWallId,
      ascents: ascents || [],
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
        setRouteGrade('');
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
        setAscents(routeData.ascents || []);
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

  const handleAddAscent = async () => {
    if (!ascentClimberName.trim() || !ascentDate) return;

    const newAscent = {
      id: `${Date.now()}`,
      climberName: ascentClimberName.trim(),
      date: ascentDate
    };

    const updatedAscents = [...ascents, newAscent];
    setAscents(updatedAscents);

    // Save to database
    if (currentRouteId) {
      try {
        const result = await window.storage.get(`route:${currentRouteId}`);
        if (result && result.value) {
          const routeData = JSON.parse(result.value);
          routeData.ascents = updatedAscents;
          routeData.updatedAt = new Date().toISOString();
          await window.storage.set(`route:${currentRouteId}`, JSON.stringify(routeData));
          setRoutes(routes.map(r => r.id === currentRouteId ? { ...r, ascents: updatedAscents } : r));
        }
      } catch (error) {
        console.error('Error saving ascent:', error);
      }
    }

    // Reset modal
    setAscentClimberName('');
    setAscentDate('');
    setShowAscentModal(false);
  };

  const handleDeleteAscent = async (ascentId) => {
    const updatedAscents = ascents.filter(a => a.id !== ascentId);
    setAscents(updatedAscents);

    // Save to database
    if (currentRouteId) {
      try {
        const result = await window.storage.get(`route:${currentRouteId}`);
        if (result && result.value) {
          const routeData = JSON.parse(result.value);
          routeData.ascents = updatedAscents;
          routeData.updatedAt = new Date().toISOString();
          await window.storage.set(`route:${currentRouteId}`, JSON.stringify(routeData));
          setRoutes(routes.map(r => r.id === currentRouteId ? { ...r, ascents: updatedAscents } : r));
        }
      } catch (error) {
        console.error('Error deleting ascent:', error);
      }
    }
  };

  const getHoldCount = (type) => holds.filter(h => h.type === type).length;
  const getRoutesForWall = (wallId) => routes.filter(r => r.wallId === wallId);

  // On close: collapse everything. On open: show only the active route's grade (or nothing).
  useEffect(() => {
    if (!showRouteLibrary) {
      setExpandedGrades(new Set());
      return;
    }
    if (currentRouteId) {
      const currentRoute = routes.find(r => r.id === currentRouteId);
      setExpandedGrades(currentRoute?.grade ? new Set([currentRoute.grade]) : new Set());
      setTimeout(() => {
        if (!routeListRef.current || !currentRouteId) return;
        const el = routeListRef.current.querySelector(`[data-route-id="${currentRouteId}"]`);
        if (el) el.scrollIntoView({ block: 'center' });
      }, 50);
    } else {
      setExpandedGrades(new Set());
    }
  }, [showRouteLibrary]);

  return (
    <div className="min-h-screen app-background p-4">
      {/* De-warp editor — shown immediately after an image is selected */}
      {pendingImage && (
        <WallEditor
          src={pendingImage}
          onConfirm={commitPendingImage}
          onCancel={() => {
            // "Skip" — use the raw image as-is
            commitPendingImage(pendingImage);
          }}
        />
      )}
      <div className="max-w-4xl mx-auto">
        {!image && (
          <div className="text-center mb-6">
            <h1 className="text-3xl font-bold text-white mb-2">🧗 Spray</h1>
            <p className="text-slate-300">Design, save, and manage your climbing routes</p>
          </div>
        )}

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
              <div ref={routeListRef} className="flex-1 p-6 overflow-y-auto">
                {getRoutesForWall(currentWallId).length === 0 ? <p className="text-slate-400 text-center py-8">No routes yet.</p> : (() => {
                  const wallRoutes = getRoutesForWall(currentWallId);
                  const gradeMap = {};
                  wallRoutes.forEach(route => {
                    if (!gradeMap[route.grade]) gradeMap[route.grade] = [];
                    gradeMap[route.grade].push(route);
                  });
                  const sortedGrades = Object.keys(gradeMap).sort((a, b) => parseInt(a.replace('V', '')) - parseInt(b.replace('V', '')));
                  sortedGrades.forEach(g => gradeMap[g].sort((a, b) => a.name.localeCompare(b.name)));
                  return (
                    <div className="space-y-2">
                      {sortedGrades.map(grade => {
                        const isExpanded = expandedGrades.has(grade);
                        const gradeRoutes = gradeMap[grade];
                        const hasSelected = gradeRoutes.some(r => r.id === currentRouteId);
                        return (
                          <div key={grade}>
                            <button
                              onClick={() => setExpandedGrades(prev => {
                                const next = new Set(prev);
                                if (next.has(grade)) next.delete(grade); else next.add(grade);
                                return next;
                              })}
                              className="w-full flex items-center justify-between px-4 py-3 rounded-lg font-semibold transition-colors bg-slate-600 hover:bg-slate-500 text-slate-100"
                            >
                              <span className="flex items-center gap-2">
                                <span className={`transition-transform duration-200 text-slate-300 text-xs ${isExpanded ? 'rotate-90' : ''}`}>&#9654;</span>
                                <span>{grade}</span>
                                {hasSelected && <span className="w-2 h-2 rounded-full bg-blue-400 inline-block" />}
                              </span>
                              <span className="text-slate-300 text-sm font-normal">{gradeRoutes.length} {gradeRoutes.length === 1 ? 'Route' : 'Routes'}</span>
                            </button>
                            {isExpanded && (
                              <div className="mt-1 ml-3 pl-2 space-y-1 border-l-2 border-slate-600">
                                {gradeRoutes.map(route => (
                                  <div key={route.id} data-route-id={route.id} className={`p-3 hover:bg-slate-700 ${route.id === currentRouteId ? 'bg-slate-700 outline outline-2 outline-blue-500' : 'bg-slate-800'}`}>
                                    <div className="flex justify-between items-center gap-3">
                                      <div className="flex items-center gap-3 flex-1 cursor-pointer" onClick={() => handleLoadRoute(route.id)}>
                                        <h3 className="text-white font-semibold truncate">{route.name}</h3>
                                      </div>
                                      <div className="text-red-400 hover:bg-red-900 p-2 cursor-pointer rounded" onClick={() => requestDeleteRoute(route.id)}>
                                        <Trash2 size={18} />
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
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
                <div className="flex items-center mb-4">
                  <span className="text-2xl w-8 shrink-0">🧗</span>
                  <div className="flex-1 flex items-center justify-center gap-2">
                    {editingWallName ? (
                      <>
                        <input
                          type="text"
                          value={tempWallName}
                          onChange={(e) => setTempWallName(e.target.value)}
                          className="text-xl font-bold text-white bg-slate-700 px-3 py-1 rounded border border-slate-600 focus:border-blue-400 focus:outline-none text-center"
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
                      </>
                    ) : (
                      <>
                        <h2 className="text-xl font-bold text-white">{currentWallName || 'Unnamed Wall'}</h2>
                        <button onClick={handleEditWallName} className="text-slate-400 hover:text-slate-300">
                          <Edit2 size={18} />
                        </button>
                      </>
                    )}
                  </div>
                  <div className="w-8 shrink-0" />
                </div>

                <button onClick={handleReset} className="w-full bg-slate-700 hover:bg-slate-600 text-white font-semibold py-3 px-4 rounded-lg flex items-center justify-center gap-2 mb-4">
                  <ArrowLeft size={18} /> Change Wall
                </button>

                <div className="grid grid-cols-2 gap-3 mb-4">
                  <button onClick={() => setShowRouteLibrary(true)} className="bg-purple-600 hover:bg-purple-700 text-white font-semibold py-4 px-4 rounded-lg flex items-center justify-center gap-2">
                    <FolderOpen size={20} /> Choose a Route
                  </button>
                  <button onClick={() => { setMode('create'); setHolds([]); setRouteName(''); setSetterName(''); setRouteGrade(''); setRouteNotes(''); setFootRule('marked'); setCurrentRouteId(null); setSelectedType('start'); }} className="bg-blue-600 hover:bg-blue-700 text-white font-semibold py-4 px-4 rounded-lg flex items-center justify-center gap-2">
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
                        // Show de-warp editor; on confirm, update the existing wall
                        setPendingImageMeta({ name: currentWallName, id: currentWallId, isReplacement: true });
                        setPendingImage(event.target.result);
                      };
                      reader.readAsDataURL(file);
                    }
                  }}
                  className="hidden"
                />

                <div className="bg-slate-800 rounded-lg overflow-hidden shadow-2xl">
                  <img src={image} alt="Wall" className="w-full h-auto" />
                </div>
                <button
                  onClick={() => fileInputRef.current.click()}
                  className="w-full mt-2 bg-slate-700 hover:bg-slate-600 text-white font-semibold py-3 px-4 rounded-lg flex items-center justify-center gap-2 transition-colors"
                >
                  <Camera size={18} /> Update Wall Image
                </button>
              </>
            ) : mode === 'view' ? (
              <>
                <div className="flex items-center mb-4">
                  <span className="text-2xl w-8 shrink-0">🧗</span>
                  <div className="flex-1 text-center">
                    <h2 className="text-xl font-bold text-white">{currentWallName || 'Unnamed Wall'}</h2>
                  </div>
                  <div className="w-8 shrink-0" />
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
                  <h3 className="text-white text-xl font-bold mb-3">{routeName || 'Untitled'}{routeGrade ? ` - ${routeGrade}` : ''}</h3>
                  <div className="space-y-2 text-slate-300">
                    {setterName && <div><span className="font-semibold">Setter:</span> {setterName}</div>}
                    <div><span className="font-semibold">Foot Rule:</span> {footRule === 'marked' ? 'Marked Holds' : 'Any Feet'}</div>
                    {routeNotes && <div><span className="font-semibold">Notes:</span> {routeNotes}</div>}
                    <div className="flex items-center justify-between">
                      <div><span className="font-semibold">Ascents:</span> {ascents.length}</div>
                      <div className="flex gap-2">
                        <button onClick={() => { setAscentDate(new Date().toISOString().split('T')[0]); setShowAscentModal(true); }} className="bg-green-600 hover:bg-green-700 text-white text-xs font-semibold py-1 px-2 rounded">
                          Add
                        </button>
                        <button onClick={() => setShowViewAscents(true)} className="bg-slate-600 hover:bg-slate-500 text-white text-xs font-semibold py-1 px-2 rounded">
                          View
                        </button>
                      </div>
                    </div>
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

                <div className="bg-slate-800 rounded-lg p-3 mt-4">
                  <div className="flex justify-around">
                    {Object.entries(holdTypes).map(([type, config]) => (
                      <div key={type} className="flex items-center gap-2">
                        <div className={`w-4 h-4 rounded-full ${config.color} ${config.border} border-2 shrink-0`}></div>
                        <span className="text-slate-300 text-sm">{config.label}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center mb-4">
                  <span className="text-2xl w-8 shrink-0">🧗</span>
                  <div className="flex-1 flex items-center justify-center gap-2">
                    {editingWallName ? (
                      <>
                        <input type="text" value={tempWallName} onChange={(e) => setTempWallName(e.target.value)} className="text-xl font-bold text-white bg-slate-700 px-3 py-1 rounded text-center" autoFocus onKeyDown={(e) => { if (e.key === 'Enter') handleSaveWallName(); if (e.key === 'Escape') { setEditingWallName(false); setTempWallName(''); } }} />
                        <button onClick={handleSaveWallName} className="text-green-400"><Check size={24} /></button>
                        <button onClick={() => { setEditingWallName(false); setTempWallName(''); }} className="text-red-400"><X size={24} /></button>
                      </>
                    ) : (
                      <>
                        <h2 className="text-xl font-bold text-white">{currentWallName || 'Unnamed Wall'}</h2>
                        <button onClick={handleEditWallName} className="text-slate-400"><Edit2 size={18} /></button>
                      </>
                    )}
                  </div>
                  <div className="w-8 shrink-0" />
                </div>

                <div className="grid grid-cols-3 gap-2 mb-4">
                  <button onClick={() => { setMode('choose'); setHolds([]); setRouteName(''); setSetterName(''); setRouteGrade(''); setRouteNotes(''); setFootRule('marked'); setCurrentRouteId(null); setSaveWarning([]); setShowHoldInfo(false); }} className="bg-slate-700 hover:bg-slate-600 text-white font-semibold py-3 px-4 rounded-lg flex items-center justify-center gap-2">
                    <ArrowLeft size={18} /> Back
                  </button>
                  <button onClick={() => { handleNewRoute(); setShowHoldInfo(false); }} className="bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 px-4 rounded-lg flex items-center justify-center gap-2">
                    New Route
                  </button>
                  <button onClick={() => { setShowRouteLibrary(true); setSaveWarning([]); setShowHoldInfo(false); }} className="bg-purple-600 hover:bg-purple-700 text-white font-semibold py-3 px-4 rounded-lg flex items-center justify-center">
                    Edit Route
                  </button>
                </div>

                <div className="bg-slate-800 rounded-lg p-4 mb-4">
                  {currentRouteId && <div className="flex justify-end mb-3"><span className="text-green-400 text-sm">● Saved</span></div>}
                  <div className="space-y-3">
                    <input type="text" value={routeName} onChange={(e) => { setRouteName(e.target.value); setSaveWarning([]); setShowHoldInfo(false); }} placeholder="Route Name" className="w-full px-3 py-2 bg-slate-700 text-white rounded-lg" />
                    <input type="text" value={setterName} onChange={(e) => { setSetterName(e.target.value); setSaveWarning([]); setShowHoldInfo(false); }} placeholder="Setter Name" className="w-full px-3 py-2 bg-slate-700 text-white rounded-lg" />
                    <select value={routeGrade} onChange={(e) => { setRouteGrade(e.target.value); setSaveWarning([]); setShowHoldInfo(false); }} className={`w-full px-3 py-2 bg-slate-700 rounded-lg ${routeGrade ? 'text-white' : 'text-slate-400'}`}>
                      <option value="" disabled>Grade</option>
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
                    <textarea value={routeNotes} onChange={(e) => { setRouteNotes(e.target.value); setShowHoldInfo(false); }} placeholder="Notes" rows="2" className="w-full px-3 py-2 bg-slate-700 text-white rounded-lg resize-none" />
                  </div>
                </div>

                {saveWarning.length > 0 && (
                  <div className="bg-red-900 border border-red-600 rounded-lg p-3 mb-4 relative">
                    <button onClick={() => setSaveWarning([])} className="absolute top-2 right-2 text-red-400 hover:text-red-200">
                      <X size={16} />
                    </button>
                    <p className="text-red-300 text-sm font-semibold mb-1">Please fix the following before saving:</p>
                    <ul className="space-y-1">
                      {saveWarning.map((w, i) => (
                        <li key={i} className="text-red-300 text-sm flex items-start gap-2">
                          <span className="mt-0.5">•</span>{w}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="bg-slate-800 rounded-lg p-4 mb-0">
                  <div className="grid grid-cols-4 gap-2">
                    {Object.entries(holdTypes).map(([type, config]) => (
                      <button key={type} onClick={() => { setSelectedType(type); setShowHoldInfo(false); }} className={`py-3 px-2 rounded-lg font-semibold text-sm ${selectedType === type ? `${config.color} text-slate-900` : 'bg-slate-700 text-slate-300'}`}>
                        {config.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="relative bg-slate-800 rounded-lg overflow-hidden shadow-2xl">
                  <img ref={imageRef} src={image} alt="Wall" className="w-full h-auto cursor-crosshair" style={{ touchAction: 'manipulation' }} onClick={handleImageClick} />
                  {holds.map((hold, i) => {
                    const config = holdTypes[hold.type];
                    return (
                      <div key={i} className="absolute pointer-events-none" style={{ left: `${hold.x}%`, top: `${hold.y}%` }}>
                        <div className={`absolute w-6 h-6 -ml-3 -mt-3 ${config.glow} rounded-full opacity-20 animate-pulse`}></div>
                        <div className={`absolute w-5 h-5 -ml-2.5 -mt-2.5 ${config.border} border-2 rounded-full bg-transparent`}></div>
                      </div>
                    );
                  })}
                  <button
                    onClick={() => setShowHoldInfo(v => !v)}
                    className="absolute top-1.5 right-1.5 bg-black bg-opacity-50 hover:bg-opacity-70 text-white rounded-full p-1 z-10"
                  >
                    <Info size={12} />
                  </button>
                  {showHoldInfo && (
                    <div className="absolute top-8 right-1.5 bg-slate-900 bg-opacity-90 text-slate-200 text-xs rounded-lg p-3 shadow-lg z-10 max-w-[180px]">
                      Tap to add holds<br />Double-tap to delete holds
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-3 gap-2 mt-4">
                  <button onClick={() => { handleUndo(); setShowHoldInfo(false); }} disabled={holds.length === 0} className="bg-yellow-600 hover:bg-yellow-700 disabled:bg-slate-600 text-white font-semibold py-3 px-4 rounded-lg flex items-center justify-center gap-2">
                    <Undo size={18} /> Undo
                  </button>
                  <button onClick={() => { handleClear(); setShowHoldInfo(false); }} disabled={holds.length === 0} className="bg-red-600 hover:bg-red-700 disabled:bg-slate-600 text-white font-semibold py-3 px-4 rounded-lg flex items-center justify-center gap-2"><X size={18} /> Clear</button>
                  <button onClick={() => { handleSaveRoute(); setShowHoldInfo(false); }} className="bg-green-600 hover:bg-green-700 text-white font-semibold py-3 px-4 rounded-lg flex items-center justify-center gap-2">
                    <Save size={18} /> Save
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>

      {showAscentModal && (
        <div className="fixed inset-0 bg-black bg-opacity-75 z-[100] flex items-center justify-center p-4">
          <div className="bg-slate-800 rounded-lg max-w-md w-full p-6">
            <h3 className="text-xl font-bold text-white mb-4">Log Ascent</h3>
            <div className="space-y-4 mb-6">
              <div>
                <label className="block text-slate-300 text-sm mb-2">Climber Name</label>
                <input
                  type="text"
                  value={ascentClimberName}
                  onChange={(e) => setAscentClimberName(e.target.value)}
                  placeholder="Enter name"
                  className="w-full px-3 py-2 bg-slate-700 text-white rounded-lg"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-slate-300 text-sm mb-2">Date</label>
                <input
                  type="date"
                  value={ascentDate}
                  onChange={(e) => setAscentDate(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-700 text-white rounded-lg"
                />
              </div>
            </div>
            <div className="flex gap-3">
              <button onClick={() => { setShowAscentModal(false); setAscentClimberName(''); setAscentDate(''); }} className="flex-1 bg-slate-700 hover:bg-slate-600 text-white font-semibold py-3 px-4 rounded-lg">Cancel</button>
              <button onClick={handleAddAscent} disabled={!ascentClimberName.trim() || !ascentDate} className="flex-1 bg-green-600 hover:bg-green-700 disabled:bg-slate-600 text-white font-semibold py-3 px-4 rounded-lg">Save</button>
            </div>
          </div>
        </div>
      )}

      {showViewAscents && (
        <div className="fixed inset-0 bg-black bg-opacity-75 z-[100] flex items-center justify-center p-4">
          <div className="bg-slate-800 rounded-lg max-w-2xl w-full flex flex-col" style={{ maxHeight: '85vh' }}>
            <div className="p-6 border-b border-slate-700">
              <div className="flex justify-between items-center">
                <h2 className="text-2xl font-bold text-white">Ascent Log</h2>
                <button onClick={() => setShowViewAscents(false)} className="text-slate-400 hover:text-white text-2xl">×</button>
              </div>
            </div>
            <div className="flex-1 p-6 overflow-y-auto">
              {ascents.length === 0 ? (
                <p className="text-slate-400 text-center py-8">No ascents logged yet.</p>
              ) : (
                <div className="space-y-3">
                  {[...ascents].sort((a, b) => new Date(b.date) - new Date(a.date)).map((ascent) => (
                    <div key={ascent.id} className="bg-slate-700 rounded-lg p-4">
                      <div className="flex justify-between items-center">
                        <div>
                          <h3 className="text-white font-semibold">{ascent.climberName}</h3>
                          <p className="text-slate-300 text-sm">{new Date(ascent.date.replace(/-/g, '/')).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
                        </div>
                        <button onClick={() => handleDeleteAscent(ascent.id)} className="text-red-400 hover:bg-red-900 p-2 rounded">
                          <Trash2 size={18} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

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