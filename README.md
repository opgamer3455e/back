# Aura: Video-to-Frame Extraction API

A premium, high-performance Node.js application that provides a gorgeous frontend interface and a robust REST API for extracting frames (JPG or PNG) from video files.

## Features

- **Express REST API**: A CORS-enabled endpoint (`POST /api/convert`) ready to be consumed by other websites.
- **FFmpeg Integration**: Native frame extraction utilizing multi-threaded child processes.
- **Zip Streaming**: Returns extracted frames packaged in a ZIP archive automatically.
- **Auto-Cleanup**: Intelligently deletes temp files to prevent disk bloating.
- **Premium Interface**: A "glassmorphism" IDE-style aesthetic featuring custom animations and interactive API documentation.

## Setup Instructions

1. Ensure you have **Node.js** and **FFmpeg** installed (they are already verified on your system).
2. Open PowerShell and navigate to the project directory:
   ```powershell
   cd E:\video-to-frames
   ```
3. Run the application:
   ```powershell
   npm start
   # or
   node server.js
   ```

## Usage

### Web Interface
Navigate to `http://localhost:3000/index.html` in your web browser. Drag and drop a video, adjust the settings (FPS, format, scale), and click the extraction button.

### API Integration (cURL Example)
```bash
curl -X POST http://localhost:3000/api/convert \
  -F "video=@./my_video.mp4" \
  -F "fps=5" \
  -F "format=jpg" \
  -F "width=1280" \
  -o extracted_frames.zip
```

> The API is designed to be fully CORS compatible (`Access-Control-Allow-Origin: *`), meaning you can `fetch()` it directly from any other frontend website.
