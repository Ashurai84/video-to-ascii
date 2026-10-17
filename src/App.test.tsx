import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

const context = {
  fillStyle: '',
  font: '',
  textBaseline: 'alphabetic',
  textAlign: 'start',
  fillRect: vi.fn(),
  drawImage: vi.fn(),
  getImageData: vi.fn((_x: number, _y: number, width: number, height: number) => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) { data[i] = 128; data[i + 1] = 128; data[i + 2] = 128; data[i + 3] = 255; }
    return { data };
  }),
  fillText: vi.fn(),
};

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:test-video') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(URL, 'createObjectURL');
  Reflect.deleteProperty(URL, 'revokeObjectURL');
});

async function loadTestVideo() {
  const { container } = render(<App />);
  const file = new File(['video bytes'], 'portrait.mp4', { type: 'video/mp4' });
  fireEvent.change(screen.getByLabelText('Choose a video file'), { target: { files: [file] } });
  await screen.findByText('portrait.mp4');
  const video = container.querySelector('video.source-video') as HTMLVideoElement;
  Object.defineProperties(video, {
    videoWidth: { configurable: true, value: 720 },
    videoHeight: { configurable: true, value: 1280 },
    duration: { configurable: true, value: 4 },
    readyState: { configurable: true, value: 2 },
  });
  fireEvent.loadedMetadata(video);
  await waitFor(() => expect(screen.getByText(/720 × 1280/)).toBeInTheDocument());
  return { container, video };
}

describe('editor behavior', () => {
  it('updates the actual customization control values', async () => {
    await loadTestVideo();
    const density = screen.getByLabelText('Character density') as HTMLInputElement;
    fireEvent.change(density, { target: { value: '120' } });
    expect(density.value).toBe('120');

    const contrast = screen.getByLabelText('Contrast') as HTMLInputElement;
    fireEvent.change(contrast, { target: { value: '130' } });
    expect(contrast.value).toBe('130');

    fireEvent.change(screen.getByLabelText('Character set'), { target: { value: '@%#*+=-:. ' } });
    expect(screen.getByLabelText('Character set')).toHaveValue('@%#*+=-:. ');
    fireEvent.click(screen.getByRole('button', { name: /CYAN/i }));
    expect(screen.getByRole('button', { name: /CYAN/i })).toHaveClass('selected');
    fireEvent.change(screen.getByLabelText('Output aspect'), { target: { value: 'square' } });
    expect(screen.getByLabelText('Output aspect')).toHaveValue('square');
  });

  it('releases the temporary source URL when the user removes a video', async () => {
    await loadTestVideo();
    fireEvent.click(screen.getByRole('button', { name: 'Remove video and start over' }));
    expect(await screen.findByText('Drop your video here')).toBeInTheDocument();
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-video'));
  });

  it('reports unavailable browser export rather than producing a fake file', async () => {
    await loadTestVideo();
    fireEvent.click(screen.getByRole('button', { name: /EXPORT VIDEO/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot record a canvas video/i);
  });

  it('cancels an active conversion and releases capture tracks', async () => {
    const { video } = await loadTestVideo();
    const canvasTrackStop = vi.fn();
    const audioTrackStop = vi.fn();
    const canvasTrack = { stop: canvasTrackStop } as unknown as MediaStreamTrack;
    const audioTrack = { stop: audioTrackStop } as unknown as MediaStreamTrack;
    class TestMediaStream {
      constructor(private readonly tracks: MediaStreamTrack[] = []) {}
      getTracks() { return this.tracks; }
      getVideoTracks() { return this.tracks.filter((track) => track === canvasTrack); }
      getAudioTracks() { return this.tracks.filter((track) => track === audioTrack); }
    }
    class TestMediaRecorder {
      static isTypeSupported() { return true; }
      state: RecordingState = 'inactive';
      mimeType = 'video/mp4';
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor(_stream: MediaStream, _options?: MediaRecorderOptions) {}
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; this.onstop?.(); }
    }
    vi.stubGlobal('MediaRecorder', TestMediaRecorder);
    vi.stubGlobal('MediaStream', TestMediaStream);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', { configurable: true, value: () => new TestMediaStream([canvasTrack]) });
    Object.defineProperty(video, 'captureStream', { configurable: true, value: () => new TestMediaStream([audioTrack]) });

    fireEvent.click(screen.getByRole('button', { name: /EXPORT VIDEO/i }));
    expect(await screen.findByText(/RENDERING ASCII FRAMES · ENCODING OUTPUT/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'CANCEL CONVERSION' }));
    await waitFor(() => expect(canvasTrackStop).toHaveBeenCalled());
    expect(audioTrackStop).toHaveBeenCalled();
    expect(screen.queryByText('A new character.')).not.toBeInTheDocument();
  });
});
