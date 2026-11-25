import {
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

export async function fetchBackendHealth(
  baseUrl = ''
): Promise<BackendHealthResponse | null> {
  try {
    const res = await fetch(`${normalizeBaseUrl(baseUrl)}/api/health`, {
      headers: { Accept: 'application/json' },
    });
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
    const res = await fetch(`${normalizeBaseUrl(baseUrl)}/api/state`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) return null;
    return (await res.json()) as BackendStateResponse;
  } catch {
    return null;
  }
}

export async function fetchBackendQueue(
  baseUrl = ''
): Promise<BackgroundQueueState | null> {
  try {
    const res = await fetch(`${normalizeBaseUrl(baseUrl)}/api/queue`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) return null;
    return (await res.json()) as BackgroundQueueState;
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
    const res = await fetch(`${normalizeBaseUrl(baseUrl)}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
