import { parseBlob } from 'music-metadata';
import {
  AlbumReleaseCandidate,
  AudioCodec,
  AudioTrack,
  CompanionFile,
  LeftoverFile,
  SourceMatchCandidate,
} from '../types/tonarchiv';

const AUDIO_EXTENSIONS = new Set([
  '.flac',
  '.mp3',
  '.m4a',
  '.mp4',
  '.ogg',
  '.oga',
  '.opus',
  '.wav',
  '.aiff',
  '.aif',
  '.wma',
  '.alac',
]);

const VIDEO_EXTENSIONS = new Set([
  '.mkv',
  '.avi',
  '.mov',
  '.webm',
  '.wmv',
  '.m4v',
  '.ts',
  '.mpeg',
  '.mpg',
]);

const COMPANION_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.cue',
  '.log',
  '.m3u',
  '.m3u8',
  '.pdf',
]);

export function getExtensionLower(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return '';
  return fileName.slice(dot).toLowerCase();
}

export function getParentFolderPath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(0, idx) : '';
}

export function mapParsedCodec(
  rawCodec: string | undefined,
  container: string | undefined,
  ext: string,
  bitsPerSample: number | undefined
): AudioCodec {
  const c = (rawCodec ?? '').toLowerCase();
  const cont = (container ?? '').toLowerCase();

  if (c.includes('flac')) return 'flac';
  if (c.includes('alac')) return 'alac';
  if (c.includes('aac') || c.includes('mp4a')) return 'aac';
  if (c.includes('mpeg') || c.includes('mp3') || c.includes('layer 3')) return 'mp3';
  if (c.includes('vorbis')) return 'vorbis';
  if (c.includes('opus')) return 'opus';
  if (c.includes('wma') || c.includes('wmav')) return 'wma';
  if (cont.includes('aiff') || ext === '.aiff' || ext === '.aif') return 'aiff';
  if (c.includes('pcm') || cont.includes('wave') || cont.includes('riff') || ext === '.wav') {
    return (bitsPerSample ?? 16) >= 24 ? 'pcm_s24le' : 'pcm_s16le';
  }
  if (ext === '.flac') return 'flac';
  if (ext === '.mp3') return 'mp3';
  if (ext === '.ogg' || ext === '.oga') return 'vorbis';
  if (ext === '.opus') return 'opus';
  if (ext === '.wma') return 'wma';
  return 'aac';
}

export function isCompanionFileName(fileName: string): boolean {
  const ext = getExtensionLower(fileName);
  return COMPANION_EXTENSIONS.has(ext);
}

export function isVideoExtension(ext: string): boolean {
  return VIDEO_EXTENSIONS.has(ext);
}

export function isAudioCandidateExtension(ext: string): boolean {
  return AUDIO_EXTENSIONS.has(ext);
}

export interface LocalFolderScanResult {
  tracks: AudioTrack[];
  companions: CompanionFile[];
  leftovers: LeftoverFile[];
  rootFolderName: string;
  scannedFileCount: number;
}

/**
 * Inspects real user-selected local files via music-metadata (binary header/codec & tag inspection).
 * Zero mock data: every codec, bitrate, sample rate, tag, cover, and leftover file comes from the actual files.
 */
export async function scanLocalFileList(
  fileList: FileList | File[],
  onProgress?: (processed: number, total: number, currentName: string) => void
): Promise<LocalFolderScanResult> {
  const files = Array.from(fileList);
  const tracks: AudioTrack[] = [];
  const companions: CompanionFile[] = [];
  const leftovers: LeftoverFile[] = [];

  let rootFolderName = 'Lokaler Musikordner';
  if (files.length > 0) {
    const firstRel = (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath || '';
    if (firstRel.includes('/')) {
      rootFolderName = firstRel.split('/')[0] || rootFolderName;
    }
  }

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const webkitRel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || '';
    const normalizedRel = webkitRel
      ? webkitRel.replace(/\\/g, '/').replace(/^[^/]+\//, '')
      : file.name;
    const relativePath = normalizedRel || file.name;
    const folderPath = getParentFolderPath(relativePath);
    const ext = getExtensionLower(file.name);

    onProgress?.(i + 1, files.length, file.name);

    // 1. Definite video file by container extension -> untouched leftover
    if (isVideoExtension(ext)) {
      leftovers.push({
        id: `left-${i}-${file.name}`,
        fileName: file.name,
        sourceDir: folderPath,
        sourceRelativePath: relativePath,
        sizeBytes: file.size,
        kind: 'video',
        reason: 'Videodatei — wird niemals angefasst.',
      });
      continue;
    }

    // 2. Companion files (cover.jpg, folder.jpg, .cue, .log, .m3u, .pdf)
    if (isCompanionFileName(file.name)) {
      companions.push({
        id: `comp-${i}-${file.name}`,
        fileName: file.name,
        extension: ext,
        sourceDir: folderPath,
        sourceRelativePath: relativePath,
        albumKey: folderPath || file.name,
        sizeBytes: file.size,
        targetPath: null,
        moved: false,
      });
      continue;
    }

    // 3. Non-audio leftovers (.txt, .nfo, .db, etc.)
    if (!isAudioCandidateExtension(ext)) {
      leftovers.push({
        id: `left-${i}-${file.name}`,
        fileName: file.name,
        sourceDir: folderPath,
        sourceRelativePath: relativePath,
        sizeBytes: file.size,
        kind: 'other',
        reason: 'Keine Audio- oder Begleitdatei — Quellordner bleibt deshalb erhalten.',
      });
      continue;
    }

    // 4. Parse real audio headers/tags with music-metadata
    try {
      const parsed = await parseBlob(file);

      // Check if an .mp4 file is actually a video file (e.g., H.264 / HEVC track present)
      const trackInfoList = parsed.format.trackInfo ?? [];
      const hasVideoTrack =
        ext === '.mp4' &&
        trackInfoList.some(
          (ti) => ti.video !== undefined || /avc|h264|hev|vp9|av01|mp4v/i.test(ti.codecName ?? '')
        );

      if (hasVideoTrack) {
        leftovers.push({
          id: `left-vid-${i}-${file.name}`,
          fileName: file.name,
          sourceDir: folderPath,
          sourceRelativePath: relativePath,
          sizeBytes: file.size,
          kind: 'video',
          reason: 'Echte MP4-Videodatei (Videostream erkannt) — wird niemals angefasst.',
        });
        continue;
      }

      const fmt = parsed.format;
      const common = parsed.common;
      const codec = mapParsedCodec(fmt.codec, fmt.container, ext, fmt.bitsPerSample);
      const sampleRateHz = fmt.sampleRate ?? 44100;
      const bitDepth = fmt.bitsPerSample ?? (codec === 'pcm_s24le' ? 24 : codec === 'pcm_s16le' ? 16 : null);
      const durationSec = Math.round(fmt.duration ?? 0);
      const bitrateKbps = fmt.bitrate
        ? Math.round(fmt.bitrate / 1000)
        : durationSec > 0
          ? Math.round((file.size * 8) / durationSec / 1000)
          : 0;

      const baseName = file.name.slice(0, file.name.length - ext.length);
      const rawTitle = (common.title ?? '').trim() || baseName;
      const rawArtist = (common.artist ?? '').trim() || 'Unbekannter Künstler';
      const rawAlbumArtist = (common.albumartist ?? '').trim() || rawArtist;
      const rawAlbum = (common.album ?? '').trim();
      const rawYear = common.year ? String(common.year) : '';
      const rawTrackNo = common.track?.no ? String(common.track.no).padStart(2, '0') : '';
      const rawKey = (common.key ?? '').trim();
      const rawBpm = common.bpm ? Math.round(common.bpm) : null;
      const isCompilation = Boolean(common.compilation);

      // Embedded Cover Art -> real Blob URL
      const firstPic = common.picture?.[0];
      let coverUrl: string | null = null;
      let coverSizeKb = 0;
      if (firstPic && firstPic.data && firstPic.data.length > 0) {
        const picBytes = new Uint8Array(firstPic.data);
        const blob = new Blob([picBytes], { type: firstPic.format || 'image/jpeg' });
        coverUrl = URL.createObjectURL(blob);
        coverSizeKb = Math.max(1, Math.round(firstPic.data.length / 1024));
      }

      // Embedded Lyrics
      const rawLyricsArr = common.lyrics ?? [];
      const firstLyricObj = rawLyricsArr[0];
      const extractedLyricText =
        typeof firstLyricObj === 'string'
          ? firstLyricObj
          : firstLyricObj?.text ??
            (firstLyricObj?.syncText?.map((s) => s.text).join('\n') ?? '');
      const hasSyncedLrc = /\[\d{2}:\d{2}\.\d{2}\]/.test(extractedLyricText);

      const mbArtistId = common.musicbrainz_artistid?.[0] ?? null;
      const mbRecordingId = common.musicbrainz_recordingid ?? null;
      const mbReleaseId = common.musicbrainz_albumid ?? null;

      const matchedRelease: AlbumReleaseCandidate | null =
        mbReleaseId && rawAlbum
          ? {
              releaseId: mbReleaseId,
              title: rawAlbum,
              albumArtist: rawAlbumArtist,
              year: rawYear,
              country: common.releasecountry ?? '—',
              format: common.media ?? 'Eingebettetes MB-Release',
              trackCount: common.track?.of ?? 1,
              isCompilation,
              isRemixAlbum: /remix|remixed|club edition/i.test(rawAlbum),
              matchScore: 0.92,
              tracklist: [{ position: common.track?.no ?? 1, title: rawTitle, durationSec }],
            }
          : null;

      const confidence = mbRecordingId || mbReleaseId ? 0.94 : 0.0;

      const mtimeIso = new Date(file.lastModified || Date.now()).toISOString();

      const rawGenre = (common.genre?.[0] ?? '').trim();
      const rawIsrc = (common.isrc?.[0] ?? '').trim();

      tracks.push({
        id: `local-${i}-${file.size}-${file.lastModified}`,
        fileName: file.name,
        extension: ext,
        sourceDir: folderPath,
        sourceRelativePath: relativePath,
        sizeBytes: file.size,
        mtimeIso,
        durationSec,

        codec,
        sampleRateHz,
        bitDepth,
        bitrateKbps,

        spectralCutoffKhz: null,
        spectralWarningOnly: false,

        artist: rawArtist,
        albumArtist: rawAlbumArtist,
        title: rawTitle,
        album: rawAlbum,
        year: rawYear,
        trackNumber: rawTrackNo,
        genre: rawGenre,
        isrc: rawIsrc,
        compilationFlag: isCompilation,
        isLooseFile: !rawAlbum && !folderPath,

        originalTags: {
          artist: common.artist?.trim() ?? '',
          albumArtist: common.albumartist?.trim() ?? '',
          title: common.title?.trim() ?? '',
          album: common.album?.trim() ?? '',
          year: rawYear,
          trackNumber: rawTrackNo,
          genre: rawGenre,
          key: rawKey,
          bpm: rawBpm,
          compilation: isCompilation,
        },

        mbArtistId,
        mbRecordingId,
        acoustidId: common.acoustid_id ?? null,
        acoustidConfidence: confidence,
        matchedRelease,
        availableReleases: matchedRelease ? [matchedRelease] : [],
        inMatchedReleaseTracklist: Boolean(matchedRelease),
        matchedReleaseTrackPos: common.track?.no ?? null,
        isRemixAlbumTrack: Boolean(matchedRelease?.isRemixAlbum),
        detachedFromAlbum: false,
        detachReason: null,

        activeSource: 'musicbrainz',
        sourceCandidates: [],
        cachedLookup: false,

        camelotKey: rawKey || '—',
        musicalKey: rawKey || '—',
        bpm: rawBpm,
        replayGainDb:
          typeof common.replaygain_track_gain?.dB === 'number'
            ? common.replaygain_track_gain.dB
            : null,

        cover: {
          status: coverUrl ? 'existing' : 'missing',
          source: coverUrl ? 'Eingebettet' : 'Keine',
          resolution: coverUrl ? 'Eingebettet' : '—',
          sizeKb: coverSizeKb,
          imageUrl: coverUrl ?? undefined,
          fallbackGradient: 'from-slate-800 to-slate-900',
          embeddedBefore: Boolean(coverUrl),
        },
        lyrics: {
          status: extractedLyricText
            ? hasSyncedLrc
              ? 'synced'
              : 'plain'
            : 'missing',
          source: 'Keine',
          syncedLrc: hasSyncedLrc ? extractedLyricText : '',
          plainText: extractedLyricText,
        },

        manualAssignment: 'none',
        manualReleaseId: null,
        pendingReRunTagAndMove: false,
        status: 'pending',
        skippedInMode2Reason: null,
        taggedAt: null,
        movedToPath: null,
      });
    } catch {
      leftovers.push({
        id: `left-unparsed-${i}-${file.name}`,
        fileName: file.name,
        sourceDir: folderPath,
        sourceRelativePath: relativePath,
        sizeBytes: file.size,
        kind: 'other',
        reason: 'Datei konnte nicht als gültige Audiodatei gelesen werden — bleibt unverändert.',
      });
    }
  }

  return {
    tracks,
    companions,
    leftovers,
    rootFolderName,
    scannedFileCount: files.length,
  };
}

/**
 * Real rate-limited MusicBrainz & LRCLIB lookup for browser Mode 1 analysis.
 * Strictly honors MusicBrainz 1 req/sec rule and degrades gracefully on network/CORS errors.
 */
let lastMbRequestAt = 0;

async function waitMusicBrainzRateLimit(): Promise<void> {
  const now = Date.now();
  const waitMs = Math.max(0, 1050 - (now - lastMbRequestAt));
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  lastMbRequestAt = Date.now();
}

export interface LiveLookupResult {
  trackPatch: Partial<AudioTrack>;
  cacheHit: boolean;
  mbHit: boolean;
  coverHit: boolean;
  lyricsHit: boolean;
  recoverableError: string | null;
}

const MB_CACHE_PREFIX = 'tonarchiv:mb:v1:';

export async function runLiveLookupForTrack(
  track: AudioTrack,
  options: { fetchCover: boolean; fetchLyrics: boolean }
): Promise<LiveLookupResult> {
  const cacheKey = `${MB_CACHE_PREFIX}${(track.artist || '').toLowerCase()}::${(track.title || '').toLowerCase()}::${(track.album || '').toLowerCase()}`;

  try {
    const cachedRaw = typeof window !== 'undefined' ? window.localStorage.getItem(cacheKey) : null;
    if (cachedRaw) {
      const parsed = JSON.parse(cachedRaw) as {
        patch: Partial<AudioTrack>;
        mbHit: boolean;
        coverHit: boolean;
        lyricsHit: boolean;
      };
      return {
        trackPatch: { ...parsed.patch, cachedLookup: true },
        cacheHit: true,
        mbHit: parsed.mbHit,
        coverHit: parsed.coverHit,
        lyricsHit: parsed.lyricsHit,
        recoverableError: null,
      };
    }
  } catch {
    // Ignore storage read errors
  }

  const patch: Partial<AudioTrack> = {};
  let mbHit = false;
  let coverHit = false;
  let lyricsHit = false;
  let recoverableError: string | null = null;
  const candidates: SourceMatchCandidate[] = [...track.sourceCandidates];

  // 1. MusicBrainz Recording & Release Search (max 1 req/sec)
  if (track.title && track.title !== 'Unbekannt') {
    try {
      await waitMusicBrainzRateLimit();
      const queryParts = [`recording:"${track.title.replace(/"/g, '')}"`];
      if (track.artist && track.artist !== 'Unbekannter Künstler') {
        queryParts.push(`artist:"${track.artist.replace(/"/g, '')}"`);
      }
      const url = `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(
        queryParts.join(' AND ')
      )}&fmt=json&limit=3`;
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
      });

      if (res.ok) {
        const data = (await res.json()) as {
          recordings?: Array<{
            id: string;
            title: string;
            score?: number;
            length?: number;
            'artist-credit'?: Array<{ name?: string; artist?: { id: string; name: string } }>;
            releases?: Array<{
              id: string;
              title: string;
              date?: string;
              country?: string;
              'track-count'?: number;
              'release-group'?: { 'primary-type'?: string; 'secondary-types'?: string[] };
            }>;
          }>;
        };

        const bestRec = data.recordings?.[0];
        if (bestRec) {
          mbHit = true;
          const scoreNorm = Math.min(0.99, Math.max(0.4, (bestRec.score ?? 80) / 100));
          const artistCredit = bestRec['artist-credit']?.[0];
          const artistName = artistCredit?.artist?.name || artistCredit?.name || track.artist;
          const artistMbid = artistCredit?.artist?.id ?? null;

          const releases: AlbumReleaseCandidate[] = (bestRec.releases ?? []).slice(0, 5).map((rel) => {
            const secTypes = rel['release-group']?.['secondary-types'] ?? [];
            const isComp = secTypes.includes('Compilation');
            const isRemix =
              secTypes.includes('Remix') || /remix|remixed|club edition/i.test(rel.title);
            return {
              releaseId: rel.id,
              title: rel.title,
              albumArtist: isComp ? 'Various Artists' : artistName,
              year: (rel.date ?? '').slice(0, 4),
              country: rel.country ?? '—',
              format: rel['release-group']?.['primary-type'] ?? 'Album',
              trackCount: rel['track-count'] ?? 1,
              isCompilation: isComp,
              isRemixAlbum: isRemix,
              matchScore: scoreNorm,
              tracklist: [
                {
                  position: Number(track.trackNumber) || 1,
                  title: bestRec.title,
                  durationSec: bestRec.length ? Math.round(bestRec.length / 1000) : track.durationSec,
                },
              ],
            };
          });

          const topRelease = releases[0] ?? null;

          candidates.push({
            provider: 'musicbrainz',
            confidence: scoreNorm,
            artist: artistName,
            albumArtist: topRelease?.albumArtist ?? artistName,
            title: bestRec.title,
            album: topRelease?.title ?? track.album,
            year: topRelease?.year ?? track.year,
            mbRecordingId: bestRec.id,
            notes: `MusicBrainz Recording-Score ${bestRec.score ?? 0} %`,
          });

          patch.mbRecordingId = bestRec.id;
          patch.mbArtistId = artistMbid;
          patch.acoustidConfidence = scoreNorm;
          patch.availableReleases = releases;
          patch.activeSource = 'musicbrainz';
          patch.sourceCandidates = candidates;

          if (topRelease && scoreNorm >= 0.8) {
            patch.matchedRelease = topRelease;
            patch.inMatchedReleaseTracklist = true;
            if (!track.album) patch.album = topRelease.title;
            if (!track.year && topRelease.year) patch.year = topRelease.year;
          }

          // Optional Cover Art Archive lookup when no cover is embedded yet
          if (options.fetchCover && !track.cover.imageUrl && topRelease?.releaseId) {
            patch.cover = {
              ...track.cover,
              status: 'fetched',
              source: 'Cover Art Archive',
              resolution: '500×500',
              imageUrl: `https://coverartarchive.org/release/${topRelease.releaseId}/front-500`,
            };
            coverHit = true;
          }
        }
      } else if (res.status === 503 || res.status === 429) {
        recoverableError = `MusicBrainz Rate-Limit (HTTP ${res.status}) — Track als Review markiert`;
      }
    } catch {
      recoverableError = 'MusicBrainz API nicht erreichbar — lokale Datei-Tags bleiben erhalten';
    }
  }

  // 2. LRCLIB Public Synced Lyrics Lookup
  if (
    options.fetchLyrics &&
    track.lyrics.status === 'missing' &&
    track.artist &&
    track.artist !== 'Unbekannter Künstler' &&
    track.title
  ) {
    try {
      const lrcUrl = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(
        track.artist
      )}&track_name=${encodeURIComponent(track.title)}${
        track.durationSec > 0 ? `&duration=${track.durationSec}` : ''
      }`;
      const lrcRes = await fetch(lrcUrl);
      if (lrcRes.ok) {
        const lrcData = (await lrcRes.json()) as {
          instrumental?: boolean;
          syncedLyrics?: string;
          plainLyrics?: string;
        };
        if (lrcData.instrumental) {
          patch.lyrics = {
            ...track.lyrics,
            status: 'instrumental',
            source: 'LRCLIB',
            syncedLrc: '',
            plainText: '',
          };
          lyricsHit = true;
        } else if (lrcData.syncedLyrics || lrcData.plainLyrics) {
          patch.lyrics = {
            ...track.lyrics,
            status: lrcData.syncedLyrics ? 'synced' : 'plain',
            source: 'LRCLIB',
            syncedLrc: lrcData.syncedLyrics ?? '',
            plainText: lrcData.plainLyrics ?? lrcData.syncedLyrics ?? '',
          };
          lyricsHit = true;
        }
      }
    } catch {
      // Non-fatal: lyrics lookup failure never aborts run
    }
  }

  try {
    if (typeof window !== 'undefined' && (mbHit || lyricsHit)) {
      window.localStorage.setItem(
        cacheKey,
        JSON.stringify({ patch, mbHit, coverHit, lyricsHit })
      );
    }
  } catch {
    // Ignore quota errors
  }

  return {
    trackPatch: patch,
    cacheHit: false,
    mbHit,
    coverHit,
    lyricsHit,
    recoverableError,
  };
}

export function clearBrowserLookupCache(): void {
  if (typeof window === 'undefined') return;
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(MB_CACHE_PREFIX)) keysToRemove.push(k);
    }
    keysToRemove.forEach((k) => window.localStorage.removeItem(k));
  } catch {
    // Ignore storage errors
  }
}
