import { describe, expect, it } from 'vitest';
import {
  calculateLuminance,
  calculateOutputDimensions,
  CHARACTER_RAMPS,
  drawAsciiFrame,
  formatTime,
  mapLuminanceToCharacter,
  validateVideoFile,
} from './ascii';

describe('ASCII mapping', () => {
  it('uses perceptual luminance weights', () => {
    expect(calculateLuminance(255, 255, 255)).toBeCloseTo(255);
    expect(calculateLuminance(255, 0, 0)).toBeCloseTo(54.213);
    expect(calculateLuminance(0, 255, 0)).toBeCloseTo(182.376);
  });

  it('maps dark pixels to sparse characters and light pixels to dense characters on black', () => {
    const ramp = CHARACTER_RAMPS.Classic;
    expect(mapLuminanceToCharacter(0, ramp)).toBe(' ');
    expect(mapLuminanceToCharacter(255, ramp)).toBe('@');
    expect(mapLuminanceToCharacter(-20, ramp)).toBe(' ');
    expect(mapLuminanceToCharacter(300, ramp)).toBe('@');
  });

  it('preserves source aspect within the output size cap and supports requested ratios', () => {
    expect(calculateOutputDimensions(1920, 1080, 'original')).toEqual({ width: 1280, height: 720 });
    expect(calculateOutputDimensions(720, 1280, 'vertical')).toEqual({ width: 720, height: 1280 });
    expect(calculateOutputDimensions(1920, 1080, 'square')).toEqual({ width: 900, height: 900 });
    expect(calculateOutputDimensions(1920, 1080, 'landscape')).toEqual({ width: 1280, height: 720 });
  });

  it('validates browser video input by extension and MIME type', () => {
    expect(validateVideoFile({ name: 'clip.mov', type: 'video/quicktime' })).toBeNull();
    expect(validateVideoFile({ name: 'clip.webm', type: 'video/webm' })).toBeNull();
    expect(validateVideoFile({ name: 'clip.exe', type: 'video/mp4' })).toContain('Choose an MP4');
    expect(validateVideoFile({ name: 'clip.mp4', type: 'application/octet-stream' })).toContain('Choose an MP4');
  });

  it('formats timeline time', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(65.9)).toBe('1:05');
  });
});

describe('frame renderer', () => {
  it('draws sampled characters into an output canvas at the requested aspect', () => {
    let renderedCharacters = 0;
    const drawingContext = {
      fillStyle: '', font: '', textBaseline: 'alphabetic', textAlign: 'start',
      fillRect: () => undefined,
      drawImage: () => undefined,
      fillText: () => { renderedCharacters += 1; },
      getImageData: (_x: number, _y: number, width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4).fill(255) }),
    };
    const createCanvas = () => ({ width: 0, height: 0, getContext: () => drawingContext }) as unknown as HTMLCanvasElement;
    const output = createCanvas();
    const sampler = createCanvas();
    const source = { width: 360, height: 640 } as unknown as CanvasImageSource;
    drawAsciiFrame(source, output, {
      density: 48, brightness: 0, contrast: 100, ramp: CHARACTER_RAMPS.Classic,
      color: 'cyan', aspectRatio: 'square',
    }, sampler);
    expect(output.width).toBe(900);
    expect(output.height).toBe(900);
    expect(sampler.width).toBe(48);
    expect(sampler.height).toBeGreaterThan(0);
    expect(renderedCharacters).toBeGreaterThan(0);
  });
});
