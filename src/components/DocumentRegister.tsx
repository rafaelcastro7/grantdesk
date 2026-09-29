import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import {
  DOCUMENT_KINDS,
  EXPIRING_WITHIN_DAYS,
  KIND_LABEL,
  documentStatus,
  effectiveExpiry,
  type DocumentKind,
  type DocumentStatus,
} from "@/lib/client-documents";

export type ClientDocument = {
  id: string;
  client_id: string;
  kind: DocumentKind;
  title: string;
  location: string;
  issued_on: string | null;
  expires_on: string | null;
  notes: string | null;
  updated_at: string;
};

export const DOCUMENT_COLUMNS =
  "id, client_id, kind, title, location, issued_on, expires_on, notes, updated_at";

const STATUS_LABEL: Record<DocumentStatus, string> = {
  current: "current",
  expiring: `expires within ${EXPIRING_WITHIN_DAYS} days`,
  expired: "expired",
  undated: "undated",
};

const STATUS_COLOR: Record<DocumentStatus, string> = {
  current: "text-[var(--color-ink-soft)]",
  expiring: "text-[var(--color-accent)]",
  expired: "text-[var(--color-ineligible)]",
  undated: "text-[var(--color-ink-soft)]",
};

type Draft = Omit<ClientDocument, "id" | "client_id" | "updated_at">;

const EMPTY: Draft = {
  kind: "financial_statements",
  title: "",
  location: "",
  issued_on: null,
  expires_on: null,
  notes: null,
};

/**
 * The client's paperwork, recorded once: where each file lives and the dates
 * that decide whether it can still be sent. Locations, not files — the
 * self-hosted stack runs no Storage service.
 */
export function DocumentRegister({ clientId }: { clientId: string }) {
  const [documents, setDocuments] = useState<ClientDocument[] | null>(null);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const today = new Date();

  useEffect(() => {
    let cancelled = false;
    void supabase()
      .from("client_documents")
      .select(DOCUMENT_COLUMNS)
      .eq("client_id", clientId)
      .order("kind")
      .then(({ data, error: readError }) => {
        if (cancelled) return;
        // An empty register on a failed read would say "nothing on file".
        if (readError) setError(`Could not read the document register: ${readError.message}`);
        else setDocuments((data ?? []) as ClientDocument[]);
      });
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  async function save(id: string | "new", draft: Draft) {
    setError(null);
    setEditing(null);
    if (id === "new") {
      const tempId = `pending-${crypto.randomUUID()}`;
      const optimistic: ClientDocument = {
        ...draft,
        id: tempId,
        client_id: clientId,
        updated_at: new Date().toISOString(),
      };
      setDocuments((current) => [...(current ?? []), optimistic]);
      const { data, error: insertError } = await supabase()
        .from("client_documents")
        .insert({ ...draft, client_id: clientId })
        .select(DOCUMENT_COLUMNS)
        .single();
      setDocuments((current) =>
        insertError
          ? (current ?? []).filter((d) => d.id !== tempId)
          : (current ?? []).map((d) => (d.id === tempId ? (data as ClientDocument) : d)),
      );
      if (insertError) setError(`Could not add "${draft.title}": ${insertError.message}`);
      return;
    }
    const before = documents?.find((d) => d.id === id);
    setDocuments((current) => (current ?? []).map((d) => (d.id === id ? { ...d, ...draft } : d)));
    const { error: updateError } = await supabase()
      .from("client_documents")
      .update({ ...draft, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (updateError && before) {
      setDocuments((current) => (current ?? []).map((d) => (d.id === id ? before : d)));
      setError(`Could not save "${draft.title}": ${updateError.message}`);
    }
  }

  async function remove(doc: ClientDocument) {
    setError(null);
    setDocuments((current) => (current ?? []).filter((d) => d.id !== doc.id));
    const { error: deleteError } = await supabase()
      .from("client_documents")
      .delete()
      .eq("id", doc.id);
    if (deleteError) {
      setDocuments((current) => [...(current ?? []), doc]);
      setError(`Could not remove "${doc.title}": ${deleteError.message}`);
    }
  }

  return (
    <section className="mt-10" data-testid="document-register">
      <h2 className="text-sm font-semibold">Documents on file</h2>
      <p className="mt-1 max-w-prose text-sm text-[var(--color-ink-soft)]">
        Where each document lives and when it stops being acceptable. Financial statements go stale
        18 months after issue and insurance after 12, unless you enter an expiry date. Only the
        location is stored, not the file.
      </p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-[var(--color-ineligible)]">
          {error}
        </p>
      )}
      {documents !== null && documents.length > 0 && (
        <ul className="mt-3 flex flex-col gap-px overflow-hidden rounded-md border border-[var(--color-rule)] bg-[var(--color-rule)]">
          {documents.map((doc) => {
            const status = documentStatus(doc, today);
            const expiry = effectiveExpiry(doc);
            return editing === doc.id ? (
              <li key={doc.id} className="bg-[var(--color-surface)] px-4 py-3">
                <DocumentForm
                  initial={doc}
                  onSave={(draft) => save(doc.id, draft)}
                  onCancel={() => setEditing(null)}
                />
              </li>
            ) : (
              <li
                key={doc.id}
                data-testid="document"
                className="bg-[var(--color-surface)] px-4 py-3 text-sm"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-medium">{doc.title}</span>
                  <span
                    data-testid="document-status"
                    className={`shrink-0 text-xs uppercase tracking-wide ${STATUS_COLOR[status]}`}
                  >
                    {STATUS_LABEL[status]}
                  </span>
                </div>
                <p className="mt-1 text-[var(--color-ink-soft)]">
                  {KIND_LABEL[doc.kind]}
                  {doc.issued_on && ` · issued ${doc.issued_on}`}
                  {expiry && ` · good until ${expiry}`}
                </p>
                <p className="mt-1 break-all text-[var(--color-ink-soft)]">{doc.location}</p>
                {doc.notes && <p className="mt-1 text-[var(--color-ink-soft)]">{doc.notes}</p>}
                {!doc.id.startsWith("pending-") && (
                  <div className="mt-2 flex gap-3 text-xs">
                    <button type="button" onClick={() => setEditing(doc.id)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(doc)}
                      data-testid="remove-document"
                      className="text-[var(--color-ineligible)]"
                    >
                      Remove
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {editing === "new" ? (
        <div className="mt-3 rounded-md border border-[var(--color-rule)] bg-[var(--color-surface)] px-4 py-3">
          <DocumentForm
            initial={EMPTY}
            onSave={(draft) => save("new", draft)}
            onCancel={() => setEditing(null)}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setEditing("new")}
          disabled={documents === null}
          data-testid="add-document"
          className="mt-3 rounded-md border border-[var(--color-rule)] px-3 py-2 text-sm font-medium disabled:opacity-50"
        >
          Add a document
        </button>
      )}
    </section>
  );
}

function DocumentForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: Draft;
  onSave: (draft: Draft) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft>({
    kind: initial.kind,
    title: initial.title,
    location: initial.location,
    issued_on: initial.issued_on,
    expires_on: initial.expires_on,
    notes: initial.notes,
  });
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const input =
    "mt-1 w-full rounded-md border border-[var(--color-rule)] bg-[var(--color-paper)] px-2 py-1 text-sm";
  const invalidDates =
    !!draft.issued_on && !!draft.expires_on && draft.issued_on > draft.expires_on;

  return (
    <form
      className="grid gap-2 text-sm sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ ...draft, title: draft.title.trim(), location: draft.location.trim() });
      }}
    >
      <label>
        Kind
        <select
          value={draft.kind}
          onChange={(e) => set("kind", e.target.value as DocumentKind)}
          className={input}
        >
          {DOCUMENT_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {KIND_LABEL[kind]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Title
        <input
          value={draft.title}
          onChange={(e) => set("title", e.target.value)}
          required
          className={input}
        />
      </label>
      <label className="sm:col-span-2">
        Where it is
        <input
          value={draft.location}
          onChange={(e) => set("location", e.target.value)}
          required
          placeholder="A Drive link or folder path"
          className={input}
        />
      </label>
      <label>
        Issued on
        <input
          type="date"
          value={draft.issued_on ?? ""}
          onChange={(e) => set("issued_on", e.target.value || null)}
          className={input}
        />
      </label>
      <label>
        Expires on
        <input
          type="date"
          value={draft.expires_on ?? ""}
          onChange={(e) => set("expires_on", e.target.value || null)}
          className={input}
        />
      </label>
      <label className="sm:col-span-2">
        Notes
        <input
          value={draft.notes ?? ""}
          onChange={(e) => set("notes", e.target.value || null)}
          className={input}
        />
      </label>
      {invalidDates && (
        <p className="text-[var(--color-ineligible)] sm:col-span-2">
          The expiry date is before the issue date.
        </p>
      )}
      <div className="flex gap-3 sm:col-span-2">
        <button
          type="submit"
          disabled={!draft.title.trim() || !draft.location.trim() || invalidDates}
          data-testid="save-document"
          className="rounded-md border border-[var(--color-rule)] px-3 py-1.5 font-medium disabled:opacity-50"
        >
          Save
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
