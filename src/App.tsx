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
  createSeedCompanions,
  createSeedLeftovers,
  createSeedTracks,
  DEFAULT_CONFIG,
} from './data/seedLibrary';
import { ArtistResolutionOverrides } from './engine/artistDedupe';
import {
  computeNextModeAction,
  DuplicateOverrides,
  evaluateLibraryPlan,
} from './engine/classifierAndPlanner';
import {
  ArtistClusterStatus,
  AudioTrack,
  BackgroundQueueState,
  CompanionFile,
  DuplicateDecision,
  JournalEntry,
  LeftoverFile,
  ManualAssignment,
  PipelineConfig,
  RollbackJournal,
  SourceProvider,
  SqliteCacheState,
  WorkflowModeId,
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
  fingerprintEntries: 11,
  mbReleaseEntries: 10,
  coverEntries: 15,
  lyricsEntries: 12,
  lastCheckpointIso: null,
  interruptedAnalyzeCheckpoint: null,
};

export default function App() {
  const [activeSection, setActiveSection] = useState<NavSectionId>('library');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [config, setConfig] = useState<PipelineConfig>(DEFAULT_CONFIG);
  const [tracks, setTracks] = useState<AudioTrack[]>(() => createSeedTracks());
  const [companions, setCompanions] = useState<CompanionFile[]>(() => createSeedCompanions());
  const [leftovers] = useState<LeftoverFile[]>(() => createSeedLeftovers());

  const [artistOverrides, setArtistOverrides] = useState<ArtistResolutionOverrides>({
    decisions: {},
    renamedCanonical: {},
  });
  const [duplicateOverrides, setDuplicateOverrides] = useState<DuplicateOverrides>({
    decisions: {},
    selectedOriginals: {},
  });

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

  const queueTimerRef = useRef<number | null>(null);
  const queuePausedRef = useRef(false);
  const queueIndexRef = useRef(0);
  const queueTrackIdsRef = useRef<string[]>([]);
  const queueActiveModeRef = useRef<WorkflowModeId | 'rerun' | null>(null);

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    window.setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 2800);
  }, []);

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
          journal.state === 'interrupted' || cache.interruptedAnalyzeCheckpoint !== null,
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
    ]
  );

  const clearQueueTimer = () => {
    if (queueTimerRef.current !== null) {
      window.clearInterval(queueTimerRef.current);
      queueTimerRef.current = null;
    }
  };

  useEffect(() => {
    return () => clearQueueTimer();
  }, []);

  // Executes one step of the async background queue for Mode 1, Mode 2, Mode 3, or Re-Run (Mode 2 + Mode 3)
  const startBackgroundQueue = useCallback(
    (
      mode: WorkflowModeId | 'rerun',
      targetTrackIds: string[],
      startAtIndex = 0
    ) => {
      clearQueueTimer();
      queuePausedRef.current = false;
      queueIndexRef.current = startAtIndex;
      queueTrackIdsRef.current = targetTrackIds;
      queueActiveModeRef.current = mode;

      const total = targetTrackIds.length;
      if (total === 0) return;

      const runId = `run-${Date.now()}`;
      if (mode === 'tag' || mode === 'move' || mode === 'rerun') {
        setJournal((prev) => ({
          ...prev,
          runId,
          mode,
          state: 'in_progress',
          lastFsyncIso: new Date().toISOString(),
        }));
      }

      setQueue({
        activeMode: mode,
        status: 'running',
        processedCount: startAtIndex,
        totalCount: total,
        errorCount: 0,
        cacheHitCount: 0,
        etaSeconds: Math.max(1, Math.ceil((total - startAtIndex) * 0.12)),
        currentTrackLabel: '',
        checkpointIndex: startAtIndex,
        errors: [],
      });

      const tick = () => {
        if (queuePausedRef.current) return;
        const idx = queueIndexRef.current;
        const ids = queueTrackIdsRef.current;
        const activeMode = queueActiveModeRef.current;

        if (!activeMode || idx >= ids.length) {
          clearQueueTimer();
          if (activeMode === 'analyze') {
            setMode1Completed(true);
            setCache((prev) => ({
              ...prev,
              fingerprintEntries: tracks.length,
              mbReleaseEntries: 11,
              coverEntries: 17,
              lyricsEntries: 14,
              lastCheckpointIso: new Date().toISOString(),
              interruptedAnalyzeCheckpoint: null,
            }));
            showToast('Modus 1 abgeschlossen — Analysebericht erstellt (Read-Only).');
          } else if (activeMode === 'tag') {
            setMode2Completed(true);
            setJournal((prev) => ({
              ...prev,
              state: 'completed',
              lastFsyncIso: new Date().toISOString(),
            }));
            showToast(
              'Modus 2 abgeschlossen — Tags, Cover & Lyrics geschrieben (Original-Tags in rollback.json).'
            );
          } else if (activeMode === 'move') {
            setMode3Completed(true);
            // Move companion files and record truly empty dirs removed
            setCompanions((prev) =>
              prev.map((c) => {
                const evaluated = evaluation.evaluatedCompanions.find((ec) => ec.id === c.id);
                return {
                  ...c,
                  targetPath: evaluated?.targetPath ?? c.targetPath,
                  moved: Boolean(config.moveCompanionFiles && evaluated?.targetPath),
                };
              })
            );
            setJournal((prev) => ({
              ...prev,
              state: 'completed',
              lastFsyncIso: new Date().toISOString(),
              removedEmptyDirs: config.cleanupEmptyDirs
                ? [
                    'apple_lossless/Royksopp_MelodyAM',
                    'classics/Simon_and_Garfunkel',
                    'itunes_downloads/Tyler_IGOR',
                    'albums_flac/Dua_Lipa_Club_Future_Nostalgia',
                    'albums_flac/Fred_Again_AL3',
                    'sampler/Bravo_Hits_124',
                  ]
                : [],
            }));
            showToast(
              'Modus 3 abgeschlossen — Alben, Begleitdateien & _Review/ atomar verschoben.'
            );
          } else if (activeMode === 'rerun') {
            setJournal((prev) => ({
              ...prev,
              state: 'completed',
              lastFsyncIso: new Date().toISOString(),
            }));
            showToast(
              `Gezielter Re-Run (Modus 2 + Modus 3) für ${ids.length} Track(s) abgeschlossen.`
            );
          }

          setQueue((prev) => ({
            ...prev,
            status: 'completed',
            processedCount: ids.length,
            etaSeconds: 0,
            currentTrackLabel: '',
            checkpointIndex: ids.length,
          }));
          return;
        }

        const trackId = ids[idx];
        const track = tracks.find((t) => t.id === trackId);
        const plan = evaluation.trackPlans.get(trackId);
        const nowIso = new Date().toISOString();

        if (track && plan) {
          if (activeMode === 'analyze') {
            setTracks((prev) =>
              prev.map((t) =>
                t.id === trackId && t.status === 'pending' ? { ...t, status: 'analyzed' } : t
              )
            );
            // Demonstrate graceful non-fatal ShazamIO rate-limit handling on one bootleg track
            const triggerRecoverableShazamWarn =
              track.id === 'trk-05' && config.enableShazamFallback && !track.cachedLookup;

            setQueue((prev) => ({
              ...prev,
              processedCount: idx + 1,
              cacheHitCount: prev.cacheHitCount + (track.cachedLookup ? 1 : 0),
              errorCount: prev.errorCount + (triggerRecoverableShazamWarn ? 1 : 0),
              etaSeconds: Math.max(0, Math.ceil((ids.length - idx - 1) * 0.12)),
              currentTrackLabel: `${track.artist} — ${track.title}`,
              checkpointIndex: idx + 1,
              errors: triggerRecoverableShazamWarn
                ? [
                    ...prev.errors,
                    {
                      id: `err-${track.id}`,
                      stage: 'ShazamIO',
                      trackLabel: track.fileName,
                      message: 'Temporäres Rate-Limit (HTTP 429) — Backoff & Fallback erfolgreich',
                      recovered: true,
                    },
                  ]
                : prev.errors,
            }));
          } else if (activeMode === 'tag') {
            const skippedConflict = plan.hasOpenArtistConflict;
            const skippedLowConf =
              !skippedConflict &&
              plan.willSkipInMode2;

            if (!skippedConflict && !skippedLowConf) {
              // Write-Ahead Journal entry: pending -> done with Original Tags Snapshot
              const entry: JournalEntry = {
                id: `j-tag-${track.id}-${idx}`,
                kind: 'tag',
                trackId: track.id,
                fromPath: track.sourceRelativePath,
                toPath: track.sourceRelativePath,
                originalTags: { ...track.originalTags },
                status: 'done',
                timestampIso: nowIso,
              };
              setJournal((prev) => ({
                ...prev,
                lastFsyncIso: nowIso,
                entries: [...prev.entries, entry],
              }));
            }

            setTracks((prev) =>
              prev.map((t) => {
                if (t.id !== trackId) return t;
                if (skippedConflict) {
                  return {
                    ...t,
                    status: 'skipped_artist_conflict',
                    skippedInMode2Reason: plan.skipMode2Reason,
                  };
                }
                if (skippedLowConf) {
                  return {
                    ...t,
                    status: 'skipped_low_confidence',
                    skippedInMode2Reason: plan.skipMode2Reason,
                  };
                }
                return {
                  ...t,
                  albumArtist:
                    plan.classification === 'dj_remix'
                      ? t.originalTags.albumArtist
                      : plan.resolvedAlbumArtist,
                  status: 'tagged',
                  taggedAt: nowIso,
                  skippedInMode2Reason: null,
                };
              })
            );

            setQueue((prev) => ({
              ...prev,
              processedCount: idx + 1,
              etaSeconds: Math.max(0, Math.ceil((ids.length - idx - 1) * 0.1)),
              currentTrackLabel: `${track.artist} — ${track.title}`,
              checkpointIndex: idx + 1,
            }));
          } else if (activeMode === 'move') {
            const entry: JournalEntry = {
              id: `j-move-${track.id}-${idx}`,
              kind: 'move_track',
              trackId: track.id,
              fromPath: track.sourceRelativePath,
              toPath: plan.targetRelativePath,
              originalTags: { ...track.originalTags },
              status: 'done',
              timestampIso: nowIso,
            };
            setJournal((prev) => ({
              ...prev,
              lastFsyncIso: nowIso,
              entries: [...prev.entries, entry],
            }));

            setTracks((prev) =>
              prev.map((t) =>
                t.id === trackId
                  ? {
                      ...t,
                      status: 'moved',
                      movedToPath: plan.targetRelativePath,
                    }
                  : t
              )
            );

            setQueue((prev) => ({
              ...prev,
              processedCount: idx + 1,
              etaSeconds: Math.max(0, Math.ceil((ids.length - idx - 1) * 0.08)),
              currentTrackLabel: `→ ${plan.targetRelativePath}`,
              checkpointIndex: idx + 1,
            }));
          } else if (activeMode === 'rerun') {
            // Combined Mode 2 (Tagging + Original-Tags in Journal) -> Mode 3 (Atomic Move)
            const tagEntry: JournalEntry = {
              id: `j-rerun-tag-${track.id}-${idx}`,
              kind: 'tag',
              trackId: track.id,
              fromPath: track.movedToPath ?? track.sourceRelativePath,
              toPath: track.movedToPath ?? track.sourceRelativePath,
              originalTags: { ...track.originalTags },
              status: 'done',
              timestampIso: nowIso,
            };
            const moveEntry: JournalEntry = {
              id: `j-rerun-move-${track.id}-${idx}`,
              kind: 'move_track',
              trackId: track.id,
              fromPath: track.movedToPath ?? track.sourceRelativePath,
              toPath: plan.targetRelativePath,
              originalTags: { ...track.originalTags },
              status: 'done',
              timestampIso: nowIso,
            };
            setJournal((prev) => ({
              ...prev,
              lastFsyncIso: nowIso,
              entries: [...prev.entries, tagEntry, moveEntry],
            }));

            setTracks((prev) =>
              prev.map((t) =>
                t.id === trackId
                  ? {
                      ...t,
                      taggedAt: nowIso,
                      movedToPath: plan.targetRelativePath,
                      pendingReRunTagAndMove: false,
                      status: 'moved',
                    }
                  : t
              )
            );

            setQueue((prev) => ({
              ...prev,
              processedCount: idx + 1,
              etaSeconds: Math.max(0, Math.ceil((ids.length - idx - 1) * 0.1)),
              currentTrackLabel: `Re-Run M2+M3 → ${plan.targetRelativePath}`,
              checkpointIndex: idx + 1,
            }));
          }
        }

        queueIndexRef.current = idx + 1;
      };

      queueTimerRef.current = window.setInterval(tick, 90);
    },
    [config.cleanupEmptyDirs, config.enableShazamFallback, config.moveCompanionFiles, evaluation, showToast, tracks]
  );

  // Primary Top-Bar CTA handler
  const handleTriggerPrimaryAction = () => {
    if (!nextModeAction.enabled) return;
    setActiveSection('library');

    if (nextModeAction.mode === 'analyze') {
      startBackgroundQueue(
        'analyze',
        tracks.map((t) => t.id),
        0
      );
      return;
    }

    if (nextModeAction.mode === 'tag') {
      if (!journal.backupConfirmedAt) {
        setPendingModeAfterBackup('tag');
        setBackupModalOpen(true);
        return;
      }
      startBackgroundQueue(
        'tag',
        tracks.map((t) => t.id),
        0
      );
      return;
    }

    if (nextModeAction.mode === 'move') {
      startBackgroundQueue(
        'move',
        tracks.map((t) => t.id),
        0
      );
      return;
    }

    if (nextModeAction.mode === 'rerun') {
      const targetIds = pendingReRunTracks.map((t) => t.id);
      if (!journal.backupConfirmedAt) {
        setPendingModeAfterBackup('rerun');
        setBackupModalOpen(true);
        return;
      }
      startBackgroundQueue('rerun', targetIds, 0);
    }
  };

  const handleConfirmBackupModal = () => {
    const confirmedIso = new Date().toISOString();
    setJournal((prev) => ({
      ...prev,
      backupConfirmedAt: confirmedIso,
      lastFsyncIso: confirmedIso,
    }));
    setBackupModalOpen(false);
    const modeToLaunch = pendingModeAfterBackup;
    setPendingModeAfterBackup(null);

    if (modeToLaunch === 'tag') {
      startBackgroundQueue(
        'tag',
        tracks.map((t) => t.id),
        0
      );
    } else if (modeToLaunch === 'rerun') {
      startBackgroundQueue(
        'rerun',
        pendingReRunTracks.map((t) => t.id),
        0
      );
    }
  };

  const handlePauseQueue = () => {
    queuePausedRef.current = true;
    setQueue((prev) => ({ ...prev, status: 'paused' }));
  };

  const handleResumeQueue = () => {
    queuePausedRef.current = false;
    setQueue((prev) => ({ ...prev, status: 'running' }));
  };

  // Full atomic journal rollback (restores paths AND original tags!)
  const handleRollbackJournal = () => {
    clearQueueTimer();
    setTracks((prev) =>
      prev.map((t) => ({
        ...t,
        artist: t.originalTags.artist,
        albumArtist: t.originalTags.albumArtist,
        title: t.originalTags.title,
        album: t.originalTags.album,
        year: t.originalTags.year,
        trackNumber: t.originalTags.trackNumber,
        compilationFlag: t.originalTags.compilation,
        status: mode1Completed ? 'analyzed' : 'pending',
        taggedAt: null,
        movedToPath: null,
        skippedInMode2Reason: null,
      }))
    );
    setCompanions((prev) => prev.map((c) => ({ ...c, moved: false })));
    setMode2Completed(false);
    setMode3Completed(false);
    setJournal((prev) => ({
      ...prev,
      state: 'rolled_back',
      lastFsyncIso: new Date().toISOString(),
      entries: prev.entries.map((e) => ({ ...e, status: 'rolled_back' })),
      removedEmptyDirs: [],
    }));
    setQueue(INITIAL_QUEUE);
    showToast('Rollback erfolgreich — alle Dateipfade und Original-Tags wiederhergestellt.');
  };

  // Simulate an interrupted journal run to demonstrate Crash-Recovery
  const handleSimulateCrashInterrupt = () => {
    const sample = tracks.slice(0, 4);
    const nowIso = new Date().toISOString();
    setJournal((prev) => ({
      ...prev,
      runId: 'run-interrupted-demo',
      mode: 'move',
      state: 'interrupted',
      backupConfirmedAt: prev.backupConfirmedAt ?? nowIso,
      lastFsyncIso: nowIso,
      entries: sample.map((t, i) => ({
        id: `j-int-${t.id}`,
        kind: 'move_track',
        trackId: t.id,
        fromPath: t.sourceRelativePath,
        toPath: evaluation.trackPlans.get(t.id)?.targetRelativePath ?? t.sourceRelativePath,
        originalTags: { ...t.originalTags },
        status: i < 2 ? 'done' : 'pending',
        timestampIso: nowIso,
      })),
    }));
    showToast('Abgebrochenes Journal simuliert — Crash-Recovery-Banner ist aktiv.');
  };

  const handleResumeInterrupted = () => {
    if (cache.interruptedAnalyzeCheckpoint !== null) {
      const startAt = Math.min(cache.interruptedAnalyzeCheckpoint, tracks.length - 1);
      setCache((prev) => ({ ...prev, interruptedAnalyzeCheckpoint: null }));
      startBackgroundQueue(
        'analyze',
        tracks.map((t) => t.id),
        startAt
      );
      return;
    }

    if (journal.state === 'interrupted') {
      const remainingIds = journal.entries
        .filter((e) => e.status === 'pending' && e.trackId)
        .map((e) => e.trackId!);
      setJournal((prev) => ({ ...prev, state: 'in_progress' }));
      setMode1Completed(true);
      setMode2Completed(true);
      startBackgroundQueue('move', remainingIds.length > 0 ? remainingIds : tracks.map((t) => t.id), 0);
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
    showToast(
      'Manuelle Zuordnung gespeichert — bereit für gezielten Re-Run (Modus 2 Taggen + Modus 3 Verschieben).'
    );
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
    showToast('Alle Fuzzy-Künstlervorschläge bestätigt — 0 offene Konflikte.');
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
        musicDir={config.hostMusicDir}
        mobileOpen={mobileMenuOpen}
        onCloseMobile={() => setMobileMenuOpen(false)}
      />

      <div className="flex-1 min-w-0 flex flex-col">
        <TopBar
          activeSection={activeSection}
          nextAction={nextModeAction}
          onTriggerPrimaryAction={handleTriggerPrimaryAction}
          onOpenMobileMenu={() => setMobileMenuOpen(true)}
        />

        <main className="flex-1 px-4 lg:px-8 py-6 max-w-[1440px] w-full mx-auto">
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
              queue={queue}
              journal={journal}
              cache={cache}
              searchQuery={searchQuery}
              activeFilter={activeFilter}
              onSearchChange={setSearchQuery}
              onFilterChange={setActiveFilter}
              onSelectTrack={setSelectedTrackId}
              onNavigateSection={setActiveSection}
              onToggleKeepReviewInPlace={(keep) =>
                setConfig((prev) => ({ ...prev, keepReviewTracksInPlace: keep }))
              }
              onPauseQueue={handlePauseQueue}
              onResumeQueue={handleResumeQueue}
              onResumeInterrupted={handleResumeInterrupted}
              onRollbackJournal={handleRollbackJournal}
              onSimulateCrashInterrupt={handleSimulateCrashInterrupt}
            />
          )}

          {activeSection === 'duplicates' && (
            <DuplicatesView
              duplicateGroups={evaluation.duplicateGroups}
              tracks={tracks}
              onSelectOriginal={handleSelectDuplicateOriginal}
              onSetDecision={handleSetDuplicateDecision}
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
              onChangeConfig={(patch) => setConfig((prev) => ({ ...prev, ...patch }))}
              onClearCache={() => {
                setCache((prev) => ({
                  ...prev,
                  fingerprintEntries: 0,
                  mbReleaseEntries: 0,
                  coverEntries: 0,
                  lyricsEntries: 0,
                  interruptedAnalyzeCheckpoint: null,
                }));
                showToast('SQLite-Cache geleert.');
              }}
              onSimulateAnalyzeCheckpoint={() => {
                setCache((prev) => ({
                  ...prev,
                  interruptedAnalyzeCheckpoint: 8,
                  lastCheckpointIso: new Date().toISOString(),
                }));
                setMode1Completed(false);
                setActiveSection('library');
                showToast('Unterbrochener Analyse-Checkpoint #8 simuliert.');
              }}
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
        onClose={() => setSelectedTrackId(null)}
        onSelectSource={handleSelectSource}
        onUpdateLyrics={handleUpdateLyrics}
        onApplyManualReviewAssignment={handleApplyManualReviewAssignment}
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
        onConfirm={handleConfirmBackupModal}
      />

      {/* Subtle Toast Notification */}
      {toastMessage && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed bottom-5 right-5 z-50 max-w-md bg-[#1B263B] border border-sky-400/40 text-slate-100 px-4 py-3 rounded-md text-xs shadow-lg"
        >
          {toastMessage}
        </div>
      )}
    </div>
  );
}
