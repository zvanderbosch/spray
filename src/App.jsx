import { useState, useRef, useEffect } from 'react';
import { Upload, Undo, Save, FolderOpen, Trash2, ArrowLeft, Edit2, Check, X, Camera, Info, BarChart2, ChevronDown, ChevronUp } from 'lucide-react';

// API-based storage
const API_URL = '/api';

// Shared PIN that unlocks delete actions app-wide. Change this to whatever
// code you want to share with trusted climbers/setters at your gym.
const ADMIN_PIN = '2477';

// Admin login persists only for the current browser tab session (clears on tab close),
// similar in spirit to sessionStorage-based UI state below.
function getSavedAdminState() {
  try {
    return sessionStorage.getItem('sprayAppIsAdmin') === 'true';
  } catch {
    return false;
  }
}

// Read persisted UI state from sessionStorage (returns null if nothing saved yet)
function getSavedState() {
  try {
    const saved = sessionStorage.getItem('sprayAppState');
    return saved ? JSON.parse(saved) : null;
  } catch {
    return null;
  }
}

// Formats an ISO date string as e.g. "2026 Jul 25" (YYYY MMM DD)
function formatRouteCreatedDate(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return '';
  const year = d.getFullYear();
  const month = d.toLocaleDateString('en-US', { month: 'short' });
  const day = String(d.getDate()).padStart(2, '0');
  return `${year} ${month} ${day}`;
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
      // Try PUT first (upsert); fall back to POST only on 404/405
      const response = await fetch(`${API_URL}/${type}s/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...data })
      });
      if (!response.ok && (response.status === 404 || response.status === 405)) {
        await fetch(`${API_URL}/${type}s`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, ...data })
        });
      }
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

// ─── Ascent Name Input with manual dropdown ───────────────────────────────────
function AscentNameInput({ value, onChange, knownNames }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={containerRef} className="relative w-full">
      <div className="flex gap-2 w-full">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Enter name"
          className="flex-1 min-w-0 px-3 py-2 bg-slate-700 text-white rounded-lg"
          autoFocus
        />
        {knownNames.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen(o => !o)}
            className={`shrink-0 px-3 py-2 rounded-lg text-white transition-colors ${open ? 'bg-teal-600' : 'bg-slate-600 hover:bg-slate-500'}`}
            title="Show previous climbers"
          >
            <ChevronDown size={16} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
        )}
      </div>
      {open && (
        <div className="absolute z-10 mt-1 w-full bg-slate-700 rounded-lg shadow-xl overflow-hidden">
          <div className="overflow-y-auto" style={{ maxHeight: '160px' }}>
            {knownNames.map(name => (
              <button
                key={name}
                type="button"
                className="w-full text-left px-4 py-2 text-white hover:bg-slate-600 transition-colors text-sm"
                onClick={() => { onChange(name); setOpen(false); }}
              >
                {name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
// ──────────────────────────────────────────────────────────────────────────────

// ─── Wall Stats Modal ─────────────────────────────────────────────────────────
function WallStats({ wallName, routes, onClose }) {
  const [expandedUser, setExpandedUser] = useState(null);
  const [ascentMode, setAscentMode] = useState('total'); // 'total' | 'unique'

  const vGrades = Array.from({ length: 18 }, (_, i) => `V${i}`);

  // Grade distribution of routes
  const gradeCount = {};
  routes.forEach(r => { if (r.grade) gradeCount[r.grade] = (gradeCount[r.grade] || 0) + 1; });
  const presentGrades = vGrades.filter(g => gradeCount[g]);
  const maxRouteCount = Math.max(1, ...presentGrades.map(g => gradeCount[g] || 0));

  // Grade colour band
  const gradeColour = (grade) => {
    const n = parseInt(grade.replace('V', ''));
    if (n <= 2) return '#4ade80';
    if (n <= 4) return '#facc15';
    if (n <= 6) return '#fb923c';
    if (n <= 8) return '#f87171';
    return '#c084fc';
  };

  // Build per-user stats — both total and unique
  const userMap = {};
  routes.forEach(r => {
    (r.ascents || []).forEach(a => {
      const name = a.climberName || 'Unknown';
      if (!userMap[name]) userMap[name] = { totalCount: 0, uniqueRouteIds: new Set(), totalGrades: {}, uniqueGrades: {} };
      userMap[name].totalCount += 1;
      if (r.grade) userMap[name].totalGrades[r.grade] = (userMap[name].totalGrades[r.grade] || 0) + 1;
      if (!userMap[name].uniqueRouteIds.has(r.id)) {
        userMap[name].uniqueRouteIds.add(r.id);
        if (r.grade) userMap[name].uniqueGrades[r.grade] = (userMap[name].uniqueGrades[r.grade] || 0) + 1;
      }
    });
  });

  const users = Object.entries(userMap).sort((a, b) => {
    const countA = ascentMode === 'total' ? a[1].totalCount : a[1].uniqueRouteIds.size;
    const countB = ascentMode === 'total' ? b[1].totalCount : b[1].uniqueRouteIds.size;
    return countB - countA;
  });

  const grandTotal = users.reduce((sum, [, d]) => sum + (ascentMode === 'total' ? d.totalCount : d.uniqueRouteIds.size), 0);

  return (
    <div className="fixed inset-0 bg-black bg-opacity-80 z-[100] flex items-center justify-center p-4">
      <div className="bg-slate-800 rounded-xl w-full max-w-lg flex flex-col" style={{ maxHeight: '90vh' }}>
        {/* Header */}
        <div className="p-5 border-b border-slate-700 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <BarChart2 size={20} className="text-teal-400" />
            <h2 className="text-xl font-bold text-white">{wallName || 'Wall'} Stats</h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-2xl leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-6">

          {/* ── Route Grade Distribution ── */}
          <section>
            <h3 className="text-slate-300 font-semibold text-sm uppercase tracking-wide mb-3">
              Route Grade Distribution — {routes.length} {routes.length === 1 ? 'route' : 'routes'}
            </h3>
            {presentGrades.length === 0 ? (
              <p className="text-slate-500 text-sm">No routes set yet.</p>
            ) : (
              <div className="space-y-2">
                {presentGrades.map(grade => {
                  const count = gradeCount[grade] || 0;
                  const pct = Math.round((count / maxRouteCount) * 100);
                  return (
                    <div key={grade} className="flex items-center gap-3">
                      <span className="text-slate-300 text-sm font-mono w-8 shrink-0">{grade}</span>
                      <div className="flex-1 bg-slate-700 rounded-full h-5 overflow-hidden">
                        <div className="h-full rounded-full transition-all duration-300" style={{ width: `${pct}%`, backgroundColor: gradeColour(grade) }} />
                      </div>
                      <span className="text-slate-400 text-sm w-6 text-right shrink-0">{count}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* ── Climber Stats ── */}
          <section>
            {/* Section header + toggle */}
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-slate-300 font-semibold text-sm uppercase tracking-wide">
                Climber Stats
              </h3>
              <div className="flex bg-slate-700 rounded-lg p-0.5 text-xs font-semibold shrink-0">
                <button
                  onClick={() => setAscentMode('total')}
                  className={`px-3 py-1 rounded-md transition-colors ${ascentMode === 'total' ? 'bg-teal-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
                >
                  Total
                </button>
                <button
                  onClick={() => setAscentMode('unique')}
                  className={`px-3 py-1 rounded-md transition-colors ${ascentMode === 'unique' ? 'bg-teal-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
                >
                  Unique
                </button>
              </div>
            </div>

            {users.length === 0 ? (
              <p className="text-slate-500 text-sm">No ascents logged yet.</p>
            ) : (
              <div className="space-y-2">
                {users.map(([name, data]) => {
                  const isOpen = expandedUser === name;
                  const count = ascentMode === 'total' ? data.totalCount : data.uniqueRouteIds.size;
                  const grades = ascentMode === 'total' ? data.totalGrades : data.uniqueGrades;
                  const userGrades = vGrades.filter(g => grades[g]);
                  const maxUserCount = Math.max(1, ...userGrades.map(g => grades[g] || 0));
                  return (
                    <div key={name} className="bg-slate-700 rounded-lg overflow-hidden">
                      <button
                        className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-600 transition-colors"
                        onClick={() => setExpandedUser(isOpen ? null : name)}
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-teal-700 flex items-center justify-center text-teal-200 font-bold text-sm shrink-0">
                            {name.charAt(0).toUpperCase()}
                          </div>
                          <span className="text-white font-semibold truncate max-w-[160px]">{name}</span>
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          <span className="text-slate-300 text-sm">
                            {count} {ascentMode === 'total' ? (count === 1 ? 'ascent' : 'ascents') : (count === 1 ? 'route' : 'routes')}
                          </span>
                          {isOpen ? <ChevronUp size={16} className="text-slate-400" /> : <ChevronDown size={16} className="text-slate-400" />}
                        </div>
                      </button>
                      {isOpen && (
                        <div className="px-4 pb-4 pt-3 border-t border-slate-600">
                          {userGrades.length === 0 ? (
                            <p className="text-slate-500 text-sm">No graded ascents.</p>
                          ) : (
                            <div className="space-y-2">
                              {userGrades.map(grade => {
                                const gradeCount = grades[grade] || 0;
                                const pct = Math.round((gradeCount / maxUserCount) * 100);
                                return (
                                  <div key={grade} className="flex items-center gap-3">
                                    <span className="text-slate-300 text-xs font-mono w-8 shrink-0">{grade}</span>
                                    <div className="flex-1 bg-slate-600 rounded-full h-4 overflow-hidden">
                                      <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: gradeColour(grade) }} />
                                    </div>
                                    <span className="text-slate-400 text-xs w-4 text-right shrink-0">{gradeCount}</span>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
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
  const [showWallStats, setShowWallStats] = useState(false);
  const [mode, setMode] = useState(saved?.mode ?? 'choose'); // 'choose', 'view', 'create'
  const [showCreateWall, setShowCreateWall] = useState(false);
  const [createWallName, setCreateWallName] = useState('');
  const [createWallPreview, setCreateWallPreview] = useState(null); // base64 preview before de-warp
  const [isAdmin, setIsAdmin] = useState(() => getSavedAdminState());
  const [showAdminLogin, setShowAdminLogin] = useState(false);
  const [adminPinInput, setAdminPinInput] = useState('');
  const [adminError, setAdminError] = useState('');
  const imageRef = useRef(null);
  const viewImageRef = useRef(null);
  const editCanvasRef = useRef(null);
  const viewCanvasRef = useRef(null);
  const offRef = useRef(null);
  const fillOffRef = useRef(null);
  const fileInputRef = useRef(null);
  const routeListRef = useRef(null);

  // Canvas-based hold rendering
  const holdColors = {
    start: { stroke: '#86efac', fill: 'rgba(74,222,128,0.0)' },
    hand: { stroke: '#38bdf8', fill: 'rgba(56,189,248,0.0)' },
    foot: { stroke: '#d8b4fe', fill: 'rgba(192,132,252,0.0)' },
    finish: { stroke: '#ef4444', fill: 'rgba(239,68,68,0.0)' },
  };
  const zOrder = ['foot', 'hand', 'finish', 'start'];

  function drawHoldsOnCanvas(canvas, imgEl, holdsArr) {
    if (!canvas || !imgEl) return;
    const rect = imgEl.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const w = rect.width;
    const h = rect.height;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const radius = 10;
    const strokeWidth = 2;

    // Reuse persistent offscreen canvases — resize only, no allocation
    if (!offRef.current) offRef.current = document.createElement('canvas');
    if (!fillOffRef.current) fillOffRef.current = document.createElement('canvas');
    const off = offRef.current;
    const fillOff = fillOffRef.current;
    off.width = w * dpr;
    off.height = h * dpr;
    fillOff.width = w * dpr;
    fillOff.height = h * dpr;
    const octx = off.getContext('2d');
    const fctx = fillOff.getContext('2d');

    const byType = {};
    zOrder.forEach(t => { byType[t] = []; });
    holdsArr.forEach(hold => { if (byType[hold.type]) byType[hold.type].push(hold); });

    zOrder.forEach(type => {
      const typeHolds = byType[type];
      if (typeHolds.length === 0) return;
      const colors = holdColors[type];

      // Clear and reset transform on reused canvases
      octx.setTransform(1, 0, 0, 1, 0, 0);
      octx.clearRect(0, 0, off.width, off.height);
      octx.scale(dpr, dpr);

      fctx.setTransform(1, 0, 0, 1, 0, 0);
      fctx.clearRect(0, 0, fillOff.width, fillOff.height);
      fctx.scale(dpr, dpr);

      const pts = typeHolds.map(hold => ({
        cx: (hold.x / 100) * w,
        cy: (hold.y / 100) * h,
      }));

      // Step 1: solid discs at outer radius to establish union shape
      octx.globalCompositeOperation = 'source-over';
      octx.fillStyle = '#ffffff';
      pts.forEach(({ cx, cy }) => {
        octx.beginPath();
        octx.arc(cx, cy, radius + strokeWidth / 2, 0, Math.PI * 2);
        octx.fill();
      });

      // Step 2: punch out interiors — overlapping interiors protect each other
      octx.globalCompositeOperation = 'destination-out';
      octx.fillStyle = '#ffffff';
      pts.forEach(({ cx, cy }) => {
        octx.beginPath();
        octx.arc(cx, cy, radius - strokeWidth / 2, 0, Math.PI * 2);
        octx.fill();
      });

      // Step 3: colorize the remaining ring pixels
      octx.globalCompositeOperation = 'source-in';
      octx.fillStyle = colors.stroke;
      octx.fillRect(0, 0, w, h);

      // Step 4: build union interior on the reused fill canvas, flood with a
      // single fillRect so alpha never compounds across overlapping circles
      fctx.globalCompositeOperation = 'source-over';
      fctx.fillStyle = '#ffffff';
      pts.forEach(({ cx, cy }) => {
        fctx.beginPath();
        fctx.arc(cx, cy, radius - strokeWidth / 2, 0, Math.PI * 2);
        fctx.fill();
      });
      fctx.globalCompositeOperation = 'source-in';
      fctx.fillStyle = colors.fill;
      fctx.fillRect(0, 0, w, h);

      // Composite fill behind the ring, then stamp onto main canvas
      octx.globalCompositeOperation = 'destination-over';
      octx.drawImage(fillOff, 0, 0, w, h);
      ctx.drawImage(off, 0, 0, w, h);
    });
  }

  useEffect(() => {
    drawHoldsOnCanvas(editCanvasRef.current, imageRef.current, holds);
  }, [holds, image]);

  useEffect(() => {
    drawHoldsOnCanvas(viewCanvasRef.current, viewImageRef.current, holds);
  }, [holds, image]);

  const holdTypes = {
    start: { color: 'bg-green-400', border: 'border-green-300', label: 'Start', glow: 'bg-green-400', fill: 'rgba(74,222,128,0.20)', zIndex: 4 },
    hand: { color: 'bg-blue-400', border: 'border-blue-300', label: 'Hand', glow: 'bg-blue-400', fill: 'rgba(96,165,250,0.20)', zIndex: 2 },
    foot: { color: 'bg-purple-400', border: 'border-purple-300', label: 'Foot', glow: 'bg-purple-400', fill: 'rgba(192,132,252,0.20)', zIndex: 1 },
    finish: { color: 'bg-red-400', border: 'border-red-300', label: 'Finish', glow: 'bg-red-400', fill: 'rgba(248,113,113,0.20)', zIndex: 3 }
  };

  const vGrades = Array.from({ length: 18 }, (_, i) => `V${i}`);

  useEffect(() => {
    Promise.all([loadWalls(), loadRoutes()]);
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
        const results = await Promise.all(result.keys.map(key => window.storage.get(key)));
        const wallData = results
          .filter(data => data && data.value)
          .map(data => {
            const wall = JSON.parse(data.value);
            return { id: data.key.replace('wall:', ''), ...wall };
          });
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
        const results = await Promise.all(result.keys.map(key => window.storage.get(key)));
        const routeData = results
          .filter(data => data && data.value)
          .map(data => {
            const route = JSON.parse(data.value);
            return { id: data.key.replace('route:', ''), ...route };
          });
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
        if (showCreateWall) {
          // In create-wall flow: just store preview; user confirms via checkmark
          setCreateWallPreview(event.target.result);
        } else {
          const newId = `${Date.now()}`;
          const name = createWallName.trim() || file.name.replace(/\.[^/.]+$/, '');
          setPendingImageMeta({ name, id: newId });
          setPendingImage(event.target.result);
          setShowCreateWall(false);
          setCreateWallName('');
        }
      };
      reader.readAsDataURL(file);
    }
    // Reset input so the same file can be re-selected
    e.target.value = '';
  };

  const commitPendingImage = async (dataUrl) => {
    const wallName = pendingImageMeta?.name || 'Unnamed Wall';
    const wallId = pendingImageMeta?.id || `${Date.now()}`;
    setImage(dataUrl);
    setCurrentWallName(wallName);
    setHolds([]);
    setCurrentWallId(wallId);
    try {
      const existingWall = walls.find(w => w.id === wallId);
      const wallData = {
        image: dataUrl,
        name: wallName,
        createdAt: existingWall?.createdAt || new Date().toISOString()
      };
      await window.storage.set(`wall:${wallId}`, JSON.stringify(wallData));
      if (existingWall) {
        setWalls(walls.map(w => w.id === wallId ? { ...w, ...wallData } : w));
      } else {
        setWalls(prev => [{ id: wallId, ...wallData }, ...prev]);
      }
    } catch (error) {
      console.error('Error saving wall:', error);
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

  const handleConfirmCreateWall = () => {
    if (!createWallName.trim() || !createWallPreview) return;
    const newId = `${Date.now()}`;
    setPendingImageMeta({ name: createWallName.trim(), id: newId });
    setPendingImage(createWallPreview);
    setShowCreateWall(false);
    setCreateWallName('');
    setCreateWallPreview(null);
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
    if (!isAdmin) return;
    const wallRoutes = routes.filter(r => r.wallId === wallId);
    const message = wallRoutes.length > 0 ? `Delete wall and ${wallRoutes.length} routes?` : 'Delete this wall?';
    setConfirmDelete({ type: 'wall', id: wallId, message });
  };

  const requestDeleteRoute = (routeId) => {
    if (!isAdmin) return;
    setConfirmDelete({ type: 'route', id: routeId, message: 'Delete this route?' });
  };

  const requestDeleteAscent = (ascentId, climberName) => {
    if (!isAdmin) return;
    setConfirmDelete({
      type: 'ascent',
      id: ascentId,
      message: climberName ? `Delete this ascent by ${climberName}?` : 'Delete this ascent?'
    });
  };

  const handleAdminLogin = () => {
    if (adminPinInput === ADMIN_PIN) {
      setIsAdmin(true);
      try { sessionStorage.setItem('sprayAppIsAdmin', 'true'); } catch { }
      setShowAdminLogin(false);
      setAdminPinInput('');
      setAdminError('');
    } else {
      setAdminError('Incorrect PIN');
      setAdminPinInput('');
    }
  };

  const handleAdminLogout = () => {
    setIsAdmin(false);
    try { sessionStorage.removeItem('sprayAppIsAdmin'); } catch { }
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
      } else if (confirmDelete.type === 'route') {
        await window.storage.delete(`route:${confirmDelete.id}`);
        setRoutes(routes.filter(r => r.id !== confirmDelete.id));
        if (currentRouteId === confirmDelete.id) handleClear();
      } else if (confirmDelete.type === 'ascent') {
        await handleDeleteAscent(confirmDelete.id);
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

  // Reusable admin login/logout control, inlined into each header row
  const adminControl = isAdmin ? (
    <button
      onClick={handleAdminLogout}
      className="bg-green-700 hover:bg-green-800 text-white text-xs font-semibold py-1.5 px-2.5 rounded-lg flex items-center gap-1 whitespace-nowrap"
    >
      <Check size={12} /> Admin
    </button>
  ) : (
    <button
      onClick={() => { setShowAdminLogin(true); setAdminError(''); setAdminPinInput(''); }}
      className="bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-semibold py-1.5 px-2.5 rounded-lg whitespace-nowrap"
    >
      Admin
    </button>
  );

  return (
    <div className="min-h-screen app-background p-4">
      {showAdminLogin && (
        <div className="fixed inset-0 bg-black bg-opacity-75 z-[120] flex items-center justify-center p-4">
          <div className="bg-slate-800 rounded-lg max-w-sm w-full p-6">
            <h3 className="text-xl font-bold text-white mb-4">Admin Login</h3>
            <p className="text-slate-300 text-sm mb-4">Enter the shared PIN to enable delete actions.</p>
            <input
              type="password"
              inputMode="numeric"
              autoFocus
              value={adminPinInput}
              onChange={(e) => { setAdminPinInput(e.target.value); setAdminError(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') handleAdminLogin(); if (e.key === 'Escape') setShowAdminLogin(false); }}
              placeholder="PIN"
              className="w-full px-3 py-2 bg-slate-700 text-white rounded-lg mb-2"
            />
            {adminError && <p className="text-red-400 text-sm mb-2">{adminError}</p>}
            <div className="flex gap-3 mt-4">
              <button onClick={() => setShowAdminLogin(false)} className="flex-1 bg-slate-700 hover:bg-slate-600 text-white font-semibold py-3 px-4 rounded-lg">Cancel</button>
              <button onClick={handleAdminLogin} className="flex-1 bg-green-600 hover:bg-green-700 text-white font-semibold py-3 px-4 rounded-lg">Log In</button>
            </div>
          </div>
        </div>
      )}

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
          <div className="flex items-center justify-between mb-6">
            <div className="w-8 shrink-0" />
            <h1 className="text-3xl font-bold text-white mb-2 text-center flex-1">🧗 Spray</h1>
            <div className="shrink-0">{adminControl}</div>
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
                {walls.length === 0 ? <p className="text-slate-400 text-center py-8">No walls exist yet. Create your first wall using "Create New Wall".</p> : (
                  <div className="space-y-3">
                    {walls.map((wall) => (
                      <div key={wall.id} className="bg-slate-700 rounded-lg p-4 hover:bg-slate-600">
                        <div className="flex gap-4">
                          <img src={wall.image} alt="Wall" className="w-24 h-24 object-cover rounded cursor-pointer" onClick={() => handleLoadWall(wall.id)} />
                          <div className="flex-1 cursor-pointer" onClick={() => handleLoadWall(wall.id)}>
                            <h3 className="text-white font-semibold">{wall.name}</h3>
                            <p className="text-slate-300 text-sm">{getRoutesForWall(wall.id).length} routes</p>
                          </div>
                          <button
                            type="button"
                            disabled={!isAdmin}
                            onClick={() => requestDeleteWall(wall.id)}
                            title={isAdmin ? 'Delete wall' : 'Admin login required to delete'}
                            className={`p-3 rounded ${isAdmin ? 'text-red-400 hover:bg-red-900 cursor-pointer' : 'text-slate-500 opacity-40 cursor-not-allowed'}`}
                          >
                            <Trash2 size={20} />
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
                                      <button
                                        type="button"
                                        disabled={!isAdmin}
                                        onClick={() => requestDeleteRoute(route.id)}
                                        title={isAdmin ? 'Delete route' : 'Admin login required to delete'}
                                        className={`p-2 rounded ${isAdmin ? 'text-red-400 hover:bg-red-900 cursor-pointer' : 'text-slate-500 opacity-40 cursor-not-allowed'}`}
                                      >
                                        <Trash2 size={18} />
                                      </button>
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
            {showCreateWall ? (
              <div className="space-y-4 text-left">
                <div className="flex items-center gap-2 mb-2">
                  <button onClick={() => { setShowCreateWall(false); setCreateWallName(''); setCreateWallPreview(null); }} className="text-slate-400 hover:text-white">
                    <ArrowLeft size={20} />
                  </button>
                  <h2 className="text-xl font-bold text-white">Create New Wall</h2>
                </div>
                <input
                  type="text"
                  value={createWallName}
                  onChange={(e) => setCreateWallName(e.target.value)}
                  placeholder="Wall Name..."
                  className="w-full px-3 py-2 bg-slate-700 text-white rounded-lg border border-slate-600 focus:border-blue-400 focus:outline-none"
                  autoFocus
                />
                <button
                  onClick={() => fileInputRef.current.click()}
                  className="w-full bg-slate-700 hover:bg-slate-600 text-slate-300 font-semibold py-3 px-6 rounded-lg flex items-center justify-center gap-2 border border-dashed border-slate-500"
                >
                  <Upload size={18} /> {createWallPreview ? 'Change Photo' : 'Select Wall Photo'}
                </button>
                {createWallPreview && (
                  <img src={createWallPreview} alt="Wall preview" className="w-full rounded-lg object-cover max-h-48" />
                )}
                <button
                  onClick={handleConfirmCreateWall}
                  disabled={!createWallName.trim() || !createWallPreview}
                  className="w-full flex items-center justify-center gap-2 py-4 px-6 rounded-lg font-semibold transition-colors
                    disabled:bg-slate-600 disabled:text-slate-400 disabled:cursor-not-allowed
                    bg-green-600 hover:bg-green-700 text-white"
                >
                  <Check size={20} /> Create Wall
                </button>
              </div>
            ) : (
              <>
                <button
                  onClick={() => setShowWallLibrary(true)}
                  className="w-full bg-purple-600 hover:bg-purple-700 text-white font-semibold py-4 px-6 rounded-lg flex items-center justify-center gap-2"
                >
                  Choose a Wall
                </button>
                <button
                  onClick={() => setShowCreateWall(true)}
                  className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-4 px-6 rounded-lg flex items-center justify-center gap-2"
                >
                  Create New Wall
                </button>
              </>
            )}
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
                  <div className="shrink-0">{adminControl}</div>
                </div>

                <button onClick={handleReset} className="w-full bg-slate-700 hover:bg-slate-600 text-white font-semibold py-3 px-4 rounded-lg flex items-center justify-center gap-2 mb-4">
                  <ArrowLeft size={18} /> Change Wall
                </button>

                <div className="grid grid-cols-3 gap-3 mb-4">
                  <button onClick={() => setShowRouteLibrary(true)} className="bg-purple-600 hover:bg-purple-700 text-white font-semibold py-4 px-4 rounded-lg flex items-center justify-center">
                    Choose a Route
                  </button>
                  <button onClick={() => { setMode('create'); setHolds([]); setRouteName(''); setSetterName(''); setRouteGrade(''); setRouteNotes(''); setFootRule('marked'); setCurrentRouteId(null); setSelectedType('start'); }} className="bg-blue-600 hover:bg-blue-700 text-white font-semibold py-4 px-4 rounded-lg flex items-center justify-center">
                    Create/Edit a Route
                  </button>
                  <button onClick={() => setShowWallStats(true)} className="bg-teal-600 hover:bg-teal-700 text-white font-semibold py-4 px-4 rounded-lg flex items-center justify-center">
                    Wall Stats
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
                  <div className="shrink-0">{adminControl}</div>
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
                    {setterName && (
                      <div>
                        <span className="font-semibold">Setter:</span> {setterName}
                        {(() => {
                          const createdAt = routes.find(r => r.id === currentRouteId)?.createdAt;
                          const formatted = formatRouteCreatedDate(createdAt);
                          return formatted ? <span className="text-slate-400"> ({formatted})</span> : null;
                        })()}
                      </div>
                    )}
                    <div><span className="font-semibold">Foot Rule:</span> {footRule === 'marked' ? 'Marked Holds' : 'Any Feet'}</div>
                    {routeNotes && <div><span className="font-semibold">Notes:</span> {routeNotes}</div>}
                    <div className="flex items-center justify-between">
                      <div><span className="font-semibold">Ascents:</span> {ascents.length}</div>
                      <div className="flex gap-2">
                        <button onClick={() => { const d = new Date(); const localDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; setAscentDate(localDate); setShowAscentModal(true); }} className="bg-green-600 hover:bg-green-700 text-white text-xs font-semibold py-1 px-2 rounded">
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
                  <img ref={viewImageRef} src={image} alt="Wall" className="w-full h-auto" onLoad={() => drawHoldsOnCanvas(viewCanvasRef.current, viewImageRef.current, holds)} />
                  <canvas ref={viewCanvasRef} className="absolute inset-0 pointer-events-none" style={{ width: '100%', height: '100%' }} />
                </div>

                <div className="bg-slate-800 rounded-lg p-3 mt-4">
                  <div className="flex justify-around">
                    {Object.entries(holdTypes).map(([type, config]) => (
                      <div key={type} className="flex items-center gap-2">
                        <div className="w-4 h-4 rounded-full border-2 shrink-0" style={{ borderColor: holdColors[type].stroke, backgroundColor: holdColors[type].fill }}></div>
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
                  <div className="shrink-0">{adminControl}</div>
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
                  <img ref={imageRef} src={image} alt="Wall" className="w-full h-auto cursor-crosshair" style={{ touchAction: 'manipulation' }} onClick={handleImageClick} onLoad={() => drawHoldsOnCanvas(editCanvasRef.current, imageRef.current, holds)} />
                  <canvas ref={editCanvasRef} className="absolute inset-0 pointer-events-none" style={{ width: '100%', height: '100%' }} />
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

      {showWallStats && (
        <WallStats
          wallName={currentWallName}
          routes={routes.filter(r => r.wallId === currentWallId)}
          onClose={() => setShowWallStats(false)}
        />
      )}

      {showAscentModal && (() => {
        const allAscents = routes.flatMap(r => (r.ascents || []).map(a => a.climberName).filter(Boolean));
        const ascentCounts = {};
        allAscents.forEach(n => { ascentCounts[n] = (ascentCounts[n] || 0) + 1; });
        const knownNames = [...new Set(allAscents)].sort((a, b) => (ascentCounts[b] - ascentCounts[a]) || a.localeCompare(b));
        return (
          <div className="fixed inset-0 bg-black bg-opacity-75 z-[100] flex items-center justify-center p-4">
            <div className="bg-slate-800 rounded-lg max-w-md w-full p-6 overflow-hidden">
              <h3 className="text-xl font-bold text-white mb-4">Log Ascent</h3>
              <div className="space-y-4 mb-6">
                <div>
                  <label className="block text-slate-300 text-sm mb-2">Climber Name</label>
                  <AscentNameInput
                    value={ascentClimberName}
                    onChange={setAscentClimberName}
                    knownNames={knownNames}
                  />
                </div>
                <div>
                  <label className="block text-slate-300 text-sm mb-2">Date</label>
                  <div className="overflow-hidden rounded-lg">
                    <input
                      type="date"
                      value={ascentDate}
                      onChange={(e) => setAscentDate(e.target.value)}
                      style={{ width: '100%', boxSizing: 'border-box' }}
                      className="px-3 py-2 bg-slate-700 text-white rounded-lg"
                    />
                  </div>
                </div>
              </div>
              <div className="flex gap-3">
                <button onClick={() => { setShowAscentModal(false); setAscentClimberName(''); setAscentDate(''); }} className="flex-1 bg-slate-700 hover:bg-slate-600 text-white font-semibold py-3 px-4 rounded-lg">Cancel</button>
                <button onClick={handleAddAscent} disabled={!ascentClimberName.trim() || !ascentDate} className="flex-1 bg-green-600 hover:bg-green-700 disabled:bg-slate-600 text-white font-semibold py-3 px-4 rounded-lg">Save</button>
              </div>
            </div>
          </div>
        );
      })()}

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
                        <button
                          disabled={!isAdmin}
                          onClick={() => requestDeleteAscent(ascent.id, ascent.climberName)}
                          title={isAdmin ? 'Delete ascent' : 'Admin login required to delete'}
                          className={`p-2 rounded ${isAdmin ? 'text-red-400 hover:bg-red-900' : 'text-slate-500 opacity-40 cursor-not-allowed'}`}
                        >
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