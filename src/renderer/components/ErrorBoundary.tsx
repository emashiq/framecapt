import { Component, type ErrorInfo, type ReactNode } from 'react';
import { RotateCw, TriangleAlert } from 'lucide-react';
import { reportError } from '../lib/report-error';
import { Button } from './ui/Button';

interface State {
  failed: boolean;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    reportError('error-boundary', error, info.componentStack ?? undefined);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        role="alert"
        className="flex h-full flex-col items-center justify-center gap-4 bg-bg px-8 text-center"
      >
        <div className="flex size-14 items-center justify-center rounded-full bg-danger-soft text-danger">
          <TriangleAlert className="size-7" aria-hidden="true" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-fg">Something went wrong</h1>
          <p className="mt-1 max-w-md text-sm text-fg-muted">
            Framelet hit an unexpected problem. Your saved captures are safe. Reloading the window
            usually fixes it.
          </p>
        </div>
        <Button
          variant="primary"
          size="lg"
          icon={<RotateCw className="size-4" aria-hidden="true" />}
          onClick={() => window.location.reload()}
        >
          Reload window
        </Button>
      </div>
    );
  }
}
