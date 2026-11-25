import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Film,
  FolderInput,
  FolderOpen,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  Trash2,
} from 'lucide-react';
import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import { NextModeAction } from '../engine/classifierAndPlanner';
import { formatCodecLabel } from '../engine/codecAndSanitizer';
import {
  AnalysisReport,
  AudioTrack,
  BackgroundQueueState,
  CompanionFile,
  EvaluatedTrackPlan,
  LeftoverFile,
  PipelineConfig,
  RollbackJournal,
  SqliteCacheState,
} from '../types/tonarchiv';
import { NavSectionId } from './Sidebar';

export type LibraryFilterId =
  | 'all'
  | 'lossless'
  | 'lossy_high'
  | 'lossy_low'
  | 'dj_remix'
  | 'review'
  | 'lookup_failed'
  | 'conflicts';

interface LibraryViewProps {
  tracks: AudioTrack[];
  trackPlans: Map<string, EvaluatedTrackPlan>;
  companions: CompanionFile[];
  leftovers: LeftoverFile[];
  report: AnalysisReport;
  config: PipelineConfig;
  mode1Completed: boolean;
  mode2Completed: boolean;
  mode3Completed: boolean;
  nextAction: NextModeAction;
  queue: BackgroundQueueState;
  journal: RollbackJournal;
  cache: SqliteCacheState;
  backendConnected: boolean;
  backendUrl: string;
  backendChecking: boolean;
  musicDirExists: boolean | null;
  importingFiles: boolean;
  importProgressLabel: string;
  activeSourceLabel: string | null;
  searchQuery: string;
  activeFilter: LibraryFilterId;
  onBackendUrlChange: (url: string) => void;
  onCheckBackend: () => void;
  onStartBackendScan: () => void;
  onImportLocalFiles: (files: FileList) => void;
  onClearLoadedLibrary: () => void;
  onSearchChange: (q: string) => void;
  onFilterChange: (f: LibraryFilterId) => void;
  onSelectTrack: (trackId: string) => void;
  onNavigateSection: (section: NavSectionId) => void;
  onToggleKeepReviewInPlace: (keep: boolean) => void;
  onPauseQueue: () => void;
  onResumeQueue: () => void;
  onResumeInterrupted: () => void;
  onRollbackJournal: () => void;
  onRetryFailedLookups: (options?: { trackIds?: string[]; includeUnmatched?: boolean }) => void;
  onRescanBackend: () => void;
  onCleanupEmptyDirs: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

export function LibraryView({
  tracks,
  trackPlans,
  companions,
  leftovers,
  report,
  config,
  mode1Completed,
  mode2Completed,
  mode3Completed,
  nextAction,
  queue,
  journal,
  cache,
  backendConnected,
  backendUrl,
  backendChecking,
  musicDirExists,
  importingFiles,
  importProgressLabel,
  activeSourceLabel,
  searchQuery,
  activeFilter,
  onBackendUrlChange,
  onCheckBackend,
  onStartBackendScan,
  onImportLocalFiles,
  onClearLoadedLibrary,
  onSearchChange,
  onFilterChange,
  onSelectTrack,
  onNavigateSection,
  onToggleKeepReviewInPlace,
  onPauseQueue,
  onResumeQueue,
  onResumeInterrupted,
  onRollbackJournal,
  onRetryFailedLookups,
  onRescanBackend,
  onCleanupEmptyDirs,
}: LibraryViewProps) {
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const filesInputRef = useRef<HTMLInputElement | null>(null);
  const [visibleCount, setVisibleCount] = useState(50);
  const [visibleCompanionsCount, setVisibleCompanionsCount] = useState(30);
  const [visibleLeftoversCount, setVisibleLeftoversCount] = useState(30);

  useEffect(() => {
    setVisibleCount(50);
  }, [activeFilter, searchQuery]);

  const hasCrashRecovery =
    journal.state === 'interrupted' ||
    (cache.interruptedAnalyzeCheckpoint !== null &&
      queue.status !== 'running' &&
      queue.status !== 'paused');

  const pendingReRunTracks = useMemo(
    () => tracks.filter((t) => t.pendingReRunTagAndMove),
    [tracks]
  );

  const handleFileSelection = (e: ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files;
    if (selected && selected.length > 0) {
      onImportLocalFiles(selected);
    }
    e.target.value = '';
  };

  const lookupFailedTracks = useMemo(
    () => tracks.filter((t) => Boolean(t.lookupError)),
    [tracks]
  );

  const unmatchedTracks = useMemo(
    () => tracks.filter((t) => !t.matchedRelease && !t.mbRecordingId),
    [tracks]
  );

  const filteredTracks = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return tracks.filter((track) => {
      const plan = trackPlans.get(track.id);
      if (!plan) return false;

      if (activeFilter === 'lossless' && plan.codecQuality !== 'lossless') return false;
      if (activeFilter === 'lossy_high' && plan.codecQuality !== 'lossy_high') return false;
      if (activeFilter === 'lossy_low' && plan.codecQuality !== 'lossy_low') return false;
      if (activeFilter === 'dj_remix' && plan.classification !== 'dj_remix') return false;
      if (
        activeFilter === 'review' &&
        plan.classification !== 'review_low_confidence' &&
        plan.classification !== 'review_no_release_match'
      ) {
        return false;
      }
      if (activeFilter === 'lookup_failed' && !track.lookupError) {
        return false;
      }
      if (
        activeFilter === 'conflicts' &&
        !plan.hasOpenArtistConflict &&
        plan.collision === 'none' &&
        !track.spectralWarningOnly &&
        !track.detachedFromAlbum &&
        !track.lookupError
      ) {
        return false;
      }

      if (!q) return true;
      return (
        String(track.title ?? '').toLowerCase().includes(q) ||
        String(track.artist ?? '').toLowerCase().includes(q) ||
        String(plan.resolvedAlbumArtist ?? '').toLowerCase().includes(q) ||
        String(track.album ?? '').toLowerCase().includes(q) ||
        String(track.fileName ?? '').toLowerCase().includes(q) ||
        String(track.codec ?? '').toLowerCase().includes(q) ||
        String(track.camelotKey ?? '').toLowerCase().includes(q) ||
        String(plan.targetRelativePath ?? '').toLowerCase().includes(q) ||
        String(track.lookupError ?? '').toLowerCase().includes(q)
      );
    });
  }, [tracks, trackPlans, activeFilter, searchQuery]);

  const visibleTracks = useMemo(
    () => filteredTracks.slice(0, visibleCount),
    [filteredTracks, visibleCount]
  );

  const filterButtons: Array<{ id: LibraryFilterId; label: string; count: number; warn?: boolean }> = [
    { id: 'all', label: 'Alle', count: report.totalAudioTracks },
    { id: 'lossless', label: 'Lossless', count: report.losslessCount },
    { id: 'lossy_high', label: 'Lossy Hoch', count: report.lossyHighCount },
    { id: 'lossy_low', label: 'Lossy Niedrig', count: report.lossyLowCount },
    { id: 'dj_remix', label: 'DJ-Remixes', count: report.djRemixCount },
    {
      id: 'review',
      label: 'Review',
      count: report.reviewLosslessCount + report.reviewLossyCount,
    },
    ...(lookupFailedTracks.length > 0
      ? [
          {
            id: 'lookup_failed' as LibraryFilterId,
            label: 'MB-Abruf fehlgeschlagen',
            count: lookupFailedTracks.length,
            warn: true,
          },
        ]
      : []),
    {
      id: 'conflicts',
      label: 'Hinweise',
      count:
        report.skippedInMode2ArtistConflictCount +
        report.pathCollisionCount +
        report.fakeFlacWarningCount +
        report.detachedForeignTrackCount +
        lookupFailedTracks.length,
    },
  ];

  const skippedMode2Tracks = useMemo(
    () => tracks.filter((t) => trackPlans.get(t.id)?.hasOpenArtistConflict),
    [tracks, trackPlans]
  );
  const journalEntries = journal.entries ?? [];
  const journalRemovedDirs = journal.removedEmptyDirs ?? [];
  const queueErrors = queue.errors ?? [];
  const canRollback =
    backendConnected &&
    journalEntries.some((e) => e.status === 'done') &&
    journal.state !== 'rolled_back' &&
    queue.status !== 'running';

  return (
    <div className="space-y-6">
      {/* Hidden native inputs for real local folder & audio file import */}
      <input
        ref={folderInputRef}
        type="file"
        multiple
        // @ts-expect-error webkitdirectory is standard in Chromium/Firefox/Safari for directory selection
        webkitdirectory=""
        directory=""
        onChange={handleFileSelection}
        aria-label="Lokalen Musikordner auswählen"
        className="sr-only"
      />
      <input
        ref={filesInputRef}
        type="file"
        multiple
        accept=".flac,.mp3,.m4a,.mp4,.ogg,.oga,.opus,.wav,.aiff,.aif,.wma,.jpg,.jpeg,.png,.cue,.log,.m3u,.m3u8,.pdf,.txt,.nfo"
        onChange={handleFileSelection}
        aria-label="Einzelne Audiodateien auswählen"
        className="sr-only"
      />

      {/* Crash-Recovery Banner (only shown on real interrupted journal / SQLite checkpoint) */}
      {hasCrashRecovery && (
        <section
          aria-label="Crash-Recovery"
          className="bg-[#151E2E] border border-red-500/50 rounded-lg p-5 flex flex-col md:flex-row md:items-center justify-between gap-4"
        >
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-sm font-semibold text-red-400">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>Abgebrochener Lauf erkannt (Journal / SQLite-Checkpoint)</span>
            </div>
            <p className="text-xs text-slate-300 leading-relaxed">
              {journal.state === 'interrupted'
                ? `Das atomare Journal rollback.json (${journalEntries.filter((e) => e.status === 'done').length} done, ${journalEntries.filter((e) => e.status === 'pending').length} pending) wurde vor Abschluss unterbrochen. Du kannst den Lauf fortsetzen oder alle Pfade & Original-Tags zurückrollen.`
                : `Ein vorheriger Analyse-Lauf wurde bei Checkpoint #${cache.interruptedAnalyzeCheckpoint} unterbrochen. Gespeicherte Ergebnisse liegen im SQLite-Cache bereit.`}
            </p>
          </div>
          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={onResumeInterrupted}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md bg-sky-400 text-slate-950 text-xs font-semibold hover:bg-sky-300 whitespace-nowrap"
            >
              <Play className="h-3.5 w-3.5" />
              <span>Lauf fortsetzen</span>
            </button>
            {journal.state === 'interrupted' && (
              <button
                type="button"
                onClick={onRollbackJournal}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md border border-[#243044] bg-[#0F172A] text-slate-200 text-xs font-medium hover:border-red-400 hover:text-red-300 whitespace-nowrap"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>Vollständig zurückrollen</span>
              </button>
            )}
          </div>
        </section>
      )}

      {/* 3-Step Sequential Modes Bar */}
      <section
        aria-label="Betriebsmodi"
        className="bg-[#151E2E] border border-[#243044] rounded-lg p-5"
      >
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-0 md:divide-x md:divide-[#243044]">
          {/* Mode 1 */}
          <div className="md:pr-5 space-y-1">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-semibold text-slate-100">1. Nur analysieren</span>
              <span
                className={`font-mono ${
                  mode1Completed
                    ? 'text-emerald-400'
                    : queue.activeMode === 'analyze'
                      ? 'text-sky-400'
                      : tracks.length > 0
                        ? 'text-slate-300'
                        : 'text-slate-500'
                }`}
              >
                {mode1Completed
                  ? 'Abgeschlossen'
                  : queue.activeMode === 'analyze' && queue.status === 'running'
                    ? 'Läuft'
                    : tracks.length > 0 || backendConnected
                      ? 'Bereit (Read-Only)'
                      : 'Keine Dateien'}
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Kein Schreibzugriff. Codec-Check, Release-Matching, Duplikate, Künstler &amp; Bericht.
            </p>
          </div>

          {/* Mode 2 */}
          <div className="md:px-5 space-y-1">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-semibold text-slate-100">2. Taggen</span>
              <span
                className={`font-mono ${
                  mode2Completed
                    ? 'text-emerald-400'
                    : mode1Completed && backendConnected
                      ? 'text-sky-400'
                      : 'text-slate-500'
                }`}
              >
                {mode2Completed
                  ? 'Abgeschlossen'
                  : !backendConnected && mode1Completed
                    ? 'Docker-Backend nötig'
                    : mode1Completed
                      ? 'Freigeschaltet'
                      : 'Gesperrt'}
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Backup-Pflichtmodal, Original-Tags in rollback.json.{' '}
              {report.skippedInMode2ArtistConflictCount > 0 && !mode2Completed ? (
                <span className="text-amber-400">
                  {report.skippedInMode2ArtistConflictCount} Konflikt-Tracks werden übersprungen.
                </span>
              ) : (
                'Konfidenz ≥ ' + Math.round(config.confidenceThreshold * 100) + ' %.'
              )}
            </p>
          </div>

          {/* Mode 3 */}
          <div className="md:pl-5 space-y-1">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-semibold text-slate-100">3. Verschieben &amp; aufräumen</span>
              <span
                className={`font-mono ${
                  mode3Completed
                    ? 'text-emerald-400'
                    : mode2Completed &&
                        backendConnected &&
                        report.openArtistConflictCount === 0 &&
                        report.pathCollisionCount === 0
                      ? 'text-sky-400'
                      : 'text-slate-500'
                }`}
              >
                {mode3Completed
                  ? pendingReRunTracks.length > 0
                    ? `Re-Run bereit (${pendingReRunTracks.length})`
                    : 'Abgeschlossen'
                  : !backendConnected
                    ? 'Docker-Backend nötig'
                    : !mode2Completed
                      ? 'Wartet auf Modus 2'
                      : report.openArtistConflictCount > 0
                        ? `Blockiert (${report.openArtistConflictCount} Konflikte)`
                        : report.pathCollisionCount > 0
                          ? `Blockiert (${report.pathCollisionCount} Kollisionen)`
                          : 'Freigeschaltet'}
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Erfordert 0 offene Künstlerkonflikte. Verschiebt Alben, Begleitdateien &amp;{' '}
              <span className="font-mono">_Review/</span>.
            </p>
          </div>
        </div>

        {!nextAction.enabled &&
          nextAction.blockReason &&
          nextAction.mode !== 'done' &&
          tracks.length > 0 &&
          queue.status !== 'running' &&
          queue.status !== 'paused' && (
            <div className="mt-4 pt-3.5 border-t border-[#243044] flex flex-wrap items-center justify-between gap-3 text-xs">
              <div className="flex items-center gap-2 text-amber-300">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span>{nextAction.blockReason}</span>
              </div>
              {report.openArtistConflictCount > 0 && (
                <button
                  type="button"
                  onClick={() => onNavigateSection('artists')}
                  className="px-3 py-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-200 font-medium hover:border-amber-400 whitespace-nowrap"
                >
                  Künstler-Check öffnen →
                </button>
              )}
            </div>
          )}
      </section>

      {/* Background Queue Monitor */}
      {queue.status !== 'idle' && (
        <section
          aria-label="Hintergrund-Queue"
          className="bg-[#151E2E] border border-[#243044] rounded-lg p-5 space-y-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2.5 text-sm font-semibold text-slate-100">
                <span>
                  Hintergrund-Queue:{' '}
                  {queue.activeMode === 'analyze'
                    ? 'Modus 1 (Analyse)'
                    : queue.activeMode === 'retry_failed'
                      ? 'Nachprüfung (MusicBrainz-Retry)'
                      : queue.activeMode === 'tag'
                        ? 'Modus 2 (Taggen)'
                        : queue.activeMode === 'move'
                          ? 'Modus 3 (Verschieben & Aufräumen)'
                          : 'Gezielter Re-Run (Modus 2 + Modus 3)'}
                </span>
                <span className="text-slate-600">·</span>
                <span
                  className={`text-xs font-mono ${
                    queue.status === 'completed'
                      ? 'text-emerald-400'
                      : queue.status === 'paused'
                        ? 'text-amber-400'
                        : 'text-sky-400'
                  }`}
                >
                  {queue.status === 'running'
                    ? 'Läuft'
                    : queue.status === 'paused'
                      ? 'Pausiert'
                      : queue.status === 'completed'
                        ? 'Fertig'
                        : 'Fehler'}
                </span>
              </div>
              <div className="text-xs text-slate-400 font-mono tabular-nums">
                Verarbeitet: {queue.processedCount} / {queue.totalCount} · Hinweise/Fehler:{' '}
                <span className={queue.errorCount > 0 ? 'text-amber-400' : 'text-slate-300'}>
                  {queue.errorCount}
                </span>{' '}
                · Cache-Treffer: {queue.cacheHitCount} · Restzeit (ETA):{' '}
                {queue.status === 'completed' ? '0 s' : `${queue.etaSeconds} s`}
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {queue.status === 'running' && (
                <button
                  type="button"
                  onClick={onPauseQueue}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-[#243044] bg-[#0F172A] text-xs font-medium text-slate-200 hover:border-amber-400"
                >
                  <Pause className="h-3.5 w-3.5" />
                  <span>Pause</span>
                </button>
              )}
              {queue.status === 'paused' && (
                <button
                  type="button"
                  onClick={onResumeQueue}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-sky-400 text-slate-950 text-xs font-semibold hover:bg-sky-300"
                >
                  <Play className="h-3.5 w-3.5" />
                  <span>Fortsetzen</span>
                </button>
              )}
            </div>
          </div>

          <div className="w-full h-1.5 bg-[#0F172A] rounded-full overflow-hidden">
            <div
              className={`h-full transition-transform duration-150 origin-left ${
                queue.status === 'completed'
                  ? 'bg-emerald-500'
                  : queue.status === 'paused'
                    ? 'bg-amber-500'
                    : 'bg-sky-400'
              }`}
              style={{
                transform: `scaleX(${
                  queue.totalCount > 0 ? Math.min(1, queue.processedCount / queue.totalCount) : 0
                })`,
              }}
            />
          </div>

          {queue.currentTrackLabel && queue.status !== 'completed' && (
            <div className="text-xs text-slate-400 truncate">
              Aktuell: <span className="font-mono text-slate-300">{queue.currentTrackLabel}</span>
            </div>
          )}

          {queueErrors.length > 0 && (
            <div className="pt-2 border-t border-[#243044] space-y-1">
              {queue.errorCount > 8 && (
                <div className="text-[11px] font-mono text-slate-400">
                  Letzte {Math.min(8, queueErrors.length)} von {queue.errorCount} Hinweisen (Lauf
                  läuft weiter):
                </div>
              )}
              {queueErrors.slice(-8).map((err) => (
                <div key={err.id} className="text-xs text-amber-300 flex items-start gap-2 min-w-0">
                  <span className="font-mono text-amber-400 shrink-0">[{err.stage}]</span>
                  <span className="truncate">
                    {err.trackLabel}: {err.message}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Mode 1 Analysis Report */}
      {mode1Completed && tracks.length > 0 && (
        <section
          aria-label="Analysebericht Modus 1"
          className="bg-[#151E2E] border border-[#243044] rounded-lg overflow-hidden"
        >
          <div className="px-5 py-3.5 border-b border-[#243044] flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
              <h2 className="font-display text-sm font-semibold text-slate-100">
                Analysebericht (Modus 1 · Read-Only)
              </h2>
            </div>
            <label className="inline-flex items-center gap-2 text-xs text-slate-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={config.keepReviewTracksInPlace}
                onChange={(e) => onToggleKeepReviewInPlace(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-slate-600 bg-[#0F172A] accent-sky-400"
              />
              <span>Review-Tracks an ursprünglichem Ort belassen</span>
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 divide-y sm:divide-y-0 sm:divide-x divide-[#243044]">
            <button
              type="button"
              onClick={() => onFilterChange('lossless')}
              className="p-4 text-left hover:bg-slate-800/40 transition-colors"
            >
              <div className="text-xs text-slate-400">Qualitäts-Verteilung (Codec)</div>
              <div className="mt-1.5 font-mono text-sm tabular-nums text-slate-100">
                <span className="text-emerald-400">{report.losslessCount} Lossless</span> ·{' '}
                <span>{report.lossyHighCount} Lossy</span> ·{' '}
                <span className="text-red-400">{report.lossyLowCount} Low</span>
              </div>
              <div className="mt-1 text-xs text-slate-500">ALAC ≠ AAC · Videos ignoriert</div>
            </button>

            <button
              type="button"
              onClick={() => onNavigateSection('duplicates')}
              className="p-4 text-left hover:bg-slate-800/40 transition-colors"
            >
              <div className="text-xs text-slate-400">Duplikat-Gruppen</div>
              <div className="mt-1.5 font-mono text-sm tabular-nums text-slate-100">
                {report.duplicateGroupCount} Gruppen ({report.duplicateMoveCount} → _Duplikate)
              </div>
              <div className="mt-1 text-xs text-slate-500">
                + {report.crossAlbumNoticeCount} Cross-Album-Hinweis (kein Move)
              </div>
            </button>

            <button
              type="button"
              onClick={() => onFilterChange('dj_remix')}
              className="p-4 text-left hover:bg-slate-800/40 transition-colors"
            >
              <div className="text-xs text-slate-400">DJ-Remixes &amp; Fake-FLACs</div>
              <div className="mt-1.5 font-mono text-sm tabular-nums text-slate-100">
                {report.djRemixCount} DJ-Remixes ·{' '}
                <span className="text-amber-400">{report.fakeFlacWarningCount} Fake-FLAC</span>
              </div>
              <div className="mt-1 text-xs text-slate-500">
                Spektral-Check nur Warnung · {report.detachedForeignTrackCount} herausgelöst
              </div>
            </button>

            <button
              type="button"
              onClick={() => onFilterChange('review')}
              className="p-4 text-left hover:bg-slate-800/40 transition-colors"
            >
              <div className="text-xs text-slate-400">
                {config.keepReviewTracksInPlace
                  ? 'Review-Tracks (bleiben liegen)'
                  : 'Ziel: _Review/ (nach Codec)'}
              </div>
              <div className="mt-1.5 font-mono text-sm tabular-nums text-slate-100">
                {report.reviewLosslessCount} Lossless · {report.reviewLossyCount} Lossy
              </div>
              <div className="mt-1 text-xs text-slate-500">
                {config.keepReviewTracksInPlace
                  ? 'Ursprungsort unverändert'
                  : '_Review/Lossless & _Review/Lossy'}
              </div>
            </button>

            <button
              type="button"
              onClick={() => onNavigateSection('artists')}
              className="p-4 text-left hover:bg-slate-800/40 transition-colors"
            >
              <div className="text-xs text-slate-400">Künstler &amp; Gemischte Alben</div>
              <div className="mt-1.5 font-mono text-sm tabular-nums text-slate-100">
                <span
                  className={
                    report.openArtistConflictCount > 0 ? 'text-amber-400' : 'text-emerald-400'
                  }
                >
                  {report.openArtistConflictCount} Konflikte
                </span>{' '}
                · {report.mixedAlbumCount} gemischt
              </div>
              <div className="mt-1 text-xs text-slate-500">
                Modus 3 benötigt 0 offene Konflikte
              </div>
            </button>
          </div>

          {skippedMode2Tracks.length > 0 && (
            <div className="px-5 py-3 bg-[#111927] border-t border-[#243044] flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="text-amber-300">
                Modus-2-Hinweis: {skippedMode2Tracks.length} Track(s) mit offenem
                Künstlerkonflikt werden beim Taggen übersprungen (
                {skippedMode2Tracks
                  .slice(0, 5)
                  .map((t) => t.fileName)
                  .join(', ')}
                {skippedMode2Tracks.length > 5
                  ? ` und ${skippedMode2Tracks.length - 5} weitere`
                  : ''}
                ).
              </div>
              <button
                type="button"
                onClick={() => onNavigateSection('artists')}
                className="text-sky-400 hover:text-sky-300 font-medium whitespace-nowrap"
              >
                Künstler-Check öffnen →
              </button>
            </div>
          )}
        </section>
      )}

      {/* Production Data Source Empty State OR Active Library Table */}
      {tracks.length === 0 ? (
        backendConnected ? (
          <section
            aria-label="Container bereit — Analyse manuell starten"
            className="bg-[#151E2E] border border-[#243044] rounded-lg p-6 space-y-5"
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="space-y-1.5">
                <div className="flex items-center gap-2.5 text-slate-100">
                  <CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0" />
                  <h2 className="font-display text-base font-semibold">
                    TonArchiv läuft &amp; ist bereit
                  </h2>
                </div>
                <p className="text-xs text-slate-400 leading-relaxed max-w-2xl">
                  Die Oberfläche und das FastAPI-Backend laufen stabil. Es wurden noch keine
                  Dateien gescannt oder verändert — du kannst hier prüfen, ob dein Musikordner
                  erkannt wurde, und Modus 1 (rein lesend) starten, sobald du bereit bist.
                </p>
              </div>
              <span className="font-mono text-xs text-emerald-400">Backend online</span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 border-t border-b border-[#243044] py-4 text-xs">
              <div className="space-y-1">
                <div className="text-slate-400">Musikordner im Container</div>
                <div className="font-mono text-slate-100 break-all">
                  {config.containerMusicDir}
                </div>
                <div
                  className={`font-mono ${
                    musicDirExists === false ? 'text-red-400' : 'text-emerald-400'
                  }`}
                >
                  {musicDirExists === false
                    ? 'Nicht gefunden — HOST_MUSIC_DIR prüfen'
                    : 'Erkannt & lesbar'}
                </div>
              </div>

              <div className="space-y-1">
                <div className="text-slate-400">Metadaten-Dienste</div>
                <div className="text-slate-200">MusicBrainz · Cover Art · LRCLIB</div>
                <div className="font-mono text-slate-400">
                  AcoustID: {config.acoustidKeyConfigured ? 'aktiv' : 'optional'} · Discogs:{' '}
                  {config.discogsTokenConfigured ? 'aktiv' : 'optional'}
                </div>
              </div>

              <div className="space-y-1">
                <div className="text-slate-400">Sicherheitsmodus</div>
                <div className="text-slate-200">Modus 1 ist 100 % Read-Only</div>
                <div className="font-mono text-slate-400">
                  Config-Volume: {config.configDir}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={onStartBackendScan}
                disabled={queue.status === 'running' || musicDirExists === false}
                className="inline-flex items-center gap-2 px-4 py-2.5 min-h-[42px] rounded-md bg-sky-400 text-slate-950 text-xs font-semibold hover:bg-sky-300 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
              >
                <Play className="h-4 w-4" />
                <span>
                  {queue.status === 'running'
                    ? 'Scan / Modus 1 läuft …'
                    : 'Modus 1: Bibliothek jetzt scannen & analysieren'}
                </span>
              </button>
              <button
                type="button"
                onClick={onCheckBackend}
                disabled={backendChecking}
                className="inline-flex items-center gap-1.5 px-3.5 py-2.5 min-h-[42px] rounded-md border border-[#243044] bg-[#0F172A] text-slate-200 text-xs font-medium hover:border-sky-400 whitespace-nowrap"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${backendChecking ? 'animate-spin' : ''}`} />
                <span>{backendChecking ? 'Prüfe …' : 'Status neu prüfen'}</span>
              </button>
            </div>
          </section>
        ) : (
        <section
          aria-label="Produktionsdaten laden"
          className="grid grid-cols-1 lg:grid-cols-2 gap-6"
        >
          {/* Option 1: Real Local Folder Scan via music-metadata */}
          <div className="bg-[#151E2E] border border-[#243044] rounded-lg p-6 flex flex-col justify-between gap-5">
            <div className="space-y-2">
              <div className="flex items-center gap-2.5 text-slate-100">
                <FolderInput className="h-5 w-5 text-sky-400 shrink-0" />
                <h2 className="font-display text-base font-semibold">
                  Lokalen Musikordner direkt analysieren
                </h2>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                Wähle deinen echten Musikordner oder einzelne Audiodateien aus. TonArchiv liest
                Codec (FLAC, ALAC, AAC, MP3, OGG, WAV), Bitrate, Sample-Rate, Original-Tags,
                eingebettete Cover, Songtexte, Begleitdateien und Videos direkt im Browser ein —
                ohne Demo-Daten und ohne Datei-Upload.
              </p>
            </div>

            {importingFiles ? (
              <div className="bg-[#0F172A] border border-[#243044] rounded-md p-3.5 text-xs font-mono text-sky-300">
                Lese Dateien ein: {importProgressLabel}
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => folderInputRef.current?.click()}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-sky-400 text-slate-950 text-xs font-semibold hover:bg-sky-300 whitespace-nowrap"
                >
                  <FolderOpen className="h-4 w-4" />
                  <span>Musikordner wählen</span>
                </button>
                <button
                  type="button"
                  onClick={() => filesInputRef.current?.click()}
                  className="inline-flex items-center gap-2 px-3.5 py-2 rounded-md border border-[#243044] bg-[#0F172A] text-slate-200 text-xs font-medium hover:border-sky-400 whitespace-nowrap"
                >
                  <span>Einzelne Dateien wählen</span>
                </button>
              </div>
            )}
          </div>

          {/* Option 2: Connect to Real Homeserver Docker FastAPI Backend */}
          <div className="bg-[#151E2E] border border-[#243044] rounded-lg p-6 flex flex-col justify-between gap-5">
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 text-slate-100">
                  <Server className="h-5 w-5 text-sky-400 shrink-0" />
                  <h2 className="font-display text-base font-semibold">
                    TonArchiv Docker-Backend verbinden
                  </h2>
                </div>
                <span
                  className={`font-mono text-xs ${
                    backendConnected ? 'text-emerald-400' : 'text-slate-400'
                  }`}
                >
                  {backendConnected ? 'Verbunden' : 'Nicht verbunden'}
                </span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                Für direkten Schreibzugriff (Modus 2 Taggen, Modus 3 atomares Verschieben,
                SQLite-Cache &amp; <span className="font-mono">rollback.json</span> auf{' '}
                <span className="font-mono text-slate-200">{config.hostMusicDir}</span>) läuft das
                Dashboard direkt im FastAPI-Docker-Container.
              </p>

              <div className="space-y-1">
                <label htmlFor="backend-url-input" className="block text-xs text-slate-400">
                  Backend-URL (leer lassen für Same-Origin im Docker-Container)
                </label>
                <input
                  id="backend-url-input"
                  type="url"
                  value={backendUrl}
                  onChange={(e) => onBackendUrlChange(e.target.value)}
                  placeholder="z. B. http://192.168.1.10:7070"
                  className="w-full rounded-md bg-[#0F172A] border border-[#243044] px-3 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-sky-400"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={onCheckBackend}
                disabled={backendChecking}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md border border-[#243044] bg-[#0F172A] text-slate-200 text-xs font-medium hover:border-sky-400 whitespace-nowrap"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${backendChecking ? 'animate-spin' : ''}`} />
                <span>{backendChecking ? 'Prüfe Verbindung …' : 'Verbindung prüfen'}</span>
              </button>
              <button
                type="button"
                onClick={() => onNavigateSection('docker')}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md text-xs font-medium text-sky-400 hover:text-sky-300 whitespace-nowrap"
              >
                <span>Docker-Paket herunterladen →</span>
              </button>
            </div>
          </div>
        </section>
        )
      ) : (
        <>
          {/* Active Production Source Strip */}
          <div className="bg-[#151E2E] border border-[#243044] rounded-lg px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-1 sm:gap-2 text-slate-300">
              <span className="font-semibold text-slate-100">
                Quelle: {activeSourceLabel || config.hostMusicDir}
              </span>
              <span className="hidden sm:inline text-slate-600">·</span>
              <span className="font-mono text-slate-400">
                {backendConnected
                  ? 'FastAPI Docker-Backend (Lese- & Schreibzugriff)'
                  : 'Lokaler Browser-Scan (Read-Only · Modus 2/3 über Docker-Container)'}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {lookupFailedTracks.length === 0 &&
                unmatchedTracks.length > 0 &&
                mode1Completed &&
                queue.status !== 'running' &&
                queue.status !== 'paused' && (
                  <button
                    type="button"
                    onClick={() => onRetryFailedLookups({ includeUnmatched: true })}
                    className="inline-flex items-center gap-1.5 px-3 py-2 min-h-[40px] rounded border border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 whitespace-nowrap"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    <span>Ohne Treffer erneut abrufen ({unmatchedTracks.length})</span>
                  </button>
                )}
              {backendConnected ? (
                <>
                  <button
                    type="button"
                    onClick={onCleanupEmptyDirs}
                    disabled={queue.status === 'running' || queue.status === 'paused'}
                    className="inline-flex items-center gap-1.5 px-3 py-2 min-h-[40px] rounded border border-[#243044] bg-[#0F172A] text-slate-200 hover:border-sky-400 disabled:opacity-50 whitespace-nowrap"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>Leere Alt-Ordner aufräumen</span>
                  </button>
                  <button
                    type="button"
                    onClick={onRescanBackend}
                    disabled={queue.status === 'running' || queue.status === 'paused'}
                    className="inline-flex items-center gap-1.5 px-3 py-2 min-h-[40px] rounded border border-[#243044] bg-[#0F172A] text-slate-200 hover:border-sky-400 disabled:opacity-50 whitespace-nowrap"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    <span>Ordner neu scannen</span>
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => folderInputRef.current?.click()}
                    className="inline-flex items-center gap-1.5 px-3 py-2 min-h-[40px] rounded border border-[#243044] bg-[#0F172A] text-slate-200 hover:border-sky-400 whitespace-nowrap"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                    <span>Ordner wechseln</span>
                  </button>
                  <button
                    type="button"
                    onClick={onClearLoadedLibrary}
                    className="inline-flex items-center gap-1.5 px-3 py-2 min-h-[40px] rounded border border-[#243044] bg-[#0F172A] text-slate-400 hover:text-red-300 hover:border-red-400/50 whitespace-nowrap"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>Leeren</span>
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Persistent Banner for tracks where MusicBrainz was unreachable */}
          {lookupFailedTracks.length > 0 &&
            queue.status !== 'running' &&
            queue.status !== 'paused' && (
              <section
                aria-label="Fehlgeschlagene MusicBrainz-Abrufe"
                className="bg-[#151E2E] border border-amber-500/45 rounded-lg p-4 flex flex-col md:flex-row md:items-center justify-between gap-4"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2 text-sm font-semibold text-amber-300">
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                    <span>
                      {lookupFailedTracks.length} Tracks: MusicBrainz war beim Scan nicht erreichbar
                    </span>
                  </div>
                  <p className="text-xs text-slate-300 leading-relaxed">
                    Diese Dateien wurden nicht beschädigt — sie wurden nur übersprungen und behalten
                    vorerst ihre lokalen Tags (landen ohne Treffer in <span className="font-mono">_Review/</span>).
                    Du kannst gezielt nur diese {lookupFailedTracks.length} Tracks noch einmal bei
                    MusicBrainz abfragen, bevor du Modus 2 (Taggen) startest.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => onFilterChange('lookup_failed')}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2.5 min-h-[42px] rounded-md border border-[#243044] bg-[#0F172A] text-slate-200 text-xs font-medium hover:border-amber-400/60 whitespace-nowrap"
                  >
                    <span>Dateien anzeigen</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onRetryFailedLookups({ includeUnmatched: false })}
                    className="inline-flex items-center gap-1.5 px-4 py-2.5 min-h-[42px] rounded-md bg-amber-400 text-slate-950 text-xs font-semibold hover:bg-amber-300 whitespace-nowrap"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    <span>Nur diese {lookupFailedTracks.length} erneut abrufen</span>
                  </button>
                </div>
              </section>
            )}

          {/* Search & Segmented Filter Controls */}
          <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-3">
            <div className="relative w-full xl:w-72 shrink-0">
              <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder="Suche nach Künstler, Titel, Codec, Pfad …"
                aria-label="Bibliothek durchsuchen"
                className="w-full min-h-[42px] rounded-md bg-[#151E2E] border border-[#243044] pl-9 pr-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-sky-400"
              />
            </div>

            <div
              role="group"
              aria-label="Bibliotheksfilter"
              className="flex flex-nowrap overflow-x-auto sm:flex-wrap items-center gap-1 bg-[#151E2E] border border-[#243044] rounded-md p-1 max-w-full"
            >
              {filterButtons.map((btn) => {
                const active = activeFilter === btn.id;
                return (
                  <button
                    key={btn.id}
                    type="button"
                    onClick={() => onFilterChange(btn.id)}
                    className={`px-3 py-2 sm:px-2.5 sm:py-1.5 min-h-[38px] sm:min-h-0 rounded text-xs font-medium whitespace-nowrap shrink-0 transition-colors ${
                      active
                        ? btn.warn
                          ? 'bg-amber-400/20 text-amber-300'
                          : 'bg-sky-400/15 text-sky-300'
                        : btn.warn
                          ? 'text-amber-300/90 hover:text-amber-200 hover:bg-amber-400/10'
                          : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                    }`}
                  >
                    {btn.label}{' '}
                    <span className="font-mono tabular-nums opacity-75">{btn.count}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* High-Density Track List (Mobile Cards < md, Desktop Table >= md) */}
          <section className="bg-[#151E2E] border border-[#243044] rounded-lg overflow-hidden">
            {filteredTracks.length === 0 ? (
              <div className="py-12 px-6 text-center space-y-3">
                <p className="text-sm text-slate-300">
                  Keine Tracks entsprechen dem aktuellen Filter oder Suchbegriff.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    onSearchChange('');
                    onFilterChange('all');
                  }}
                  className="px-4 py-2.5 min-h-[44px] rounded-md bg-sky-400/15 text-sky-300 text-xs font-medium hover:bg-sky-400/25"
                >
                  Filter zurücksetzen
                </button>
              </div>
            ) : (
              <>
                {/* Mobile Touch-First Track Card List */}
                <div className="md:hidden divide-y divide-[#243044]">
                  {visibleTracks.map((track) => {
                    const plan = trackPlans.get(track.id);
                    if (!plan) return null;
                    const confidencePct = Math.round((track.acoustidConfidence ?? 0) * 100);
                    const statusText =
                      track.status === 'moved'
                        ? 'Verschoben'
                        : track.status === 'tagged'
                          ? 'Getaggt'
                          : track.status === 'skipped_artist_conflict'
                            ? 'Übersprungen'
                            : plan.hasOpenArtistConflict
                              ? 'Künstler offen'
                              : mode1Completed
                                ? 'Analysiert'
                                : 'Offen';
                    const classLabel = plan.isDuplicateToMove
                      ? 'Duplikat → _Duplikate/'
                      : plan.classification === 'dj_remix'
                        ? 'DJ-Remix (geschützt)'
                        : plan.classification === 'review_no_release_match'
                          ? 'Review (kein Release-Match)'
                          : plan.classification === 'review_low_confidence'
                            ? `Review (${confidencePct} %)`
                            : plan.albumQuality === 'lossless'
                              ? 'Lossless-Album'
                              : plan.albumQuality === 'lossy_low'
                                ? 'Lossy Low-Quality'
                                : 'Lossy-Album';
                    const classColor = plan.isDuplicateToMove
                      ? 'text-amber-300'
                      : plan.classification === 'dj_remix'
                        ? 'text-sky-300'
                        : plan.classification === 'review_low_confidence' ||
                            plan.classification === 'review_no_release_match'
                          ? 'text-amber-400'
                          : plan.albumQuality === 'lossy_low'
                            ? 'text-red-400'
                            : 'text-emerald-400';

                    return (
                      <button
                        key={track.id}
                        type="button"
                        onClick={() => onSelectTrack(track.id)}
                        aria-label={`Details für ${track.title} öffnen`}
                        className="w-full text-left p-4 flex items-center justify-between gap-3 hover:bg-slate-800/40 active:bg-slate-800/60 transition-colors min-h-[72px]"
                      >
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium text-sm text-slate-100 truncate">
                              {track.title}
                            </span>
                            <span className="font-mono text-[11px] text-slate-400 shrink-0">
                              {statusText}
                            </span>
                          </div>
                          <div className="text-xs text-slate-400 truncate">
                            {plan.resolvedAlbumArtist}
                            {track.album ? ` · ${track.album}` : ' · Lose Datei'}
                          </div>
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
                            <span className="font-mono text-slate-300">
                              {formatCodecLabel(track.codec, track.extension)}
                            </span>
                            <span className="text-slate-600">·</span>
                            <span className="font-mono tabular-nums text-slate-400">
                              {track.bitDepth ? `${track.bitDepth}b/` : ''}
                              {((track.sampleRateHz || 44100) / 1000).toFixed(1)}k · {track.bitrateKbps || 0}k
                            </span>
                            <span className="text-slate-600">·</span>
                            <span className={classColor}>{classLabel}</span>
                          </div>
                          <div className="font-mono text-[11px] text-slate-500 truncate">
                            {plan.targetRelativePath}
                          </div>
                          {plan.collision !== 'none' && (
                            <div className="text-[11px] text-red-400">{plan.collisionDetail}</div>
                          )}
                          {track.lookupError && (
                            <div className="text-[11px] text-amber-400 truncate">
                              {track.lookupError}
                            </div>
                          )}
                        </div>
                        <ChevronRight className="h-4 w-4 text-slate-500 shrink-0" />
                      </button>
                    );
                  })}
                </div>

                {/* Desktop High-Density Track Table */}
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full min-w-[880px] table-fixed text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-[#111927] border-b border-[#243044] text-slate-400">
                        <th className="w-[24%] py-3 pl-4 pr-3 font-medium">
                          Track &amp; Album-Künstler
                        </th>
                      <th className="w-[17%] py-3 px-3 font-medium">Codec &amp; Qualität</th>
                      <th className="w-[19%] py-3 px-3 font-medium">Key · BPM · Medien</th>
                      <th className="w-[28%] py-3 px-3 font-medium">Einordnung &amp; Zielpfad</th>
                      <th className="w-[12%] py-3 pl-3 pr-4 font-medium text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#243044]">
                    {visibleTracks.map((track) => {
                      const plan = trackPlans.get(track.id);
                      if (!plan) return null;
                      const keyLabel =
                        track.camelotKey && track.camelotKey !== '—'
                          ? track.musicalKey && track.musicalKey !== track.camelotKey
                            ? `${track.camelotKey} (${track.musicalKey})`
                            : track.camelotKey
                          : !config.enableEssentia || !config.essentiaAvailable
                            ? 'Key: Essentia nötig'
                            : '—';

                      return (
                        <tr
                          key={track.id}
                          className="hover:bg-slate-800/40 transition-colors group"
                        >
                          <td className="py-3 pl-4 pr-3">
                            <button
                              type="button"
                              onClick={() => onSelectTrack(track.id)}
                              aria-label={`Details für ${track.title} öffnen`}
                              className="text-left w-full group/btn focus-visible:outline-2 focus-visible:outline-sky-400 rounded"
                            >
                              <div className="font-medium text-slate-100 group-hover/btn:text-sky-300 truncate">
                                {track.title}
                              </div>
                              <div className="text-slate-400 truncate mt-0.5">
                                {plan.resolvedAlbumArtist}
                                {track.album ? ` · ${track.album}` : ' · Lose Datei'}
                              </div>
                            </button>
                          </td>

                          <td className="py-3 px-3">
                            <div className="font-mono text-slate-200 truncate">
                              {formatCodecLabel(track.codec, track.extension)}
                            </div>
                            <div className="font-mono tabular-nums text-slate-400 truncate mt-0.5">
                              {track.bitDepth ? `${track.bitDepth}b/` : ''}
                              {((track.sampleRateHz || 44100) / 1000).toFixed(1)}k · {track.bitrateKbps || 0} kbps
                            </div>
                            {track.spectralWarningOnly &&
                              config.enableEssentia &&
                              config.essentiaAvailable && (
                                <div className="text-amber-400 truncate mt-0.5">
                                  Spektral-Warnung ({track.spectralCutoffKhz} kHz)
                                </div>
                              )}
                          </td>

                          <td className="py-3 px-3">
                            <div className="font-mono tabular-nums text-slate-200 truncate">
                              {keyLabel}
                              {track.bpm ? ` · ${track.bpm} BPM` : ''}
                            </div>
                            <div className="text-slate-400 truncate mt-0.5">
                              {plan.wavMediaSkipped
                                ? 'WAV-Schutz: Cover/Lyrics aus'
                                : `Cover ${!track.cover || track.cover.status === 'missing' ? 'Fehlt' : track.cover.resolution} · ${
                                    track.lyrics?.status === 'synced'
                                      ? 'Sync LRC'
                                      : track.lyrics?.status === 'plain'
                                        ? 'Text'
                                        : track.lyrics?.status === 'instrumental'
                                          ? 'Instrumental'
                                          : 'Ohne Lyrics'
                                  }`}
                            </div>
                          </td>

                          <td className="py-3 px-3">
                            <div className="flex items-center gap-2 text-slate-300">
                              <span
                                className={
                                  plan.isDuplicateToMove
                                    ? 'text-amber-300'
                                    : plan.classification === 'dj_remix'
                                      ? 'text-sky-300'
                                      : plan.classification === 'review_low_confidence' ||
                                          plan.classification === 'review_no_release_match'
                                        ? 'text-amber-400'
                                        : plan.albumQuality === 'lossy_low'
                                          ? 'text-red-400'
                                          : 'text-emerald-400'
                                }
                              >
                                {plan.isDuplicateToMove
                                  ? 'Duplikat → _Duplikate/'
                                  : plan.classification === 'dj_remix'
                                    ? 'DJ-Remix (Artist/Titel geschützt)'
                                    : plan.classification === 'review_no_release_match'
                                      ? 'Review (kein Release-Match)'
                                      : plan.classification === 'review_low_confidence'
                                        ? `Review (${Math.round((track.acoustidConfidence ?? 0) * 100)} %)`
                                        : plan.albumQuality === 'lossless'
                                          ? 'Lossless-Album'
                                          : plan.albumQuality === 'lossy_low'
                                            ? 'Lossy Low-Quality'
                                            : 'Lossy-Album'}
                              </span>
                              {track.pendingReRunTagAndMove && (
                                <span className="font-mono text-sky-400">· Re-Run</span>
                              )}
                            </div>
                            <div
                              className="font-mono text-slate-400 truncate mt-0.5"
                              title={plan.targetRelativePath}
                            >
                              {plan.targetRelativePath}
                            </div>
                            {plan.collision !== 'none' && (
                              <div className="text-red-400 mt-0.5">{plan.collisionDetail}</div>
                            )}
                            {track.lookupError && (
                              <div className="text-amber-400 mt-0.5 truncate" title={track.lookupError}>
                                {track.lookupError}
                              </div>
                            )}
                          </td>

                          <td className="py-3 pl-3 pr-4 text-right whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => onSelectTrack(track.id)}
                              aria-label={`Track ${track.title} inspizieren`}
                              className="inline-flex items-center gap-1 text-slate-300 hover:text-sky-300"
                            >
                              <span className="font-mono">
                                {track.status === 'moved'
                                  ? 'Verschoben'
                                  : track.status === 'tagged'
                                    ? 'Getaggt'
                                    : track.status === 'skipped_artist_conflict'
                                      ? 'Übersprungen'
                                      : plan.hasOpenArtistConflict
                                        ? 'Künstler offen'
                                        : mode1Completed
                                          ? 'Analysiert'
                                          : 'Offen'}
                              </span>
                              <ChevronRight className="h-3.5 w-3.5 text-slate-500" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {filteredTracks.length > visibleTracks.length && (
                <div className="px-4 py-3.5 border-t border-[#243044] bg-[#111927] flex flex-wrap items-center justify-between gap-3 text-xs">
                  <span className="font-mono text-slate-400 tabular-nums">
                    Zeige {visibleTracks.length} von {filteredTracks.length} Tracks
                  </span>
                  <button
                    type="button"
                    onClick={() => setVisibleCount((prev) => prev + 50)}
                    className="px-4 py-2 min-h-[40px] rounded-md border border-[#243044] bg-[#0F172A] text-sky-300 font-medium hover:border-sky-400 whitespace-nowrap"
                  >
                    Weitere 50 Tracks laden
                  </button>
                </div>
              )}
              </>
            )}
          </section>
        </>
      )}

      {/* Bottom Split: Companion Files & Untouched Leftovers/Videos */}
      {(companions.length > 0 || leftovers.length > 0) && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          {/* Companion Files */}
          <section className="bg-[#151E2E] border border-[#243044] rounded-lg overflow-hidden">
            <div className="px-5 py-3.5 border-b border-[#243044] flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                <FolderOpen className="h-4 w-4 text-sky-400" />
                <span>Begleitdateien (ziehen mit ihrem Album um)</span>
              </div>
              <span className="font-mono text-xs tabular-nums text-slate-400">
                {companions.length} Dateien
              </span>
            </div>
            {companions.length === 0 ? (
              <div className="px-5 py-6 text-xs text-slate-400">
                Keine Begleitdateien (cover.jpg, .cue, .log, .m3u, .pdf) gefunden.
              </div>
            ) : (
              <div className="divide-y divide-[#243044] text-xs">
                {companions.slice(0, visibleCompanionsCount).map((c) => (
                  <div key={c.id} className="px-5 py-3 flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className="font-mono text-slate-200 truncate">{c.fileName}</div>
                      <div className="font-mono text-slate-500 truncate mt-0.5">
                        {c.targetPath ? `→ ${c.targetPath}` : 'Bleibt am Quellort'}
                      </div>
                    </div>
                    <div className="text-right shrink-0 font-mono tabular-nums text-slate-400">
                      <div>{formatBytes(c.sizeBytes || 0)}</div>
                      <div className={c.moved ? 'text-emerald-400' : 'text-slate-500'}>
                        {c.moved ? 'Verschoben' : 'Geplant'}
                      </div>
                    </div>
                  </div>
                ))}
                {companions.length > visibleCompanionsCount && (
                  <div className="px-5 py-3 bg-[#111927] flex items-center justify-between gap-3">
                    <span className="font-mono text-slate-400">
                      Zeige {visibleCompanionsCount} von {companions.length}
                    </span>
                    <button
                      type="button"
                      onClick={() => setVisibleCompanionsCount((n) => n + 50)}
                      className="text-sky-300 font-medium hover:text-sky-200"
                    >
                      Weitere 50 anzeigen
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>

          {/* Leftovers & Untouched Videos */}
          <section className="bg-[#151E2E] border border-[#243044] rounded-lg overflow-hidden">
            <div className="px-5 py-3.5 border-b border-[#243044] flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                <Film className="h-4 w-4 text-amber-400" />
                <span>Nicht verschobene Rest- &amp; Videodateien</span>
              </div>
              <span className="font-mono text-xs tabular-nums text-slate-400">
                {leftovers.length} Dateien
              </span>
            </div>
            {leftovers.length === 0 ? (
              <div className="px-5 py-6 text-xs text-slate-400">
                Keine unberührten Rest- oder Videodateien gefunden.
              </div>
            ) : (
              <div className="divide-y divide-[#243044] text-xs">
                {leftovers.slice(0, visibleLeftoversCount).map((item) => (
                  <div key={item.id} className="px-5 py-3 flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="font-mono text-slate-200 truncate">
                        {item.sourceRelativePath}
                      </div>
                      <div className="text-slate-400 mt-0.5">{item.reason}</div>
                    </div>
                    <div className="text-right shrink-0 font-mono tabular-nums text-slate-400">
                      <div>{formatBytes(item.sizeBytes || 0)}</div>
                      <div className="text-amber-400">
                        {item.kind === 'video'
                          ? 'Video'
                          : item.kind === 'review_left_in_place'
                            ? 'Review'
                            : 'Restdatei'}
                      </div>
                    </div>
                  </div>
                ))}
                {leftovers.length > visibleLeftoversCount && (
                  <div className="px-5 py-3 bg-[#111927] flex items-center justify-between gap-3">
                    <span className="font-mono text-slate-400">
                      Zeige {visibleLeftoversCount} von {leftovers.length}
                    </span>
                    <button
                      type="button"
                      onClick={() => setVisibleLeftoversCount((n) => n + 50)}
                      className="text-sky-300 font-medium hover:text-sky-200"
                    >
                      Weitere 50 anzeigen
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      )}

      {/* Atomic Journal & Rollback Bar (Production Only — No Simulation Controls) */}
      <section className="bg-[#151E2E] border border-[#243044] rounded-lg px-4 sm:px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 text-xs">
        <div className="space-y-0.5 min-w-0">
          <div className="font-semibold text-slate-200">
            Atomares Write-Ahead-Journal (rollback.json · Temp + fsync + Rename)
          </div>
          <div className="text-slate-400 font-mono tabular-nums break-words">
            Status: {journal.state} · Einträge: {journalEntries.length} · Gelöschte leere Ordner:{' '}
            {journalRemovedDirs.length}
            {journal.backupConfirmedAt ? ' · Backup bestätigt' : ''}
          </div>
        </div>
        {canRollback && (
          <button
            type="button"
            onClick={onRollbackJournal}
            className="w-full sm:w-auto min-h-[44px] inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-md border border-red-500/40 bg-red-500/10 text-red-300 font-medium hover:bg-red-500/20 whitespace-nowrap"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>Lauf rückgängig machen (Pfade + Original-Tags)</span>
          </button>
        )}
      </section>
    </div>
  );
}
