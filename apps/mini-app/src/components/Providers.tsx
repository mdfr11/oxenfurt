import { useLaunchParams } from '@telegram-apps/sdk-react';
import { AppRoot } from '@telegram-apps/telegram-ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type PropsWithChildren, useMemo } from 'react';

type Platform = 'ios' | 'base'

function AppWrapper({ children }: PropsWithChildren) {
  // useLaunchParams must be called unconditionally — see Rules of Hooks.
  // mockEnv.ts seeds window.location.hash with launch params in dev so this
  // never throws there. In Telegram it gets real params. ErrorBoundary above
  // catches the (rare) case where this still fails to mount.
  const lp = useLaunchParams()
  const isDark = lp.tgWebAppThemeParams?.bg_color
    ? isDarkBg(lp.tgWebAppThemeParams.bg_color)
    : false
  const platform: Platform =
    lp.tgWebAppPlatform === 'ios' || lp.tgWebAppPlatform === 'macos' ? 'ios' : 'base'

  return (
    <AppRoot
      appearance={isDark ? 'dark' : 'light'}
      platform={platform}
    >
      {children}
    </AppRoot>
  );
}

function isDarkBg(hex: string): boolean {
  // Quick luminance check on a #RRGGBB hex.
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) return false
  const r = parseInt(m[1]!, 16)
  const g = parseInt(m[2]!, 16)
  const b = parseInt(m[3]!, 16)
  // ITU-R BT.601 luma; <128 → dark
  return r * 0.299 + g * 0.587 + b * 0.114 < 128
}

export function Providers({ children }: PropsWithChildren) {
  const queryClient = useMemo(() => new QueryClient(), []);

  return (
    <QueryClientProvider client={queryClient}>
      <AppWrapper>
        {children}
      </AppWrapper>
    </QueryClientProvider>
  );
}
