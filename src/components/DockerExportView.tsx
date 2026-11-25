import JSZip from 'jszip';
import { Check, Copy, Download, FileCode2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { generateDockerBundle } from '../engine/dockerGenerator';
import { PipelineConfig } from '../types/tonarchiv';

interface DockerExportViewProps {
  config: PipelineConfig;
}

export function DockerExportView({ config }: DockerExportViewProps) {
  const files = useMemo(() => generateDockerBundle(config), [config]);
  const [activeFilename, setActiveFilename] = useState<string>('docker-compose.yml');
  const [copiedFile, setCopiedFile] = useState<string | null>(null);
  const [downloadingZip, setDownloadingZip] = useState(false);

  const activeFile = files.find((f) => f.filename === activeFilename) ?? files[0];

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(activeFile.content);
      setCopiedFile(activeFile.filename);
      window.setTimeout(() => setCopiedFile(null), 1800);
    } catch {
      setCopiedFile(null);
    }
  };

  const handleDownloadZip = async () => {
    setDownloadingZip(true);
    try {
      const zip = new JSZip();
      for (const file of files) {
        zip.file(file.filename, file.content);
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'tonarchiv-docker-bundle.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setDownloadingZip(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-[#151E2E] border border-[#243044] rounded-lg p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="space-y-1">
          <h2 className="font-display text-base font-semibold text-slate-100">
            Single-Container FastAPI Docker-Paket (live aus deinen Regeln erzeugt)
          </h2>
          <p className="text-xs text-slate-400 max-w-3xl leading-relaxed">
            Ein Container, ein Dockerfile, keine Node-Zwischenschicht: FastAPI liefert das gebaute
            React-Dashboard sowie alle <span className="font-mono">/api/*</span>-Endpunkte, den
            SQLite-Cache und das atomare Journal direkt aus. Alle Änderungen an Pfaden, PUID/PGID,
            Konfidenz, DJ-Remix-Layout oder WAV-Schutz sind sofort enthalten.
          </p>
        </div>

        <button
          type="button"
          onClick={handleDownloadZip}
          disabled={downloadingZip}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-md bg-sky-400 text-slate-950 text-xs font-semibold hover:bg-sky-300 whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Download className="h-4 w-4" />
          <span>{downloadingZip ? 'Erstelle Archiv …' : 'Docker-Paket (.zip) herunterladen'}</span>
        </button>
      </div>

      {/* File Tabs + Code Viewer */}
      <div className="bg-[#151E2E] border border-[#243044] rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-[#243044] bg-[#111927] flex flex-wrap items-center justify-between gap-3">
          <div role="tablist" aria-label="Generierte Docker-Dateien" className="flex flex-wrap gap-1">
            {files.map((file) => {
              const selected = file.filename === activeFile.filename;
              return (
                <button
                  key={file.filename}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setActiveFilename(file.filename)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md font-mono text-xs whitespace-nowrap transition-colors ${
                    selected
                      ? 'bg-sky-400/15 text-sky-300'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                  }`}
                >
                  <FileCode2 className="h-3.5 w-3.5 shrink-0" />
                  <span>{file.filename}</span>
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-[#243044] bg-[#0F172A] text-xs text-slate-200 hover:border-sky-400 whitespace-nowrap"
          >
            {copiedFile === activeFile.filename ? (
              <>
                <Check className="h-3.5 w-3.5 text-emerald-400" />
                <span className="text-emerald-400">Kopiert</span>
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                <span>Inhalt kopieren</span>
              </>
            )}
          </button>
        </div>

        <div className="px-5 py-2.5 border-b border-[#243044] text-xs text-slate-400">
          {activeFile.description}
        </div>

        <pre className="p-5 bg-[#0F172A] text-slate-200 font-mono text-xs leading-relaxed overflow-x-auto max-h-[600px] overflow-y-auto">
          <code>{activeFile.content}</code>
        </pre>
      </div>
    </div>
  );
}
