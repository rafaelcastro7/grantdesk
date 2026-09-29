import { isLanguage, type Language } from "./i18n";
import { supabase } from "./supabase";

/** The signed-in consultant's stored interface language, or null before sign-in. */
export async function loadLanguagePreference(): Promise<Language | null> {
  const { data: session } = await supabase().auth.getSession();
  const userId = session.session?.user.id;
  if (!userId) return null;
  const { data } = await supabase()
    .from("consultants")
    .select("ui_language")
    .eq("id", userId)
    .maybeSingle();
  const value = (data as { ui_language?: string } | null)?.ui_language;
  return isLanguage(value) ? value : null;
}

export async function saveLanguagePreference(language: Language): Promise<void> {
  const { data: session } = await supabase().auth.getSession();
  const userId = session.session?.user.id;
  if (!userId) return;
  const { error } = await supabase()
    .from("consultants")
    .update({ ui_language: language })
    .eq("id", userId);
  if (error) throw new Error(error.message);
}
