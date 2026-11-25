import { AudioCodec, CollisionType, QualityTier } from '../types/tonarchiv';

const LOSSLESS_CODECS: ReadonlySet<AudioCodec> = new Set([
  'flac',
  'alac',
  'pcm_s24le',
  'pcm_s16le',
  'aiff',
]);

const WAV_CODECS: ReadonlySet<AudioCodec> = new Set(['pcm_s24le', 'pcm_s16le']);

const WINDOWS_RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

/**
 * Classifies audio quality strictly by actual decoded codec (ffprobe/mutagen),
 * never by file extension (e.g. .m4a ALAC = lossless, .m4a AAC = lossy).
 */
export function classifyCodecQuality(
  codec: AudioCodec,
  bitrateKbps: number,
  minLossyBitrateKbps: number,
  separateLowQualityLossy: boolean
): QualityTier {
  if (LOSSLESS_CODECS.has(codec)) {
    return 'lossless';
  }
  if (separateLowQualityLossy && bitrateKbps < minLossyBitrateKbps) {
    return 'lossy_low';
  }
  return 'lossy_high';
}

export function isLosslessCodec(codec: AudioCodec): boolean {
  return LOSSLESS_CODECS.has(codec);
}

export function isWavCodec(codec: AudioCodec, extension: string | null | undefined): boolean {
  return WAV_CODECS.has(codec) || String(extension ?? '').toLowerCase() === '.wav';
}

export function formatCodecLabel(codec: AudioCodec, extension: string | null | undefined): string {
  const ext = String(extension ?? '').replace('.', '').toUpperCase() || 'AUDIO';
  switch (codec) {
    case 'flac':
      return 'FLAC';
    case 'alac':
      return `ALAC (${ext})`;
    case 'pcm_s24le':
      return 'PCM 24-Bit (WAV)';
    case 'pcm_s16le':
      return 'PCM 16-Bit (WAV)';
    case 'aiff':
      return 'AIFF (PCM)';
    case 'mp3':
      return 'MP3';
    case 'aac':
      return `AAC (${ext})`;
    case 'vorbis':
      return 'Vorbis (OGG)';
    case 'opus':
      return 'Opus';
    case 'wma':
      return 'WMA';
    default:
      return String(codec || ext).toUpperCase();
  }
}

/**
 * Computes a numeric audio fidelity score for duplicate ranking:
 * Lossless always outranks Lossy; among Lossless, higher bitDepth then sampleRate wins.
 */
export function computeAudioQualityScore(
  codec: AudioCodec,
  bitDepth: number | null,
  sampleRateHz: number,
  bitrateKbps: number
): number {
  if (isLosslessCodec(codec)) {
    const bits = bitDepth ?? 16;
    return 1_000_000_000 + bits * 1_000_000 + sampleRateHz;
  }
  return bitrateKbps * 1000 + sampleRateHz / 100;
}

/**
 * Sanitizes a single path segment (folder name or file stem) for POSIX + SMB/Windows safety.
 */
export function sanitizePathSegment(raw: string | null | undefined): {
  value: string;
  changed: boolean;
} {
  const original = String(raw ?? '');
  // Normalize Unicode NFC and strip control chars + SMB/Windows illegal chars
  let cleaned = original
    .normalize('NFC')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();

  // Trailing dots and spaces break SMB/Windows shares
  cleaned = cleaned.replace(/[. ]+$/g, '');

  if (!cleaned) {
    cleaned = 'Unbekannt';
  }

  if (WINDOWS_RESERVED_NAMES.has(cleaned.toUpperCase())) {
    cleaned = `${cleaned}_`;
  }

  return {
    value: cleaned,
    changed: cleaned !== original,
  };
}

/**
 * Sanitizes an entire relative path and enforces max path length without mangling extension.
 */
export function sanitizeRelativePath(
  segments: Array<string | null | undefined>,
  fileStem: string | null | undefined,
  extension: string | null | undefined,
  maxPathLength: number
): {
  relativePath: string;
  changed: boolean;
  tooLong: boolean;
} {
  let changed = false;
  const cleanSegments = segments
    .map((s) => String(s ?? ''))
    .filter((s) => s.trim().length > 0)
    .map((segment) => {
      const res = sanitizePathSegment(segment);
      if (res.changed) changed = true;
      return res.value;
    });

  const cleanStemRes = sanitizePathSegment(fileStem);
  if (cleanStemRes.changed) changed = true;

  const rawExt = String(extension ?? '').trim().toLowerCase();
  const cleanExt = !rawExt ? '' : rawExt.startsWith('.') ? rawExt : `.${rawExt}`;
  let fullPath = [...cleanSegments, `${cleanStemRes.value}${cleanExt}`].join('/');
  let tooLong = false;

  if (fullPath.length > maxPathLength) {
    const dirPrefix = cleanSegments.join('/');
    const availableForStem = maxPathLength - dirPrefix.length - 1 - cleanExt.length;
    if (availableForStem >= 12) {
      const truncatedStem = cleanStemRes.value.slice(0, availableForStem).replace(/[. ]+$/g, '');
      fullPath = `${dirPrefix}/${truncatedStem}${cleanExt}`;
      changed = true;
    } else {
      tooLong = true;
    }
  }

  return {
    relativePath: fullPath,
    changed,
    tooLong,
  };
}

/**
 * Detects exact path collisions and SMB case-insensitive collisions across planned paths.
 * Never silently overwrites: flags collisions explicitly.
 */
export function detectPathCollisions(
  plannedPaths: Array<{ id: string; targetRelativePath: string; tooLong: boolean }>,
  smbCaseSafe: boolean
): Map<string, { type: CollisionType; detail: string | null }> {
  const result = new Map<string, { type: CollisionType; detail: string | null }>();
  const exactSeen = new Map<string, string>();
  const lowerSeen = new Map<string, { id: string; originalPath: string }>();

  for (const item of plannedPaths) {
    if (item.tooLong) {
      result.set(item.id, {
        type: 'path_too_long',
        detail: `Pfad überschreitet Maximallänge (${item.targetRelativePath.length} Zeichen).`,
      });
      continue;
    }

    const existingExact = exactSeen.get(item.targetRelativePath);
    if (existingExact) {
      result.set(item.id, {
        type: 'path_collision',
        detail: `Namenskollision mit anderem Track am Zielpfad "${item.targetRelativePath}" (Überschreiben blockiert).`,
      });
      continue;
    }
    exactSeen.set(item.targetRelativePath, item.id);

    if (smbCaseSafe) {
      const lowerKey = item.targetRelativePath.toLowerCase();
      const existingLower = lowerSeen.get(lowerKey);
      if (existingLower && existingLower.originalPath !== item.targetRelativePath) {
        result.set(item.id, {
          type: 'smb_case_collision',
          detail: `SMB Groß-/Kleinschreibungs-Kollision mit "${existingLower.originalPath}".`,
        });
        continue;
      }
      lowerSeen.set(lowerKey, { id: item.id, originalPath: item.targetRelativePath });
    }

    result.set(item.id, { type: 'none', detail: null });
  }

  return result;
}
