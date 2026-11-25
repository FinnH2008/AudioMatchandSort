import {
  AlbumReleaseCandidate,
  AudioCodec,
  AudioTrack,
  BackgroundQueueState,
  CompanionFile,
  LeftoverFile,
  PipelineConfig,
  RollbackJournal,
  SqliteCacheState,
} from '../types/tonarchiv';

export interface BackendHealthResponse {
  status: string;
  music_dir: string;
  music_dir_exists?: boolean;
  essentia_available: boolean;
  acoustid_configured: boolean;
  discogs_configured: boolean;
  shazamio_enabled: boolean;
  wav_embed_media: boolean;
  auto_analyze_on_start?: boolean;
  journal_state: RollbackJournal['state'];
  config?: Partial<PipelineConfig>;
}

export interface BackendStateResponse {
  tracks: AudioTrack[];
  companions: CompanionFile[];
  leftovers: LeftoverFile[];
  journal: RollbackJournal;
  cache: SqliteCacheState;
  queue?: BackgroundQueueState;
  mode1Completed: boolean;
  mode2Completed: boolean;
  mode3Completed: boolean;
  config?: Partial<PipelineConfig>;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    globalThis.clearTimeout(timer);
  }
}

function normalizeRelease(raw: unknown, fallbackDur = 0): AlbumReleaseCandidate | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const rawTracklist = Array.isArray(r.tracklist) ? r.tracklist : [];
  const tracklist = rawTracklist
    .map((item, idx) => {
      if (typeof item === 'string') {
        return { position: idx + 1, title: item, durationSec: fallbackDur };
      }
      if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        return {
          position: typeof obj.position === 'number' ? obj.position : idx + 1,
          title: String(obj.title ?? ''),
          durationSec: typeof obj.durationSec === 'number' ? obj.durationSec : fallbackDur,
        };
      }
      return null;
    })
    .filter((x): x is { position: number; title: string; durationSec: number } => x !== null);

  return {
    releaseId: String(r.releaseId ?? ''),
    title: String(r.title ?? ''),
    albumArtist: String(r.albumArtist ?? ''),
    year: String(r.year ?? ''),
    country: String(r.country ?? 'XW'),
    format: String(r.format ?? 'Digital Media'),
    trackCount: typeof r.trackCount === 'number' ? r.trackCount : 1,
    isCompilation: Boolean(r.isCompilation),
    isRemixAlbum: Boolean(r.isRemixAlbum),
    matchScore: typeof r.matchScore === 'number' ? r.matchScore : 0.85,
    tracklist,
  };
}

export function normalizeBackendTrack(raw: unknown): AudioTrack | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  if (!t.id) return null;

  const orig =
    t.originalTags && typeof t.originalTags === 'object'
      ? (t.originalTags as Record<string, unknown>)
      : {};
  const cov =
    t.cover && typeof t.cover === 'object' ? (t.cover as Record<string, unknown>) : {};
  const lyr =
    t.lyrics && typeof t.lyrics === 'object' ? (t.lyrics as Record<string, unknown>) : {};

  const sourceRelativePath = String(t.sourceRelativePath ?? t.fileName ?? '');
  const fileName = String(
    t.fileName ?? sourceRelativePath.split('/').pop() ?? 'Unbekannt'
  );
  const rawExt = String(t.extension ?? (fileName.includes('.') ? `.${fileName.split('.').pop()}` : '.mp3'));
  const extension = rawExt.startsWith('.') ? rawExt.toLowerCase() : `.${rawExt.toLowerCase()}`;
  const durationSec = Number(t.durationSec) || 0;
  const artist = String(t.artist ?? orig.artist ?? 'Unbekannter Künstler');
  const albumArtist = String(t.albumArtist ?? orig.albumArtist ?? artist);
  const title = String(t.title ?? orig.title ?? fileName.replace(/\.[^.]+$/, ''));

  const availableReleases = Array.isArray(t.availableReleases)
    ? t.availableReleases
        .map((rel) => normalizeRelease(rel, durationSec))
        .filter((rel): rel is AlbumReleaseCandidate => rel !== null)
    : [];

  return {
    id: String(t.id),
    sourceRelativePath,
    sourceDir: String(t.sourceDir ?? ''),
    fileName,
    extension,
    codec: (String(t.codec ?? 'mp3').toLowerCase() as AudioCodec),
    sizeBytes: Number(t.sizeBytes) || 0,
    mtimeIso: String(t.mtimeIso ?? '1970-01-01T00:00:00.000Z'),
    durationSec,
    bitrateKbps: Number(t.bitrateKbps) || 0,
    sampleRateHz: Number(t.sampleRateHz) || 44100,
    bitDepth: typeof t.bitDepth === 'number' ? t.bitDepth : null,
    spectralCutoffKhz: typeof t.spectralCutoffKhz === 'number' ? t.spectralCutoffKhz : null,
    spectralWarningOnly: Boolean(t.spectralWarningOnly),
    originalTags: {
      artist: String(orig.artist ?? ''),
      albumArtist: String(orig.albumArtist ?? ''),
      title: String(orig.title ?? ''),
      album: String(orig.album ?? ''),
      year: String(orig.year ?? ''),
      trackNumber: String(orig.trackNumber ?? ''),
      genre: String(orig.genre ?? ''),
      key: String(orig.key ?? ''),
      bpm: typeof orig.bpm === 'number' ? orig.bpm : null,
      compilation: Boolean(orig.compilation),
    },
    albumArtist,
    artist,
    title,
    album: String(t.album ?? orig.album ?? ''),
    year: String(t.year ?? orig.year ?? ''),
    trackNumber: String(t.trackNumber ?? orig.trackNumber ?? ''),
    genre: String(t.genre ?? orig.genre ?? ''),
    isrc: String(t.isrc ?? ''),
    compilationFlag: Boolean(t.compilationFlag),
    mbRecordingId: t.mbRecordingId ? String(t.mbRecordingId) : null,
    mbArtistId: t.mbArtistId ? String(t.mbArtistId) : null,
    acoustidId: t.acoustidId ? String(t.acoustidId) : null,
    acoustidConfidence: Number(t.acoustidConfidence) || 0,
    activeSource: (t.activeSource as AudioTrack['activeSource']) || 'musicbrainz',
    sourceCandidates: Array.isArray(t.sourceCandidates) ? (t.sourceCandidates as AudioTrack['sourceCandidates']) : [],
    cachedLookup: Boolean(t.cachedLookup),
    matchedRelease: normalizeRelease(t.matchedRelease, durationSec),
    availableReleases,
    inMatchedReleaseTracklist: Boolean(t.inMatchedReleaseTracklist),
    matchedReleaseTrackPos: typeof t.matchedReleaseTrackPos === 'number' ? t.matchedReleaseTrackPos : null,
    isRemixAlbumTrack: Boolean(t.isRemixAlbumTrack),
    detachedFromAlbum: Boolean(t.detachedFromAlbum),
    detachReason: t.detachReason ? String(t.detachReason) : null,
    musicalKey: String(t.musicalKey ?? '—'),
    camelotKey: String(t.camelotKey ?? '—'),
    bpm: typeof t.bpm === 'number' ? t.bpm : null,
    replayGainDb: typeof t.replayGainDb === 'number' ? t.replayGainDb : null,
    cover: {
      status: (cov.status as AudioTrack['cover']['status']) || 'missing',
      source: (cov.source as AudioTrack['cover']['source']) || 'Keine',
      resolution: String(cov.resolution ?? '—'),
      sizeKb: Number(cov.sizeKb) || 0,
      embeddedBefore: Boolean(cov.embeddedBefore),
      imageUrl: typeof cov.imageUrl === 'string' ? cov.imageUrl : undefined,
      fallbackGradient: String(cov.fallbackGradient ?? 'from-slate-800 to-slate-900'),
    },
    lyrics: {
      status: (lyr.status as AudioTrack['lyrics']['status']) || 'missing',
      source: (lyr.source as AudioTrack['lyrics']['source']) || 'Keine',
      syncedLrc: String(lyr.syncedLrc ?? ''),
      plainText: String(lyr.plainText ?? ''),
    },
    isLooseFile: Boolean(t.isLooseFile),
    manualAssignment: (t.manualAssignment as AudioTrack['manualAssignment']) || 'none',
    manualReleaseId: t.manualReleaseId ? String(t.manualReleaseId) : null,
    pendingReRunTagAndMove: Boolean(t.pendingReRunTagAndMove),
    status: (t.status as AudioTrack['status']) || 'pending',
    taggedAt: t.taggedAt ? String(t.taggedAt) : null,
    movedToPath: t.movedToPath ? String(t.movedToPath) : null,
    skippedInMode2Reason: t.skippedInMode2Reason ? String(t.skippedInMode2Reason) : null,
  };
}

export function normalizeBackendQueue(raw: unknown): BackgroundQueueState {
  const q = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const rawErrors = Array.isArray(q.errors) ? q.errors : [];
  return {
    activeMode: (q.activeMode as BackgroundQueueState['activeMode']) ?? null,
    status: (q.status as BackgroundQueueState['status']) ?? 'idle',
    processedCount: Number(q.processedCount) || 0,
    totalCount: Number(q.totalCount) || 0,
    errorCount: Number(q.errorCount) || 0,
    cacheHitCount: Number(q.cacheHitCount) || 0,
    etaSeconds: Number(q.etaSeconds) || 0,
    currentTrackLabel: String(q.currentTrackLabel ?? ''),
    checkpointIndex: Number(q.checkpointIndex) || 0,
    errors: rawErrors
      .filter((e) => e !== null && e !== undefined)
      .slice(-25)
      .map((e, idx) => {
        if (typeof e === 'string') {
          return {
            id: `err-${idx}`,
            stage: 'Pipeline',
            trackLabel: '',
            message: e,
            recovered: true,
          };
        }
        const item = typeof e === 'object' ? (e as Record<string, unknown>) : {};
        return {
          id: String(item.id ?? `err-${idx}`),
          stage: String(item.stage ?? 'Pipeline'),
          trackLabel: String(item.trackLabel ?? ''),
          message: String(item.message ?? ''),
          recovered: item.recovered !== false,
        };
      }),
  };
}

export function normalizeBackendState(raw: unknown): BackendStateResponse | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  const tracks = Array.isArray(s.tracks)
    ? s.tracks
        .map((item) => normalizeBackendTrack(item))
        .filter((item): item is AudioTrack => item !== null)
    : [];

  const j = s.journal && typeof s.journal === 'object' ? (s.journal as Record<string, unknown>) : {};
  const c = s.cache && typeof s.cache === 'object' ? (s.cache as Record<string, unknown>) : {};

  return {
    tracks,
    companions: Array.isArray(s.companions) ? (s.companions as CompanionFile[]) : [],
    leftovers: Array.isArray(s.leftovers) ? (s.leftovers as LeftoverFile[]) : [],
    journal: {
      runId: j.runId ? String(j.runId) : null,
      mode: (j.mode as RollbackJournal['mode']) ?? 'idle',
      state: (j.state as RollbackJournal['state']) ?? 'idle',
      backupConfirmedAt: j.backupConfirmedAt ? String(j.backupConfirmedAt) : null,
      lastFsyncIso: j.lastFsyncIso ? String(j.lastFsyncIso) : null,
      entries: Array.isArray(j.entries) ? (j.entries as RollbackJournal['entries']) : [],
      removedEmptyDirs: Array.isArray(j.removedEmptyDirs)
        ? (j.removedEmptyDirs as string[])
        : [],
    },
    cache: {
      dbPath: String(c.dbPath ?? '/config/cache.db'),
      fingerprintEntries: Number(c.fingerprintEntries) || 0,
      mbReleaseEntries: Number(c.mbReleaseEntries) || 0,
      coverEntries: Number(c.coverEntries) || 0,
      lyricsEntries: Number(c.lyricsEntries) || 0,
      lastCheckpointIso: c.lastCheckpointIso ? String(c.lastCheckpointIso) : null,
      interruptedAnalyzeCheckpoint:
        typeof c.interruptedAnalyzeCheckpoint === 'number'
          ? c.interruptedAnalyzeCheckpoint
          : null,
    },
    queue: s.queue ? normalizeBackendQueue(s.queue) : undefined,
    mode1Completed: Boolean(s.mode1Completed),
    mode2Completed: Boolean(s.mode2Completed),
    mode3Completed: Boolean(s.mode3Completed),
    config: s.config && typeof s.config === 'object' ? (s.config as Partial<PipelineConfig>) : undefined,
  };
}

export async function fetchBackendHealth(
  baseUrl = ''
): Promise<BackendHealthResponse | null> {
  try {
    const res = await fetchWithTimeout(
      `${normalizeBaseUrl(baseUrl)}/api/health`,
      { headers: { Accept: 'application/json' }, cache: 'no-store' },
      10_000
    );
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) return null;
    const data = (await res.json()) as BackendHealthResponse;
    return data && data.status === 'ok' ? data : null;
  } catch {
    return null;
  }
}

export async function fetchBackendState(
  baseUrl = ''
): Promise<BackendStateResponse | null> {
  try {
    const res = await fetchWithTimeout(
      `${normalizeBaseUrl(baseUrl)}/api/state`,
      { headers: { Accept: 'application/json' }, cache: 'no-store' },
      30_000
    );
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) return null;
    const raw = await res.json();
    return normalizeBackendState(raw);
  } catch {
    return null;
  }
}

export async function fetchBackendTrackDetail(
  baseUrl: string,
  trackId: string
): Promise<AudioTrack | null> {
  try {
    const res = await fetchWithTimeout(
      `${normalizeBaseUrl(baseUrl)}/api/tracks/${encodeURIComponent(trackId)}`,
      { headers: { Accept: 'application/json' }, cache: 'no-store' },
      10_000
    );
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) return null;
    return normalizeBackendTrack(await res.json());
  } catch {
    return null;
  }
}

export async function fetchBackendQueue(
  baseUrl = ''
): Promise<BackgroundQueueState | null> {
  try {
    const res = await fetchWithTimeout(
      `${normalizeBaseUrl(baseUrl)}/api/queue`,
      { headers: { Accept: 'application/json' }, cache: 'no-store' },
      8_000
    );
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) return null;
    return normalizeBackendQueue(await res.json());
  } catch {
    return null;
  }
}

export async function postBackendAction<T = Record<string, unknown>>(
  baseUrl: string,
  path: string,
  body?: unknown
): Promise<T | null> {
  try {
    const res = await fetchWithTimeout(
      `${normalizeBaseUrl(baseUrl)}${path}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
      60_000
    );
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
