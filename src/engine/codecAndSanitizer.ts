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

/**
 * Deterministically resolves exact path collisions, SMB case-insensitive collisions,
 * and overly long paths (> maxPathLength) by shortening long intermediate segments or
 * appending SMB-safe numeric suffixes " (2)", " (3)", ... without ever overwriting.
 */
export function ensureUniqueRelativePaths(
  plannedPaths: Array<{ id: string; targetRelativePath: string; tooLong: boolean }>,
  maxPathLength: number,
  smbCaseSafe: boolean
): Map<string, { targetRelativePath: string; changed: boolean; tooLong: boolean }> {
  const resolved = new Map<string, { targetRelativePath: string; changed: boolean; tooLong: boolean }>();
  const usedExact = new Set<string>();
  const usedLower = new Set<string>();

  const isTaken = (candidate: string): boolean => {
    if (usedExact.has(candidate)) return true;
    if (smbCaseSafe && usedLower.has(candidate.toLowerCase())) return true;
    return false;
  };

  const splitPath = (relPath: string): { dir: string; stem: string; ext: string } => {
    const slashIdx = relPath.lastIndexOf('/');
    const dir = slashIdx >= 0 ? relPath.slice(0, slashIdx) : '';
    const file = slashIdx >= 0 ? relPath.slice(slashIdx + 1) : relPath;
    const dotIdx = file.lastIndexOf('.');
    if (dotIdx > 0) {
      return { dir, stem: file.slice(0, dotIdx), ext: file.slice(dotIdx) };
    }
    return { dir, stem: file, ext: '' };
  };

  const fitLength = (dir: string, stem: string, suffix: string, ext: string): string => {
    const cleanDir = dir;
    const prefix = cleanDir ? `${cleanDir}/` : '';
    const allowedStem = maxPathLength - prefix.length - suffix.length - ext.length;
    if (allowedStem >= 8) {
      const clippedStem = stem.slice(0, allowedStem).replace(/[. ]+$/g, '') || 'Track';
      return `${prefix}${clippedStem}${suffix}${ext}`;
    }
    // Deep directory chain exceeded maxPathLength (e.g., nested _Review/...): keep root bucket + leaf folder
    const segs = cleanDir.split('/').filter(Boolean);
    const compactDir =
      segs.length >= 3
        ? `${segs[0]}/${segs[1]}/${segs[segs.length - 1].slice(0, 40)}`
        : segs.map((s) => s.slice(0, 40)).join('/');
    const compactPrefix = compactDir ? `${compactDir}/` : '';
    const compactAllowed = Math.max(8, maxPathLength - compactPrefix.length - suffix.length - ext.length);
    const clippedStem = stem.slice(0, compactAllowed).replace(/[. ]+$/g, '') || 'Track';
    return `${compactPrefix}${clippedStem}${suffix}${ext}`;
  };

  for (const item of plannedPaths) {
    let candidate = item.targetRelativePath;
    let changed = false;

    if (item.tooLong || candidate.length > maxPathLength) {
      const { dir, stem, ext } = splitPath(candidate);
      candidate = fitLength(dir, stem, '', ext);
      changed = true;
    }

    if (isTaken(candidate)) {
      const { dir, stem, ext } = splitPath(candidate);
      let counter = 2;
      while (counter < 10_000) {
        const nextCandidate = fitLength(dir, stem, ` (${counter})`, ext);
        if (!isTaken(nextCandidate)) {
          candidate = nextCandidate;
          changed = true;
          break;
        }
        counter += 1;
      }
    }

    usedExact.add(candidate);
    if (smbCaseSafe) {
      usedLower.add(candidate.toLowerCase());
    }
    resolved.set(item.id, {
      targetRelativePath: candidate,
      changed,
      tooLong: candidate.length > maxPathLength,
    });
  }

  return resolved;
}

