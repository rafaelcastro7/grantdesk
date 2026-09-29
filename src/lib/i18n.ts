import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";
import * as common from "./messages/common";
import * as home from "./messages/home";
import * as clients from "./messages/clients";
import * as matches from "./messages/matches";
import * as proposal from "./messages/proposal";
import * as brief from "./messages/brief";

/**
 * Interface language, EN and FR, without a translation framework.
 *
 * English is the source: every French entry is typed against the English keys,
 * so a string added in one language and forgotten in the other fails the
 * typecheck rather than rendering a raw key to a Quebec client's consultant.
 * Split per screen only so each dictionary sits next to one reader's work.
 */
export type Language = "en" | "fr";
export const LANGUAGES: readonly Language[] = ["en", "fr"];

const EN = {
  ...common.en,
  ...home.en,
  ...clients.en,
  ...matches.en,
  ...proposal.en,
  ...brief.en,
};
export type MessageKey = keyof typeof EN;

const FR: Record<MessageKey, string> = {
  ...common.fr,
  ...home.fr,
  ...clients.fr,
  ...matches.fr,
  ...proposal.fr,
  ...brief.fr,
};

export const DICTIONARIES: Record<Language, Record<MessageKey, string>> = { en: EN, fr: FR };

export type Vars = Record<string, string | number>;

export function translate(language: Language, key: MessageKey, vars?: Vars): string {
  const template = DICTIONARIES[language][key] ?? EN[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

export function isLanguage(value: unknown): value is Language {
  return value === "en" || value === "fr";
}

/** BCP 47 locale for dates and numbers: Canadian conventions in both languages. */
export function localeFor(language: Language): string {
  return language === "fr" ? "fr-CA" : "en-CA";
}

/**
 * Before sign-in: an explicit ?lang= wins, then a choice made earlier on this
 * browser, then the browser's own languages. After sign-in the consultant's
 * stored preference overrides all of these (see I18nProvider).
 */
export function detectLanguage(input: {
  search?: string;
  stored?: string | null;
  browser?: readonly string[];
}): Language {
  const param = new URLSearchParams(input.search ?? "").get("lang")?.toLowerCase();
  if (isLanguage(param)) return param;
  if (isLanguage(input.stored)) return input.stored;
  for (const tag of input.browser ?? []) {
    const primary = tag.toLowerCase().split("-")[0];
    if (isLanguage(primary)) return primary;
  }
  return "en";
}

export const STORAGE_KEY = "grantdesk.lang";

function readStored(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStored(language: Language): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, language);
  } catch {
    // Private windows can refuse storage; the choice then lasts this page only.
  }
}

export type I18n = {
  language: Language;
  locale: string;
  t: (key: MessageKey, vars?: Vars) => string;
  setLanguage: (language: Language) => void;
};

const I18nContext = createContext<I18n | null>(null);

type Persist = (language: Language) => Promise<void> | void;
type LoadPreference = () => Promise<Language | null>;

/**
 * Server render and first client render are always English, so hydration
 * matches; the detected language is applied in an effect straight after.
 */
export function I18nProvider(props: {
  children: ReactNode;
  initial?: Language;
  loadPreference?: LoadPreference;
  persist?: Persist;
}) {
  const { loadPreference, persist } = props;
  const [language, setState] = useState<Language>(props.initial ?? "en");

  useEffect(() => {
    if (props.initial) return;
    const search = window.location.search;
    const fromParam = new URLSearchParams(search).get("lang");
    const detected = detectLanguage({
      search,
      stored: readStored(),
      browser: navigator.languages?.length ? navigator.languages : [navigator.language],
    });
    setState(detected);
    if (isLanguage(fromParam) || !loadPreference) return;
    let cancelled = false;
    void loadPreference()
      .then((stored) => {
        if (!cancelled && stored) {
          setState(stored);
          writeStored(stored);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [props.initial, loadPreference]);

  useEffect(() => {
    if (typeof document !== "undefined") document.documentElement.lang = language;
  }, [language]);

  const setLanguage = useCallback(
    (next: Language) => {
      setState(next);
      writeStored(next);
      void Promise.resolve(persist?.(next)).catch(() => {});
    },
    [persist],
  );

  const value = useMemo<I18n>(
    () => ({
      language,
      locale: localeFor(language),
      t: (key, vars) => translate(language, key, vars),
      setLanguage,
    }),
    [language, setLanguage],
  );

  return createElement(I18nContext.Provider, { value }, props.children);
}

const FALLBACK: I18n = {
  language: "en",
  locale: "en-CA",
  t: (key, vars) => translate("en", key, vars),
  setLanguage: () => {},
};

/** Outside a provider (isolated component tests) this is plain English. */
export function useI18n(): I18n {
  return useContext(I18nContext) ?? FALLBACK;
}
