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

// Delete item
app.delete('/:type/:id', (req, res) => {
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