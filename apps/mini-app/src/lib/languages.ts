// Polyglot support — maps the user's learning language to the canonical
// regional code that Google Translate TTS and MyMemory expect, and to the
// short two-letter code MyMemory wants for `langpair=`.
//
// Region picks are conservative defaults — what most "neutral" speakers
// would expect:
//   - en defers to the user's voiceLocale setting (US / UK)
//   - pt → Brazil, because European Portuguese voices on Google are notably
//     thinner; learners are statistically more likely to be targeting BR
//   - zh → Mainland China simplified
// Forkers can edit this table or add a per-language sub-region setting
// if a community asks.

import type { LearningLanguage, NativeLanguage } from './settings'

const REGION_BY_LANG: Record<LearningLanguage, string> = {
  en: 'en-US',  // overridden by voiceLocale setting
  es: 'es-ES',
  de: 'de-DE',
  fr: 'fr-FR',
  it: 'it-IT',
  pt: 'pt-BR',
  ja: 'ja-JP',
  zh: 'zh-CN',
  ko: 'ko-KR',
}

/**
 * BCP-47 language tag for TTS playback of the learning-language term.
 * For English, falls back to the user's accent preference (US / UK);
 * for everything else uses the canonical region above.
 */
export function ttsLangTag(learning: LearningLanguage, englishVoice: 'en-US' | 'en-GB'): string {
  if (learning === 'en') return englishVoice
  return REGION_BY_LANG[learning]
}

/**
 * Short two-letter code for the MyMemory translate endpoint
 * (`langpair=src|tgt`). MyMemory accepts both `pt` and `pt-br` — we send
 * the short form for portability across other free providers.
 */
export function shortLangCode(code: LearningLanguage | NativeLanguage): string {
  return code
}
