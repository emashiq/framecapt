import { StrictMode, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { MainApp } from './MainApp';
import { ErrorBoundary } from './components/ErrorBoundary';
import { installGlobalErrorReporting } from './lib/report-error';
import { roleFromHash } from './role';
import { CountdownView } from './views/CountdownView';
import { CameraView } from './views/camera/CameraView';
import { MeetingPromptView } from './views/meeting-prompt/MeetingPromptView';
import { OverlayView } from './views/overlay/OverlayView';
import { RecorderWorker } from './views/RecorderWorker';
import { StepsPill } from './views/toolbar/StepsPill';
import { ToolbarView } from './views/toolbar/ToolbarView';
import type { Role } from '../shared/types';

/** The toolbar window shows the step-guide controls when it was opened with `?mode=steps`. */
const ToolbarEntry = window.location.hash.includes('mode=steps') ? StepsPill : ToolbarView;

/**
 * Per-role root components; the main role renders the app.
 */
const roleViews: Partial<Record<Role, ComponentType>> = {
  overlay: OverlayView,
  recorder: RecorderWorker,
  toolbar: ToolbarEntry,
  countdown: CountdownView,
  camera: CameraView,
  'meeting-prompt': MeetingPromptView,
};

installGlobalErrorReporting();

const RoleView = roleViews[roleFromHash(window.location.hash)] ?? MainApp;
const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <RoleView />
    </ErrorBoundary>
  </StrictMode>,
);
