import { mockTelegramEnv } from '@telegram-apps/sdk';

if (import.meta.env.DEV) {
  const themeParams = {
    accent_text_color: '#6ab2f2',
    bg_color: '#17212b',
    button_color: '#5288c1',
    button_text_color: '#ffffff',
    destructive_text_color: '#ec3942',
    hint_color: '#708499',
    link_color: '#6ab2f2',
    secondary_bg_color: '#232e3c',
    section_bg_color: '#17212b',
    section_header_text_color: '#6ab2f2',
    subtitle_text_color: '#708499',
    text_color: '#f5f5f5',
  };

  const initData = new URLSearchParams([
    ['user', JSON.stringify({
      id: 99282,
      first_name: 'Andrew',
      last_name: 'Rogue',
      username: 'rogue',
      language_code: 'en',
      is_premium: true,
      allows_write_to_pm: true,
    })],
    ['auth_date', Math.floor(Date.now() / 1000).toString()],
    ['query_id', 'AAHdF6IQAAAAAN0XohDhrOrc'],
    ['hash', '89d6079ad6762351f35c6632bc87df3001399814177c8df20b4a71b5881858e0'],
    ['signature', '6db21c83ae64700770539132fa0511c6e2cae167a0300766ee9435796ad44571'],
  ]);

  // Build launch params hash and inject into window.location.hash
  // so the SDK can find them via its normal retrieval flow.
  const hash = new URLSearchParams([
    ['tgWebAppPlatform', 'tdesktop'],
    ['tgWebAppThemeParams', JSON.stringify(themeParams)],
    ['tgWebAppData', initData.toString()],
    ['tgWebAppVersion', '7.0'],
    ['tgWebAppStartParam', 'debug'],
    ['tgWebAppBotInline', 'false'],
  ]).toString();

  // Write to hash FIRST so retrieveLaunchParams() can find it.
  // Preserve existing hash (deep-links)
  const existing = window.location.hash.replace(/^#/, '');
  window.location.hash = `#${hash}${existing ? '&' + existing : ''}`;

  try {
    mockTelegramEnv({});
    console.log('Mock Telegram environment initialized');
  } catch (e) {
    console.warn('mockTelegramEnv failed (non-critical):', e);
  }
}

export {};
