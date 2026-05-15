import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  fallback?: (error: Error, reset: () => void) => ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('ErrorBoundary caught:', error, info.componentStack)
  }

  reset = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    if (error !== null) {
      if (this.props.fallback) return this.props.fallback(error, this.reset)
      return (
        <div className="h-screen flex flex-col items-center justify-center p-6 text-center bg-tg-bg">
          <h2 className="text-xl font-bold mb-2">Что-то пошло не так</h2>
          <pre className="text-xs text-tg-hint mb-6 max-w-full overflow-x-auto">{error.message}</pre>
          <button onClick={this.reset} className="text-tg-link font-semibold">
            Перезагрузить
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
