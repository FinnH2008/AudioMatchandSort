import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Film,
  FolderOpen,
  Pause,
  Play,
  RotateCcw,
  Search,
} from 'lucide-react';
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
  queue: BackgroundQueueState;
  journal: RollbackJournal;
  cache: SqliteCacheState;
  searchQuery: string;
  activeFilter: LibraryFilterId;
  onSearchChange: (q: string) => void;
  onFilterChange: (f: LibraryFilterId) => void;
  onSelectTrack: (trackId: string) => void;
  onNavigateSection: (section: NavSectionId) => void;
  onToggleKeepReviewInPlace: (keep: boolean) => void;
  onPauseQueue: () => void;
  onResumeQueue: () => void;
  onResumeInterrupted: () => void;
  onRollbackJournal: () => void;
  onSimulateCrashInterrupt: () => void;
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
  queue,
  journal,
  cache,
  searchQuery,
  activeFilter,
  onSearchChange,
  onFilterChange,
  onSelectTrack,
  onNavigateSection,
  onToggleKeepReviewInPlace,
  onPauseQueue,
  onResumeQueue,
  onResumeInterrupted,
  onRollbackJournal,
  onSimulateCrashInterrupt,
}: LibraryViewProps) {
  const hasCrashRecovery =
    journal.state === 'interrupted' || cache.interruptedAnalyzeCheckpoint !== null;

  const pendingReRunTracks = tracks.filter((t) => t.pendingReRunTagAndMove);

  const filteredTracks = tracks.filter((track) => {
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
    if (
      activeFilter === 'conflicts' &&
      !plan.hasOpenArtistConflict &&
      plan.collision === 'none' &&
      !track.spectralWarningOnly &&
      !track.detachedFromAlbum
    ) {
      return false;
    }

    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    return (
      track.title.toLowerCase().includes(q) ||
      track.artist.toLowerCase().includes(q) ||
      plan.resolvedAlbumArtist.toLowerCase().includes(q) ||
      track.album.toLowerCase().includes(q) ||
      track.fileName.toLowerCase().includes(q) ||
      track.codec.toLowerCase().includes(q) ||
      track.camelotKey.toLowerCase().includes(q) ||
      plan.targetRelativePath.toLowerCase().includes(q)
    );
  });

  const filterButtons: Array<{ id: LibraryFilterId; label: string; count: number }> = [
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
    {
      id: 'conflicts',
      label: 'Hinweise',
      count:
        report.skippedInMode2ArtistConflictCount +
        report.pathCollisionCount +
        report.fakeFlacWarningCount +
        report.detachedForeignTrackCount,
    },
  ];

  const skippedMode2Tracks = tracks.filter((t) => trackPlans.get(t.id)?.hasOpenArtistConflict);
  const canRollback =
    journal.entries.some((e) => e.status === 'done') &&
    journal.state !== 'rolled_back' &&
    queue.status !== 'running';

  return (
    <div className="space-y-6">
      {/* Crash-Recovery Banner */}
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
                ? `Das atomare Journal rollback.json (${journal.entries.filter((e) => e.status === 'done').length} done, ${journal.entries.filter((e) => e.status === 'pending').length} pending) wurde vor Abschluss unterbrochen. Du kannst den Lauf nahtlos fortsetzen oder alle Pfade & Original-Tags zurückrollen.`
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
                      : 'text-slate-400'
                }`}
              >
                {mode1Completed
                  ? 'Abgeschlossen'
                  : queue.activeMode === 'analyze'
                    ? 'Läuft'
                    : 'Bereit (Read-Only)'}
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
                    : mode1Completed
                      ? 'text-sky-400'
                      : 'text-slate-500'
                }`}
              >
                {mode2Completed
                  ? 'Abgeschlossen'
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
                        report.openArtistConflictCount === 0 &&
                        report.pathCollisionCount === 0
                      ? 'text-sky-400'
                      : 'text-amber-400'
                }`}
              >
                {mode3Completed
                  ? pendingReRunTracks.length > 0
                    ? `Re-Run bereit (${pendingReRunTracks.length})`
                    : 'Abgeschlossen'
                  : !mode2Completed
                    ? 'Wartet auf Modus 2'
                    : report.openArtistConflictCount > 0
                      ? `Blockiert (${report.openArtistConflictCount} Konflikte)`
                      : 'Freigeschaltet'}
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Erfordert 0 offene Künstlerkonflikte. Verschiebt Alben, Begleitdateien &amp;{' '}
              <span className="font-mono">_Review/</span>.
            </p>
          </div>
        </div>
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
                Verarbeitet: {queue.processedCount} / {queue.totalCount} · Fehler:{' '}
                <span className={queue.errorCount > 0 ? 'text-amber-400' : 'text-slate-300'}>
                  {queue.errorCount}
                </span>{' '}
                · SQLite-Cache-Treffer: {queue.cacheHitCount} · Restzeit (ETA):{' '}
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

          {queue.errors.length > 0 && (
            <div className="pt-2 border-t border-[#243044] space-y-1">
              {queue.errors.map((err) => (
                <div key={err.id} className="text-xs text-amber-300 flex items-center gap-2">
                  <span className="font-mono text-amber-400">[{err.stage}]</span>
                  <span>
                    {err.trackLabel}: {err.message} (Lauf nicht abgebrochen)
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Mode 1 Analysis Report */}
      {mode1Completed && (
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

          {/* Transparent list of tracks skipped in Mode 2 due to open artist conflicts */}
          {skippedMode2Tracks.length > 0 && (
            <div className="px-5 py-3 bg-[#111927] border-t border-[#243044] flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="text-amber-300">
                Modus-2-Hinweis: {skippedMode2Tracks.length} Track(s) mit offenem
                Künstlerkonflikt werden beim Taggen übersprungen (
                {skippedMode2Tracks.map((t) => t.fileName).join(', ')}).
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
            className="w-full rounded-md bg-[#151E2E] border border-[#243044] pl-9 pr-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-sky-400"
          />
        </div>

        <div
          role="group"
          aria-label="Bibliotheksfilter"
          className="flex flex-wrap items-center gap-1 bg-[#151E2E] border border-[#243044] rounded-md p-1"
        >
          {filterButtons.map((btn) => {
            const active = activeFilter === btn.id;
            return (
              <button
                key={btn.id}
                type="button"
                onClick={() => onFilterChange(btn.id)}
                className={`px-2.5 py-1.5 rounded text-xs font-medium whitespace-nowrap shrink-0 transition-colors ${
                  active
                    ? 'bg-sky-400/15 text-sky-300'
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

      {/* High-Density Track Table */}
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
              className="px-4 py-2 rounded-md bg-sky-400/15 text-sky-300 text-xs font-medium hover:bg-sky-400/25"
            >
              Filter zurücksetzen
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px] table-fixed text-left border-collapse text-xs">
              <thead>
                <tr className="bg-[#111927] border-b border-[#243044] text-slate-400">
                  <th className="w-[24%] py-3 pl-4 pr-3 font-medium">Track &amp; Album-Künstler</th>
                  <th className="w-[17%] py-3 px-3 font-medium">Codec &amp; Qualität</th>
                  <th className="w-[19%] py-3 px-3 font-medium">Key · BPM · Medien</th>
                  <th className="w-[28%] py-3 px-3 font-medium">Einordnung &amp; Zielpfad</th>
                  <th className="w-[12%] py-3 pl-3 pr-4 font-medium text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#243044]">
                {filteredTracks.map((track) => {
                  const plan = trackPlans.get(track.id)!;
                  const keyLabel =
                    !config.enableEssentia || !config.essentiaAvailable
                      ? 'Essentia aus'
                      : `${track.camelotKey} (${track.musicalKey})`;

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
                          {(track.sampleRateHz / 1000).toFixed(1)}k · {track.bitrateKbps} kbps
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
                          {config.enableEssentia && config.essentiaAvailable && track.bpm
                            ? ` · ${track.bpm} BPM`
                            : ''}
                        </div>
                        <div className="text-slate-400 truncate mt-0.5">
                          {plan.wavMediaSkipped
                            ? 'WAV-Schutz: Cover/Lyrics aus'
                            : `Cover ${track.cover.status === 'missing' ? 'Fehlt' : track.cover.resolution} · ${
                                track.lyrics.status === 'synced'
                                  ? 'Sync LRC'
                                  : track.lyrics.status === 'plain'
                                    ? 'Text'
                                    : track.lyrics.status === 'instrumental'
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
                                    ? `Review (${Math.round(track.acoustidConfidence * 100)} %)`
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
        )}
      </section>

      {/* Bottom Split: Companion Files & Untouched Leftovers/Videos + Journal Rollback */}
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
          <div className="divide-y divide-[#243044] text-xs">
            {companions.map((c) => (
              <div key={c.id} className="px-5 py-3 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="font-mono text-slate-200 truncate">{c.fileName}</div>
                  <div className="font-mono text-slate-500 truncate mt-0.5">
                    {c.targetPath ? `→ ${c.targetPath}` : 'Bleibt am Quellort (Option aus)'}
                  </div>
                </div>
                <div className="text-right shrink-0 font-mono tabular-nums text-slate-400">
                  <div>{formatBytes(c.sizeBytes)}</div>
                  <div className={c.moved ? 'text-emerald-400' : 'text-slate-500'}>
                    {c.moved ? 'Verschoben' : 'Geplant'}
                  </div>
                </div>
              </div>
            ))}
          </div>
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
          <div className="divide-y divide-[#243044] text-xs">
            {leftovers.map((item) => (
              <div key={item.id} className="px-5 py-3 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="font-mono text-slate-200 truncate">{item.sourceRelativePath}</div>
                  <div className="text-slate-400 mt-0.5">{item.reason}</div>
                </div>
                <div className="text-right shrink-0 font-mono tabular-nums text-slate-400">
                  <div>{formatBytes(item.sizeBytes)}</div>
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
          </div>
        </section>
      </div>

      {/* Atomic Journal & Rollback Bar */}
      <section className="bg-[#151E2E] border border-[#243044] rounded-lg px-5 py-4 flex flex-wrap items-center justify-between gap-4 text-xs">
        <div className="space-y-0.5">
          <div className="font-semibold text-slate-200">
            Atomares Write-Ahead-Journal (rollback.json · Temp + fsync + Rename)
          </div>
          <div className="text-slate-400 font-mono tabular-nums">
            Status: {journal.state} · Einträge: {journal.entries.length} · Gelöschte leere Ordner:{' '}
            {journal.removedEmptyDirs.length}
            {journal.backupConfirmedAt ? ' · Backup bestätigt' : ''}
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          {!hasCrashRecovery && (
            <button
              type="button"
              onClick={onSimulateCrashInterrupt}
              className="px-3 py-1.5 rounded-md border border-[#243044] text-slate-300 hover:border-amber-400 hover:text-amber-300 whitespace-nowrap"
            >
              Crash-Recovery testen
            </button>
          )}
          {canRollback && (
            <button
              type="button"
              onClick={onRollbackJournal}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md border border-red-500/40 bg-red-500/10 text-red-300 font-medium hover:bg-red-500/20 whitespace-nowrap"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>Lauf rückgängig machen (Pfade + Original-Tags)</span>
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
