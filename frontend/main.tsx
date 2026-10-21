import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

class ErrorBoundary extends Component<{ children: ReactNode }, { message: string | null }> {
  state = { message: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: unknown) {
    console.error('[app:crash]', error);
  }

  render() {
    if (this.state.message) {
      return (
        <pre
          style={{
            margin: 0,
            padding: 8,
            height: '100%',
            boxSizing: 'border-box',
            overflow: 'auto',
            font: '10px/1.4 monospace',
            color: '#7a2d3d',
            background: 'rgba(255, 240, 243, 0.94)',
            whiteSpace: 'pre-wrap'
          }}
        >
          {`Ice Agent failed to render:\n${this.state.message}`}
        </pre>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
