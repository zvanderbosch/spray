import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const dbPath = path.join(__dirname, 'db.json');
const uploadsDir = path.join(__dirname, 'public', 'uploads');

// Shared PIN required to log in as admin and perform deletes. Set this via
// an environment variable in production; the fallback below is just for
// local dev. This value now lives ONLY on the server — the browser never
// receives or stores the correct PIN, just a pass/fail answer.
const ADMIN_PIN = process.env.ADMIN_PIN || '2477';

// Create uploads directory if it doesn't exist
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use('/uploads', express.static(uploadsDir));

// Helper function to read db
function readDB() {
    if (!fs.existsSync(dbPath)) {
        fs.writeFileSync(dbPath, JSON.stringify({ walls: [], routes: [] }));
    }
    return JSON.parse(fs.readFileSync(dbPath, 'utf8'));
}

// Helper function to write db
function writeDB(data) {
    fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
}

// Helper function to save base64 image as file
function saveImageFile(wallId, base64Data) {
    try {
        // Extract base64 data and extension
        const matches = base64Data.match(/^data:image\/([a-zA-Z]+);base64,(.+)$/);
        if (!matches) {
            return base64Data; // Return as-is if not base64
        }

        const ext = matches[1];
        const base64Content = matches[2];
        const filename = `wall-${wallId}.${ext}`;
        const filepath = path.join(uploadsDir, filename);

        // Save image to file
        fs.writeFileSync(filepath, base64Content, 'base64');

        // Return URL path
        return `/uploads/${filename}`;
    } catch (error) {
        console.error('Image save error:', error);
        return base64Data; // Fallback to base64
    }
}

// Require the shared admin PIN (sent as the x-admin-pin header) for any
// request that reaches this middleware. Used to gate deletes.
function requireAdminPin(req, res, next) {
    const ip = req.ip;

    if (isLockedOut(ip)) {
        return res.status(429).json({ error: 'Too many failed attempts. Try again in a few minutes.' });
    }

    const providedPin = req.headers['x-admin-pin'];

    if (!providedPin || providedPin !== ADMIN_PIN) {
        recordFailedAttempt(ip);
        return res.status(401).json({ error: 'Admin PIN required or incorrect' });
    }

    recordSuccess(ip);
    next();
}

// --- Simple in-memory brute-force protection for the PIN ---
// Note: this resets on server restart and is per-instance only (fine for a
// single small server; wouldn't scale correctly behind multiple instances).
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const failedAttemptsByIp = new Map(); // ip -> { count, lockedUntil }

function isLockedOut(ip) {
    const entry = failedAttemptsByIp.get(ip);
    return !!(entry && entry.lockedUntil && Date.now() < entry.lockedUntil);
}

function recordFailedAttempt(ip) {
    const entry = failedAttemptsByIp.get(ip) || { count: 0, lockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= MAX_FAILED_ATTEMPTS) {
        entry.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
        entry.count = 0;
    }
    failedAttemptsByIp.set(ip, entry);
}

function recordSuccess(ip) {
    failedAttemptsByIp.delete(ip);
}

// Admin login — the ONLY place the PIN is compared. The browser never holds
// a copy of the correct PIN; it just sends whatever the user typed here and
// gets a yes/no answer back.
app.post('/admin/login', (req, res) => {
    const ip = req.ip;

    if (isLockedOut(ip)) {
        return res.status(429).json({ error: 'Too many failed attempts. Try again in a few minutes.' });
    }

    const { pin } = req.body || {};

    if (pin && pin === ADMIN_PIN) {
        recordSuccess(ip);
        return res.json({ ok: true });
    }

    recordFailedAttempt(ip);
    return res.status(401).json({ error: 'Incorrect PIN' });
});

// Get all items
app.get('/:type', (req, res) => {
    const db = readDB();
    const type = req.params.type;
    res.json(db[type] || []);
});

// Get single item
app.get('/:type/:id', (req, res) => {
    const db = readDB();
    const type = req.params.type;
    const id = req.params.id;
    const item = db[type]?.find(i => i.id === id);

    if (item) {
        res.json(item);
    } else {
        res.status(404).json({ error: 'Not found' });
    }
});

// Create item
app.post('/:type', (req, res) => {
    const db = readDB();
    const type = req.params.type;
    const newItem = req.body;

    // If it's a wall with base64 image, save it as a file
    if (type === 'walls' && newItem.image && newItem.image.startsWith('data:')) {
        newItem.image = saveImageFile(newItem.id, newItem.image);
    }

    if (!db[type]) {
        db[type] = [];
    }

    db[type].push(newItem);
    writeDB(db);
    res.status(201).json(newItem);
});

// Update item
app.put('/:type/:id', (req, res) => {
    const db = readDB();
    const type = req.params.type;
    const id = req.params.id;
    const updatedItem = req.body;

    // If it's a wall with base64 image, save it as a file
    if (type === 'walls' && updatedItem.image && updatedItem.image.startsWith('data:')) {
        // Delete old image if it exists
        const oldItem = db[type]?.find(i => i.id === id);
        if (oldItem && oldItem.image && oldItem.image.startsWith('/uploads/')) {
            const oldPath = path.join(__dirname, 'public', oldItem.image);
            if (fs.existsSync(oldPath)) {
                fs.unlinkSync(oldPath);
            }
        }
        updatedItem.image = saveImageFile(id, updatedItem.image);
    }

    const index = db[type]?.findIndex(i => i.id === id);

    if (index !== -1) {
        db[type][index] = updatedItem;
        writeDB(db);
        res.json(updatedItem);
    } else {
        res.status(404).json({ error: 'Not found' });
    }
});

// Delete a single ascent from a route — requires the shared admin PIN.
// Ascents are stored embedded in the route's `ascents` array rather than as
// their own top-level collection, so this needs its own endpoint instead of
// going through the generic /:type/:id delete route below.
app.delete('/routes/:routeId/ascents/:ascentId', requireAdminPin, (req, res) => {
    const db = readDB();
    const { routeId, ascentId } = req.params;

    const route = db.routes?.find(r => r.id === routeId);
    if (!route) {
        return res.status(404).json({ error: 'Route not found' });
    }

    const originalLength = (route.ascents || []).length;
    route.ascents = (route.ascents || []).filter(a => a.id !== ascentId);

    if (route.ascents.length === originalLength) {
        return res.status(404).json({ error: 'Ascent not found' });
    }

    route.updatedAt = new Date().toISOString();
    writeDB(db);
    res.json({ deleted: true });
});

// Delete item — requires the shared admin PIN
app.delete('/:type/:id', requireAdminPin, (req, res) => {
    const db = readDB();
    const type = req.params.type;
    const id = req.params.id;

    const index = db[type]?.findIndex(i => i.id === id);

    if (index !== -1) {
        const item = db[type][index];

        // If it's a wall, delete the image file
        if (type === 'walls' && item.image && item.image.startsWith('/uploads/')) {
            const imagePath = path.join(__dirname, 'public', item.image);
            if (fs.existsSync(imagePath)) {
                fs.unlinkSync(imagePath);
            }
        }

        db[type].splice(index, 1);
        writeDB(db);
        res.json({ deleted: true });
    } else {
        res.status(404).json({ error: 'Not found' });
    }
});

app.listen(3001, '0.0.0.0', () => {
    console.log('API Server is running on port 3001');
    console.log('Uploads directory:', uploadsDir);
});