import { CharacterWorkshop } from "./CharacterWorkshop";
import { api } from "../lib/api";
import { useRef, useState } from "react";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import type {
  CharacterDraft,
  CharacterTemplate,
  ProviderSelection,
  CharacterSummary,
} from "../../../runtime-host/src/service-types";
import { friendlyError } from "../lib/api";
export function Characters({
  characters,
  selected,
  busy,
  onSelect,
  onCreate,
  memorySelected,
  onMemory,
  provider,
  model,
  canGenerate,
}: {
  memorySelected: string;
  onMemory: (id: string) => Promise<void>;
  provider: ProviderSelection["provider"];
  model: string;
  canGenerate: boolean;
  characters: CharacterSummary[];
  selected: string;
  busy: boolean;
  onSelect: (id: string) => Promise<void>;
  onCreate: (
    draft: CharacterDraft | { requestId: string; template: CharacterTemplate },
  ) => Promise<void>;
}) {
  const [open, setOpen] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState({
    name: "",
    description: "",
    speechStyle: "",
    biography: "",
  });
  const attempt = useRef<{ fingerprint: string; id: string } | null>(null);
  const valid = Object.values(fields).every((v) => v.trim());
  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !valid) return;
    setError(null);
    const fingerprint = JSON.stringify(fields);
    if (attempt.current?.fingerprint !== fingerprint)
      attempt.current = { fingerprint, id: crypto.randomUUID() };
    try {
      await onCreate({ ...fields, requestId: attempt.current.id });
      setFields({ name: "", description: "", speechStyle: "", biography: "" });
      attempt.current = null;
      setOpen(false);
    } catch (reason) {
      setError(friendlyError(reason));
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Your characters</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="character-selection">Active character</Label>
          <Select
            value={selected}
            disabled={busy}
            onValueChange={(id) => {
              setError(null);
              void onSelect(id).catch((reason) =>
                setError(friendlyError(reason)),
              );
            }}
          >
            <SelectTrigger id="character-selection">
              <SelectValue placeholder="Choose a character" />
            </SelectTrigger>
            <SelectContent>
              {characters.map((c) => (
                <SelectItem key={c.characterId} value={c.characterId}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="text-sm text-muted-foreground">
          Profile and memory are selected independently. New replies are added
          to the selected memory; earlier messages keep their original speaker.
        </p>
        <div className="space-y-2">
          <Label htmlFor="memory-selection">Connected memory</Label>
          <Select
            value={memorySelected}
            disabled={busy}
            onValueChange={(id) => {
              setError(null);
              void onMemory(id).catch((reason) =>
                setError(friendlyError(reason)),
              );
            }}
          >
            <SelectTrigger id="memory-selection">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {characters.map((c) => (
                <SelectItem key={c.characterId} value={c.characterId}>
                  {c.name}’s history
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selected !== memorySelected && (
            <p className="text-sm text-muted-foreground">
              Another character’s history is connected. New conversations will
              be saved there.
            </p>
          )}
        </div>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            void (async () => {
              try {
                const template = await api<CharacterTemplate>(
                  `characters/export?characterId=${encodeURIComponent(selected)}`,
                );
                const url = URL.createObjectURL(
                  new Blob([JSON.stringify(template, null, 2)], {
                    type: "application/json",
                  }),
                );
                const a = document.createElement("a");
                a.href = url;
                a.download = "character.json";
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              } catch (reason) {
                setError(friendlyError(reason));
              }
            })()
          }
        >
          Export profile
        </Button>
        <p className="text-xs text-muted-foreground">
          Export includes the authored profile and attribution, never this
          runtime’s conversations or provider keys. Review imported extensions
          before sharing.
        </p>
        <CharacterWorkshop
          busy={busy}
          provider={provider}
          model={model}
          canGenerate={canGenerate}
          onSave={onCreate}
        />
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            setOpen(!open);
            setError(null);
          }}
        >
          {open ? "Close creation form" : "Create character"}
        </Button>
        {open && (
          <form onSubmit={(event) => void create(event)} className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Author an original fictional character. This starts a new history;
              it does not copy another character’s memories.
            </p>
            {(
              [
                ["name", "Name", 80],
                ["description", "Personality and description", 1000],
                ["speechStyle", "Speaking style", 500],
                ["biography", "Fictional biography", 3000],
              ] as const
            ).map(([key, label, max]) => (
              <div className="space-y-2" key={key}>
                <Label htmlFor={`character-${key}`}>{label} *</Label>
                {key === "name" ? (
                  <Input
                    id={`character-${key}`}
                    value={fields[key]}
                    maxLength={max}
                    required
                    disabled={busy}
                    onChange={(e) =>
                      setFields({ ...fields, [key]: e.target.value })
                    }
                  />
                ) : (
                  <Textarea
                    id={`character-${key}`}
                    value={fields[key]}
                    maxLength={max}
                    required
                    disabled={busy}
                    onChange={(e) =>
                      setFields({ ...fields, [key]: e.target.value })
                    }
                  />
                )}
                <p className="text-xs text-muted-foreground">
                  {fields[key].length} / {max} characters
                </p>
              </div>
            ))}
            <p className="text-sm text-muted-foreground">
              Biography is fiction, not evidence of lived events. Saved profiles
              cannot yet be edited or deleted here.
            </p>
            <Button type="submit" disabled={busy || !valid}>
              {busy ? "Saving…" : "Save and open character"}
            </Button>
          </form>
        )}
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
