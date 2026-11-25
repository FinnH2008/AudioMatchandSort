import { AlertTriangle, Check, Disc, FileAudio, Music2, RefreshCw, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatCodecLabel } from '../engine/codecAndSanitizer';
import {
  AudioTrack,
  EvaluatedTrackPlan,
  ManualAssignment,
  PipelineConfig,
  SourceProvider,
} from '../types/tonarchiv';

interface TrackInspectorDrawerProps {
  track: AudioTrack | null;
  plan: EvaluatedTrackPlan | null;
  config: PipelineConfig;
  queueBusy?: boolean;
  onClose: () => void;
  onSelectSource: (trackId: string, provider: SourceProvider) => void;
  onUpdateLyrics: (
    trackId: string,
    payload: { syncedLrc: string; plainText: string; status: 'synced' | 'plain' | 'instrumental' }
  ) => void;
  onApplyManualReviewAssignment: (
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
  ) => void;
  onRetryTrackLookup?: (trackId: string) => void;
}

type DrawerTab = 'overview' | 'metadata' | 'lyrics';

export function TrackInspectorDrawer({
  track,
  plan,
  config,
  queueBusy = false,
  onClose,
  onSelectSource,
  onUpdateLyrics,
  onApplyManualReviewAssignment,
  onRetryTrackLookup,
}: TrackInspectorDrawerProps) {
  const [activeTab, setActiveTab] = useState<DrawerTab>('overview');
  const [imgError, setImgError] = useState(false);

  // Manual assignment editor state for review tracks
  const [chosenAssignment, setChosenAssignment] = useState<ManualAssignment>('album_track');
  const [selectedReleaseId, setSelectedReleaseId] = useState<string>('');
  const [editAlbumArtist, setEditAlbumArtist] = useState('');
  const [editArtist, setEditArtist] = useState('');
  const [editTitle, setEditTitle] = useState('');
  const [editAlbum, setEditAlbum] = useState('');
  const [editYear, setEditYear] = useState('');
  const [editTrackNo, setEditTrackNo] = useState('');

  // Lyrics editor state
  const [lyricsDraft, setLyricsDraft] = useState('');
  const [lyricsSavedToast, setLyricsSavedToast] = useState(false);

  useEffect(() => {
    if (!track) return;
    setImgError(false);
    setActiveTab('overview');
    setChosenAssignment(track.manualAssignment === 'none' ? 'album_track' : track.manualAssignment);
    setSelectedReleaseId(track.manualReleaseId ?? track.availableReleases?.[0]?.releaseId ?? '');
    setEditAlbumArtist(track.albumArtist || '');
    setEditArtist(track.artist || '');
    setEditTitle(track.title || '');
    setEditAlbum(track.album || '');
    setEditYear(track.year || '');
    setEditTrackNo(track.trackNumber || '');
    setLyricsDraft(track.lyrics?.syncedLrc || track.lyrics?.plainText || '');
    setLyricsSavedToast(false);
  }, [track?.id]);

  useEffect(() => {
    if (!track) return;
    const incomingLyrics = track.lyrics?.syncedLrc || track.lyrics?.plainText || '';
    if (incomingLyrics) {
      setLyricsDraft((prev) => (prev ? prev : incomingLyrics));
    }
  }, [track?.lyrics?.syncedLrc, track?.lyrics?.plainText]);

  useEffect(() => {
    if (!track) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [track, onClose]);

  if (!track || !plan) return null;

  const isReviewTrack =
    plan.classification === 'review_low_confidence' ||
    plan.classification === 'review_no_release_match' ||
    track.manualAssignment !== 'none';

  const keyDisplay =
    !config.enableEssentia || !config.essentiaAvailable
      ? 'Essentia deaktiviert'
      : config.keyFormat === 'camelot'
        ? track.camelotKey
        : config.keyFormat === 'musical'
          ? track.musicalKey
          : `${track.camelotKey} · ${track.musicalKey}`;

  const handleReleaseDropdownChange = (relId: string) => {
    setSelectedReleaseId(relId);
    const rel = track.availableReleases.find((r) => r.releaseId === relId);
    if (rel) {
      setEditAlbumArtist(rel.albumArtist);
      setEditAlbum(rel.title);
      setEditYear(rel.year);
    }
  };

  const handleSaveManualAssignment = () => {
    if (chosenAssignment === 'album_track') {
      onApplyManualReviewAssignment(track.id, 'album_track', {
        manualReleaseId: selectedReleaseId || null,
        albumArtist: editAlbumArtist.trim() || track.albumArtist,
        artist: editArtist.trim() || track.artist,
        title: editTitle.trim() || track.title,
        album: editAlbum.trim() || track.album,
        year: editYear.trim() || track.year,
        trackNumber: editTrackNo.trim() || track.trackNumber,
      });
    } else {
      onApplyManualReviewAssignment(track.id, chosenAssignment);
    }
  };

  const handleSaveLyrics = () => {
    const trimmed = lyricsDraft.trim();
    const isSynced = /\[\d{2}:\d{2}\.\d{2}\]/.test(trimmed);
    onUpdateLyrics(track.id, {
      syncedLrc: isSynced ? trimmed : '',
      plainText: trimmed,
      status: trimmed ? (isSynced ? 'synced' : 'plain') : 'instrumental',
    });
    setLyricsSavedToast(true);
    window.setTimeout(() => setLyricsSavedToast(false), 2000);
  };

  const tagDiffRows: Array<{ field: string; before: string; after: string; locked?: boolean }> = [
    {
      field: 'ALBUMARTIST',
      before: track.originalTags?.albumArtist || '—',
      after:
        plan.classification === 'dj_remix'
          ? track.originalTags?.albumArtist || track.albumArtist
          : plan.resolvedAlbumArtist,
      locked: plan.classification === 'dj_remix' || plan.willSkipInMode2,
    },
    {
      field: 'ARTIST',
      before: track.originalTags?.artist || '—',
      after:
        plan.classification === 'dj_remix'
          ? track.originalTags?.artist || track.artist
          : track.artist,
      locked: plan.classification === 'dj_remix' || plan.willSkipInMode2,
    },
    {
      field: 'TITLE',
      before: track.originalTags?.title || '—',
      after:
        plan.classification === 'dj_remix'
          ? track.originalTags?.title || track.title
          : track.title,
      locked: plan.classification === 'dj_remix' || plan.willSkipInMode2,
    },
    {
      field: 'ALBUM',
      before: track.originalTags?.album || '—',
      after:
        plan.classification === 'dj_remix'
          ? track.originalTags?.album || '—'
          : track.album || '—',
      locked: plan.classification === 'dj_remix' || plan.willSkipInMode2,
    },
    {
      field: 'INITIALKEY / TKEY',
      before: track.originalTags?.key || '—',
      after:
        !config.enableEssentia || !config.essentiaAvailable
          ? 'Essentia aus'
          : plan.classification === 'dj_remix' && !config.enrichRemixEmptyFields
            ? track.originalTags?.key || '—'
            : keyDisplay,
    },
    {
      field: 'BPM',
      before: track.originalTags?.bpm ? String(track.originalTags.bpm) : '—',
      after:
        !config.enableEssentia || !config.essentiaAvailable
          ? 'Essentia aus'
          : track.bpm
            ? String(track.bpm)
            : '—',
    },
    {
      field: 'COMPILATION',
      before: track.originalTags?.compilation ? '1' : '0',
      after: track.compilationFlag ? '1 (Various Artists)' : '0',
    },
    {
      field: 'REPLAYGAIN',
      before: '—',
      after:
        config.writeReplayGain && typeof track.replayGainDb === 'number'
          ? `${track.replayGainDb.toFixed(1)} dB`
          : 'Deaktiviert',
    },
  ];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="inspector-drawer-title"
      className="fixed inset-0 z-50 flex justify-end bg-slate-950/75"
    >
      <div className="fixed inset-0" onClick={onClose} aria-hidden="true" />
      <div className="relative z-10 w-full max-w-2xl h-full bg-[#151E2E] border-l border-[#243044] flex flex-col overflow-hidden">
        {/* Drawer Header */}
        <div className="px-4 sm:px-6 py-4 sm:py-5 border-b border-[#243044] flex items-start justify-between gap-3 sm:gap-4">
          <div className="min-w-0 space-y-1">
            <h2
              id="inspector-drawer-title"
              className="font-display text-base sm:text-lg font-semibold text-slate-50 truncate"
            >
              {track.title}
            </h2>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-400">
              <span className="text-slate-200">{track.artist}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono">{formatCodecLabel(track.codec, track.extension)}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">
                {track.bitDepth ? `${track.bitDepth}-Bit / ` : ''}
                {((track.sampleRateHz || 44100) / 1000).toFixed(1)} kHz · {track.bitrateKbps || 0} kbps
              </span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">
                {track.cachedLookup ? 'SQLite-Cache' : 'Live-Abfrage'}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Track-Inspektor schließen"
            className="min-h-[44px] min-w-[44px] -mr-2 -mt-1 flex items-center justify-center rounded-md text-slate-400 hover:bg-slate-800 hover:text-slate-100 shrink-0"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Segmented Tabs */}
        <div
          role="tablist"
          aria-label="Inspektor-Reiter"
          className="px-4 sm:px-6 py-2.5 sm:py-3 border-b border-[#243044] bg-[#111927] flex items-center gap-1 overflow-x-auto"
        >
          {(
            [
              { id: 'overview', label: 'Übersicht & Release' },
              { id: 'metadata', label: 'Metadaten & Cover' },
              { id: 'lyrics', label: 'Songtexte (Lyrics)' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-3 py-2 sm:py-1.5 min-h-[40px] sm:min-h-0 rounded-md text-xs font-medium whitespace-nowrap shrink-0 transition-colors ${
                activeTab === tab.id
                  ? 'bg-sky-400/15 text-sky-300'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Drawer Body */}
        <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-5 space-y-6 text-sm">
          {activeTab === 'overview' && (
            <>
              {/* MusicBrainz Lookup Error Notice + Targeted Single-Track Retry */}
              {track.lookupError && (
                <div className="bg-[#0F172A] border border-amber-500/50 rounded-md p-4 space-y-2.5">
                  <div className="flex items-center gap-2 text-xs font-semibold text-amber-300">
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                    <span>MusicBrainz-Abruf beim Scan fehlgeschlagen</span>
                  </div>
                  <p className="text-xs text-slate-300 leading-relaxed">
                    {track.lookupError} Die Datei blieb unverändert mit ihren lokalen Tags erhalten.
                  </p>
                  {onRetryTrackLookup && (
                    <button
                      type="button"
                      disabled={queueBusy}
                      onClick={() => onRetryTrackLookup(track.id)}
                      className="inline-flex items-center gap-1.5 px-3 py-2 min-h-[38px] rounded-md bg-amber-400 text-slate-950 text-xs font-semibold hover:bg-amber-300 disabled:opacity-50"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      <span>Diesen Track erneut bei MusicBrainz abrufen</span>
                    </button>
                  )}
                </div>
              )}

              {/* Detachment / Release Tracklist Notice */}
              {track.detachReason && (
                <div className="bg-[#0F172A] border border-amber-500/40 rounded-md p-4 space-y-1">
                  <div className="flex items-center gap-2 text-xs font-semibold text-amber-400">
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                    <span>Herauslöse- / Review-Begründung</span>
                  </div>
                  <p className="text-slate-200 text-sm">{track.detachReason}</p>
                </div>
              )}

              {/* Spectral Amber Warning ONLY */}
              {track.spectralWarningOnly && config.enableEssentia && config.essentiaAvailable && (
                <div className="bg-[#0F172A] border border-amber-500/40 rounded-md p-4 space-y-1">
                  <div className="text-xs font-semibold text-amber-400">
                    Spektral-Cutoff-Warnung (Heuristik · {track.spectralCutoffKhz} kHz)
                  </div>
                  <p className="text-xs text-slate-300">
                    Verdacht auf hochskalierten Transcode. TonArchiv markiert diese Datei
                    ausschließlich als Warnung und sortiert sie niemals automatisch aus Lossless um.
                  </p>
                </div>
              )}

              {/* Paths */}
              <div className="space-y-3">
                <h3 className="text-xs font-semibold text-slate-400">Pfad-Zuordnung</h3>
                <div className="bg-[#0F172A] border border-[#243044] rounded-md p-4 space-y-2.5 text-xs">
                  <div>
                    <div className="text-slate-500 mb-0.5">Aktueller Quellpfad</div>
                    <div className="font-mono text-slate-300 break-all">
                      {track.sourceRelativePath}
                    </div>
                  </div>
                  <div className="border-t border-[#243044] pt-2.5">
                    <div className="text-slate-500 mb-0.5">Geplanter Zielpfad</div>
                    <div className="font-mono text-sky-300 break-all">
                      {plan.targetRelativePath}
                    </div>
                  </div>
                </div>
              </div>

              {/* Matched Release */}
              <div className="space-y-2.5">
                <h3 className="text-xs font-semibold text-slate-400">
                  Album-Release-Erkennung (MusicBrainz)
                </h3>
                {track.matchedRelease ? (
                  <div className="bg-[#0F172A] border border-[#243044] rounded-md p-4 space-y-1.5 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-slate-100">
                        {track.matchedRelease.title}
                      </span>
                      <span className="font-mono tabular-nums text-emerald-400">
                        Match {Math.round((track.matchedRelease.matchScore ?? 0.85) * 100)} %
                      </span>
                    </div>
                    <div className="text-slate-400">
                      {track.matchedRelease.albumArtist} · {track.matchedRelease.year} ·{' '}
                      {track.matchedRelease.format} · {track.matchedRelease.country} ·{' '}
                      <span className="font-mono tabular-nums">
                        {track.matchedRelease.trackCount} Tracks
                      </span>
                    </div>
                    <div className="text-slate-300 pt-1">
                      {track.inMatchedReleaseTracklist
                        ? `Trackliste bestätigt (Position #${track.matchedReleaseTrackPos ?? '—'}, Dauer ±3 s)`
                        : 'Track nicht in der offiziellen Trackliste dieses Releases'}
                    </div>
                  </div>
                ) : (
                  <div className="bg-[#0F172A] border border-[#243044] rounded-md p-4 text-xs text-slate-400">
                    Kein sicheres Album-Release zugeordnet. Konfidenz:{' '}
                    <span className="font-mono tabular-nums text-amber-400">
                      {Math.round((track.acoustidConfidence ?? 0) * 100)} %
                    </span>{' '}
                    (Schwellwert {Math.round(config.confidenceThreshold * 100)} %).
                  </div>
                )}
              </div>

              {/* Manual Review Assignment & Re-Run (Mode 2 + Mode 3) */}
              {isReviewTrack && (
                <div className="bg-[#0F172A] border border-sky-400/40 rounded-md p-4 space-y-4">
                  <div className="space-y-1">
                    <h3 className="text-sm font-semibold text-slate-100">
                      Manuelle Nach-Zuordnung (gezielter Re-Run: Modus 2 + Modus 3)
                    </h3>
                    <p className="text-xs text-slate-400">
                      Ordne diesen Review-Track manuell zu. Der anschließende Re-Run führt zuerst
                      Modus 2 (Taggen inkl. Original-Tags im Journal) und danach Modus 3
                      (Verschieben) gezielt für diesen Track aus.
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {(
                      [
                        { id: 'album_track', label: 'Als Album-Track' },
                        { id: 'dj_remix', label: 'Als DJ-Remix' },
                        { id: 'duplicate', label: 'Als Duplikat (_Duplikate/)' },
                      ] as const
                    ).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setChosenAssignment(opt.id)}
                        className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                          chosenAssignment === opt.id
                            ? 'bg-sky-400 text-slate-950'
                            : 'bg-[#151E2E] border border-[#243044] text-slate-300 hover:text-slate-100'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>

                  {chosenAssignment === 'dj_remix' && (
                    <p className="text-xs text-slate-300">
                      DJ-Remix-Regeln aktiv: <span className="font-mono">Artist</span> und{' '}
                      <span className="font-mono">Titel</span> bleiben unverändert; nur leere Felder
                      (Key, BPM, ReplayGain, Cover) werden ergänzt.
                    </p>
                  )}

                  {chosenAssignment === 'album_track' && (
                    <div className="space-y-3 pt-1">
                      {track.availableReleases.length > 0 && (
                        <div>
                          <label
                            htmlFor="manual-release-select"
                            className="block text-xs text-slate-400 mb-1"
                          >
                            Album-Release auswählen (optional)
                          </label>
                          <select
                            id="manual-release-select"
                            value={selectedReleaseId}
                            onChange={(e) => handleReleaseDropdownChange(e.target.value)}
                            className="w-full rounded-md bg-[#151E2E] border border-[#243044] px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-sky-400"
                          >
                            <option value="">Manuelle Tag-Eingabe ohne Release-Vorlage</option>
                            {track.availableReleases.map((rel) => (
                              <option key={rel.releaseId} value={rel.releaseId}>
                                {rel.albumArtist} — {rel.title} ({rel.year} · {rel.format} ·{' '}
                                {rel.trackCount} Tracks)
                              </option>
                            ))}
                          </select>
                        </div>
                      )}

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label
                            htmlFor="edit-album-artist"
                            className="block text-xs text-slate-400 mb-1"
                          >
                            ALBUMARTIST (Ordnername)
                          </label>
                          <input
                            id="edit-album-artist"
                            type="text"
                            value={editAlbumArtist}
                            onChange={(e) => setEditAlbumArtist(e.target.value)}
                            className="w-full rounded-md bg-[#151E2E] border border-[#243044] px-3 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-sky-400"
                          />
                        </div>
                        <div>
                          <label
                            htmlFor="edit-album"
                            className="block text-xs text-slate-400 mb-1"
                          >
                            Album
                          </label>
                          <input
                            id="edit-album"
                            type="text"
                            value={editAlbum}
                            onChange={(e) => setEditAlbum(e.target.value)}
                            className="w-full rounded-md bg-[#151E2E] border border-[#243044] px-3 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-sky-400"
                          />
                        </div>
                        <div>
                          <label
                            htmlFor="edit-title"
                            className="block text-xs text-slate-400 mb-1"
                          >
                            Titel
                          </label>
                          <input
                            id="edit-title"
                            type="text"
                            value={editTitle}
                            onChange={(e) => setEditTitle(e.target.value)}
                            className="w-full rounded-md bg-[#151E2E] border border-[#243044] px-3 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-sky-400"
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label
                              htmlFor="edit-year"
                              className="block text-xs text-slate-400 mb-1"
                            >
                              Jahr
                            </label>
                            <input
                              id="edit-year"
                              type="text"
                              value={editYear}
                              onChange={(e) => setEditYear(e.target.value)}
                              className="w-full rounded-md bg-[#151E2E] border border-[#243044] px-3 py-1.5 text-xs font-mono text-slate-100 focus:outline-none focus:border-sky-400"
                            />
                          </div>
                          <div>
                            <label
                              htmlFor="edit-trackno"
                              className="block text-xs text-slate-400 mb-1"
                            >
                              Track-Nr.
                            </label>
                            <input
                              id="edit-trackno"
                              type="text"
                              value={editTrackNo}
                              onChange={(e) => setEditTrackNo(e.target.value)}
                              className="w-full rounded-md bg-[#151E2E] border border-[#243044] px-3 py-1.5 text-xs font-mono text-slate-100 focus:outline-none focus:border-sky-400"
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="flex items-center justify-between gap-3 pt-1">
                    <span className="text-xs text-slate-400">
                      {track.pendingReRunTagAndMove
                        ? 'Für gezielten Re-Run (Modus 2 + 3) vorgemerkt.'
                        : 'Änderung merkt den Track direkt für den Re-Run vor.'}
                    </span>
                    <button
                      type="button"
                      onClick={handleSaveManualAssignment}
                      className="px-3.5 py-2 rounded-md bg-sky-400 text-slate-950 text-xs font-semibold hover:bg-sky-300 whitespace-nowrap"
                    >
                      Zuordnung für Re-Run speichern
                    </button>
                  </div>
                </div>
              )}

              {/* Multi-Source Comparison */}
              <div className="space-y-2.5">
                <h3 className="text-xs font-semibold text-slate-400">
                  Quellen-Abgleich (MusicBrainz / ShazamIO / Discogs / Deezer)
                </h3>
                <div className="divide-y divide-[#243044] border border-[#243044] rounded-md bg-[#0F172A]">
                  {track.sourceCandidates.map((cand) => {
                    const selected = track.activeSource === cand.provider;
                    return (
                      <div
                        key={cand.provider}
                        className="p-3.5 flex items-start justify-between gap-4"
                      >
                        <div className="space-y-0.5 text-xs min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-slate-100 capitalize">
                              {cand.provider === 'musicbrainz'
                                ? 'MusicBrainz'
                                : cand.provider === 'shazamio'
                                  ? 'ShazamIO'
                                  : cand.provider === 'discogs'
                                    ? 'Discogs'
                                    : 'Deezer'}
                            </span>
                            <span className="text-slate-600">·</span>
                            <span
                              className={`font-mono tabular-nums ${
                                cand.confidence >= config.confidenceThreshold
                                  ? 'text-emerald-400'
                                  : 'text-amber-400'
                              }`}
                            >
                              {Math.round(cand.confidence * 100)} % Konfidenz
                            </span>
                          </div>
                          <div className="text-slate-300">
                            {cand.artist} — {cand.title} ({cand.album || 'Ohne Album'},{' '}
                            {cand.year || '—'})
                          </div>
                          <div className="text-slate-500">{cand.notes}</div>
                        </div>
                        <button
                          type="button"
                          onClick={() => onSelectSource(track.id, cand.provider)}
                          disabled={selected}
                          className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap shrink-0 ${
                            selected
                              ? 'bg-emerald-500/15 text-emerald-400 cursor-default'
                              : 'bg-[#151E2E] border border-[#243044] text-slate-200 hover:border-sky-400'
                          }`}
                        >
                          {selected ? 'Aktiv' : 'Übernehmen'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {activeTab === 'metadata' && (
            <>
              {/* Cover Art Section */}
              <div className="flex flex-col sm:flex-row gap-5 items-start bg-[#0F172A] border border-[#243044] rounded-md p-4">
                <div className="w-32 h-32 shrink-0 rounded-md overflow-hidden border border-[#243044] bg-slate-900 flex items-center justify-center">
                  {track.cover?.imageUrl && !imgError ? (
                    <img
                      src={track.cover.imageUrl}
                      alt={`Album-Cover für ${track.album || track.title}`}
                      referrerPolicy="no-referrer"
                      onError={() => setImgError(true)}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div
                      className={`w-full h-full bg-gradient-to-br ${track.cover?.fallbackGradient || 'from-slate-800 to-slate-900'} flex flex-col items-center justify-center gap-1.5 text-slate-400 p-2 text-center`}
                    >
                      <Disc className="h-7 w-7 opacity-70" />
                      <span className="text-[11px]">Kein Cover</span>
                    </div>
                  )}
                </div>

                <div className="flex-1 space-y-2 text-xs">
                  <div className="text-sm font-semibold text-slate-100">
                    Eingebettetes Album-Cover (Mutagen)
                  </div>
                  <div className="text-slate-300 space-y-1">
                    <div>
                      Quelle: <span className="text-slate-100">{track.cover?.source || 'Keine'}</span> ·
                      Auflösung:{' '}
                      <span className="font-mono tabular-nums text-slate-100">
                        {track.cover?.resolution || '—'}
                      </span>{' '}
                      · Größe:{' '}
                      <span className="font-mono tabular-nums text-slate-100">
                        {track.cover?.sizeKb || 0} KB
                      </span>
                    </div>
                    <div className="text-slate-400">
                      Vorher eingebettet: {track.cover?.embeddedBefore ? 'Ja' : 'Nein'} · Zielformat:{' '}
                      <span className="font-mono">
                        {track.codec === 'flac'
                          ? 'METADATA_BLOCK_PICTURE'
                          : track.codec === 'alac' || track.codec === 'aac'
                            ? 'covr Atom'
                            : 'ID3v2.4 APIC'}
                      </span>
                    </div>
                  </div>

                  {plan.wavMediaSkipped && (
                    <div className="pt-1 text-amber-400">
                      WAV-Schutz aktiv: Cover- &amp; Lyrics-Embedding für WAV ist standardmäßig
                      deaktiviert (in „Ordner &amp; Regeln“ optional zuschaltbar).
                    </div>
                  )}
                </div>
              </div>

              {/* DJ-Remix Tag Protection Explanation */}
              {plan.classification === 'dj_remix' && (
                <div className="bg-[#0F172A] border border-[#243044] rounded-md p-3.5 text-xs text-slate-300">
                  <strong className="text-slate-100">DJ-Remix-Schutz:</strong>{' '}
                  <span className="font-mono">Artist</span> und{' '}
                  <span className="font-mono">Titel</span> werden nicht überschrieben. Ergänzbare
                  leere Felder:{' '}
                  <span className="font-mono text-sky-300">
                    {plan.willEnrichRemixEmptyFields.length > 0
                      ? plan.willEnrichRemixEmptyFields.join(', ')
                      : 'Keine (deaktiviert oder bereits befüllt)'}
                  </span>
                </div>
              )}

              {/* Before / After Tag Diff Table */}
              <div className="space-y-2">
                <h3 className="text-xs font-semibold text-slate-400">
                  Vorher / Nachher Tag-Diff (Original-Tags werden in rollback.json gesichert)
                </h3>
                <div className="overflow-x-auto border border-[#243044] rounded-md">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-[#111927] text-slate-400 border-b border-[#243044]">
                      <tr>
                        <th className="px-3.5 py-2.5 font-medium">Tag-Feld</th>
                        <th className="px-3.5 py-2.5 font-medium">Vorher (Original)</th>
                        <th className="px-3.5 py-2.5 font-medium">Nachher (Ziel)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#243044] bg-[#0F172A]">
                      {tagDiffRows.map((row) => {
                        const changed = row.before !== row.after && !row.locked;
                        return (
                          <tr key={row.field}>
                            <td className="px-3.5 py-2.5 font-mono text-slate-400 whitespace-nowrap">
                              {row.field}
                            </td>
                            <td className="px-3.5 py-2.5 text-slate-400">{row.before}</td>
                            <td
                              className={`px-3.5 py-2.5 ${
                                row.locked
                                  ? 'text-slate-400'
                                  : changed
                                    ? 'text-sky-300 font-medium'
                                    : 'text-slate-200'
                              }`}
                            >
                              {row.after}
                              {row.locked && (
                                <span className="ml-2 text-[11px] text-slate-500">
                                  (geschützt)
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}

          {activeTab === 'lyrics' && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
                <div className="flex items-center gap-2">
                  <Music2 className="h-4 w-4 text-sky-400" />
                  <span>
                    Quelle: <strong className="text-slate-200">{track.lyrics?.source || 'Keine'}</strong> ·
                    Status:{' '}
                    <strong className="text-slate-200">
                      {track.lyrics?.status === 'synced'
                        ? 'Synchronisiert (LRC)'
                        : track.lyrics?.status === 'plain'
                          ? 'Volltext'
                          : track.lyrics?.status === 'instrumental'
                            ? 'Instrumental'
                            : 'Fehlt'}
                    </strong>
                  </span>
                </div>
                {config.writeLrcSidecar && !plan.wavMediaSkipped && (
                  <span className="font-mono text-slate-400">+ .lrc Sidecar</span>
                )}
              </div>

              {plan.wavMediaSkipped && (
                <div className="bg-[#0F172A] border border-amber-500/40 rounded-md p-3.5 text-xs text-amber-300">
                  WAV-Embedding ist deaktiviert — Lyrics werden für diese WAV-Datei nicht in
                  ID3-Chunks geschrieben.
                </div>
              )}

              <div>
                <label htmlFor="lyrics-editor" className="block text-xs text-slate-400 mb-1.5">
                  Songtext / LRC-Zeitstempel vor dem Schreiben bearbeiten
                </label>
                <textarea
                  id="lyrics-editor"
                  rows={12}
                  value={lyricsDraft}
                  onChange={(e) => setLyricsDraft(e.target.value)}
                  placeholder="[00:15.40] Zeitstempel-Zeile oder reiner Songtext … (leer lassen für Instrumental)"
                  className="w-full rounded-md bg-[#0F172A] border border-[#243044] p-3.5 font-mono text-xs text-slate-100 leading-relaxed focus:outline-none focus:border-sky-400"
                />
              </div>

              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setLyricsDraft('');
                    onUpdateLyrics(track.id, {
                      syncedLrc: '',
                      plainText: '',
                      status: 'instrumental',
                    });
                    setLyricsSavedToast(true);
                    window.setTimeout(() => setLyricsSavedToast(false), 2000);
                  }}
                  className="px-3 py-1.5 rounded-md border border-[#243044] text-xs text-slate-300 hover:bg-slate-800"
                >
                  Als Instrumental markieren
                </button>
                <button
                  type="button"
                  onClick={handleSaveLyrics}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-sky-400 text-slate-950 text-xs font-semibold hover:bg-sky-300"
                >
                  {lyricsSavedToast ? (
                    <>
                      <Check className="h-3.5 w-3.5" />
                      <span>Gespeichert</span>
                    </>
                  ) : (
                    <>
                      <FileAudio className="h-3.5 w-3.5" />
                      <span>Lyrics übernehmen</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
