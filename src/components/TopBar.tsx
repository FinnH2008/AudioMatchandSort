import { Menu, Play, RefreshCw } from 'lucide-react';
import { NextModeAction } from '../engine/classifierAndPlanner';
import { NavSectionId } from './Sidebar';

interface TopBarProps {
  activeSection: NavSectionId;
  nextAction: NextModeAction;
  onTriggerPrimaryAction: () => void;
  onOpenMobileMenu: () => void;
}

const SECTION_TITLES: Record<NavSectionId, string> = {
  library: 'Bibliothek & Analysebericht',
  duplicates: 'Duplikate',
  artists: 'Künstler-Check',
  rules: 'Ordner & Regeln',
  pipeline: 'Pipeline & Cache',
  docker: 'Docker-Export',
};

export function TopBar({
  activeSection,
  nextAction,
  onTriggerPrimaryAction,
  onOpenMobileMenu,
}: TopBarProps) {
  return (
    <header className="sticky top-0 z-30 h-16 bg-[#0F172A]/95 backdrop-blur-xs border-b border-[#243044] px-4 lg:px-8 flex items-center justify-between gap-6">
      <div className="flex items-center gap-3 min-w-0">
        <button
          type="button"
          onClick={onOpenMobileMenu}
          aria-label="Menü öffnen"
          className="lg:hidden rounded-md p-2 text-slate-300 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-sky-400"
        >
          <Menu className="h-5 w-5" />
        </button>

        <div className="flex items-center gap-2 text-sm min-w-0">
          <span className="text-slate-400 whitespace-nowrap shrink-0">TonArchiv</span>
          <span className="text-slate-600" aria-hidden="true">
            /
          </span>
          <h1 className="font-display font-semibold text-slate-100 truncate">
            {SECTION_TITLES[activeSection]}
          </h1>
        </div>
      </div>

      {/* Single primary CTA button strictly reflecting the currently next Mode */}
      <div className="flex items-center shrink-0">
        <button
          type="button"
          onClick={onTriggerPrimaryAction}
          disabled={!nextAction.enabled}
          title={nextAction.blockReason ?? undefined}
          className={`inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-semibold whitespace-nowrap shrink-0 transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 ${
            nextAction.enabled
              ? 'bg-sky-400 text-slate-950 hover:bg-sky-300 cursor-pointer'
              : 'bg-slate-800 text-slate-400 border border-[#243044] cursor-not-allowed'
          }`}
        >
          {nextAction.mode === 'rerun' ? (
            <RefreshCw className="h-4 w-4 shrink-0" />
          ) : (
            <Play className="h-4 w-4 shrink-0" />
          )}
          <span>{nextAction.label}</span>
        </button>
      </div>
    </header>
  );
}
