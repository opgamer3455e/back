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

let db;
let captureInterval;
let cleanupInterval;
let stream;

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
}

// Time loop
setInterval(() => {
    const now = new Date();
    sysTimeEl.textContent = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}:${String(now.getMilliseconds()).padStart(3, '0')}`;
}, 50);

// Core Logic
async function setupWebcam() {
    try {
        log('TRANSMITTING WAKE-UP PING TO SERVER...');
        // Fire-and-forget empty request to wake up the Render instance
        fetch('https://back-ednt.onrender.com/').catch(err => log(`PING ERROR: ${err.message}`, 'error'));
        
        log('REQUESTING OPTIC SENSOR UPLINK...');
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
        videoEl.srcObject = stream;
        camStatus.textContent = 'ONLINE';
        camStatus.classList.add('online');
        log('SENSOR INITIATED SUCCESSFULLY', 'success');
        
        btnInit.disabled = true;
        btnHalt.disabled = false;
        recBadge.classList.remove('hidden');

        startRecordingCycle();
        
        // Start cleanup cycle
        cleanupInterval = setInterval(cleanupOldChunks, 10000);
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
            processAndUploadChunk(timestamp, blob);
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
    if (stream) {
        stream.getTracks().forEach(t => t.stop());
        stream = null;
    }
    videoEl.srcObject = null;
    camStatus.textContent = 'OFFLINE';
    camStatus.classList.remove('online');
    btnInit.disabled = false;
    btnHalt.disabled = true;
    recBadge.classList.add('hidden');
    log('SENSOR UPLINK HALTED');
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

async function processAndUploadChunk(timestamp, blob) {
    log(`TRANSMITTING CHUNK [${timestamp}] TO RENDER API...`);
    const fps = fpsConfig.value;
    
    const formData = new FormData();
    formData.append('video', blob, `chunk-${timestamp}.webm`);
    formData.append('fps', fps);
    formData.append('format', 'jpg');
    formData.append('width', '480');
    
    try {
        const res = await fetch('https://back-ednt.onrender.com/api/convert', {
            method: 'POST',
            body: formData
        });
        
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        
        const zipBlob = await res.blob();
        console.log(`Success: Received frames ZIP for chunk [${timestamp}] (${zipBlob.size} bytes).`);
        log(`CHUNK [${timestamp}] RECEIVED SUCCESSFULLY. (No auto-download)`, 'success');
    } catch (err) {
        log(`TRANSMISSION FAILED: ${err.message}`, 'error');
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
