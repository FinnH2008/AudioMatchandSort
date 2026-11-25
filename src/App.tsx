import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArtistDedupeView } from './components/ArtistDedupeView';
import { BackupConfirmModal } from './components/BackupConfirmModal';
import { DockerExportView } from './components/DockerExportView';
import { DuplicatesView } from './components/DuplicatesView';
import { LibraryFilterId, LibraryView } from './components/LibraryView';
import { PipelineAndCacheView } from './components/PipelineAndCacheView';
import { RulesAndFoldersView } from './components/RulesAndFoldersView';
import { NavSectionId, Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { TrackInspectorDrawer } from './components/TrackInspectorDrawer';
import {
  fetchBackendHealth,
  fetchBackendQueue,
  fetchBackendState,
  fetchBackendTrackDetail,
  postBackendAction,
} from './engine/apiClient';
import { ArtistResolutionOverrides } from './engine/artistDedupe';
import {
  computeNextModeAction,
  DuplicateOverrides,
  evaluateLibraryPlan,
} from './engine/classifierAndPlanner';
import {
  clearBrowserLookupCache,
  runLiveLookupForTrack,
  scanLocalFileList,
} from './engine/localFolderScanner';
import {
  ArtistClusterStatus,
  AudioTrack,
  BackgroundQueueState,
  CompanionFile,
  DEFAULT_CONFIG,
  DuplicateDecision,
  LeftoverFile,
  ManualAssignment,
  PipelineConfig,
  RollbackJournal,
  SourceProvider,
  SqliteCacheState,
} from './types/tonarchiv';

const INITIAL_QUEUE: BackgroundQueueState = {
  activeMode: null,
  status: 'idle',
  processedCount: 0,
  totalCount: 0,
  errorCount: 0,
  cacheHitCount: 0,
  etaSeconds: 0,
  currentTrackLabel: '',
  checkpointIndex: 0,
  errors: [],
};

const INITIAL_JOURNAL: RollbackJournal = {
  runId: null,
  mode: 'idle',
  state: 'idle',
  backupConfirmedAt: null,
  lastFsyncIso: null,
  entries: [],
  removedEmptyDirs: [],
};

const INITIAL_CACHE: SqliteCacheState = {
  dbPath: '/config/cache.db',
  fingerprintEntries: 0,
  mbReleaseEntries: 0,
  coverEntries: 0,
  lyricsEntries: 0,
  lastCheckpointIso: null,
  interruptedAnalyzeCheckpoint: null,
};

export default function App() {
  const [activeSection, setActiveSection] = useState<NavSectionId>('library');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [config, setConfig] = useState<PipelineConfig>(DEFAULT_CONFIG);
  const [tracks, setTracks] = useState<AudioTrack[]>([]);
  const [companions, setCompanions] = useState<CompanionFile[]>([]);
  const [leftovers, setLeftovers] = useState<LeftoverFile[]>([]);

  // Production source state
  const [backendUrl, setBackendUrl] = useState('');
  const [backendConnected, setBackendConnected] = useState(false);
  const [backendChecking, setBackendChecking] = useState(false);
  const [musicDirExists, setMusicDirExists] = useState<boolean | null>(null);
  const [importingFiles, setImportingFiles] = useState(false);
  const [importProgressLabel, setImportProgressLabel] = useState('');
  const [activeSourceLabel, setActiveSourceLabel] = useState<string | null>(null);

  const [artistOverrides, setArtistOverrides] = useState<ArtistResolutionOverrides>(() => {
    if (typeof window === 'undefined') return { decisions: {}, renamedCanonical: {} };
    try {
      const raw = window.localStorage.getItem('tonarchiv:artistOverrides');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          return {
            decisions: parsed.decisions && typeof parsed.decisions === 'object' ? parsed.decisions : {},
            renamedCanonical:
              parsed.renamedCanonical && typeof parsed.renamedCanonical === 'object'
                ? parsed.renamedCanonical
                : {},
          };
        }
      }
    } catch {
      // ignore storage errors
    }
    return { decisions: {}, renamedCanonical: {} };
  });
  const [duplicateOverrides, setDuplicateOverrides] = useState<DuplicateOverrides>(() => {
    if (typeof window === 'undefined') return { decisions: {}, selectedOriginals: {} };
    try {
      const raw = window.localStorage.getItem('tonarchiv:duplicateOverrides');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          return {
            decisions: parsed.decisions && typeof parsed.decisions === 'object' ? parsed.decisions : {},
            selectedOriginals:
              parsed.selectedOriginals && typeof parsed.selectedOriginals === 'object'
                ? parsed.selectedOriginals
                : {},
          };
        }
      }
    } catch {
      // ignore storage errors
    }
    return { decisions: {}, selectedOriginals: {} };
  });

  useEffect(() => {
    try {
      window.localStorage.setItem('tonarchiv:artistOverrides', JSON.stringify(artistOverrides));
    } catch {
      // ignore quota errors
    }
  }, [artistOverrides]);

  useEffect(() => {
    try {
      window.localStorage.setItem('tonarchiv:duplicateOverrides', JSON.stringify(duplicateOverrides));
    } catch {
      // ignore quota errors
    }
  }, [duplicateOverrides]);

  // 3 sequential modes state
  const [mode1Completed, setMode1Completed] = useState(false);
  const [mode2Completed, setMode2Completed] = useState(false);
  const [mode3Completed, setMode3Completed] = useState(false);

  const [queue, setQueue] = useState<BackgroundQueueState>(INITIAL_QUEUE);
  const [journal, setJournal] = useState<RollbackJournal>(INITIAL_JOURNAL);
  const [cache, setCache] = useState<SqliteCacheState>(INITIAL_CACHE);

  // UI filters & modals
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<LibraryFilterId>('all');
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [backupModalOpen, setBackupModalOpen] = useState(false);
  const [pendingModeAfterBackup, setPendingModeAfterBackup] = useState<'tag' | 'rerun' | null>(
    null
  );
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const pauseRef = useRef(false);
  const abortRunRef = useRef(false);
  const coverObjectUrlsRef = useRef<string[]>([]);

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    window.setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 2800);
  }, []);

  const revokeCoverUrls = useCallback(() => {
    coverObjectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    coverObjectUrlsRef.current = [];
  }, []);

  useEffect(() => {
    return () => {
      abortRunRef.current = true;
      revokeCoverUrls();
    };
  }, [revokeCoverUrls]);

  // Connect to real FastAPI Single-Container backend if available (with in-flight mutex)
  const inFlightStateSyncRef = useRef(false);
  const pendingStateSyncRef = useRef(false);
  const trackCountRef = useRef(0);
  trackCountRef.current = tracks.length;

  const checkAndLoadBackend = useCallback(
    async (targetUrl: string, silent = false) => {
      if (inFlightStateSyncRef.current) {
        pendingStateSyncRef.current = true;
        return;
      }
      inFlightStateSyncRef.current = true;
      setBackendChecking(true);
      try {
        const health = await fetchBackendHealth(targetUrl);
        if (!health) {
          setBackendConnected(false);
          setMusicDirExists(null);
          if (!silent) {
            showToast(
              'Kein TonArchiv FastAPI-Backend erreichbar. Nutze den lokalen Ordner-Scan oder starte den Docker-Container.'
            );
          }
          return;
        }

        setBackendConnected(true);
        setMusicDirExists(health.music_dir_exists ?? null);
        if (targetUrl.trim() && typeof window !== 'undefined') {
          try {
            window.localStorage.setItem('tonarchiv:backendUrl', targetUrl.trim());
          } catch {
            // Ignore storage quota errors
          }
        }
        setConfig((prev) => ({
          ...prev,
          ...(health.config ?? {}),
          containerMusicDir: health.music_dir || prev.containerMusicDir,
          essentiaAvailable: health.essentia_available,
          acoustidKeyConfigured: health.acoustid_configured,
          discogsTokenConfigured: health.discogs_configured,
          enableShazamFallback: health.shazamio_enabled,
          wavEmbedMedia: health.wav_embed_media,
        }));

        const state = await fetchBackendState(targetUrl);
        if (state) {
          revokeCoverUrls();
          if (state.config) {
            setConfig((prev) => ({ ...prev, ...state.config }));
          }
          setTracks(state.tracks ?? []);
          setCompanions(state.companions ?? []);
          setLeftovers(state.leftovers ?? []);
          setJournal(state.journal ?? INITIAL_JOURNAL);
          setCache(state.cache ?? INITIAL_CACHE);
          if (state.queue) {
            setQueue(state.queue);
          }
          const qDone = state.queue?.status === 'completed';
          const qMode = state.queue?.activeMode;
          setMode1Completed(
            Boolean(state.mode1Completed) ||
              Boolean(state.mode2Completed) ||
              Boolean(state.mode3Completed) ||
              (qDone && (qMode === 'analyze' || qMode === 'tag' || qMode === 'move'))
          );
          setMode2Completed(
            Boolean(state.mode2Completed) ||
              Boolean(state.mode3Completed) ||
              (qDone && (qMode === 'tag' || qMode === 'move'))
          );
          setMode3Completed(Boolean(state.mode3Completed) || (qDone && qMode === 'move'));
          setActiveSourceLabel(health.music_dir || '/music');
        }

        if (!silent) {
          showToast(`Mit TonArchiv FastAPI-Backend (${health.music_dir}) verbunden.`);
        }
      } finally {
        inFlightStateSyncRef.current = false;
        setBackendChecking(false);
        if (pendingStateSyncRef.current) {
          pendingStateSyncRef.current = false;
          void checkAndLoadBackend(targetUrl, true);
        }
      }
    },
    [revokeCoverUrls, showToast]
  );

  useEffect(() => {
    const savedBackendUrl =
      typeof window !== 'undefined' ? window.localStorage.getItem('tonarchiv:backendUrl') : null;
    if (savedBackendUrl) {
      setBackendUrl(savedBackendUrl);
      void checkAndLoadBackend(savedBackendUrl, true);
    } else if (import.meta.env.PROD) {
      void checkAndLoadBackend('', true);
    }
  }, [checkAndLoadBackend]);

  // Live polling when FastAPI background queue is active:
  // Polls ONLY lightweight /api/queue every 2s (no overlapping fetches, no 10s full-state hammering on mobile).
  // Syncs full /api/state once when initial tracks appear or when the job finishes/errors.
  const queuePollBusyRef = useRef(false);
  const lastEmptyTrackSyncRef = useRef(0);
  useEffect(() => {
    if (!backendConnected) return;
    if (queue.status !== 'running' && queue.status !== 'paused') return;
    const timer = window.setInterval(async () => {
      if (queuePollBusyRef.current) return;
      queuePollBusyRef.current = true;
      try {
        const liveQueue = await fetchBackendQueue(backendUrl);
        if (!liveQueue) return;
        setQueue(liveQueue);

        const finished =
          liveQueue.status === 'completed' ||
          liveQueue.status === 'idle' ||
          liveQueue.status === 'error';

        if (liveQueue.status === 'completed') {
          if (liveQueue.activeMode === 'analyze') {
            setMode1Completed(true);
          } else if (liveQueue.activeMode === 'tag') {
            setMode1Completed(true);
            setMode2Completed(true);
          } else if (liveQueue.activeMode === 'move') {
            setMode1Completed(true);
            setMode2Completed(true);
            setMode3Completed(true);
          }
        }

        const now = Date.now();
        const needsInitialTrackLoad =
          trackCountRef.current === 0 &&
          liveQueue.totalCount > 0 &&
          now - lastEmptyTrackSyncRef.current >= 25_000;

        if (finished || needsInitialTrackLoad) {
          lastEmptyTrackSyncRef.current = now;
          await checkAndLoadBackend(backendUrl, true);
        }
      } finally {
        queuePollBusyRef.current = false;
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [backendConnected, backendUrl, queue.status, checkAndLoadBackend]);

  // Load full track detail (including full synced/plain lyrics) on demand when opening inspector
  const handleSelectTrack = useCallback(
    (trackId: string) => {
      setSelectedTrackId(trackId);
      if (!backendConnected) return;
      void fetchBackendTrackDetail(backendUrl, trackId).then((detail) => {
        if (!detail) return;
        setTracks((prev) => prev.map((t) => (t.id === detail.id ? { ...t, ...detail } : t)));
      });
    },
    [backendConnected, backendUrl]
  );

  // Real local folder ingestion via music-metadata
  const handleImportLocalFiles = useCallback(
    async (files: FileList) => {
      abortRunRef.current = true;
      setImportingFiles(true);
      setImportProgressLabel(`0 / ${files.length}`);
      revokeCoverUrls();

      const scanned = await scanLocalFileList(files, (done, total, name) => {
        setImportProgressLabel(`${done} / ${total} · ${name}`);
      });

      const createdUrls = scanned.tracks
        .map((t) => t.cover.imageUrl)
        .filter((u): u is string => Boolean(u && u.startsWith('blob:')));
      coverObjectUrlsRef.current = createdUrls;

      setTracks(scanned.tracks);
      setCompanions(scanned.companions);
      setLeftovers(scanned.leftovers);
      setActiveSourceLabel(scanned.rootFolderName);
      setMode1Completed(false);
      setMode2Completed(false);
      setMode3Completed(false);
      setQueue(INITIAL_QUEUE);
      setJournal(INITIAL_JOURNAL);
      setArtistOverrides({ decisions: {}, renamedCanonical: {} });
      setDuplicateOverrides({ decisions: {}, selectedOriginals: {} });
      setImportingFiles(false);
      setImportProgressLabel('');

      showToast(
        `${scanned.tracks.length} Audiodatei(en), ${scanned.companions.length} Begleitdatei(en) und ${scanned.leftovers.length} Restdatei(en) aus „${scanned.rootFolderName}“ eingelesen.`
      );
    },
    [revokeCoverUrls, showToast]
  );

  const handleClearLoadedLibrary = useCallback(() => {
    abortRunRef.current = true;
    revokeCoverUrls();
    setTracks([]);
    setCompanions([]);
    setLeftovers([]);
    setActiveSourceLabel(null);
    setMode1Completed(false);
    setMode2Completed(false);
    setMode3Completed(false);
    setQueue(INITIAL_QUEUE);
    setJournal(INITIAL_JOURNAL);
    setSelectedTrackId(null);
    setSearchQuery('');
    setActiveFilter('all');
  }, [revokeCoverUrls]);

  // Deterministic live plan evaluation
  const evaluation = useMemo(
    () =>
      evaluateLibraryPlan(
        tracks,
        companions,
        leftovers,
        config,
        artistOverrides,
        duplicateOverrides
      ),
    [tracks, companions, leftovers, config, artistOverrides, duplicateOverrides]
  );

  const pendingReRunTracks = useMemo(
    () => tracks.filter((t) => t.pendingReRunTagAndMove),
    [tracks]
  );

  const nextModeAction = useMemo(
    () =>
      computeNextModeAction({
        mode1Completed,
        mode2Completed,
        mode3Completed,
        openArtistConflictCount: evaluation.report.openArtistConflictCount,
        pathCollisionCount: evaluation.report.pathCollisionCount,
        pendingReRunCount: pendingReRunTracks.length,
        queueRunningOrPaused: queue.status === 'running' || queue.status === 'paused',
        hasInterruptedJournal:
          journal.state === 'interrupted' ||
          (cache.interruptedAnalyzeCheckpoint !== null &&
            queue.status !== 'running' &&
            queue.status !== 'paused'),
        totalTracks: tracks.length,
        backendConnected,
      }),
    [
      mode1Completed,
      mode2Completed,
      mode3Completed,
      evaluation.report.openArtistConflictCount,
      evaluation.report.pathCollisionCount,
      pendingReRunTracks.length,
      queue.status,
      journal.state,
      cache.interruptedAnalyzeCheckpoint,
      tracks.length,
      backendConnected,
    ]
  );

  // Real Mode 1 live analysis runner (rate-limited MusicBrainz + LRCLIB + Cover Art Archive)
  const runLocalMode1Analysis = useCallback(
    async (startAtIndex = 0) => {
      const snapshotTracks = [...tracks];
      if (snapshotTracks.length === 0) return;

      abortRunRef.current = false;
      pauseRef.current = false;

      setQueue({
        activeMode: 'analyze',
        status: 'running',
        processedCount: startAtIndex,
        totalCount: snapshotTracks.length,
        errorCount: 0,
        cacheHitCount: 0,
        etaSeconds: Math.max(1, snapshotTracks.length - startAtIndex),
        currentTrackLabel: '',
        checkpointIndex: startAtIndex,
        errors: [],
      });

      let mbCount = 0;
      let coverCount = 0;
      let lyricsCount = 0;

      for (let i = startAtIndex; i < snapshotTracks.length; i++) {
        if (abortRunRef.current) return;

        while (pauseRef.current) {
          if (abortRunRef.current) return;
          await new Promise((r) => setTimeout(r, 120));
        }

        const track = snapshotTracks[i];
        setQueue((prev) => ({
          ...prev,
          currentTrackLabel: `${track.artist} — ${track.title}`,
          etaSeconds: Math.max(1, snapshotTracks.length - i),
        }));

        const lookup = await runLiveLookupForTrack(track, {
          fetchCover: config.embedCover,
          fetchLyrics: config.fetchLyrics,
        });

        if (abortRunRef.current) return;

        if (lookup.mbHit) mbCount += 1;
        if (lookup.coverHit) coverCount += 1;
        if (lookup.lyricsHit) lyricsCount += 1;

        setTracks((prev) =>
          prev.map((t) =>
            t.id === track.id
              ? {
                  ...t,
                  ...lookup.trackPatch,
                  lookupError: lookup.recoverableError ?? null,
                  status: t.status === 'pending' ? 'analyzed' : t.status,
                }
              : t
          )
        );

        setQueue((prev) => ({
          ...prev,
          processedCount: i + 1,
          cacheHitCount: prev.cacheHitCount + (lookup.cacheHit ? 1 : 0),
          errorCount: prev.errorCount + (lookup.recoverableError ? 1 : 0),
          etaSeconds: Math.max(0, snapshotTracks.length - (i + 1)),
          checkpointIndex: i + 1,
          errors: lookup.recoverableError
            ? [
                ...prev.errors,
                {
                  id: `err-${track.id}-${i}`,
                  stage: 'MusicBrainz',
                  trackLabel: track.fileName,
                  message: lookup.recoverableError,
                  recovered: true,
                },
              ]
            : prev.errors,
        }));
      }

      setMode1Completed(true);
      setCache((prev) => ({
        ...prev,
        mbReleaseEntries: prev.mbReleaseEntries + mbCount,
        coverEntries: prev.coverEntries + coverCount,
        lyricsEntries: prev.lyricsEntries + lyricsCount,
        lastCheckpointIso: new Date().toISOString(),
        interruptedAnalyzeCheckpoint: null,
      }));
      setQueue((prev) => ({
        ...prev,
        status: 'completed',
        processedCount: snapshotTracks.length,
        etaSeconds: 0,
        currentTrackLabel: '',
      }));
      showToast('Modus 1 abgeschlossen — Analysebericht erstellt (Read-Only).');
    },
    [config.embedCover, config.fetchLyrics, showToast, tracks]
  );

  // Retry ONLY tracks where MusicBrainz lookup failed (or unmatched tracks on request)
  const handleRetryFailedLookups = useCallback(
    async (options?: { trackIds?: string[]; includeUnmatched?: boolean }) => {
      if (queue.status === 'running' || queue.status === 'paused') {
        showToast('Es läuft bereits eine Hintergrund-Aufgabe.');
        return;
      }

      if (backendConnected) {
        const res = await postBackendAction<{ started?: boolean; reason?: string }>(
          backendUrl,
          '/api/mode/retry-failed',
          {
            config,
            trackIds: options?.trackIds ?? null,
            includeUnmatched: Boolean(options?.includeUnmatched),
          }
        );
        if (res && res.started === false) {
          showToast(res.reason || 'Nachprüfung konnte nicht gestartet werden.');
          return;
        }
        const q = await fetchBackendQueue(backendUrl);
        if (q) setQueue(q);
        showToast('MusicBrainz-Nachprüfung für fehlgeschlagene Tracks gestartet.');
        return;
      }

      const explicitSet = options?.trackIds ? new Set(options.trackIds) : null;
      const targets = tracks.filter((t) => {
        if (explicitSet) return explicitSet.has(t.id);
        if (t.lookupError) return true;
        return Boolean(options?.includeUnmatched && !t.matchedRelease && !t.mbRecordingId);
      });

      if (targets.length === 0) {
        showToast('Keine fehlgeschlagenen MusicBrainz-Abrufe offen.');
        return;
      }

      abortRunRef.current = false;
      pauseRef.current = false;
      setQueue({
        activeMode: 'retry_failed',
        status: 'running',
        processedCount: 0,
        totalCount: targets.length,
        errorCount: 0,
        cacheHitCount: 0,
        etaSeconds: targets.length,
        currentTrackLabel: '',
        checkpointIndex: 0,
        errors: [],
      });

      for (let i = 0; i < targets.length; i += 1) {
        if (abortRunRef.current) return;
        while (pauseRef.current) {
          if (abortRunRef.current) return;
          await new Promise((r) => setTimeout(r, 120));
        }
        const track = targets[i];
        setQueue((prev) => ({
          ...prev,
          currentTrackLabel: `${track.artist} — ${track.title}`,
          etaSeconds: Math.max(1, targets.length - i),
        }));

        const lookup = await runLiveLookupForTrack(track, {
          fetchCover: config.embedCover,
          fetchLyrics: config.fetchLyrics,
        });
        if (abortRunRef.current) return;

        setTracks((prev) =>
          prev.map((t) =>
            t.id === track.id
              ? {
                  ...t,
                  ...lookup.trackPatch,
                  lookupError: lookup.recoverableError ?? null,
                  status: t.status === 'pending' ? 'analyzed' : t.status,
                }
              : t
          )
        );

        setQueue((prev) => ({
          ...prev,
          processedCount: i + 1,
          cacheHitCount: prev.cacheHitCount + (lookup.cacheHit ? 1 : 0),
          errorCount: prev.errorCount + (lookup.recoverableError ? 1 : 0),
          etaSeconds: Math.max(0, targets.length - (i + 1)),
          checkpointIndex: i + 1,
          errors: lookup.recoverableError
            ? [
                ...prev.errors.slice(-24),
                {
                  id: `retry-err-${track.id}-${i}`,
                  stage: 'MusicBrainz',
                  trackLabel: track.fileName,
                  message: lookup.recoverableError,
                  recovered: true,
                },
              ]
            : prev.errors,
        }));
      }

      setQueue((prev) => ({
        ...prev,
        status: 'completed',
        processedCount: targets.length,
        etaSeconds: 0,
        currentTrackLabel: '',
      }));
      showToast(`MusicBrainz-Nachprüfung abgeschlossen (${targets.length} Tracks geprüft).`);
    },
    [backendConnected, backendUrl, config, queue.status, showToast, tracks]
  );

  const buildTagPayload = useCallback(
    (subset?: AudioTrack[]) => {
      const sourceTracks = subset ?? tracks;
      return sourceTracks
        .filter((t) => {
          const plan = evaluation.trackPlans.get(t.id);
          if (!plan) return false;
          if (subset) return true;
          return !plan.hasOpenArtistConflict && !plan.willSkipInMode2;
        })
        .map((t) => {
          const plan = evaluation.trackPlans.get(t.id);
          return {
            id: t.id,
            sourceRelativePath: t.sourceRelativePath,
            fileName: t.fileName,
            originalTags: t.originalTags,
            artist: t.artist,
            albumArtist: plan?.resolvedAlbumArtist ?? t.albumArtist,
            title: t.title,
            album: t.album,
            year: t.year,
            trackNumber: t.trackNumber,
            genre: t.genre,
            cover: t.cover,
            lyrics: t.lyrics,
            isDjRemix: plan?.classification === 'dj_remix' || t.manualAssignment === 'dj_remix',
          };
        });
    },
    [evaluation.trackPlans, tracks]
  );

  const buildMovePayload = useCallback(
    (subset?: AudioTrack[]) => {
      const sourceTracks = subset ?? tracks;
      const trackMoves = sourceTracks
        .map((t) => {
          const plan = evaluation.trackPlans.get(t.id);
          if (
            !plan ||
            !plan.targetRelativePath ||
            plan.targetRelativePath === t.sourceRelativePath
          ) {
            return null;
          }
          return {
            trackId: t.id,
            fromPath: t.sourceRelativePath,
            toPath: plan.targetRelativePath,
          };
        })
        .filter((x): x is { trackId: string; fromPath: string; toPath: string } => x !== null);

      const companionMoves = subset
        ? []
        : evaluation.evaluatedCompanions
            .filter((c) => c.targetPath && c.targetPath !== c.sourceRelativePath)
            .map((c) => ({
              id: c.id,
              fromPath: c.sourceRelativePath,
              toPath: c.targetPath as string,
            }));

      return { moves: trackMoves, companionMoves };
    },
    [evaluation.evaluatedCompanions, evaluation.trackPlans, tracks]
  );

  // Trigger real FastAPI backend mode when connected, or real local Mode 1 when in browser mode
  const handleTriggerPrimaryAction = async () => {
    if (!nextModeAction.enabled) return;
    setActiveSection('library');

    if (nextModeAction.mode === 'analyze') {
      if (backendConnected) {
        await postBackendAction(backendUrl, '/api/mode/analyze', { config });
        const q = await fetchBackendQueue(backendUrl);
        if (q) setQueue(q);
        showToast('Modus 1 (Analyse) im Docker-Container gestartet.');
      } else {
        void runLocalMode1Analysis(0);
      }
      return;
    }

    if (!backendConnected) {
      showToast('Schreibzugriff erfordert das verbundene TonArchiv FastAPI Docker-Backend.');
      return;
    }

    if (nextModeAction.mode === 'tag') {
      if (!journal.backupConfirmedAt) {
        setPendingModeAfterBackup('tag');
        setBackupModalOpen(true);
        return;
      }
      const res = await postBackendAction<{ started?: boolean; reason?: string }>(
        backendUrl,
        '/api/mode/tag',
        {
          config,
          tracks: buildTagPayload(),
        }
      );
      if (res && res.started === false) {
        showToast(res.reason || 'Modus 2 konnte nicht gestartet werden.');
        return;
      }
      const q = await fetchBackendQueue(backendUrl);
      if (q) setQueue(q);
      showToast('Modus 2 (Taggen & Cover) im Docker-Container gestartet.');
      return;
    }

    if (nextModeAction.mode === 'move') {
      const { moves, companionMoves } = buildMovePayload();
      const res = await postBackendAction<{ started?: boolean; reason?: string }>(
        backendUrl,
        '/api/mode/move',
        {
          config,
          moves,
          companionMoves,
        }
      );
      if (res && res.started === false) {
        showToast(res.reason || 'Modus 3 konnte nicht gestartet werden.');
        return;
      }
      const q = await fetchBackendQueue(backendUrl);
      if (q) setQueue(q);
      showToast('Modus 3 (Atomares Verschieben) im Docker-Container gestartet.');
      return;
    }

    if (nextModeAction.mode === 'rerun') {
      if (!journal.backupConfirmedAt) {
        setPendingModeAfterBackup('rerun');
        setBackupModalOpen(true);
        return;
      }
      const { moves } = buildMovePayload(pendingReRunTracks);
      await postBackendAction(backendUrl, '/api/mode/rerun', {
        config,
        trackIds: pendingReRunTracks.map((t) => t.id),
        tracks: buildTagPayload(pendingReRunTracks),
        moves,
      });
      await checkAndLoadBackend(backendUrl, true);
      showToast('Gezielter Re-Run (Modus 2 + Modus 3) abgeschlossen.');
    }
  };

  const handleConfirmBackupModal = async () => {
    setBackupModalOpen(false);
    const modeToLaunch = pendingModeAfterBackup;
    setPendingModeAfterBackup(null);

    if (!backendConnected) return;

    const confirmRes = await postBackendAction<{ backupConfirmedAt?: string }>(
      backendUrl,
      '/api/backup/confirm',
      { confirmed: true }
    );
    if (confirmRes?.backupConfirmedAt) {
      setJournal((prev) => ({
        ...prev,
        backupConfirmedAt: confirmRes.backupConfirmedAt ?? new Date().toISOString(),
      }));
    }

    if (modeToLaunch === 'tag') {
      const res = await postBackendAction<{ started?: boolean; reason?: string }>(
        backendUrl,
        '/api/mode/tag',
        {
          config,
          tracks: buildTagPayload(),
        }
      );
      if (res && res.started === false) {
        showToast(res.reason || 'Modus 2 konnte nicht gestartet werden.');
        return;
      }
      const q = await fetchBackendQueue(backendUrl);
      if (q) setQueue(q);
      showToast('Modus 2 (Taggen & Cover) im Docker-Container gestartet.');
    } else if (modeToLaunch === 'rerun') {
      const { moves } = buildMovePayload(pendingReRunTracks);
      await postBackendAction(backendUrl, '/api/mode/rerun', {
        config,
        trackIds: pendingReRunTracks.map((t) => t.id),
        tracks: buildTagPayload(pendingReRunTracks),
        moves,
      });
      await checkAndLoadBackend(backendUrl, true);
      showToast('Gezielter Re-Run (Modus 2 + Modus 3) abgeschlossen.');
    }
  };

  const handlePauseQueue = () => {
    pauseRef.current = true;
    setQueue((prev) => ({ ...prev, status: 'paused' }));
    if (backendConnected) {
      void postBackendAction(backendUrl, '/api/queue/pause');
    }
  };

  const handleResumeQueue = () => {
    pauseRef.current = false;
    setQueue((prev) => ({ ...prev, status: 'running' }));
    if (backendConnected) {
      void postBackendAction(backendUrl, '/api/queue/resume');
    }
  };

  const handleRollbackJournal = async () => {
    if (!backendConnected) return;
    await postBackendAction(backendUrl, '/api/rollback');
    await checkAndLoadBackend(backendUrl, true);
    showToast('Rollback über FastAPI-Journal ausgeführt.');
  };

  const handleResumeInterrupted = async () => {
    if (cache.interruptedAnalyzeCheckpoint !== null) {
      if (backendConnected) {
        await postBackendAction(backendUrl, '/api/mode/analyze', {
          resumeFrom: cache.interruptedAnalyzeCheckpoint,
        });
        await checkAndLoadBackend(backendUrl, true);
      } else {
        void runLocalMode1Analysis(cache.interruptedAnalyzeCheckpoint);
      }
      return;
    }

    if (backendConnected && journal.state === 'interrupted') {
      if (journal.mode === 'tag') {
        await postBackendAction(backendUrl, '/api/mode/tag', {
          config,
          tracks: buildTagPayload(),
        });
      } else {
        const { moves, companionMoves } = buildMovePayload();
        await postBackendAction(backendUrl, '/api/mode/move', {
          config,
          moves,
          companionMoves,
          resume: true,
        });
      }
      const q = await fetchBackendQueue(backendUrl);
      if (q) setQueue(q);
      await checkAndLoadBackend(backendUrl, true);
    }
  };

  // Track Inspector actions
  const handleSelectSource = (trackId: string, provider: SourceProvider) => {
    setTracks((prev) =>
      prev.map((t) => {
        if (t.id !== trackId) return t;
        const cand = t.sourceCandidates.find((c) => c.provider === provider);
        if (!cand) return t;
        return {
          ...t,
          activeSource: provider,
          artist: cand.artist,
          albumArtist: cand.albumArtist,
          title: cand.title,
          album: cand.album,
          year: cand.year,
          acoustidConfidence: cand.confidence,
          mbRecordingId: cand.mbRecordingId ?? t.mbRecordingId,
        };
      })
    );
    showToast('Erkennungsquelle übernommen — Zielpfad aktualisiert.');
  };

  const handleUpdateLyrics = (
    trackId: string,
    payload: { syncedLrc: string; plainText: string; status: 'synced' | 'plain' | 'instrumental' }
  ) => {
    setTracks((prev) =>
      prev.map((t) =>
        t.id === trackId
          ? {
              ...t,
              lyrics: {
                ...t.lyrics,
                syncedLrc: payload.syncedLrc,
                plainText: payload.plainText,
                status: payload.status,
              },
            }
          : t
      )
    );
  };

  const handleApplyManualReviewAssignment = (
    trackId: string,
    assignment: ManualAssignment,
    edits?: {
      manualReleaseId?: string | null;
      albumArtist?: string;
      artist?: string;
      title?: string;
      album?: string;
      year?: string;
      trackNumber?: string;
    }
  ) => {
    setTracks((prev) =>
      prev.map((t) => {
        if (t.id !== trackId) return t;
        const matchedManualRelease =
          edits?.manualReleaseId
            ? t.availableReleases.find((r) => r.releaseId === edits.manualReleaseId) ?? null
            : t.matchedRelease;

        return {
          ...t,
          manualAssignment: assignment,
          manualReleaseId: edits?.manualReleaseId ?? null,
          matchedRelease: assignment === 'album_track' ? matchedManualRelease : t.matchedRelease,
          albumArtist: edits?.albumArtist ?? t.albumArtist,
          artist: edits?.artist ?? t.artist,
          title: edits?.title ?? t.title,
          album: edits?.album ?? t.album,
          year: edits?.year ?? t.year,
          trackNumber: edits?.trackNumber ?? t.trackNumber,
          acoustidConfidence: assignment === 'album_track' ? 0.95 : t.acoustidConfidence,
          pendingReRunTagAndMove: true,
        };
      })
    );
    showToast('Manuelle Zuordnung gespeichert — bereit für gezielten Re-Run (Modus 2 + Modus 3).');
  };

  // Artist & Duplicate override handlers
  const handleSetClusterDecision = (clusterId: string, status: ArtistClusterStatus) => {
    setArtistOverrides((prev) => ({
      ...prev,
      decisions: { ...prev.decisions, [clusterId]: status },
    }));
  };

  const handleRenameCluster = (clusterId: string, newCanonicalName: string) => {
    setArtistOverrides((prev) => ({
      ...prev,
      renamedCanonical: { ...prev.renamedCanonical, [clusterId]: newCanonicalName },
    }));
  };

  const handleResolveAllFuzzy = () => {
    const next: Record<string, ArtistClusterStatus> = { ...artistOverrides.decisions };
    for (const c of evaluation.artistClusters) {
      if (c.rule === 'fuzzy_suggestion' && c.status === 'needs_review') {
        next[c.id] = 'user_confirmed';
      }
    }
    setArtistOverrides((prev) => ({ ...prev, decisions: next }));
    showToast('Alle offenen Künstlervorschläge bestätigt.');
  };

  const handleSelectDuplicateOriginal = (groupId: string, trackId: string) => {
    setDuplicateOverrides((prev) => ({
      decisions: { ...prev.decisions, [groupId]: 'confirmed' },
      selectedOriginals: { ...prev.selectedOriginals, [groupId]: trackId },
    }));
  };

  const handleSetDuplicateDecision = (groupId: string, decision: DuplicateDecision) => {
    setDuplicateOverrides((prev) => ({
      ...prev,
      decisions: { ...prev.decisions, [groupId]: decision },
    }));
  };

  const handleConfirmAllDuplicateRecommendations = () => {
    const nextDecisions: Record<string, DuplicateDecision> = { ...duplicateOverrides.decisions };
    let count = 0;
    for (const g of evaluation.duplicateGroups) {
      if (g.scope !== 'cross_album_notice') {
        nextDecisions[g.id] = 'confirmed';
        count += 1;
      }
    }
    setDuplicateOverrides((prev) => ({
      ...prev,
      decisions: nextDecisions,
    }));
    showToast(`Alle ${count} Duplikat-Empfehlungen übernommen (Duplikate → _Duplikate/).`);
  };

  const handleKeepAllDuplicates = () => {
    const nextDecisions: Record<string, DuplicateDecision> = { ...duplicateOverrides.decisions };
    let count = 0;
    for (const g of evaluation.duplicateGroups) {
      if (g.scope !== 'cross_album_notice') {
        nextDecisions[g.id] = 'keep_both';
        count += 1;
      }
    }
    setDuplicateOverrides((prev) => ({
      ...prev,
      decisions: nextDecisions,
    }));
    showToast(`Alle ${count} Duplikat-Gruppen auf „Alle behalten“ gesetzt.`);
  };

  const handleClearCache = async () => {
    clearBrowserLookupCache();
    if (backendConnected) {
      await postBackendAction(backendUrl, '/api/cache/clear');
    }
    setCache((prev) => ({
      ...prev,
      fingerprintEntries: 0,
      mbReleaseEntries: 0,
      coverEntries: 0,
      lyricsEntries: 0,
      interruptedAnalyzeCheckpoint: null,
    }));
    showToast('Cache geleert.');
  };

  const handleCleanupEmptyDirs = async () => {
    if (!backendConnected) return;
    const res = await postBackendAction<{ cleaned?: boolean; removedCount?: number }>(
      backendUrl,
      '/api/cleanup-empty'
    );
    const count = res?.removedCount ?? 0;
    showToast(
      count > 0
        ? `${count} leere Alt-Ordner / verwaiste Cover-Ordner entfernt.`
        : 'Keine leeren Alt-Ordner gefunden (Ordner enthalten noch echte Dateien).'
    );
  };

  const handleRescanBackend = async () => {
    if (!backendConnected) return;
    showToast('Scanne /music auf der Festplatte neu …');
    await postBackendAction(backendUrl, '/api/rescan');
    await checkAndLoadBackend(backendUrl, true);
    showToast('Musikordner (/music) frisch eingelesen.');
  };

  const selectedTrack = selectedTrackId
    ? tracks.find((t) => t.id === selectedTrackId) ?? null
    : null;
  const selectedTrackPlan = selectedTrackId
    ? evaluation.trackPlans.get(selectedTrackId) ?? null
    : null;

  const tracksToTagInMode2 = useMemo(() => {
    return Array.from(evaluation.trackPlans.values()).filter((p) => !p.willSkipInMode2).length;
  }, [evaluation.trackPlans]);

  return (
    <div className="min-h-screen bg-[#0F172A] text-slate-100 flex">
      <Sidebar
        activeSection={activeSection}
        onSelectSection={setActiveSection}
        counts={{
          tracks: tracks.length,
          duplicates: evaluation.report.duplicateGroupCount,
          openArtistConflicts: evaluation.report.openArtistConflictCount,
          pendingReRun: pendingReRunTracks.length,
        }}
        musicDir={activeSourceLabel || config.hostMusicDir}
        mobileOpen={mobileMenuOpen}
        onCloseMobile={() => setMobileMenuOpen(false)}
      />

      <div className="flex-1 min-w-0 flex flex-col">
        <TopBar
          activeSection={activeSection}
          nextAction={nextModeAction}
          onTriggerPrimaryAction={() => void handleTriggerPrimaryAction()}
          onOpenMobileMenu={() => setMobileMenuOpen(true)}
        />

        <main className="flex-1 px-4 lg:px-8 pt-5 pb-20 lg:py-6 max-w-[1440px] w-full mx-auto">
          {activeSection === 'library' && (
            <LibraryView
              tracks={tracks}
              trackPlans={evaluation.trackPlans}
              companions={evaluation.evaluatedCompanions}
              leftovers={evaluation.effectiveLeftovers}
              report={evaluation.report}
              config={config}
              mode1Completed={mode1Completed}
              mode2Completed={mode2Completed}
              mode3Completed={mode3Completed}
              nextAction={nextModeAction}
              queue={queue}
              journal={journal}
              cache={cache}
              backendConnected={backendConnected}
              backendUrl={backendUrl}
              backendChecking={backendChecking}
              musicDirExists={musicDirExists}
              importingFiles={importingFiles}
              importProgressLabel={importProgressLabel}
              activeSourceLabel={activeSourceLabel}
              searchQuery={searchQuery}
              activeFilter={activeFilter}
              onBackendUrlChange={setBackendUrl}
              onCheckBackend={() => void checkAndLoadBackend(backendUrl, false)}
              onStartBackendScan={() => void handleTriggerPrimaryAction()}
              onImportLocalFiles={(files) => void handleImportLocalFiles(files)}
              onClearLoadedLibrary={handleClearLoadedLibrary}
              onSearchChange={setSearchQuery}
              onFilterChange={setActiveFilter}
              onSelectTrack={handleSelectTrack}
              onNavigateSection={setActiveSection}
              onToggleKeepReviewInPlace={(keep) =>
                setConfig((prev) => ({ ...prev, keepReviewTracksInPlace: keep }))
              }
              onPauseQueue={handlePauseQueue}
              onResumeQueue={handleResumeQueue}
              onResumeInterrupted={() => void handleResumeInterrupted()}
              onRollbackJournal={() => void handleRollbackJournal()}
              onRetryFailedLookups={(opts) => void handleRetryFailedLookups(opts)}
              onRescanBackend={() => void handleRescanBackend()}
              onCleanupEmptyDirs={() => void handleCleanupEmptyDirs()}
            />
          )}

          {activeSection === 'duplicates' && (
            <DuplicatesView
              duplicateGroups={evaluation.duplicateGroups}
              tracks={tracks}
              onSelectOriginal={handleSelectDuplicateOriginal}
              onSetDecision={handleSetDuplicateDecision}
              onConfirmAllRecommendations={handleConfirmAllDuplicateRecommendations}
              onKeepAllDuplicates={handleKeepAllDuplicates}
            />
          )}

          {activeSection === 'artists' && (
            <ArtistDedupeView
              clusters={evaluation.artistClusters}
              onSetClusterDecision={handleSetClusterDecision}
              onRenameCluster={handleRenameCluster}
              onResolveAllFuzzy={handleResolveAllFuzzy}
            />
          )}

          {activeSection === 'rules' && (
            <RulesAndFoldersView
              config={config}
              tracks={tracks}
              trackPlans={evaluation.trackPlans}
              companions={evaluation.evaluatedCompanions}
              onChangeConfig={(patch) => setConfig((prev) => ({ ...prev, ...patch }))}
            />
          )}

          {activeSection === 'pipeline' && (
            <PipelineAndCacheView
              config={config}
              cache={cache}
              backendConnected={backendConnected}
              onChangeConfig={(patch) => setConfig((prev) => ({ ...prev, ...patch }))}
              onClearCache={() => void handleClearCache()}
            />
          )}

          {activeSection === 'docker' && <DockerExportView config={config} />}
        </main>
      </div>

      {/* Track Inspector Drawer */}
      <TrackInspectorDrawer
        track={selectedTrack}
        plan={selectedTrackPlan}
        config={config}
        queueBusy={queue.status === 'running' || queue.status === 'paused'}
        onClose={() => setSelectedTrackId(null)}
        onSelectSource={handleSelectSource}
        onUpdateLyrics={handleUpdateLyrics}
        onApplyManualReviewAssignment={handleApplyManualReviewAssignment}
        onRetryTrackLookup={(trackId) => void handleRetryFailedLookups({ trackIds: [trackId] })}
      />

      {/* Mandatory Backup Confirmation Modal before Mode 2 */}
      <BackupConfirmModal
        open={backupModalOpen}
        hostMusicDir={config.hostMusicDir}
        tracksToTagCount={
          pendingModeAfterBackup === 'rerun' ? pendingReRunTracks.length : tracksToTagInMode2
        }
        skippedConflictCount={
          pendingModeAfterBackup === 'rerun'
            ? 0
            : evaluation.report.skippedInMode2ArtistConflictCount
        }
        onCancel={() => {
          setBackupModalOpen(false);
          setPendingModeAfterBackup(null);
        }}
        onConfirm={() => void handleConfirmBackupModal()}
      />

      {/* Subtle Toast Notification */}
      {toastMessage && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed bottom-18 lg:bottom-5 left-4 right-4 sm:left-auto sm:right-5 z-50 sm:max-w-md bg-[#1B263B] border border-sky-400/40 text-slate-100 px-4 py-3 rounded-md text-xs shadow-lg"
        >
          {toastMessage}
        </div>
      )}
    </div>
  );
}
