import { StrictMode, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { installGlobalErrorReporting } from './lib/report-error';
import { roleFromHash } from './role';
import { CountdownView } from './views/CountdownView';
import { OverlayView } from './views/overlay/OverlayView';
import { RecorderWorker } from './views/RecorderWorker';
import { ToolbarView } from './views/toolbar/ToolbarView';
import type { Role } from '../shared/types';

/**
 * Per-role root components; the main role renders the app.
 */
const roleViews: Partial<Record<Role, ComponentType>> = {
  overlay: OverlayView,
  recorder: RecorderWorker,
  toolbar: ToolbarView,
  countdown: CountdownView,
};

installGlobalErrorReporting();

const RoleView = roleViews[roleFromHash(window.location.hash)] ?? App;
const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <RoleView />
    </ErrorBoundary>
  </StrictMode>,
);
