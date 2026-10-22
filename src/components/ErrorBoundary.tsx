import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div style={{
          padding: '20px',
          maxWidth: '600px',
          margin: '40px auto',
          backgroundColor: '#fef2f2',
          border: '1px solid #fecaca',
          borderRadius: '8px',
        }}>
          <h2 style={{ color: '#dc2626', marginBottom: '16px' }}>
            Что-то пошло не так
          </h2>
          <p style={{ color: '#991b1b', marginBottom: '16px' }}>
            Произошла непредвиденная ошибка. Попробуйте перезагрузить страницу.
          </p>
          {this.state.error && (
            <details style={{
              backgroundColor: '#fef2f2',
              padding: '12px',
              borderRadius: '4px',
              fontFamily: 'monospace',
              fontSize: '12px',
            }}>
              <summary style={{ cursor: 'pointer', color: '#7f1d1d' }}>
                Показать детали ошибки
              </summary>
              <pre style={{
                marginTop: '8px',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}>
                {this.state.error.toString()}
              </pre>
            </details>
          )}
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: '16px',
              padding: '8px 16px',
              backgroundColor: '#dc2626',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
            }}
          >
            Перезагрузить страницу
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
