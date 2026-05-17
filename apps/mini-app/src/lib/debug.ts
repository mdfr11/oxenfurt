// Dev-only console breadcrumbs. Use for "I did the thing" tracing
// that's useful while iterating in vite-dev but pure noise in the
// Telegram WebView console for an end user. `console.warn` for actual
// failure paths is fine — those help operators diagnose prod issues.
//
// Bundled away in prod: `import.meta.env.DEV` is statically replaced
// with `false`, so the arrow stays as a no-op closure and Rolldown
// eliminates the dead call sites. No runtime check, no log statement
// in the prod bundle.

const isDev = import.meta.env.DEV

export const debug: (...args: unknown[]) => void = isDev
  ? (...args) => console.info(...args)
  : () => {}
