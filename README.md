# video-to-ascii

A free, browser-only video-to-ASCII converter and recorder with synchronized audio preservation.

## Run locally

Requires Node.js 22.12 or newer and npm.

```sh
npm install
npm run dev
```

The production checks are:

```sh
npm run typecheck
npm test
npm run build
```

## Browser and codec behavior

- The selected input must be decodable by the browser. MP4, MOV, and WebM are accepted by extension; actual codec support depends on the browser, operating system, and installed media codecs.
- Export uses `HTMLCanvasElement.captureStream()` and `MediaRecorder`. It chooses MP4 only when that browser reports a supported MP4 recorder type; otherwise it uses a supported WebM type. If neither format is available, it shows an error instead of writing a file with a misleading extension.
- The browser's video element capture stream supplies audio when available. Some browsers do not expose a local video's audio track to capture; in that case the interface identifies the export as video-only.
- Export happens in real time at the selected capture rate. Actual frame pacing can be lower than the selected rate on a busy or low-power device. Output frame rate may be variable, and browser codec padding can cause small duration differences; recording stops when source playback ends.
- Keep the page in the foreground during export. If the browser backgrounds or suspends the tab, ascii.mov cancels the recording rather than silently delivering a file with unreliable timing.
- Original-aspect output is capped at 1280 pixels on the longest dimension. Vertical, square, and landscape modes use 720×1280, 900×900, and 1280×720 canvases respectively.
- Short clips are recommended. Frames are processed one at a time, but encoded `MediaRecorder` chunks are retained in memory until the output file is finalized. The upload UI recommends staying below 500 MB; this is a practical guideline, not a guaranteed device-independent limit.

Current browser support is detected at runtime rather than assumed. The end-to-end verification for this version used a Chromium-based desktop browser with a 3-second portrait H.264/AAC input and produced a playable H.264/AAC MP4. Firefox and Safari can select WebM or MP4 only when their own recorder and capture APIs report support.

## Implementation notes

The ASCII renderer reads luminance from a downsampled canvas and batches one character string per output row, keeping rendering work proportional to the configured grid. No video frames, thumbnails, names, or metadata are sent to a remote service. The implementation uses browser capture/recording APIs; it does not bundle WebCodecs muxing or FFmpeg.wasm, so it cannot transcode to a codec that the browser itself cannot record.
