import { FolderTree, ShieldAlert } from 'lucide-react';
import {
  AudioTrack,
  CompanionFile,
  EvaluatedTrackPlan,
  PipelineConfig,
} from '../types/tonarchiv';

interface RulesAndFoldersViewProps {
  config: PipelineConfig;
  tracks: AudioTrack[];
  trackPlans: Map<string, EvaluatedTrackPlan>;
  companions: CompanionFile[];
  onChangeConfig: (patch: Partial<PipelineConfig>) => void;
}

export function RulesAndFoldersView({
  config,
  tracks,
  trackPlans,
  companions,
  onChangeConfig,
}: RulesAndFoldersViewProps) {
  // Build sorted unique directory tree lines from live trackPlans + companions
  const treePaths = new Set<string>();
  for (const track of tracks) {
    const plan = trackPlans.get(track.id);
    if (!plan) continue;
    treePaths.add(plan.targetRelativePath);
  }
  for (const c of companions) {
    if (c.targetPath) treePaths.add(c.targetPath);
  }

  const sortedPaths = Array.from(treePaths).sort((a, b) => a.localeCompare(b));

  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
      {/* Left Column: Rules & Controls */}
      <div className="xl:col-span-7 space-y-6">
        {/* Volume Mount & Permissions */}
        <section className="bg-[#151E2E] border border-[#243044] rounded-lg p-5 space-y-4">
          <div>
            <h2 className="font-display text-sm font-semibold text-slate-100">
              Einzelordner-Mount &amp; Dateirechte (PUID / PGID)
            </h2>
            <p className="text-xs text-slate-400 mt-1">
              Ein einzelner Volume-Mount im selben Dateisystem garantiert atomares Verschieben ohne
              EXDEV-Fehler.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <label htmlFor="host-music-dir" className="block text-xs text-slate-400 mb-1">
                Host-Ordnerpfad (wird als {config.containerMusicDir} gemountet)
              </label>
              <input
                id="host-music-dir"
                type="text"
                value={config.hostMusicDir}
                onChange={(e) => onChangeConfig({ hostMusicDir: e.target.value })}
                className="w-full rounded-md bg-[#0F172A] border border-[#243044] px-3 py-2 font-mono text-xs text-slate-100 focus:outline-none focus:border-sky-400"
              />
            </div>

            <div>
              <label htmlFor="puid-input" className="block text-xs text-slate-400 mb-1">
                PUID (Host-Benutzer-ID)
              </label>
              <input
                id="puid-input"
                type="number"
                value={config.puid}
                onChange={(e) =>
                  onChangeConfig({ puid: Math.max(0, Number(e.target.value) || 0) })
                }
                className="w-full rounded-md bg-[#0F172A] border border-[#243044] px-3 py-2 font-mono text-xs tabular-nums text-slate-100 focus:outline-none focus:border-sky-400"
              />
            </div>

            <div>
              <label htmlFor="pgid-input" className="block text-xs text-slate-400 mb-1">
                PGID (Host-Gruppen-ID)
              </label>
              <input
                id="pgid-input"
                type="number"
                value={config.pgid}
                onChange={(e) =>
                  onChangeConfig({ pgid: Math.max(0, Number(e.target.value) || 0) })
                }
                className="w-full rounded-md bg-[#0F172A] border border-[#243044] px-3 py-2 font-mono text-xs tabular-nums text-slate-100 focus:outline-none focus:border-sky-400"
              />
            </div>
          </div>
        </section>

        {/* Quality Gate, DJ-Remixes & _Review */}
        <section className="bg-[#151E2E] border border-[#243044] rounded-lg p-5 space-y-5">
          <div>
            <h2 className="font-display text-sm font-semibold text-slate-100">
              Codec-Qualitätsfilter, DJ-Remixes &amp; _Review-Ablage
            </h2>
            <p className="text-xs text-slate-400 mt-1">
              Qualität wird per ffprobe/mutagen über den tatsächlichen Codec bestimmt (M4A/ALAC =
              Lossless, M4A/AAC = Lossy) und auf Albumebene entschieden.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="bitrate-gate" className="block text-xs text-slate-400 mb-1">
                Lossy Bitrate-Grenze (Low-Quality darunter)
              </label>
              <select
                id="bitrate-gate"
                value={config.minLossyBitrateKbps}
                onChange={(e) => onChangeConfig({ minLossyBitrateKbps: Number(e.target.value) })}
                className="w-full rounded-md bg-[#0F172A] border border-[#243044] px-3 py-2 font-mono text-xs text-slate-100 focus:outline-none focus:border-sky-400"
              >
                <option value={192}>192 kbps</option>
                <option value={256}>256 kbps (Empfohlen)</option>
                <option value={320}>320 kbps</option>
              </select>
            </div>

            <div>
              <label htmlFor="key-format" className="block text-xs text-slate-400 mb-1">
                Tonart-Tag-Format (INITIALKEY / TKEY)
              </label>
              <select
                id="key-format"
                value={config.keyFormat}
                onChange={(e) =>
                  onChangeConfig({ keyFormat: e.target.value as PipelineConfig['keyFormat'] })
                }
                className="w-full rounded-md bg-[#0F172A] border border-[#243044] px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-sky-400"
              >
                <option value="both">Kombiniert (8A · A min)</option>
                <option value="camelot">Nur Camelot (8A)</option>
                <option value="musical">Nur Standard (A min)</option>
              </select>
            </div>
          </div>

          {/* DJ-Remixes Target Structure Option A vs Option B */}
          <div className="space-y-2 pt-2 border-t border-[#243044]">
            <div className="text-xs font-medium text-slate-200">
              Zielstruktur für DJ-Remixes (dauerhafter Bereich)
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => onChangeConfig({ djRemixLayout: 'root_folder' })}
                className={`p-3.5 rounded-md border text-left transition-colors ${
                  config.djRemixLayout === 'root_folder'
                    ? 'border-sky-400 bg-sky-400/10'
                    : 'border-[#243044] bg-[#0F172A] hover:border-slate-600'
                }`}
              >
                <div className="text-xs font-semibold text-slate-100">
                  Option A (Standard): Eigener Hauptordner
                </div>
                <div className="font-mono text-[11px] text-slate-400 mt-1">
                  DJ-Remixes/{'{Künstler}'}/…
                </div>
              </button>

              <button
                type="button"
                onClick={() => onChangeConfig({ djRemixLayout: 'split_by_quality' })}
                className={`p-3.5 rounded-md border text-left transition-colors ${
                  config.djRemixLayout === 'split_by_quality'
                    ? 'border-sky-400 bg-sky-400/10'
                    : 'border-[#243044] bg-[#0F172A] hover:border-slate-600'
                }`}
              >
                <div className="text-xs font-semibold text-slate-100">
                  Option B: Nach Qualität getrennt
                </div>
                <div className="font-mono text-[11px] text-slate-400 mt-1">
                  Lossless/DJ-Remixes/ &amp; Lossy/DJ-Remixes/
                </div>
              </button>
            </div>
          </div>

          <div className="space-y-3 pt-2 border-t border-[#243044] text-xs">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={config.enrichRemixEmptyFields}
                onChange={(e) => onChangeConfig({ enrichRemixEmptyFields: e.target.checked })}
                className="mt-0.5 h-4 w-4 rounded border-slate-600 bg-[#0F172A] accent-sky-400"
              />
              <span>
                <strong className="text-slate-100">Remixes: Key/BPM/Cover ergänzen</strong>
                <span className="block text-slate-400 mt-0.5">
                  Artist und Titel bleiben bei DJ-Remixes immer unverändert. Nur leere Felder (Key,
                  BPM, ReplayGain, Cover) werden ergänzt.
                </span>
              </span>
            </label>

            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={config.separateLowQualityLossy}
                onChange={(e) => onChangeConfig({ separateLowQualityLossy: e.target.checked })}
                className="mt-0.5 h-4 w-4 rounded border-slate-600 bg-[#0F172A] accent-sky-400"
              />
              <span>
                <strong className="text-slate-100">
                  Unterordner Lossy/Low-Quality/ unter {config.minLossyBitrateKbps} kbps
                </strong>
                <span className="block text-slate-400 mt-0.5">
                  Trennt minderwertige MP3/AAC/OGG-Alben sichtbar von vollwertigen Lossy-Alben.
                </span>
              </span>
            </label>

            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={config.keepReviewTracksInPlace}
                onChange={(e) => onChangeConfig({ keepReviewTracksInPlace: e.target.checked })}
                className="mt-0.5 h-4 w-4 rounded border-slate-600 bg-[#0F172A] accent-sky-400"
              />
              <span>
                <strong className="text-slate-100">
                  Review-Tracks an ursprünglichem Ort belassen
                </strong>
                <span className="block text-slate-400 mt-0.5">
                  Standard aus: Review-Tracks landen qualitätsgetrennt unter{' '}
                  <span className="font-mono">_Review/Lossless/</span> und{' '}
                  <span className="font-mono">_Review/Lossy/</span> mit unveränderter
                  Relativstruktur.
                </span>
              </span>
            </label>
          </div>
        </section>

        {/* Cover, Lyrics, WAV & SMB Sanitizing */}
        <section className="bg-[#151E2E] border border-[#243044] rounded-lg p-5 space-y-4 text-xs">
          <h2 className="font-display text-sm font-semibold text-slate-100">
            Cover, Songtexte, WAV-Schutz &amp; SMB-Sanitizing
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="cover-max-size" className="block text-slate-400 mb-1">
                Cover-Auflösung (Cover Art Archive / Deezer / Discogs)
              </label>
              <select
                id="cover-max-size"
                value={config.coverMaxSize}
                onChange={(e) =>
                  onChangeConfig({ coverMaxSize: Number(e.target.value) as 600 | 1000 | 1400 })
                }
                className="w-full rounded-md bg-[#0F172A] border border-[#243044] px-3 py-2 font-mono text-xs text-slate-100"
              >
                <option value={600}>600 × 600 px</option>
                <option value={1000}>1000 × 1000 px (Empfohlen)</option>
                <option value={1400}>1400 × 1400 px</option>
              </select>
            </div>

            <div>
              <label htmlFor="max-path-length" className="block text-slate-400 mb-1">
                Maximale Pfadlänge (Zeichen)
              </label>
              <input
                id="max-path-length"
                type="number"
                min={120}
                max={255}
                value={config.maxPathLength}
                onChange={(e) =>
                  onChangeConfig({
                    maxPathLength: Math.min(255, Math.max(120, Number(e.target.value) || 240)),
                  })
                }
                className="w-full rounded-md bg-[#0F172A] border border-[#243044] px-3 py-2 font-mono tabular-nums text-slate-100"
              />
            </div>
          </div>

          <div className="space-y-3 pt-2 border-t border-[#243044]">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={config.embedCover}
                onChange={(e) => onChangeConfig({ embedCover: e.target.checked })}
                className="mt-0.5 h-4 w-4 rounded border-slate-600 bg-[#0F172A] accent-sky-400"
              />
              <span className="text-slate-200">
                Cover-Artwork direkt per Mutagen in die Audiodatei einbetten (+ cover.jpg pro Album)
              </span>
            </label>

            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={config.fetchLyrics}
                onChange={(e) => onChangeConfig({ fetchLyrics: e.target.checked })}
                className="mt-0.5 h-4 w-4 rounded border-slate-600 bg-[#0F172A] accent-sky-400"
              />
              <span className="text-slate-200">
                Synchronisierte Songtexte (LRCLIB / syncedlyrics) einbetten (+ .lrc Sidecar)
              </span>
            </label>

            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={config.wavEmbedMedia}
                onChange={(e) => onChangeConfig({ wavEmbedMedia: e.target.checked })}
                className="mt-0.5 h-4 w-4 rounded border-slate-600 bg-[#0F172A] accent-sky-400"
              />
              <span>
                <strong className="text-amber-300">
                  Cover &amp; Lyrics in WAV-Dateien einbetten (optional, standardmäßig aus)
                </strong>
                <span className="block text-slate-400 mt-0.5">
                  WAV-ID3v2-Chunks werden von vielen Playern unzuverlässig gelesen. Nur aktivieren,
                  wenn dein Player WAV-ID3 vollständig unterstützt.
                </span>
              </span>
            </label>

            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={config.moveCompanionFiles}
                onChange={(e) => onChangeConfig({ moveCompanionFiles: e.target.checked })}
                className="mt-0.5 h-4 w-4 rounded border-slate-600 bg-[#0F172A] accent-sky-400"
              />
              <span className="text-slate-200">
                Begleitdateien (cover.jpg, folder.jpg, .cue, .log, .m3u, .pdf) mit Album verschieben
              </span>
            </label>

            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={config.smbCaseSafe}
                onChange={(e) => onChangeConfig({ smbCaseSafe: e.target.checked })}
                className="mt-0.5 h-4 w-4 rounded border-slate-600 bg-[#0F172A] accent-sky-400"
              />
              <span className="text-slate-200">
                SMB-Sanitizing &amp; Case-Insensitive-Kollisionsprüfung (niemals still überschreiben)
              </span>
            </label>
          </div>
        </section>
      </div>

      {/* Right Column: Live Target Folder Tree Preview */}
      <aside className="xl:col-span-5 bg-[#151E2E] border border-[#243044] rounded-lg overflow-hidden sticky top-20">
        <div className="px-5 py-4 border-b border-[#243044] flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <FolderTree className="h-4 w-4 text-sky-400" />
            <span>Live-Zielstruktur ({config.containerMusicDir})</span>
          </div>
          <span className="font-mono text-xs tabular-nums text-slate-400">
            {sortedPaths.length} Pfade
          </span>
        </div>

        <div className="p-4 bg-[#0F172A] max-h-[620px] overflow-y-auto font-mono text-[11px] leading-relaxed space-y-1">
          {sortedPaths.map((p) => {
            const colorClass = p.startsWith('Lossless/')
              ? 'text-emerald-300'
              : p.startsWith('DJ-Remixes/') || p.includes('/DJ-Remixes/')
                ? 'text-sky-300'
                : p.startsWith('_Duplikate/')
                  ? 'text-amber-300'
                  : p.startsWith('_Review/')
                    ? 'text-amber-200'
                    : p.startsWith('Lossy/Low-Quality/')
                      ? 'text-red-300'
                      : 'text-slate-300';
            return (
              <div key={p} className={`${colorClass} truncate`} title={p}>
                /{p}
              </div>
            );
          })}
        </div>

        <div className="px-5 py-3.5 border-t border-[#243044] text-xs text-slate-400 flex items-start gap-2">
          <ShieldAlert className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
          <span>
            Leere Alt-Ordner werden erst gelöscht, wenn wirklich keine Rest- oder Videodateien mehr
            enthalten sind.
          </span>
        </div>
      </aside>
    </div>
  );
}
