import { Component, ErrorInfo, ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    hasError: false,
    errorMessage: '',
  };

  private handleWindowError = (event: ErrorEvent) => {
    const msg = event.error?.message || event.message || 'Unerwarteter Laufzeitfehler.';
    if (msg.toLowerCase().includes('resizeobserver')) return;
    this.setState({ hasError: true, errorMessage: msg });
  };

  private handleUnhandledRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    const msg =
      reason instanceof Error
        ? reason.message
        : typeof reason === 'string'
          ? reason
          : 'Unbehandelte asynchrone Ausnahme.';
    this.setState({ hasError: true, errorMessage: msg });
  };

  componentDidMount() {
    window.addEventListener('error', this.handleWindowError);
    window.addEventListener('unhandledrejection', this.handleUnhandledRejection);
  }

  componentWillUnmount() {
    window.removeEventListener('error', this.handleWindowError);
    window.removeEventListener('unhandledrejection', this.handleUnhandledRejection);
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error?.message || 'Unbekannter Laufzeitfehler in der Oberfläche.',
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[TonArchiv UI Error]', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#0F172A] text-slate-100 flex items-center justify-center p-6">
          <div className="max-w-lg w-full bg-[#151E2E] border border-red-500/40 rounded-lg p-6 space-y-4">
            <h1 className="font-display text-lg font-semibold text-red-400">
              Oberflächen-Fehler abgefangen
            </h1>
            <p className="text-xs text-slate-300 leading-relaxed">
              Beim Rendern der geladenen Daten ist ein unerwarteter Fehler aufgetreten. Deine
              Audiodateien wurden nicht verändert.
            </p>
            <div className="bg-[#0F172A] border border-[#243044] rounded-md p-3 font-mono text-xs text-red-300 break-words">
              {this.state.errorMessage}
            </div>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex items-center justify-center px-4 py-2.5 min-h-[42px] rounded-md bg-sky-400 text-slate-950 text-xs font-semibold hover:bg-sky-300"
            >
              Seite neu laden
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
