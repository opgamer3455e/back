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

    // Form Submission
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
        submitBtn.querySelector('.btn-text').innerText = 'PROCESSING...';
        progressContainer.classList.remove('hidden');
        progressBar.style.width = '30%';
        statusText.innerText = 'Uploading video asset...';
        statusText.style.color = 'var(--accent-cyan)';

        try {
            // Upload & Stream processing
            const response = await fetch('http://localhost:3000/api/convert', {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.error || 'Server processing failed');
            }

            statusText.innerText = 'Extracting frames & Zipping...';
            progressBar.style.width = '70%';

            // Parse filename from headers
            const contentDisposition = response.headers.get('Content-Disposition');
            let filename = 'frames.zip';
            if (contentDisposition) {
                const filenameMatch = contentDisposition.match(/filename="?([^"]+)"?/);
                if (filenameMatch && filenameMatch.length === 2) {
                    filename = filenameMatch[1];
                }
            }

            // Stream response to blob for download
            const blob = await response.blob();
            const downloadUrl = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = downloadUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(downloadUrl);
            a.remove();

            // Success UI
            progressBar.style.width = '100%';
            statusText.innerText = 'COMPLETED! Download started.';
            statusText.style.color = 'var(--accent-cyan)';
            setTimeout(() => {
                resetForm();
            }, 3000);

        } catch (error) {
            console.error('Extraction error:', error);
            statusText.innerText = `ERROR: ${error.message}`;
            statusText.style.color = 'var(--accent-magenta)';
            progressBar.style.background = 'var(--accent-magenta)';
            setTimeout(() => {
                resetForm();
            }, 4000);
        }
    });

    function resetForm() {
        submitBtn.disabled = false;
        submitBtn.querySelector('.btn-text').innerText = 'INITIALIZE EXTRACTION';
        progressContainer.classList.add('hidden');
        progressBar.style.width = '0%';
        progressBar.style.background = 'linear-gradient(90deg, var(--accent-magenta), var(--accent-cyan))';
        videoInput.value = '';
        dropText.innerHTML = `Drag & Drop Video Asset<br><small>or click to browse local files</small>`;
    }

    // Code Snippet Tabs Logic
    const tabs = document.querySelectorAll('.tab');
    const codeSnippet = document.getElementById('code-snippet');
    const copyBtn = document.getElementById('copy-btn');

    const snippets = {
        'cURL': `curl -X POST http://localhost:3000/api/convert \\
  -F "video=@./footage.mp4" \\
  -F "fps=5" \\
  -F "format=jpg" \\
  -F "width=1280" \\
  -o frames.zip`,
        'Fetch (JS)': `const formData = new FormData();
formData.append('video', fileInput.files[0]);
formData.append('fps', '5');
formData.append('format', 'jpg');
formData.append('width', '1280');

fetch('http://localhost:3000/api/convert', {
    method: 'POST',
    body: formData
}).then(res => res.blob())
  .then(blob => {
      // Handle the zip blob
  });`
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
