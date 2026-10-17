import { ChangeEvent, DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ACCEPTED_EXTENSIONS,
  calculateOutputDimensions,
  CHARACTER_RAMPS,
  drawAsciiFrame,
  formatFileSize,
  formatTime,
  RenderSettings,
  validateVideoFile,
} from './lib/ascii';

type SourceVideo = { file: File; url: string; width: number; height: number; duration: number };
type ExportedVideo = { url: string; blob: Blob; mimeType: string; width: number; height: number; duration: number; audioPreserved: boolean };
type RecorderStream = MediaStream & { stop?: () => void };
type AudioContextWithWebkit = typeof window & { webkitAudioContext?: typeof AudioContext };

const DEFAULT_SETTINGS: RenderSettings = {
  density: 72,
  brightness: 0,
  contrast: 100,
  ramp: CHARACTER_RAMPS.Detailed,
  color: 'white',
  aspectRatio: 'original',
};
const FRAME_RATES = [15, 24, 30, 60];

function getSupportedMimeTypes(): string[] {
  if (typeof MediaRecorder === 'undefined') return [];
  return [
    'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ].filter((type) => MediaRecorder.isTypeSupported(type));
}

function Icon({ name }: { name: 'upload' | 'play' | 'pause' | 'close' | 'download' | 'arrow' }) {
  const paths: Record<typeof name, React.ReactNode> = {
    upload: <><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 20h16"/></>,
    play: <path d="m8 5 12 7-12 7z" fill="currentColor" stroke="none"/>,
    pause: <><path d="M8 5v14"/><path d="M16 5v14"/></>,
    close: <><path d="m6 6 12 12"/><path d="M18 6 6 18"/></>,
    download: <><path d="M12 4v12"/><path d="m7 11 5 5 5-5"/><path d="M4 20h16"/></>,
    arrow: <><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></>,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function App() {
  const inputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const comparisonRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const samplerRef = useRef<HTMLCanvasElement>(document.createElement('canvas'));
  const recorderRef = useRef<MediaRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const audioDestinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const settingsRef = useRef(DEFAULT_SETTINGS);
  const cancelRef = useRef(false);
  const exportStartedAt = useRef(0);
  const [source, setSource] = useState<SourceVideo | null>(null);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [frameRate, setFrameRate] = useState(30);
  const [dragActive, setDragActive] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [error, setError] = useState('');
  const [exportState, setExportState] = useState<'idle' | 'starting' | 'recording' | 'finalizing'>('idle');
  const [exported, setExported] = useState<ExportedVideo | null>(null);
  const [exportError, setExportError] = useState('');
  const [elapsed, setElapsed] = useState(0);

  settingsRef.current = settings;

  useEffect(() => {
    return () => {
      if (source?.url) URL.revokeObjectURL(source.url);
    };
  }, [source?.url]);

  useEffect(() => {
    return () => {
      if (exported?.url) URL.revokeObjectURL(exported.url);
    };
  }, [exported?.url]);

  useEffect(() => {
    return () => {
      audioSourceRef.current?.disconnect();
      audioDestinationRef.current?.disconnect();
      audioDestinationRef.current?.stream.getTracks().forEach((track) => track.stop());
      audioSourceRef.current = null;
      audioDestinationRef.current = null;
      const context = audioContextRef.current;
      audioContextRef.current = null;
      if (context && context.state !== 'closed') void context.close();
    };
  }, [source?.url]);

  const renderFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2 || !video.videoWidth) return;
    try {
      drawAsciiFrame(video, canvas, settingsRef.current, samplerRef.current);
    } catch (renderError) {
      setError(renderError instanceof Error ? renderError.message : 'Could not render this video frame.');
    }
  }, []);

  useEffect(() => {
    if (!source) return;
    let active = true;
    const video = videoRef.current;
    if (!video) return;
    let raf = 0;
    const drawPausedFrame = () => renderFrame();
    const drawAndSchedule = () => {
      if (!active) return;
      renderFrame();
      if (!video.paused && !video.ended) {
        raf = requestAnimationFrame(drawAndSchedule);
      }
    };
    const startLoop = () => {
      cancelAnimationFrame(raf);
      if (!video.paused && !video.ended) raf = requestAnimationFrame(drawAndSchedule);
      else renderFrame();
    };
    video.addEventListener('loadeddata', startLoop);
    video.addEventListener('play', startLoop);
    video.addEventListener('seeked', drawPausedFrame);
    video.addEventListener('pause', drawPausedFrame);
    startLoop();
    return () => {
      active = false;
      cancelAnimationFrame(raf);
      video.removeEventListener('loadeddata', startLoop);
      video.removeEventListener('play', startLoop);
      video.removeEventListener('seeked', drawPausedFrame);
      video.removeEventListener('pause', drawPausedFrame);
    };
  }, [source, renderFrame]);

  useEffect(() => {
    if (exportState !== 'recording') return;
    const timer = window.setInterval(() => setElapsed((Date.now() - exportStartedAt.current) / 1000), 250);
    return () => window.clearInterval(timer);
  }, [exportState]);

  useEffect(() => {
    if (exportState !== 'starting' && exportState !== 'recording') return;
    const handleVisibilityChange = () => {
      if (!document.hidden) return;
      setExportError('The browser suspended this tab. Conversion was cancelled to protect the output timing; keep ascii.mov in the foreground and try again.');
      videoRef.current?.pause();
      setPlaying(false);
      setExportState('finalizing');
      stopExport(true);
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [exportState]);

  useEffect(() => {
    const comparison = comparisonRef.current;
    const sourceVideo = videoRef.current;
    if (!showOriginal || !comparison || !sourceVideo) return;
    const syncComparison = () => {
      if (Number.isFinite(sourceVideo.currentTime)) comparison.currentTime = sourceVideo.currentTime;
      if (sourceVideo.paused) comparison.pause();
      else void comparison.play().catch(() => undefined);
    };
    if (comparison.readyState >= 1) syncComparison();
    else comparison.addEventListener('loadedmetadata', syncComparison, { once: true });
    return () => comparison.removeEventListener('loadedmetadata', syncComparison);
  }, [showOriginal, source?.url]);

  useEffect(() => {
    renderFrame();
  }, [settings, renderFrame]);

  const acceptFile = (file?: File) => {
    if (!file) return;
    const validationError = validateVideoFile(file);
    if (validationError) {
      setError(validationError);
      return;
    }
    stopExport(true);
    setExportState('idle');
    setError('');
    setExportError('');
    setExported(null);
    setCurrentTime(0);
    setPlaying(false);
    setShowOriginal(false);
    const url = URL.createObjectURL(file);
    setSource({ file, url, width: 0, height: 0, duration: 0 });
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    acceptFile(event.currentTarget.files?.[0]);
    event.currentTarget.value = '';
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    acceptFile(event.dataTransfer.files[0]);
  };

  const onMetadata = () => {
    const video = videoRef.current;
    if (!video || !source) return;
    if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.videoWidth || !video.videoHeight) {
      setError('This video could not be decoded. Try a browser-compatible H.264 MP4 or VP8/VP9 WebM file.');
      return;
    }
    setSource((current) => current ? { ...current, width: video.videoWidth, height: video.videoHeight, duration: video.duration } : current);
    setCurrentTime(0);
    setError('');
    window.setTimeout(renderFrame, 0);
  };

  const updateSetting = <K extends keyof RenderSettings>(key: K, value: RenderSettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
    setExported(null);
  };

  const removeVideo = () => {
    stopExport(true);
    videoRef.current?.pause();
    setSource(null);
    setExported(null);
    setError('');
    setExportError('');
    setCurrentTime(0);
    setPlaying(false);
    setSettings(DEFAULT_SETTINGS);
  };

  const togglePlayback = async () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      try {
        await video.play();
        if (showOriginal) await comparisonRef.current?.play();
        setPlaying(true);
      } catch {
        setError('Playback was blocked by the browser. Press play again to start the preview.');
      }
    } else {
      video.pause();
      comparisonRef.current?.pause();
      setPlaying(false);
    }
  };

  function stopExport(cancelled: boolean) {
    cancelRef.current = cancelled;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    }
  }

  const exportVideo = async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !source) return;
    setExportError('');
    setExported(null);
    setExportState('starting');
    cancelRef.current = false;
    setElapsed(0);
    setError('');
    let canvasStream: MediaStream | undefined;
    let sourceStream: RecorderStream | undefined;
    let audioDestination: MediaStreamAudioDestinationNode | undefined;
    try {
      if (typeof MediaRecorder === 'undefined' || typeof canvas.captureStream !== 'function') {
        throw new Error('This browser cannot record a canvas video. Try the latest Chrome, Edge, or Firefox desktop browser.');
      }
      video.pause();
      comparisonRef.current?.pause();
      setPlaying(false);
      if (video.currentTime > 0.05 || video.ended) {
        const seeked = new Promise<void>((resolve) => video.addEventListener('seeked', () => resolve(), { once: true }));
        video.currentTime = 0;
        await seeked;
      }
      if (cancelRef.current) throw new Error('Conversion cancelled.');
      const dimensions = calculateOutputDimensions(source.width, source.height, settings.aspectRatio);
      canvas.width = dimensions.width;
      canvas.height = dimensions.height;
      renderFrame();
      canvasStream = canvas.captureStream(frameRate);
      const captureSource = video as HTMLVideoElement & { captureStream?: () => RecorderStream; mozCaptureStream?: () => RecorderStream; webkitCaptureStream?: () => RecorderStream };
      const capture = captureSource.captureStream ?? captureSource.mozCaptureStream ?? captureSource.webkitCaptureStream;
      if (capture) sourceStream = capture.call(video);
      let audioTracks = sourceStream?.getAudioTracks() ?? [];
      if (audioTracks.length === 0) {
        const AudioContextConstructor = window.AudioContext ?? (window as AudioContextWithWebkit).webkitAudioContext;
        if (AudioContextConstructor) {
          try {
            const audioContext = audioContextRef.current ?? new AudioContextConstructor();
            audioContextRef.current = audioContext;
            if (!audioSourceRef.current) audioSourceRef.current = audioContext.createMediaElementSource(video);
            audioDestination = audioContext.createMediaStreamDestination();
            audioDestinationRef.current = audioDestination;
            audioSourceRef.current.connect(audioDestination);
            audioSourceRef.current.connect(audioContext.destination);
            if (audioContext.state === 'suspended') await audioContext.resume();
            audioTracks = audioDestination.stream.getAudioTracks();
          } catch {
            audioDestination?.stream.getTracks().forEach((track) => track.stop());
            audioDestination?.disconnect();
            audioDestination = undefined;
            audioDestinationRef.current = null;
            audioTracks = [];
          }
        }
      }
      const outputStream = new MediaStream([...canvasStream.getVideoTracks(), ...audioTracks]);
      const supportedTypes = getSupportedMimeTypes();
      if (!supportedTypes.length) throw new Error('This browser cannot encode a compatible MP4 or WebM video. Try current Chrome, Edge, or Firefox.');

      let recorder: MediaRecorder | null = null;
      let selectedType = '';
      let lastError: unknown;
      for (const type of supportedTypes) {
        try {
          recorder = new MediaRecorder(outputStream, { mimeType: type, videoBitsPerSecond: 5_000_000 });
          selectedType = type;
          break;
        } catch (caught) {
          lastError = caught;
        }
      }
      if (!recorder) throw lastError instanceof Error ? lastError : new Error('Could not initialize this browser’s video encoder.');

      recorderRef.current = recorder;
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onerror = () => {
        setExportError('The browser stopped encoding this video. Try a shorter clip or a different browser.');
        stopExport(true);
      };
      recorder.onstop = () => {
        const wasCancelled = cancelRef.current;
        const effectiveType = recorder?.mimeType || selectedType;
        recorderRef.current = null;
        video.onended = null;
        if (audioDestination) {
          audioSourceRef.current?.disconnect(audioDestination);
          audioDestination.stream.getTracks().forEach((track) => track.stop());
          audioDestinationRef.current = null;
        }
        canvasStream?.getTracks().forEach((track) => track.stop());
        sourceStream?.getTracks().forEach((track) => track.stop());
        outputStream.getTracks().forEach((track) => track.stop());
        if (!wasCancelled) {
          const blob = new Blob(chunks, { type: effectiveType });
          if (blob.size === 0) {
            setExportError('The browser produced an empty file. Try another supported browser or codec.');
          } else {
            const url = URL.createObjectURL(blob);
            const probe = document.createElement('video');
            probe.preload = 'metadata';
            probe.onloadedmetadata = () => {
              const outputWidth = probe.videoWidth || canvas.width;
              const outputHeight = probe.videoHeight || canvas.height;
              const outputDuration = Number.isFinite(probe.duration) ? probe.duration : source.duration;
              probe.removeAttribute('src');
              probe.load();
              setExported({
                url, blob, mimeType: effectiveType,
                width: outputWidth, height: outputHeight,
                duration: outputDuration, audioPreserved: audioTracks.length > 0,
              });
            };
            probe.onerror = () => {
              URL.revokeObjectURL(url);
              setExportError('The encoded file could not be decoded by this browser. Try another browser or a shorter clip.');
            };
            probe.src = url;
            probe.load();
          }
        }
        setExportState('idle');
      };

      if (cancelRef.current) throw new Error('Conversion cancelled.');
      renderFrame();
      await video.play();
      if (cancelRef.current) {
        video.pause();
        throw new Error('Conversion cancelled.');
      }
      recorder.start(250);
      exportStartedAt.current = Date.now();
      setExportState('recording');
      setPlaying(true);
      video.onended = () => {
        renderFrame();
        setExportState('finalizing');
        stopExport(false);
      };
    } catch (caught) {
      canvasStream?.getTracks().forEach((track) => track.stop());
      sourceStream?.getTracks().forEach((track) => track.stop());
      recorderRef.current = null;
      setExportState('idle');
      setPlaying(false);
      if (!cancelRef.current) setExportError(caught instanceof Error ? caught.message : 'Export failed. Please try another video.');
      if (audioDestination) {
        audioSourceRef.current?.disconnect(audioDestination);
        audioDestination.stream.getTracks().forEach((track) => track.stop());
        audioDestinationRef.current = null;
      }
    }
  };

  const cancelConversion = () => {
    cancelRef.current = true;
    videoRef.current?.pause();
    comparisonRef.current?.pause();
    setPlaying(false);
    setExportState('idle');
    stopExport(true);
  };

  const percentage = source?.duration ? Math.min(100, (currentTime / source.duration) * 100) : 0;
  const remaining = source?.duration ? Math.max(0, source.duration - currentTime) : 0;
  const outputExtension = exported?.mimeType.includes('mp4') ? 'mp4' : 'webm';
  const supportedDescription = useMemo(() => {
    const types = getSupportedMimeTypes();
    if (types.some((type) => type.includes('mp4'))) return 'MP4 recording is available in this browser.';
    if (types.some((type) => type.includes('webm'))) return 'This browser exports WebM. MP4 encoding is not available here.';
    return 'Video export is unavailable in this browser.';
  }, []);

  return (
    <main className="site-shell">
      <header className="topbar">
        <a className="wordmark" href="#top" aria-label="ascii.mov home">ascii<span>.</span>mov</a>
        <div className="topbar-right">
          <span className="local-indicator"><i aria-hidden="true" />LOCAL PROCESSING</span>
          <a className="quiet-link" href="#privacy">PRIVACY</a>
        </div>
      </header>

      <section className="hero" id="top">
        <div className="hero-kicker">ASCII VIDEO CONVERTER <span>— 01</span></div>
        <h1>Every frame.<br /><span>Reimagined.</span></h1>
        <div className="hero-bottom">
          <p>Turn your videos into living ASCII art.<br />No uploads. No accounts. No fees.</p>
          <div className="hero-meta">A LITTLE LIGHT.<br />A LOT OF CHARACTER.</div>
        </div>
      </section>

      {!source && <section className="upload-section" aria-labelledby="upload-title">
        <div
          className={`drop-zone${dragActive ? ' drag-active' : ''}`}
          onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => { if (event.currentTarget === event.target) setDragActive(false); }}
          onDrop={onDrop}
        >
          <div className="upload-glyph"><Icon name="upload" /></div>
          <h2 id="upload-title">Drop your video here</h2>
          <p>MP4, MOV, WebM · up to 500 MB recommended</p>
          <button className="button button-yellow" onClick={() => inputRef.current?.click()}>
            SELECT VIDEO <Icon name="arrow" />
          </button>
          <input ref={inputRef} type="file" accept="video/mp4,video/quicktime,video/webm,video/x-m4v,video/ogg,.mp4,.mov,.webm,.m4v,.ogv" onChange={onFileChange} hidden aria-label="Choose a video file" />
          <p className="drop-footnote">Files are read locally by your browser. Nothing is sent away.</p>
        </div>
        {error && <p className="error-message" role="alert">{error}</p>}
        <div className="limit-note"><span>GOOD TO KNOW</span><p>Short clips are quickest. Export runs in real time, so a one-minute video takes about one minute to convert.</p></div>
      </section>}

      {source && <section className="editor" aria-label="Video ASCII editor">
        <video
          ref={videoRef}
          className="source-video"
          src={source.url}
          preload="metadata"
          playsInline
          onLoadedMetadata={onMetadata}
          onTimeUpdate={(event) => {
            const time = event.currentTarget.currentTime;
            setCurrentTime(time);
            const comparison = comparisonRef.current;
            if (comparison && Math.abs(comparison.currentTime - time) > 0.08) comparison.currentTime = time;
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onError={() => setError('Your browser could not decode this video. Try an H.264 MP4 or VP8/VP9 WebM. The file stays on your device.')}
        />
        <div className="editor-heading">
          <div>
            <div className="section-label">01 / SOURCE VIDEO</div>
            <h2>{source.file.name}</h2>
            {source.duration > 0 && <p className="source-meta">{source.width} × {source.height} <span>·</span> {formatTime(source.duration)} <span>·</span> {formatFileSize(source.file.size)}</p>}
          </div>
          <button className="icon-button remove-button" onClick={removeVideo} aria-label="Remove video and start over" title="Remove video"><Icon name="close" /></button>
        </div>

        {error && <p className="error-message" role="alert">{error}</p>}

        <div className="workspace">
          <div className="preview-column">
            <div className="preview-toolbar">
              <span className="section-label">{showOriginal ? 'SOURCE PREVIEW' : 'ASCII PREVIEW'}</span>
              <button className="text-button" onClick={() => setShowOriginal((value) => !value)} aria-pressed={showOriginal}>
                {showOriginal ? 'VIEW ASCII' : 'COMPARE SOURCE'}
              </button>
            </div>
            <div className="preview-stage" style={source.width && source.height ? { aspectRatio: `${calculateOutputDimensions(source.width, source.height, settings.aspectRatio).width} / ${calculateOutputDimensions(source.width, source.height, settings.aspectRatio).height}` } : undefined}>
              <canvas ref={canvasRef} className={`ascii-canvas${showOriginal ? ' hidden' : ''}`} aria-label="Live ASCII video preview" />
              {showOriginal && <video ref={comparisonRef} className="comparison-video" src={source.url} muted playsInline aria-label="Original video preview" />}
              {!source.width && <div className="preview-loading"><span className="loading-mark">ascii.</span><span>DECODING LOCAL VIDEO</span></div>}
              {!showOriginal && <div className="preview-stamp">ASCII.MOV <span>／</span> LIVE</div>}
            </div>
            <div className="transport">
              <button className="play-button" onClick={togglePlayback} aria-label={playing ? 'Pause preview' : 'Play preview'} disabled={!source.duration || exportState === 'starting' || exportState === 'recording'}><Icon name={playing ? 'pause' : 'play'} /></button>
              <div className="timeline-wrap">
                <input className="timeline" aria-label="Seek video" type="range" min="0" max={source.duration || 0} step="0.01" value={Math.min(currentTime, source.duration || 0)} onChange={(event) => { const video = videoRef.current; if (video) { video.currentTime = Number(event.currentTarget.value); setCurrentTime(video.currentTime); } }} style={{ '--timeline-progress': `${percentage}%` } as React.CSSProperties} />
                <div className="time-readout"><span>{formatTime(currentTime)}</span><span>{formatTime(source.duration)}</span></div>
              </div>
              <span className="fps-readout">{frameRate} FPS</span>
            </div>
          </div>

          <aside className="controls-panel">
            <div className="section-label">02 / CHARACTER ENGINE</div>
            <div className="control-row density-control">
              <div className="control-title"><label htmlFor="density">Character density</label><output htmlFor="density">{settings.density} COL</output></div>
              <input id="density" type="range" min="48" max="150" step="1" value={settings.density} disabled={exportState !== 'idle'} onChange={(event) => updateSetting('density', Number(event.currentTarget.value))} />
              <div className="range-labels"><span>LESS DETAIL</span><span>MORE DETAIL</span></div>
            </div>
            <div className="control-row slider-control">
              <div className="control-title"><label htmlFor="brightness">Brightness</label><output htmlFor="brightness">{settings.brightness > 0 ? '+' : ''}{settings.brightness}</output></div>
              <input id="brightness" type="range" min="-40" max="40" step="1" value={settings.brightness} disabled={exportState !== 'idle'} onChange={(event) => updateSetting('brightness', Number(event.currentTarget.value))} />
            </div>
            <div className="control-row slider-control">
              <div className="control-title"><label htmlFor="contrast">Contrast</label><output htmlFor="contrast">{settings.contrast}%</output></div>
              <input id="contrast" type="range" min="50" max="150" step="1" value={settings.contrast} disabled={exportState !== 'idle'} onChange={(event) => updateSetting('contrast', Number(event.currentTarget.value))} />
            </div>
            <div className="control-row">
              <label className="control-title" htmlFor="ramp">Character set</label>
              <select id="ramp" value={settings.ramp} disabled={exportState !== 'idle'} onChange={(event) => updateSetting('ramp', event.currentTarget.value)}>
                {Object.entries(CHARACTER_RAMPS).map(([label, ramp]) => <option key={label} value={ramp}>{label}</option>)}
              </select>
            </div>
            <div className="control-row">
              <span className="control-title">Character color</span>
              <div className="segmented" role="group" aria-label="Character color">
                <button className={settings.color === 'white' ? 'selected' : ''} onClick={() => updateSetting('color', 'white')} disabled={exportState !== 'idle'}><i className="swatch swatch-white" /> WHITE</button>
                <button className={settings.color === 'cyan' ? 'selected' : ''} onClick={() => updateSetting('color', 'cyan')} disabled={exportState !== 'idle'}><i className="swatch swatch-cyan" /> CYAN</button>
              </div>
            </div>
            <div className="control-row">
              <label className="control-title" htmlFor="aspect">Output aspect</label>
              <select id="aspect" value={settings.aspectRatio} disabled={exportState !== 'idle'} onChange={(event) => updateSetting('aspectRatio', event.currentTarget.value as RenderSettings['aspectRatio'])}>
                <option value="original">Original</option><option value="vertical">Vertical · 9:16</option><option value="square">Square · 1:1</option><option value="landscape">Landscape · 16:9</option>
              </select>
            </div>
            <div className="control-row">
              <label className="control-title" htmlFor="fps">Output frame rate</label>
              <select id="fps" value={frameRate} disabled={exportState !== 'idle'} onChange={(event) => { setFrameRate(Number(event.currentTarget.value)); setExported(null); }}>
                {FRAME_RATES.map((rate) => <option key={rate} value={rate}>{rate} FPS</option>)}
              </select>
            </div>
            <div className="encoder-note"><span className="note-dot" />{supportedDescription}</div>
            <button className="button button-yellow export-button" onClick={exportVideo} disabled={!source.duration || exportState !== 'idle'}>
              {exportState === 'idle' ? <>EXPORT VIDEO <Icon name="arrow" /></> : <>CONVERTING <span className="button-spinner" /></>}
            </button>
          </aside>
        </div>

        {exportState !== 'idle' && <div className="conversion-panel" role="status" aria-live="polite">
          <div className="conversion-topline"><span className="section-label">{exportState === 'starting' ? 'INITIALIZING VIDEO ENCODER…' : exportState === 'recording' ? 'RENDERING ASCII FRAMES · ENCODING OUTPUT' : 'FINALIZING VIDEO…'}</span><span>{Math.round(percentage)}%</span></div>
          <div className="progress-track"><span style={{ width: `${percentage}%` }} /></div>
          <div className="conversion-bottom"><span>{exportState === 'recording' ? `${formatTime(currentTime)} / ${formatTime(source.duration)} · ${elapsed.toFixed(0)}s elapsed` : 'Preparing local browser resources'}</span><span>{exportState === 'recording' ? `ABOUT ${formatTime(remaining)} LEFT` : ' '}</span></div>
          <button className="cancel-button" onClick={cancelConversion}>CANCEL CONVERSION</button>
        </div>}

        {exportError && <div className="export-error" role="alert"><span>EXPORT ERROR</span><p>{exportError}</p></div>}
        {exported && <section className="completion" aria-labelledby="complete-title">
          <div className="completion-head"><div><div className="section-label">03 / READY TO KEEP</div><h2 id="complete-title">A new character.</h2></div><span className="complete-check">✓</span></div>
          <video className="output-preview" controls playsInline src={exported.url} aria-label="Exported ASCII video preview" />
          <div className="output-meta"><span>{outputExtension.toUpperCase()} <i>·</i> {exported.width} × {exported.height} <i>·</i> {formatTime(exported.duration)} <i>·</i> {formatFileSize(exported.blob.size)}</span><span>{exported.audioPreserved ? 'AUDIO INCLUDED' : 'NO AUDIO TRACK DETECTED'}</span></div>
          {!exported.audioPreserved && <p className="audio-note">The browser did not expose an audio track from this source, so this export contains video only.</p>}
          <div className="completion-actions"><a className="button button-yellow" href={exported.url} download={`ascii-${source.file.name.replace(/\.[^.]+$/, '')}.${outputExtension}`}>DOWNLOAD VIDEO <Icon name="download" /></a><button className="text-button" onClick={removeVideo}>CONVERT ANOTHER VIDEO <Icon name="arrow" /></button></div>
        </section>}
      </section>}

      <footer className="footer" id="privacy">
        <div className="footer-brand"><span>ascii.mov</span><span>Made for the love of characters.</span></div>
        <div className="privacy-copy"><span>YOUR VIDEO STAYS ON YOUR DEVICE.</span><p>Frames are decoded and recorded locally in this browser tab. ascii.mov has no upload service, account, or video storage. Removing the video or closing this page releases its temporary browser resources.</p></div>
        <div className="footer-mark">© 2026 <span>／</span> FREE FOREVER</div>
      </footer>
      <p className="sr-only">Accepted file types: {ACCEPTED_EXTENSIONS.join(', ')}</p>
    </main>
  );
}

export default App;
