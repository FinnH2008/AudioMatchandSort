import { Menu, Play, RefreshCw } from 'lucide-react';
import { NextModeAction } from '../engine/classifierAndPlanner';
import { NavSectionId } from './Sidebar';

interface TopBarProps {
  activeSection: NavSectionId;
  nextAction: NextModeAction;
  onTriggerPrimaryAction: () => void;
  onOpenMobileMenu: () => void;
}

const SECTION_TITLES: Record<NavSectionId, { desktop: string; mobile: string }> = {
  library: { desktop: 'Bibliothek & Analysebericht', mobile: 'Bibliothek' },
  duplicates: { desktop: 'Duplikate', mobile: 'Duplikate' },
  artists: { desktop: 'Künstler-Check', mobile: 'Künstler' },
  rules: { desktop: 'Ordner & Regeln', mobile: 'Regeln' },
  pipeline: { desktop: 'Pipeline & Cache', mobile: 'Pipeline' },
  docker: { desktop: 'Docker-Export', mobile: 'Docker' },
};

export function TopBar({
  activeSection,
  nextAction,
  onTriggerPrimaryAction,
  onOpenMobileMenu,
}: TopBarProps) {
  return (
    <header className="sticky top-0 z-30 h-14 lg:h-16 bg-[#0F172A]/95 backdrop-blur-xs border-b border-[#243044] px-3 sm:px-4 lg:px-8 flex items-center justify-between gap-3 lg:gap-6">
      <div className="flex items-center gap-2 sm:gap-3 min-w-0">
        <button
          type="button"
          onClick={onOpenMobileMenu}
          aria-label="Menü öffnen"
          className="lg:hidden min-h-[44px] min-w-[44px] -ml-1 flex items-center justify-center rounded-md text-slate-300 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-sky-400 shrink-0"
        >
          <Menu className="h-5 w-5" />
        </button>

        <div className="flex items-center gap-1.5 sm:gap-2 text-sm min-w-0">
          <span className="hidden sm:inline text-slate-400 whitespace-nowrap shrink-0">
            TonArchiv
          </span>
          <span className="hidden sm:inline text-slate-600" aria-hidden="true">
            /
          </span>
          <h1 className="font-display font-semibold text-slate-100 truncate">
            <span className="sm:hidden">{SECTION_TITLES[activeSection].mobile}</span>
            <span className="hidden sm:inline">{SECTION_TITLES[activeSection].desktop}</span>
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
          className={`inline-flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2 min-h-[40px] rounded-md text-xs sm:text-sm font-semibold whitespace-nowrap shrink-0 transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 max-w-[185px] sm:max-w-none ${
            nextAction.enabled
              ? 'bg-sky-400 text-slate-950 hover:bg-sky-300 cursor-pointer'
              : 'bg-slate-800 text-slate-400 border border-[#243044] cursor-not-allowed'
          }`}
        >
          {nextAction.mode === 'rerun' ? (
            <RefreshCw className="h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0" />
          ) : (
            <Play className="h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0" />
          )}
          <span className="truncate">{nextAction.label}</span>
        </button>
      </div>
    </header>
  );
}
