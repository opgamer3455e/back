const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const { v4: uuidv4 } = require('uuid');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Bypass-Tunnel-Reminder'],
    exposedHeaders: ['Content-Disposition']
}));
app.use(express.json());

const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, tempDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || '.mp4';
        cb(null, uuidv4() + ext);
    }
});
const upload = multer({ storage });

const cleanupDir = (dirPath) => {
    if (fs.existsSync(dirPath)) {
        fs.rm(dirPath, { recursive: true, force: true }, () => {});
    }
};

app.post('/api/convert', upload.single('video'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No video provided' });

    const videoPath = req.file.path;
    const jobId = uuidv4();
    const outputDir = path.join(tempDir, jobId);
    fs.mkdirSync(outputDir, { recursive: true });

    const fps = req.body.fps || '5';
    const format = req.body.format || 'jpg';
    const width = req.body.width || '-1';
    
    const ffmpegArgs = ['-i', videoPath];
    if (width !== '-1' && width !== '') ffmpegArgs.push('-vf', `fps=${fps},scale=${width}:-1`);
    else ffmpegArgs.push('-vf', `fps=${fps}`);

    if (format === 'jpg') {
        const quality = req.body.quality || '2';
        ffmpegArgs.push('-q:v', quality);
        ffmpegArgs.push(path.join(outputDir, 'frame_%04d.jpg'));
    } else {
        ffmpegArgs.push(path.join(outputDir, 'frame_%04d.png'));
    }

    console.log(`Job ${jobId} | Starting synchronous FFmpeg...`);
    
    // Essential fix to prevent buffer stall on large videos!
    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, { stdio: 'ignore' });

    ffmpegProcess.on('error', (err) => {
        console.error(`Job ${jobId} | spawn error:`, err);
        cleanupDir(outputDir);
        fs.unlink(videoPath, () => {});
        if (!res.headersSent) res.status(500).json({ error: 'FFmpeg failed to start.' });
    });

    ffmpegProcess.on('close', (code) => {
        if (code !== 0) {
            console.error(`Job ${jobId} | exited with code ${code}`);
            cleanupDir(outputDir);
            fs.unlink(videoPath, () => {});
            if (!res.headersSent) return res.status(500).json({ error: 'FFmpeg extraction failed. Corrupt video?' });
            return;
        }

        console.log(`Job ${jobId} | FFmpeg completed. Zipping and streaming directly...`);

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="frames_${jobId}.zip"`);
        res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');

        const archive = archiver('zip', { zlib: { level: 5 } });

        archive.on('error', (err) => {
            console.error(`Job ${jobId} | Archiver error:`, err);
            if (!res.headersSent) res.status(500).send({error: err.message});
        });

        res.on('finish', () => {
            console.log(`Job ${jobId} | Zip sent. Performing deep cleanup.`);
            cleanupDir(outputDir);
            fs.unlink(videoPath, () => {});
        });

        archive.pipe(res);
        archive.directory(outputDir, false);
        archive.finalize();
    });
});

app.listen(port, () => {
    console.log(`Synchronous API Server running at http://localhost:${port}`);
});
