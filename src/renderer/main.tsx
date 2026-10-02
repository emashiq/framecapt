import { StrictMode, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { installGlobalErrorReporting } from './lib/report-error';
import { roleFromHash } from './role';
import type { Role } from '../shared/types';

/**
 * Per-role root components. Later phases register '#/overlay', '#/toolbar' and '#/recorder'
 * views here; until then every role renders the main app.
 */
const roleViews: Partial<Record<Role, ComponentType>> = {};

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
