require('dotenv').config();
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
    origin: '*', // Allows ANY origin, including 'null' (file:///)
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Bypass-Tunnel-Reminder'],
    exposedHeaders: ['Content-Disposition']
}));
app.use(express.json({ limit: '50mb' }));

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
        fs.rm(dirPath, { recursive: true, force: true }, () => { });
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
        fs.unlink(videoPath, () => { });
        if (!res.headersSent) res.status(500).json({ error: 'FFmpeg failed to start.' });
    });

    ffmpegProcess.on('close', (code) => {
        if (code !== 0) {
            console.error(`Job ${jobId} | exited with code ${code}`);
            cleanupDir(outputDir);
            fs.unlink(videoPath, () => { });
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
            if (!res.headersSent) res.status(500).send({ error: err.message });
        });

        res.on('finish', () => {
            console.log(`Job ${jobId} | Zip sent. Performing deep cleanup.`);
            cleanupDir(outputDir);
            fs.unlink(videoPath, () => { });
        });

        archive.pipe(res);
        archive.directory(outputDir, false);
        archive.finalize();
    });
});

app.post("/api/analyze", async (req, res) => {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "OPENROUTER_API_KEY is not set in environment variables." });
    }

    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.APP_URL || "https://ai.studio",
          "X-Title": "Palantir Aegis Node",
        },
        body: JSON.stringify({
          model: "nvidia/nemotron-nano-12b-v2-vl:free",
          response_format: { type: "json_object" },
          messages: [
            {
               role: "system",
               content: `You are the Palantir Aegis CCTV intelligence engine. You will receive an image frame from a CCTV feed. 
You must output a raw JSON response exactly adhering to this schema, with no markdown wrappers or additional text:
{
  "threat_detected": boolean,
  "threat_type": "None" | "Weapon" | "Robbery" | "Hostage" | "Theft" | "Malicious Intent",
  "worker_status": "Working" | "Idle" | "Distracted (Using Phone)" | "No Worker Present",
  "bounding_boxes": [[ymin, xmin, ymax, xmax, "label"]],
  "confidence_score": 0.00 to 1.00,
  "summary": "String description of scene."
}
IMPORTANT: Provide bounding_boxes coordinates representing pixel locations, assuming the image size is 640x480.
`
            },
            {
               role: "user",
               content: req.body.image ? [
                 { type: "text", text: "Analyze this CCTV frame:" },
                 { type: "image_url", image_url: { url: req.body.image } }
               ] : `Analyze this hypothetical CCTV scene: ${req.body.scene || "A worker in a warehouse is looking at his phone instead of operating the forklift."}`
            }
          ]
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error("OpenRouter API error:", errText);
        return res.status(response.status).json({ error: "OpenRouter API failed", details: errText });
      }

      const data = await response.json();
      
      if (!data || !data.choices || !data.choices[0]) {
        console.error("Unexpected OpenRouter response:", data);
        return res.status(500).json({ error: "Invalid response from AI model", details: data });
      }

      const content = data.choices[0]?.message?.content;
      try {
        const parsedContent = JSON.parse(content);
        res.json(parsedContent);
      } catch (parseError) {
        console.error("JSON parse error:", parseError, "Content was:", content);
        res.status(500).json({ error: "Failed to parse AI response as JSON", details: content });
      }
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Internal server error connecting to AI.", details: e.message });
    }
});

app.listen(port, () => {
    console.log(`Synchronous API Server running at http://localhost:${port}`);
});
