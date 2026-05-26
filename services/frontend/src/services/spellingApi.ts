import { http } from './backendApi'

export interface SpellingMisspelling {
  word: string
  suggestions: string[]
}

export interface SpellingCheckResponse {
  language: string
  misspellings: SpellingMisspelling[]
}

export interface SpellingDictionaryResponse {
  language: string
  words: string[]
}

export const spellingApi = {
  check: (language: string, words: string[]) =>
    http<SpellingCheckResponse>('/api/spelling/check', {
      method: 'POST',
      body: JSON.stringify({ language, words }),
    }),

  suggest: (language: string, word: string) =>
    http<SpellingMisspelling>('/api/spelling/suggest', {
      method: 'POST',
      body: JSON.stringify({ language, word }),
    }),

  dictionary: (language = 'en') =>
    http<SpellingDictionaryResponse>(`/api/spelling/dictionary?language=${encodeURIComponent(language)}`),

  learn: (language: string, word: string) =>
    http<SpellingDictionaryResponse>('/api/spelling/learn', {
      method: 'POST',
      body: JSON.stringify({ language, word }),
    }),

  unlearn: (language: string, word: string) =>
    http<SpellingDictionaryResponse>('/api/spelling/unlearn', {
      method: 'POST',
      body: JSON.stringify({ language, word }),
    }),
}
