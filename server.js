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

// Enable Cross-Origin Resource Sharing for API access from other websites
app.use(cors());
app.use(express.static('public'));
app.use(express.json());

const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
}

// Configure Multer for video uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, tempDir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || '.mp4';
        cb(null, uuidv4() + ext);
    }
});
const upload = multer({ storage });

// Cleanup helper
const cleanupDir = (dirPath) => {
    if (fs.existsSync(dirPath)) {
        fs.rm(dirPath, { recursive: true, force: true }, (err) => {
            if (err) console.error(`Error cleaning up ${dirPath}:`, err);
        });
    }
};

// POST /api/convert - Core endpoint
app.post('/api/convert', upload.single('video'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No video file provided' });
    }

    const videoPath = req.file.path;
    const jobId = uuidv4();
    const outputDir = path.join(tempDir, jobId);
    fs.mkdirSync(outputDir, { recursive: true });

    // Extraction parameters
    const fps = req.body.fps || '5';
    const format = req.body.format || 'jpg';
    const width = req.body.width || '-1';
    
    // Construct ffmpeg arguments
    const ffmpegArgs = ['-i', videoPath];
    
    if (width !== '-1' && width !== '') {
        ffmpegArgs.push('-vf', `fps=${fps},scale=${width}:-1`);
    } else {
        ffmpegArgs.push('-vf', `fps=${fps}`);
    }

    if (format === 'jpg') {
        const quality = req.body.quality || '2';
        ffmpegArgs.push('-q:v', quality); // 1 (best) to 5
        ffmpegArgs.push(path.join(outputDir, 'frame_%04d.jpg'));
    } else {
        ffmpegArgs.push(path.join(outputDir, 'frame_%04d.png'));
    }

    console.log(`Job ${jobId} | Starting FFmpeg...`);

    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, { stdio: 'ignore' });

    ffmpegProcess.on('error', (err) => {
        console.error(`Job ${jobId} | FFmpeg spawn error:`, err);
        cleanupDir(outputDir);
        fs.unlink(videoPath, () => {});
        if (!res.headersSent) res.status(500).json({ error: 'Failed to start FFmpeg process' });
    });

    ffmpegProcess.on('close', (code) => {
        if (code !== 0) {
            console.error(`Job ${jobId} | FFmpeg exited with code ${code}`);
            cleanupDir(outputDir);
            fs.unlink(videoPath, () => {});
            return res.status(500).json({ error: 'Failed to extract frames from video' });
        }

        console.log(`Job ${jobId} | FFmpeg completed. Zipping and streaming...`);

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="frames_${jobId}.zip"`);
        res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');

        const archive = archiver('zip', { zlib: { level: 5 } });

        archive.on('error', (err) => {
            console.error(`Job ${jobId} | Archiver error:`, err);
            if (!res.headersSent) res.status(500).send({error: err.message});
        });

        // Cleanup after completion
        res.on('finish', () => {
            console.log(`Job ${jobId} | Zip sent successfully. Cleaning up temp files.`);
            cleanupDir(outputDir);
            fs.unlink(videoPath, () => {});
        });

        archive.pipe(res);
        archive.directory(outputDir, false);
        archive.finalize();
    });
});

app.listen(port, () => {
    console.log(`API Server running at http://localhost:${port}`);
    console.log(`Public interface available at http://localhost:${port}/index.html`);
});
