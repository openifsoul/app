import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Label } from "./ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { api, ApiError, friendlyError } from "../lib/api";
import type {
  CharacterTemplate,
  ProviderSelection,
} from "../../../runtime-host/src/service-types";

export function CharacterWorkshop({
  busy,
  provider,
  model,
  canGenerate,
  onSave,
}: {
  busy: boolean;
  canGenerate: boolean;
  onSave: (request: {
    requestId: string;
    template: CharacterTemplate;
  }) => Promise<void>;
} & ProviderSelection) {
  const [brief, setBrief] = useState("");
  const [authoring, setAuthoring] = useState<{
    library: CharacterTemplate[];
    prompt: string;
  } | null>(null);
  const [preview, setPreview] = useState<CharacterTemplate | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const lock = useRef(false);
  const generation = useRef<{ fingerprint: string; id: string } | null>(null);
  const save = useRef<{ fingerprint: string; id: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ library: CharacterTemplate[]; prompt: string }>(
      "characters/authoring",
      { signal: controller.signal },
    )
      .then(setAuthoring)
      .catch((reason) => {
        if (!controller.signal.aborted) setError(friendlyError(reason));
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    setSlow(false);
    if (!pending) return;
    const timer = setTimeout(() => setSlow(true), 10000);
    return () => clearTimeout(timer);
  }, [pending]);
  async function perform(work: () => Promise<void>) {
    if (lock.current || busy) return;
    lock.current = true;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (reason) {
      setError(
        reason instanceof ApiError && reason.code === "invalid-document"
          ? "This file is not a supported character profile. Import an exported character.json file; memory archives and required extensions are not supported."
          : reason instanceof ApiError && reason.code === "budget-exceeded"
            ? "This profile exceeds the workspace limit. Files must be no larger than 64 KiB; the library holds up to 50 characters."
            : friendlyError(reason),
      );
    } finally {
      lock.current = false;
      setPending(false);
    }
  }
  async function generate() {
    await perform(async () => {
      const fingerprint = JSON.stringify({ brief, provider, model });
      if (generation.current?.fingerprint !== fingerprint)
        generation.current = { fingerprint, id: crypto.randomUUID() };
      try {
        setPreview(
          await api<CharacterTemplate>("characters/generate", {
            method: "POST",
            body: { requestId: generation.current.id, brief, provider, model },
          }),
        );
        generation.current = null;
      } catch (reason) {
        if (reason instanceof ApiError && reason.code === "controller-failed")
          generation.current = null;
        throw reason;
      }
    });
  }
  async function importFile(file: File | undefined) {
    await perform(async () => {
      if (!file) return;
      if (file.size > 65536) throw new ApiError("budget-exceeded");
      let value: unknown;
      try {
        value = JSON.parse(await file.text());
      } catch {
        throw new ApiError("invalid-document");
      }
      // This preview is untrusted. The server validates the entire document before saving.
      const t = value as CharacterTemplate;
      if (
        !t ||
        t.kind !== "character-template" ||
        t.schemaVersion !== "draft-0.2.0" ||
        typeof t.profile?.name !== "string" ||
        typeof t.profile?.description !== "string" ||
        typeof t.profile?.authoredBiography?.text !== "string" ||
        typeof t.profile?.speechStyle?.description !== "string"
      )
        throw new ApiError("invalid-document");
      setPreview(t);
      setNotice(
        "File loaded for review. Its full format will be checked when saved.",
      );
    });
  }
  return (
    <div className="space-y-4">
      <Tabs defaultValue="generate">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="generate">Generate</TabsTrigger>
          <TabsTrigger value="import">Import</TabsTrigger>
          <TabsTrigger value="library">Library</TabsTrigger>
        </TabsList>
        <TabsContent value="generate" className="space-y-3">
          <Label htmlFor="character-brief">Describe your character *</Label>
          <Textarea
            id="character-brief"
            maxLength={4000}
            value={brief}
            disabled={busy || pending}
            onChange={(e) => setBrief(e.target.value)}
            placeholder="A talking clock who lost its memories and wants to explore the world…"
          />
          <p className="text-xs text-muted-foreground">
            {brief.length} / 4000 · Uses {provider} /{" "}
            {model || "choose a model"}. Generation sends only this brief.
            Review invented details before saving.
          </p>
          <Button
            disabled={busy || pending || !canGenerate || !brief.trim()}
            onClick={() => void generate()}
          >
            {pending ? "Creating profile…" : "Generate profile"}
          </Button>
          {!canGenerate && (
            <p className="text-sm text-muted-foreground">
              Choose a connected language model in settings to generate here.
              You can also copy a prompt for another agent.
            </p>
          )}
          <Button
            variant="outline"
            disabled={busy || pending || !authoring || !brief.trim()}
            onClick={() =>
              void perform(async () => {
                await navigator.clipboard.writeText(authoring!.prompt + brief);
                setNotice(
                  "Prompt copied. Ask another agent, then import its character.json file.",
                );
              })
            }
          >
            Copy prompt for another agent
          </Button>
        </TabsContent>
        <TabsContent value="import" className="space-y-3">
          <Label htmlFor="character-file">Character profile file</Label>
          <Input
            id="character-file"
            type="file"
            accept=".json,application/json"
            disabled={busy || pending}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              void importFile(file);
            }}
          />
          <p className="text-sm text-muted-foreground">
            Import a profile exported from another laboratory or made by another
            agent. JSON, up to 64 KiB. Conversations and memory archives are not
            imported.
          </p>
        </TabsContent>
        <TabsContent value="library" className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Original starter profiles. Each saved copy starts with an empty
            history.
          </p>
          {!authoring && <p>Loading starter library…</p>}
          {authoring?.library.map((t) => (
            <div key={t.templateId} className="rounded-md border p-3 space-y-2">
              <strong>{t.profile.name}</strong>
              <p className="text-sm">{t.profile.description}</p>
              <Button
                variant="outline"
                disabled={busy || pending}
                onClick={() => {
                  setPreview(t);
                  setError(null);
                  setNotice(null);
                }}
              >
                Preview {t.profile.name}
              </Button>
            </div>
          ))}
        </TabsContent>
      </Tabs>
      {preview && (
        <section
          aria-label="Profile preview"
          className="min-w-0 break-words rounded-md border p-3 space-y-3"
        >
          <h3 className="font-semibold">{preview.profile.name}</h3>
          <p className="text-sm whitespace-pre-wrap">
            {preview.profile.description}
          </p>
          <p className="text-sm whitespace-pre-wrap">
            <strong>Voice: </strong>
            {preview.profile.speechStyle.description}
          </p>
          <p className="text-sm whitespace-pre-wrap">
            <strong>Fictional biography: </strong>
            {preview.profile.authoredBiography.text}
          </p>
          <p className="text-xs text-muted-foreground">
            Saving creates a new character and empty history. You can connect
            another local memory afterwards. Profiles cannot yet be edited or
            deleted here.
          </p>
          <Button
            disabled={busy || pending}
            onClick={() =>
              void perform(async () => {
                const fingerprint = JSON.stringify(preview);
                if (save.current?.fingerprint !== fingerprint)
                  save.current = { fingerprint, id: crypto.randomUUID() };
                await onSave({ requestId: save.current.id, template: preview });
                save.current = null;
                setPreview(null);
                setNotice(
                  "Character saved and opened. You can now send a message.",
                );
                document.getElementById("chat-message")?.focus();
              })
            }
          >
            Save and chat
          </Button>
        </section>
      )}
      {slow && (
        <p role="status" className="text-sm">
          Still waiting for the model. This request has a one-minute limit; your
          brief stays here.
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
