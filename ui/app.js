const DB_NAME = 'SurveillanceBufferDB';
const DB_VERSION = 1;
const STORE_NAME = 'chunks';
const MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
const CHUNK_DURATION_MS = 2000;

// UI Elements
const videoEl = document.getElementById('webcam-preview');
const btnInit = document.getElementById('btn-init');
const btnHalt = document.getElementById('btn-halt');
const camStatus = document.getElementById('cam-status');
const recBadge = document.getElementById('rec-badge');
const terminalLog = document.getElementById('terminal-log');
const chunkCountEl = document.getElementById('chunk-count');
const sysTimeEl = document.getElementById('sys-time');
const fpsConfig = document.getElementById('fps-config');
const apiKeyInput = document.getElementById('api-key');
let db;
let captureInterval;
let cleanupInterval;
let openRouterInterval;
let stream;
let activeUploads = new Set();
let zipQueue = [];
let pendingUploads = [];
let uploadQueueInterval;
let isUploading = false;
let isAnalyzing = false;

const reqMinuteEl = document.getElementById('req-minute');
const reqDailyEl = document.getElementById('req-daily');

let reqHistory = [];
let requestsToday = parseInt(localStorage.getItem('requestsToday')) || 0;
let todayDate = localStorage.getItem('todayDate') || new Date().toDateString();
let isGlobalRateLimited = false;

if (todayDate !== new Date().toDateString()) {
    requestsToday = 0;
    todayDate = new Date().toDateString();
    localStorage.setItem('todayDate', todayDate);
    localStorage.setItem('requestsToday', 0);
}

// Toggle this to test locally vs production
const API_BASE = 'http://localhost:3000';
// const API_BASE = 'https://back-ednt.onrender.com';

// IndexedDB Init
function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (e) => {
            const tempDb = e.target.result;
            if (!tempDb.objectStoreNames.contains(STORE_NAME)) {
                tempDb.createObjectStore(STORE_NAME, { keyPath: 'timestamp' });
            }
        };
        request.onsuccess = (e) => {
            db = e.target.result;
            resolve(db);
        };
        request.onerror = (e) => reject(e);
    });
}

function log(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = `log-line ${type}`;
    el.textContent = `[${new Date().toISOString().split('T')[1].slice(0, 12)}] ${msg}`;
    terminalLog.appendChild(el);
    terminalLog.scrollTop = terminalLog.scrollHeight;
    
    setTimeout(() => {
        if (terminalLog.contains(el)) {
            el.remove();
        }
    }, 30000);
}

// Time loop
setInterval(() => {
    const now = new Date();
    sysTimeEl.textContent = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}:${String(now.getMilliseconds()).padStart(3, '0')}`;
    
    if (reqMinuteEl) {
        const timeNow = Date.now();
        reqHistory = reqHistory.filter(t => timeNow - t < 60000);
        reqMinuteEl.textContent = reqHistory.length;
        if (reqDailyEl) reqDailyEl.textContent = requestsToday;
        
        if (isGlobalRateLimited && reqHistory.length < 10 && requestsToday < 200) {
            isGlobalRateLimited = false;
            log('RATE LIMIT RESET. RESUMING ALL FUNCTIONS.', 'success');
        }
    }
}, 50);

// Core Logic
async function setupWebcam() {
    try {
        log('TRANSMITTING WAKE-UP PING TO SERVER...');
        // Fire-and-forget empty request to wake up the backend instance
        fetch(`${API_BASE}/`).catch(err => log(`PING ERROR: ${err.message}`, 'error'));

        log('REQUESTING OPTIC SENSOR UPLINK...');
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
        videoEl.srcObject = stream;
        camStatus.textContent = 'ONLINE';
        camStatus.classList.add('online');
        log('SENSOR INITIATED SUCCESSFULLY', 'success');

        btnInit.classList.add('hidden');
        btnHalt.classList.remove('hidden');
        recBadge.classList.remove('hidden');

        startRecordingCycle();

        // Start cleanup cycle
        cleanupInterval = setInterval(cleanupOldChunks, 10000);

        // Start ZIP queue processing
        openRouterInterval = setInterval(processZipQueue, 4000);

        // Start Upload queue processing
        uploadQueueInterval = setInterval(processUploadQueue, 2000);
    } catch (err) {
        log(`SENSOR UPLINK FAILED: ${err.message}`, 'error');
    }
}

function startRecordingCycle() {
    log(`COMMENCING ${CHUNK_DURATION_MS}ms RECORDING CYCLE`);

    function recordChunk() {
        if (!stream) return;
        const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
        const chunks = [];

        recorder.ondataavailable = e => {
            if (e.data.size > 0) chunks.push(e.data);
        };

        recorder.onstop = async () => {
            const blob = new Blob(chunks, { type: 'video/webm' });
            const timestamp = Date.now();
            await saveChunk(timestamp, blob);
            pendingUploads.push({ timestamp, blob });
        };

        recorder.start();
        setTimeout(() => {
            if (recorder.state === 'recording') {
                recorder.stop();
            }
        }, CHUNK_DURATION_MS);
    }

    // Initial call
    recordChunk();
    captureInterval = setInterval(recordChunk, CHUNK_DURATION_MS);
}

function haltCapture() {
    if (captureInterval) clearInterval(captureInterval);
    if (cleanupInterval) clearInterval(cleanupInterval);
    if (openRouterInterval) clearInterval(openRouterInterval);
    if (uploadQueueInterval) clearInterval(uploadQueueInterval);

    pendingUploads = [];
    isUploading = false;

    // Abort all active fetch requests
    for (let controller of activeUploads) {
        controller.abort();
    }
    activeUploads.clear();

    if (stream) {
        stream.getTracks().forEach(t => t.stop());
        stream = null;
    }
    videoEl.srcObject = null;
    camStatus.textContent = 'OFFLINE';
    camStatus.classList.remove('online');
    btnInit.classList.remove('hidden');
    btnHalt.classList.add('hidden');
    recBadge.classList.add('hidden');
    log('SENSOR UPLINK AND ALL PROCESSES KILLED', 'error');
}

async function saveChunk(timestamp, blob) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put({ timestamp, blob });
        tx.oncomplete = () => {
            updateChunkCount();
            resolve();
        };
        tx.onerror = () => reject(tx.error);
    });
}

function updateChunkCount() {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.count();
    req.onsuccess = () => {
        chunkCountEl.textContent = req.result;
    };
}

async function cleanupOldChunks() {
    const cutoff = Date.now() - MAX_AGE_MS;
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.openCursor();

    let deleted = 0;
    req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
            if (cursor.value.timestamp < cutoff) {
                store.delete(cursor.primaryKey);
                deleted++;
            }
            cursor.continue();
        } else {
            if (deleted > 0) log(`PURGED ${deleted} OLD CHUNKS FROM MEMORY`);
            updateChunkCount();
        }
    };
}

async function processUploadQueue() {
    if (isUploading || pendingUploads.length === 0) return;
    
    isUploading = true;
    const chunk = pendingUploads[0];
    
    const success = await processAndUploadChunk(chunk.timestamp, chunk.blob);
    if (success) {
        pendingUploads.shift(); // Remove successfully sent chunk
    }
    isUploading = false;
}

async function processAndUploadChunk(timestamp, blob) {
    log(`TRANSMITTING CHUNK [${timestamp}] TO RENDER API...`);
    const fps = fpsConfig.value;

    const formData = new FormData();
    formData.append('video', blob, `chunk-${timestamp}.webm`);
    formData.append('fps', fps);
    formData.append('format', 'jpg');
    formData.append('width', '480');

    const controller = new AbortController();
    activeUploads.add(controller);

    try {
        const res = await fetch(`${API_BASE}/api/convert`, {
            method: 'POST',
            body: formData,
            signal: controller.signal
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const zipBlob = await res.blob();
        console.log(`Success: Received frames ZIP for chunk [${timestamp}] (${zipBlob.size} bytes).`);
        log(`CHUNK [${timestamp}] RECEIVED SUCCESSFULLY. (Queued for Analysis)`, 'success');

        zipQueue.push({ timestamp, blob: zipBlob });
        return true;
    } catch (err) {
        if (err.name === 'AbortError') {
            log(`TRANSMISSION [${timestamp}] ABORTED`, 'error');
            return true; // Return true to remove from queue if aborted intentionally
        } else {
            log(`TRANSMISSION FAILED: ${err.message} (Will retry)`, 'error');
            return false;
        }
    } finally {
        activeUploads.delete(controller);
    }
}

async function processZipQueue() {
    if (zipQueue.length === 0 || isAnalyzing || isGlobalRateLimited) return;

    if (reqHistory.length >= 10 || requestsToday >= 200) {
        if (!isGlobalRateLimited) {
            isGlobalRateLimited = true;
            log('RATE LIMIT EXCEEDED! PAUSING SYSTEM UNTIL RESET.', 'error');
        }
        return;
    }

    isAnalyzing = true;
    const item = zipQueue.shift();
    const { timestamp, blob } = item;
    log(`[${timestamp}] EXTRACTING FRAMES...`, 'info');

    try {
        const jszip = new JSZip();
        const zip = await jszip.loadAsync(blob);
        const files = Object.keys(zip.files).filter(name => !zip.files[name].dir && name.match(/\.(jpg|jpeg|png)$/i));

        if (files.length === 0) {
            log(`[${timestamp}] NO VALID FRAMES IN ZIP`, 'error');
            isAnalyzing = false;
            return;
        }

        files.sort();
        const firstFile = files[0];

        const fileData = await zip.files[firstFile].async('uint8array');
        const imgBlob = new Blob([fileData], { type: 'image/jpeg' });

        const base64Data = await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.readAsDataURL(imgBlob);
        });

        const success = await analyzeWithOpenRouter(timestamp, base64Data);
        if (success === false) {
            log(`[${timestamp}] RATE LIMITED. PAUSING QUEUE FOR 10 SECONDS...`, 'error');
            zipQueue.unshift(item);
            await new Promise(r => setTimeout(r, 10000));
        }

    } catch (err) {
        log(`[${timestamp}] EXTRACTION FAILED: ${err.message}`, 'error');
    } finally {
        isAnalyzing = false;
    }
}

async function analyzeWithOpenRouter(timestamp, base64Data) {
    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
        log(`[${timestamp}] OPENROUTER API KEY MISSING`, 'error');
        return false;
    }

    log(`[${timestamp}] QUERYING PALANTIR AEGIS (OPENROUTER)...`, 'info');

    reqHistory.push(Date.now());
    requestsToday++;
    localStorage.setItem('requestsToday', requestsToday);

    try {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://ai.studio",
                "X-Title": "Palantir Aegis Node"
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
IMPORTANT: Provide bounding_boxes coordinates representing pixel locations, assuming the image size is 640x480.`
                    },
                    {
                        role: "user",
                        content: [
                            { type: "text", text: "Analyze this CCTV frame:" },
                            { type: "image_url", image_url: { url: base64Data } }
                        ]
                    }
                ]
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            let errMsg = errText;
            try {
                const parsed = JSON.parse(errText);
                if (parsed.error && parsed.error.message) {
                    errMsg = parsed.error.message;
                } else if (parsed.error) {
                    errMsg = parsed.error;
                }
            } catch (e) { }
            throw new Error(`HTTP ${response.status} - ${errMsg}`);
        }

        const data = await response.json();

        const content = data.choices?.[0]?.message?.content;
        let parsedContent = null;
        try {
            if (content) parsedContent = JSON.parse(content);
        } catch (e) {
            console.error("JSON parse error on AI response", content);
        }

        if (parsedContent) {
            log(`[${timestamp}] AI REPLY: ${JSON.stringify(parsedContent)}`, 'success');
        } else if (content) {
            log(`[${timestamp}] AI REPLY: ${content}`, 'warning');
        } else {
            log(`[${timestamp}] AI RETURNED NO RESPONSE`, 'error');
        }
        console.log(`[${timestamp}] Palantir Aegis Success:`, data);
        return true;

    } catch (err) {
        log(`[${timestamp}] AI QUERY FAILED: ${err.message}`, 'error');
        console.error(`[${timestamp}] Palantir Aegis Error:`, err);
        if (err.message.includes('429')) return false; // Return false to trigger retry
        return true; // Drop chunk for other errors
    }
}

// Listeners
btnInit.addEventListener('click', setupWebcam);
btnHalt.addEventListener('click', haltCapture);

// Startup
initDB().then(() => {
    log('LOCAL BUFFER DB INITIALIZED');
    updateChunkCount();
}).catch(err => {
    log(`DB INIT FAILED: ${err.message}`, 'error');
});
