document.addEventListener('DOMContentLoaded', () => {
    const dropZone = document.getElementById('drop-zone');
    const videoInput = document.getElementById('video-input');
    const dropText = document.getElementById('drop-text');
    const extractForm = document.getElementById('extract-form');
    const submitBtn = document.getElementById('submit-btn');
    const progressContainer = document.getElementById('progress-container');
    const progressBar = document.getElementById('progress-bar');
    const statusText = document.getElementById('status-text');
    
    // Drag and drop mechanics
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, preventDefaults, false);
    });

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.add('drag-active'), false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.remove('drag-active'), false);
    });

    dropZone.addEventListener('drop', (e) => {
        let dt = e.dataTransfer;
        let files = dt.files;
        handleFiles(files);
    });

    dropZone.addEventListener('click', () => {
        videoInput.click();
    });

    videoInput.addEventListener('change', function() {
        handleFiles(this.files);
    });

    function handleFiles(files) {
        if (files.length > 0) {
            const file = files[0];
            if (file.type.startsWith('video/')) {
                videoInput.files = files; // Assign to input
                dropText.innerHTML = `Asset Selected:<br><span style="color: var(--accent-cyan); font-weight: 600;">${file.name}</span><br><small>${(file.size / (1024 * 1024)).toFixed(2)} MB</small>`;
            } else {
                alert('Please upload a valid video file.');
            }
        }
    }

    // Form Submission & Sync Pipeline
    extractForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        if (!videoInput.files || videoInput.files.length === 0) {
            alert('Please provide a video asset first.');
            return;
        }

        const formData = new FormData(extractForm);
        formData.append('video', videoInput.files[0]);

        // UI Reset
        submitBtn.disabled = true;
        submitBtn.querySelector('.btn-text').innerText = 'WAITING FOR SERVER...';
        progressContainer.classList.remove('hidden');
        progressBar.style.width = '50%';
        progressBar.style.transition = 'width 10s ease';
        statusText.innerText = 'Extracting and zipping frames (this may take a few minutes)...';
        statusText.style.color = 'var(--accent-cyan)';

        try {
            // 1. SYNCHRONOUS SINGLE-GO REQUEST
            const response = await fetch('http://atharv-backend-api-v1.loca.lt/api/convert', {
                method: 'POST',
                headers: {
                    'Bypass-Tunnel-Reminder': 'true'
                },
                body: formData
            });

            if (!response.ok) {
                let errMsg = 'Server processing failed';
                try {
                    const errData = await response.json();
                    errMsg = errData.error;
                } catch(e) {}
                throw new Error(errMsg);
            }

            // 2. PARSE BLOB & DOWNLOAD
            statusText.innerText = 'Downloading Zip Stream...';
            progressBar.style.width = '80%';
            progressBar.style.transition = 'width 0.5s ease';

            const blob = await response.blob();
            
            // Extract filename if provided
            let filename = 'frames.zip';
            const contentDisposition = response.headers.get('Content-Disposition');
            if (contentDisposition) {
                const match = contentDisposition.match(/filename="?([^"]+)"?/);
                if (match) filename = match[1];
            }

            const downloadUrl = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = downloadUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(downloadUrl);
            a.remove();

            progressBar.style.width = '100%';
            statusText.innerText = 'COMPLETED! Download started.';
            statusText.style.color = 'var(--accent-cyan)';
            setTimeout(() => resetForm(), 3000);

        } catch (error) {
            handleError(error);
        }
    });

    function handleError(error) {
        console.error('Extraction error:', error);
        statusText.innerText = `ERROR: ${error.message}`;
        statusText.style.color = 'var(--accent-magenta)';
        progressBar.style.background = 'var(--accent-magenta)';
        setTimeout(() => resetForm(), 5000);
    }

    function resetForm() {
        submitBtn.disabled = false;
        submitBtn.querySelector('.btn-text').innerText = 'INITIALIZE EXTRACTION';
        progressContainer.classList.add('hidden');
        progressBar.style.width = '0%';
        progressBar.style.transition = 'width 0.3s ease';
        progressBar.style.background = 'linear-gradient(90deg, var(--accent-magenta), var(--accent-cyan))';
        videoInput.value = '';
        dropText.innerHTML = `Drag & Drop Video Asset<br><small>or click to browse local files</small>`;
    }

    // Code Snippet Tabs Logic
    const tabs = document.querySelectorAll('.tab');
    const codeSnippet = document.getElementById('code-snippet');
    const copyBtn = document.getElementById('copy-btn');

    // Updated code snippet for sync integration
    const snippets = {
        'cURL': `# Single Synchronous Request Pipeline
curl -X POST http://localhost:3000/api/convert \\
  -F "video=@./footage.mp4" \\
  -F "fps=5" \\
  -o extracted_frames.zip`,
        'Fetch (JS)': `// Single Synchronous Fetch Request
const formData = new FormData();
formData.append('video', fileInput.files[0]);

const response = await fetch('http://localhost:3000/api/convert', {
    method: 'POST',
    body: formData
});

const blob = await response.blob();
// Download the blob securely via an object URL!`
    };

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            codeSnippet.textContent = snippets[tab.innerText];
        });
    });

    copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(codeSnippet.textContent).then(() => {
            const originalText = copyBtn.innerText;
            copyBtn.innerText = 'Copied!';
            setTimeout(() => { copyBtn.innerText = originalText; }, 2000);
        });
    });
});
