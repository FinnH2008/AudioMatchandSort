import { Check, Info, Layers } from 'lucide-react';
import { countCompleteTags } from '../engine/classifierAndPlanner';
import { formatCodecLabel } from '../engine/codecAndSanitizer';
import {
  AudioTrack,
  DuplicateDecision,
  DuplicateGroup,
  DuplicateMatchReason,
  DuplicateTiebreakerReason,
} from '../types/tonarchiv';

interface DuplicatesViewProps {
  duplicateGroups: DuplicateGroup[];
  tracks: AudioTrack[];
  onSelectOriginal: (groupId: string, trackId: string) => void;
  onSetDecision: (groupId: string, decision: DuplicateDecision) => void;
}

const MATCH_REASON_LABELS: Record<DuplicateMatchReason, string> = {
  mb_recording_id: 'Identische MusicBrainz Recording-ID',
  acoustid_fingerprint: 'Identischer AcoustID-Fingerprint',
  normalized_title_artist_duration: 'Normalisierter Titel + Künstler + Dauer (±2 s)',
};

const TIEBREAKER_LABELS: Record<DuplicateTiebreakerReason, string> = {
  higher_quality: 'Höhere Audioqualität (Lossless / Bit-Tiefe / Sample-Rate)',
  more_complete_tags: 'Tiebreaker 1: Vollständigere Original-Tags',
  larger_file_size: 'Tiebreaker 2: Größere Dateigröße',
  older_mtime: 'Tiebreaker 3: Älteres Änderungsdatum',
};

function formatMb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function DuplicatesView({
  duplicateGroups,
  tracks,
  onSelectOriginal,
  onSetDecision,
}: DuplicatesViewProps) {
  const trackById = new Map(tracks.map((t) => [t.id, t]));
  const actionableGroups = duplicateGroups.filter((g) => g.scope !== 'cross_album_notice');
  const crossAlbumNotices = duplicateGroups.filter((g) => g.scope === 'cross_album_notice');

  return (
    <div className="space-y-8">
      <div className="bg-[#151E2E] border border-[#243044] rounded-lg p-5 flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <h2 className="font-display text-base font-semibold text-slate-100">
            Album-bewusste Track-Duplikate (niemals automatisches Löschen)
          </h2>
          <p className="text-xs text-slate-400 max-w-3xl leading-relaxed">
            Duplikate werden nur innerhalb desselben gematchten Releases, zwischen losen Dateien
            oder bei loser Lossy-Datei gegen ein Lossless-Exemplar gebildet. DJ-Remixes werden nie
            als Duplikat ihres Originals markiert. Bestätigte Duplikate wandern journalisiert nach{' '}
            <span className="font-mono text-slate-200">_Duplikate/{'{Künstler}'}/</span>.
          </p>
        </div>
        <div className="font-mono text-xs tabular-nums text-slate-300">
          {actionableGroups.length} aktive Gruppen · {crossAlbumNotices.length} Cross-Album-Hinweise
        </div>
      </div>

      {/* Section 1: Actionable Duplicate Groups */}
      <section className="space-y-4">
        <h3 className="font-display text-sm font-semibold text-slate-200">
          Aktive Duplikat-Gruppen (Ziel: _Duplikate/)
        </h3>

        {actionableGroups.length === 0 ? (
          <div className="bg-[#151E2E] border border-[#243044] rounded-lg p-8 text-center text-sm text-slate-400">
            Keine verschiebbaren Track-Duplikate gefunden.
          </div>
        ) : (
          <div className="space-y-4">
            {actionableGroups.map((group) => (
              <div
                key={group.id}
                className="bg-[#151E2E] border border-[#243044] rounded-lg overflow-hidden"
              >
                <div className="px-5 py-4 border-b border-[#243044] flex flex-wrap items-center justify-between gap-4">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-display text-sm font-semibold text-slate-100">
                        {group.canonicalArtist} — {group.title}
                      </span>
                      <span className="text-slate-600">·</span>
                      <span className="text-xs text-slate-400">
                        {MATCH_REASON_LABELS[group.matchReason]}
                      </span>
                    </div>
                    <div className="text-xs text-sky-300">
                      Empfehlungsgrund: {TIEBREAKER_LABELS[group.tiebreakerReason]}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => onSetDecision(group.id, 'confirmed')}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap ${
                        group.decision === 'confirmed'
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                          : 'bg-sky-400 text-slate-950 font-semibold hover:bg-sky-300'
                      }`}
                    >
                      <Check className="h-3.5 w-3.5" />
                      <span>
                        {group.decision === 'confirmed' ? 'Bestätigt' : 'Empfehlung bestätigen'}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onSetDecision(group.id, 'keep_both')}
                      className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap border ${
                        group.decision === 'keep_both'
                          ? 'border-sky-400 bg-sky-400/15 text-sky-300'
                          : 'border-[#243044] bg-[#0F172A] text-slate-300 hover:border-slate-500'
                      }`}
                    >
                      Alle behalten
                    </button>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full min-w-[820px] table-fixed text-left text-xs">
                    <thead className="bg-[#111927] text-slate-400 border-b border-[#243044]">
                      <tr>
                        <th className="w-[17%] py-2.5 pl-5 pr-3 font-medium">Rolle</th>
                        <th className="w-[23%] py-2.5 px-3 font-medium">Codec &amp; Qualität</th>
                        <th className="w-[22%] py-2.5 px-3 font-medium">Tags · Größe · Datum</th>
                        <th className="w-[22%] py-2.5 px-3 font-medium">Quellpfad</th>
                        <th className="w-[16%] py-2.5 pl-3 pr-5 font-medium text-right">Auswahl</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#243044]">
                      {group.trackIds.map((tid) => {
                        const track = trackById.get(tid);
                        if (!track) return null;
                        const isOriginal = group.selectedOriginalId === tid;
                        const keepAll = group.decision === 'keep_both';
                        return (
                          <tr key={tid} className="hover:bg-slate-800/30">
                            <td className="py-3 pl-5 pr-3 font-medium truncate">
                              {keepAll ? (
                                <span className="text-sky-300">Bleibt im Hauptbaum</span>
                              ) : isOriginal ? (
                                <span className="text-emerald-400">Original (Hauptbaum)</span>
                              ) : (
                                <span className="text-amber-400">→ _Duplikate/</span>
                              )}
                            </td>
                            <td className="py-3 px-3 font-mono tabular-nums text-slate-200 truncate">
                              {formatCodecLabel(track.codec, track.extension)} ·{' '}
                              {track.bitDepth ? `${track.bitDepth}b/` : ''}
                              {(track.sampleRateHz / 1000).toFixed(1)}k · {track.bitrateKbps} kbps
                            </td>
                            <td className="py-3 px-3 font-mono tabular-nums text-slate-400 truncate">
                              {countCompleteTags(track)}/10 Tags · {formatMb(track.sizeBytes)} ·{' '}
                              {track.mtimeIso.slice(0, 10)}
                            </td>
                            <td
                              className="py-3 px-3 font-mono text-slate-400 truncate"
                              title={track.sourceRelativePath}
                            >
                              {track.sourceRelativePath}
                            </td>
                            <td className="py-3 pl-3 pr-5 text-right whitespace-nowrap">
                              {!isOriginal && !keepAll ? (
                                <button
                                  type="button"
                                  onClick={() => onSelectOriginal(group.id, tid)}
                                  className="px-2.5 py-1 rounded border border-[#243044] bg-[#0F172A] text-slate-200 hover:border-sky-400 hover:text-sky-300"
                                >
                                  Als Original wählen
                                </button>
                              ) : (
                                <span className="text-slate-500">
                                  {group.recommendedOriginalId === tid ? 'Empfohlen' : 'Gewählt'}
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
            ))}
          </div>
        )}
      </section>

      {/* Section 2: Cross-Album Info Notices (NO Move Recommendation!) */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-slate-400" />
          <h3 className="font-display text-sm font-semibold text-slate-200">
            Cross-Album-Hinweise (keine Duplikate, keine Verschiebeempfehlung)
          </h3>
        </div>

        {crossAlbumNotices.length === 0 ? (
          <div className="bg-[#151E2E] border border-[#243044] rounded-lg p-6 text-xs text-slate-400">
            Keine albumübergreifenden Track-Überschneidungen erkannt.
          </div>
        ) : (
          <div className="divide-y divide-[#243044] bg-[#151E2E] border border-[#243044] rounded-lg">
            {crossAlbumNotices.map((notice) => (
              <div key={notice.id} className="p-5 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                    <Info className="h-4 w-4 text-sky-400 shrink-0" />
                    <span>
                      {notice.canonicalArtist} — {notice.title}
                    </span>
                  </div>
                  <span className="text-xs text-slate-400">{notice.crossAlbumNote}</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1 text-xs">
                  {notice.trackIds.map((tid) => {
                    const t = trackById.get(tid);
                    if (!t) return null;
                    return (
                      <div
                        key={tid}
                        className="bg-[#0F172A] border border-[#243044] rounded-md px-3.5 py-2.5 space-y-0.5"
                      >
                        <div className="text-slate-200 font-medium">
                          Album: {t.matchedRelease?.title ?? t.album} ({t.year})
                        </div>
                        <div className="font-mono text-slate-400 truncate">
                          {formatCodecLabel(t.codec, t.extension)} · {t.bitrateKbps} kbps ·{' '}
                          {t.sourceRelativePath}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
