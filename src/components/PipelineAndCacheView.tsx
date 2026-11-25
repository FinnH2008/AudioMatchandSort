import { AlertTriangle, Database, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { PipelineConfig, SqliteCacheState } from '../types/tonarchiv';

interface PipelineAndCacheViewProps {
  config: PipelineConfig;
  cache: SqliteCacheState;
  onChangeConfig: (patch: Partial<PipelineConfig>) => void;
  onClearCache: () => void;
  onSimulateAnalyzeCheckpoint: () => void;
}

export function PipelineAndCacheView({
  config,
  cache,
  onChangeConfig,
  onClearCache,
  onSimulateAnalyzeCheckpoint,
}: PipelineAndCacheViewProps) {
  const totalCacheRows =
    cache.fingerprintEntries + cache.mbReleaseEntries + cache.coverEntries + cache.lyricsEntries;

  return (
    <div className="space-y-6">
      {/* Confidence Threshold & Resilience Summary */}
      <section className="bg-[#151E2E] border border-[#243044] rounded-lg p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <h2 className="font-display text-base font-semibold text-slate-100">
              Robuste 5-Stufen-Pipeline, Rate-Limiting &amp; API-Key-Absicherung
            </h2>
            <p className="text-xs text-slate-400 max-w-3xl">
              API-Keys stammen ausschließlich aus der <span className="font-mono">.env</span>.
              Fehlende Keys deaktivieren nur die jeweilige Stufe mit klarem Hinweis statt den
              Container zum Absturz zu bringen.
            </p>
          </div>
          <div className="text-right">
            <div className="text-xs text-slate-400">Konfidenz-Schwellwert (Tag-Schutz)</div>
            <div className="font-mono text-lg font-semibold tabular-nums text-sky-400">
              {config.confidenceThreshold.toFixed(2)} ({Math.round(config.confidenceThreshold * 100)}{' '}
              %)
            </div>
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="confidence-slider" className="text-xs text-slate-300">
            Darunter werden Tags niemals überschrieben — Tracks ohne Remix-Stichwort erhalten Status{' '}
            <span className="font-mono text-amber-300">review</span>.
          </label>
          <input
            id="confidence-slider"
            type="range"
            min={0.6}
            max={0.95}
            step={0.05}
            value={config.confidenceThreshold}
            onChange={(e) => onChangeConfig({ confidenceThreshold: Number(e.target.value) })}
            className="w-full accent-sky-400"
          />
          <div className="flex justify-between font-mono text-[11px] text-slate-500 tabular-nums">
            <span>0.60</span>
            <span>0.80 (Standard)</span>
            <span>0.95</span>
          </div>
        </div>
      </section>

      {/* Pipeline Stages */}
      <section className="bg-[#151E2E] border border-[#243044] rounded-lg divide-y divide-[#243044]">
        {/* Stage 1: AcoustID + MusicBrainz */}
        <div className="p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-100">
              <span>01. Codec-Inspektion (ffprobe), Chromaprint/AcoustID &amp; MusicBrainz</span>
              <span className="text-slate-600">·</span>
              <span
                className={`font-mono text-xs ${
                  config.acoustidKeyConfigured ? 'text-emerald-400' : 'text-amber-400'
                }`}
              >
                {config.acoustidKeyConfigured
                  ? 'Aktiv (MB 1 Req/s · AcoustID 3 Req/s)'
                  : 'AcoustID deaktiviert (ACOUSTID_API_KEY fehlt — MB-Release-Suche läuft weiter)'}
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Album-First Release-Matching (Track-Anzahl, Dauer ±3 s, Land/Format), exklusive
              Compilation-Suche bei Samplern, automatischer Backoff bei HTTP 429/503.
            </p>
          </div>
          <label className="inline-flex items-center gap-2 text-xs text-slate-300 whitespace-nowrap cursor-pointer">
            <input
              type="checkbox"
              checked={config.acoustidKeyConfigured}
              onChange={(e) => onChangeConfig({ acoustidKeyConfigured: e.target.checked })}
              className="h-4 w-4 rounded border-slate-600 bg-[#0F172A] accent-sky-400"
            />
            <span className="font-mono">ACOUSTID_API_KEY in .env gesetzt</span>
          </label>
        </div>

        {/* Stage 2: Optional ShazamIO */}
        <div className="p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-100">
              <span>02. ShazamIO Fallback (optional · für Remixes &amp; Edits)</span>
              <span className="text-slate-600">·</span>
              <span
                className={`font-mono text-xs ${
                  config.enableShazamFallback ? 'text-emerald-400' : 'text-slate-400'
                }`}
              >
                {config.enableShazamFallback ? 'Aktiv (Fehler brechen Lauf nie ab)' : 'Deaktiviert'}
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Inoffizielle API — Rate-Limits oder Timeouts werden geloggt und übersprungen, ohne die
              Queue anzuhalten.
            </p>
          </div>
          <label className="inline-flex items-center gap-2 text-xs text-slate-300 whitespace-nowrap cursor-pointer">
            <input
              type="checkbox"
              checked={config.enableShazamFallback}
              onChange={(e) => onChangeConfig({ enableShazamFallback: e.target.checked })}
              className="h-4 w-4 rounded border-slate-600 bg-[#0F172A] accent-sky-400"
            />
            <span className="font-mono">ENABLE_SHAZAMIO</span>
          </label>
        </div>

        {/* Stage 3: Discogs & Deezer */}
        <div className="p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-100">
              <span>03. Discogs &amp; Deezer Release-Abgleich</span>
              <span className="text-slate-600">·</span>
              <span
                className={`font-mono text-xs ${
                  config.discogsTokenConfigured ? 'text-emerald-400' : 'text-amber-400'
                }`}
              >
                {config.discogsTokenConfigured
                  ? 'Aktiv (Discogs ~60 Req/min · Deezer Public)'
                  : 'Discogs deaktiviert (DISCOGS_TOKEN fehlt — Deezer aktiv)'}
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Verifiziert Vinyl-, Club- und EP-Releases sowie ISRCs mit Token-Bucket-Rate-Limiter.
            </p>
          </div>
          <label className="inline-flex items-center gap-2 text-xs text-slate-300 whitespace-nowrap cursor-pointer">
            <input
              type="checkbox"
              checked={config.discogsTokenConfigured}
              onChange={(e) => onChangeConfig({ discogsTokenConfigured: e.target.checked })}
              className="h-4 w-4 rounded border-slate-600 bg-[#0F172A] accent-sky-400"
            />
            <span className="font-mono">DISCOGS_TOKEN in .env gesetzt</span>
          </label>
        </div>

        {/* Stage 4: Optional Essentia */}
        <div className="p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-100">
              <span>04. Lokale Audio-Analyse mit Essentia (optional)</span>
              <span className="text-slate-600">·</span>
              <span
                className={`font-mono text-xs ${
                  config.enableEssentia && config.essentiaAvailable
                    ? 'text-emerald-400'
                    : 'text-amber-400'
                }`}
              >
                {config.enableEssentia && config.essentiaAvailable
                  ? 'Aktiv (Key · BPM · Spektral-Warnung)'
                  : 'Deaktiviert — Key/BPM/Spektral fallen sauber weg, Rest läuft weiter'}
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Berechnet Tonart (Camelot/Standard), BPM und Spektral-Cutoff (Heuristik — markiert
              ausschließlich mit Amber-Warnung, sortiert niemals automatisch um).
            </p>
          </div>
          <label className="inline-flex items-center gap-2 text-xs text-slate-300 whitespace-nowrap cursor-pointer">
            <input
              type="checkbox"
              checked={config.enableEssentia}
              onChange={(e) => onChangeConfig({ enableEssentia: e.target.checked })}
              className="h-4 w-4 rounded border-slate-600 bg-[#0F172A] accent-sky-400"
            />
            <span className="font-mono">ENABLE_ESSENTIA</span>
          </label>
        </div>

        {/* Stage 5: Cover, Lyrics & Mutagen */}
        <div className="p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-100">
              <span>05. Cover Art Archive, LRCLIB / syncedlyrics &amp; Mutagen In-File Writer</span>
              <span className="text-slate-600">·</span>
              <span className="font-mono text-xs text-emerald-400">
                Aktiv (WAV-Media {config.wavEmbedMedia ? 'an' : 'aus'})
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Bettet Cover, synchronisierte LRC-Lyrics und aktualisierte Tags in FLAC, MP3, ALAC/M4A
              ein und sichert Original-Tags atomar in <span className="font-mono">rollback.json</span>.
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-emerald-400 font-mono whitespace-nowrap">
            <ShieldCheck className="h-4 w-4" />
            <span>Single-Container FastAPI</span>
          </div>
        </div>
      </section>

      {/* SQLite Persistent Cache & Checkpoint */}
      <section className="bg-[#151E2E] border border-[#243044] rounded-lg p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <Database className="h-4 w-4 text-sky-400" />
            <div>
              <h3 className="font-display text-sm font-semibold text-slate-100">
                Persistenter SQLite-Cache &amp; Fortschritts-Checkpoint
              </h3>
              <div className="font-mono text-xs text-slate-400">{cache.dbPath}</div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onSimulateAnalyzeCheckpoint}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-[#243044] bg-[#0F172A] text-xs text-slate-200 hover:border-amber-400"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>Checkpoint-Abbruch simulieren</span>
            </button>
            <button
              type="button"
              onClick={onClearCache}
              disabled={totalCacheRows === 0}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-xs ${
                totalCacheRows > 0
                  ? 'border-[#243044] bg-[#0F172A] text-slate-300 hover:border-red-400 hover:text-red-300'
                  : 'border-[#243044] bg-[#0F172A] text-slate-600 cursor-not-allowed'
              }`}
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>Cache leeren</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <div className="bg-[#0F172A] border border-[#243044] rounded-md p-3.5">
            <div className="text-slate-400">Fingerprints / AcoustID</div>
            <div className="font-mono text-base font-semibold tabular-nums text-slate-100 mt-1">
              {cache.fingerprintEntries}
            </div>
          </div>
          <div className="bg-[#0F172A] border border-[#243044] rounded-md p-3.5">
            <div className="text-slate-400">MBID &amp; Releases</div>
            <div className="font-mono text-base font-semibold tabular-nums text-slate-100 mt-1">
              {cache.mbReleaseEntries}
            </div>
          </div>
          <div className="bg-[#0F172A] border border-[#243044] rounded-md p-3.5">
            <div className="text-slate-400">Cover-Metadaten</div>
            <div className="font-mono text-base font-semibold tabular-nums text-slate-100 mt-1">
              {cache.coverEntries}
            </div>
          </div>
          <div className="bg-[#0F172A] border border-[#243044] rounded-md p-3.5">
            <div className="text-slate-400">Lyrics (LRC / Text)</div>
            <div className="font-mono text-base font-semibold tabular-nums text-slate-100 mt-1">
              {cache.lyricsEntries}
            </div>
          </div>
        </div>

        {cache.interruptedAnalyzeCheckpoint !== null && (
          <div className="flex items-center gap-2 text-xs text-amber-300">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>
              Offener Analyse-Checkpoint bei Track #{cache.interruptedAnalyzeCheckpoint} — in der
              Ansicht „Bibliothek“ nahtlos fortsetzbar.
            </span>
          </div>
        )}
      </section>
    </div>
  );
}
