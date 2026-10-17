export type AspectRatio = 'original' | 'vertical' | 'square' | 'landscape';
export type CharacterColor = 'white' | 'cyan';

export interface RenderSettings {
  density: number;
  brightness: number;
  contrast: number;
  ramp: string;
  color: CharacterColor;
  aspectRatio: AspectRatio;
}

export const CHARACTER_RAMPS = {
  Detailed: '@#W$9876543210?!abc;:+=-,._ ',
  Classic: '@%#*+=-:. ',
  Blocks: '█▓▒░ ',
} as const;

export const ACCEPTED_EXTENSIONS = ['mp4', 'mov', 'webm', 'm4v', 'ogv'];
const rowBuffers = new WeakMap<HTMLCanvasElement, string[]>();

export function validateVideoFile(file: Pick<File, 'name' | 'type'>): string | null {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  const isVideoMime = file.type === '' || file.type.startsWith('video/');
  if (!isVideoMime || !ACCEPTED_EXTENSIONS.includes(extension)) {
    return 'Choose an MP4, MOV, WebM, M4V, or OGV video. Your browser must be able to decode the selected file.';
  }
  return null;
}

export function calculateLuminance(red: number, green: number, blue: number): number {
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function mapLuminanceToCharacter(luminance: number, ramp: string): string {
  if (!ramp.length) return ' ';
  const safeLuminance = Math.max(0, Math.min(255, luminance));
  // Ramps run from dense to sparse. Bright source pixels therefore receive
  // the first, densest glyph; dark pixels fade to the black canvas.
  const index = Math.round((1 - safeLuminance / 255) * (ramp.length - 1));
  return ramp[index] ?? ' ';
}

export function calculateOutputDimensions(
  sourceWidth: number,
  sourceHeight: number,
  aspectRatio: AspectRatio,
): { width: number; height: number } {
  if (aspectRatio === 'vertical') return { width: 720, height: 1280 };
  if (aspectRatio === 'square') return { width: 900, height: 900 };
  if (aspectRatio === 'landscape') return { width: 1280, height: 720 };
  if (sourceWidth <= 0 || sourceHeight <= 0) return { width: 1280, height: 720 };
  const scale = Math.min(1280 / sourceWidth, 1280 / sourceHeight, 1);
  return {
    width: Math.max(2, Math.round(sourceWidth * scale)),
    height: Math.max(2, Math.round(sourceHeight * scale)),
  };
}

type CanvasSource = CanvasImageSource & { width?: number; height?: number; videoWidth?: number; videoHeight?: number; naturalWidth?: number; naturalHeight?: number };

function sourceDimensions(source: CanvasSource): { width: number; height: number } {
  return {
    width: source.videoWidth || source.naturalWidth || source.width || 0,
    height: source.videoHeight || source.naturalHeight || source.height || 0,
  };
}

/** Draws a genuine sampled character rendering to the output canvas. */
export function drawAsciiFrame(
  source: CanvasImageSource,
  output: HTMLCanvasElement,
  settings: RenderSettings,
  sampler: HTMLCanvasElement,
): void {
  const { width, height } = calculateOutputDimensions(
    ...Object.values(sourceDimensions(source as CanvasSource)) as [number, number],
    settings.aspectRatio,
  );
  if (output.width !== width || output.height !== height) {
    output.width = width;
    output.height = height;
  }

  const columns = Math.max(24, Math.min(180, Math.round(settings.density)));
  const cellWidth = width / columns;
  const rows = Math.max(12, Math.round(height / (cellWidth / 0.58)));
  if (sampler.width !== columns || sampler.height !== rows) {
    sampler.width = columns;
    sampler.height = rows;
  }

  const sampleContext = sampler.getContext('2d', { willReadFrequently: true });
  const outputContext = output.getContext('2d');
  if (!sampleContext || !outputContext) throw new Error('Canvas rendering is unavailable in this browser.');

  sampleContext.fillStyle = '#000000';
  sampleContext.fillRect(0, 0, columns, rows);
  const dimensions = sourceDimensions(source as CanvasSource);
  if (dimensions.width && dimensions.height) {
    const scale = Math.min(columns / dimensions.width, rows / dimensions.height);
    const drawWidth = dimensions.width * scale;
    const drawHeight = dimensions.height * scale;
    sampleContext.drawImage(source, (columns - drawWidth) / 2, (rows - drawHeight) / 2, drawWidth, drawHeight);
  }
  const pixels = sampleContext.getImageData(0, 0, columns, rows).data;
  const fontSize = cellWidth / 0.6;
  const rowHeight = height / rows;
  outputContext.fillStyle = '#000000';
  outputContext.fillRect(0, 0, width, height);
  outputContext.fillStyle = settings.color === 'cyan' ? '#B9F5FF' : '#FFFFFF';
  outputContext.font = `${fontSize}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace`;
  outputContext.textBaseline = 'middle';
  outputContext.textAlign = 'left';

  const contrast = Math.max(0.2, Math.min(2, settings.contrast / 100));
  const brightness = settings.brightness * 1.5;
  let rowBuffer = rowBuffers.get(sampler);
  if (!rowBuffer || rowBuffer.length !== columns) {
    rowBuffer = new Array<string>(columns);
    rowBuffers.set(sampler, rowBuffer);
  }
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const pixelIndex = (row * columns + column) * 4;
      let light = calculateLuminance(pixels[pixelIndex] ?? 0, pixels[pixelIndex + 1] ?? 0, pixels[pixelIndex + 2] ?? 0);
      light = Math.max(0, Math.min(255, (light - 128) * contrast + 128 + brightness));
      rowBuffer[column] = mapLuminanceToCharacter(light, settings.ramp);
    }
    outputContext.fillText(rowBuffer.join(''), 0, (row + 0.5) * rowHeight, width);
  }
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
