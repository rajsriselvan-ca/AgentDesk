import { StrictMode, Component, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App.js';
import './styles.css';

/**
 * Root error boundary.
 *
 * A render crash otherwise leaves a blank white page, which tells the user
 * nothing and tells whoever is debugging it even less. This keeps the message
 * on screen and offers the one action that reliably helps.
 */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Unhandled render error', error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="boot-error">
        <h1>Something broke in the interface</h1>
        <p>{this.state.error.message}</p>
        <p className="muted">
          Your conversations are stored on the server, so nothing has been lost — reloading will
          bring them back.
        </p>
        <button onClick={() => window.location.reload()}>Reload</button>
      </div>
    );
  }
}

const container = document.getElementById('root');
if (!container) throw new Error('Root element is missing from index.html.');

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
