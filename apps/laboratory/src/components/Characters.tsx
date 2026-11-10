import { CharacterWorkshop } from "./CharacterWorkshop";
import { useWorkspaceBreadcrumbs } from "../lib/workspace-breadcrumbs";
import { api } from "../lib/api";
import type { CharacterInstance } from "@ifsoul/core/protocol";
import { ArrowLeft, LoaderCircle, Plus } from "lucide-react";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table";
import { useRef, useState } from "react";
import { Button } from "./ui/button";
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
  profile,
}: {
  profile?: CharacterInstance["profile"];
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
  const [view, setView] = useState<"list" | "detail" | "create">("list");
  const [workshopMounted, setWorkshopMounted] = useState(false);
  const [query, setQuery] = useState("");
  const [opening, setOpening] = useState<string | null>(null);
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
  const activeCharacter = characters.find(
    (character) => character.characterId === selected,
  );
  const filtered = characters.filter((character) =>
    `${character.name} ${character.description}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  useWorkspaceBreadcrumbs(
    "characters",
    view === "list"
      ? []
      : [
          {
            label:
              view === "create"
                ? "Create character"
                : (profile?.name ??
                  activeCharacter?.name ??
                  "Character settings"),
          },
        ],
    back,
    busy || Boolean(opening),
  );
  async function openCharacter(id: string) {
    if (busy || opening) return;
    setError(null);
    setOpening(id);
    try {
      await onSelect(id);
      setView("detail");
    } catch (reason) {
      setError(friendlyError(reason));
    } finally {
      setOpening(null);
    }
  }
  function back() {
    setError(null);
    setView("list");
  }
  async function saveTemplate(request: {
    requestId: string;
    template: CharacterTemplate;
  }) {
    await onCreate(request);
    setError(null);
    setView("detail");
  }
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
      setView("detail");
    } catch (reason) {
      setError(friendlyError(reason));
    }
  }
  return (
    <div className="characters-workspace">
      <section
        hidden={view !== "list"}
        aria-label="Character list"
        className="space-y-4"
      >
        <div className="characters-table-toolbar">
          <h2 className="text-sm font-medium">Your characters</h2>
          <Button
            disabled={busy || Boolean(opening)}
            onClick={() => {
              setError(null);
              setWorkshopMounted(true);
              setView("create");
            }}
          >
            <Plus />
            Create character
          </Button>
        </div>
        {(characters.length > 20 || query) && (
          <div className="max-w-sm space-y-2">
            <Label htmlFor="character-search">Find a character</Label>
            <Input
              id="character-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by name or description…"
            />
          </div>
        )}
        <Table aria-label="Your characters" aria-busy={Boolean(opening)}>
          <TableCaption>
            Open a character to view its profile and memory settings.
          </TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Name</TableHead>
              <TableHead scope="col">Description</TableHead>
              <TableHead scope="col">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((character) => (
              <TableRow
                key={character.characterId}
                className="character-table-row"
                aria-disabled={busy || Boolean(opening)}
                onClick={() => void openCharacter(character.characterId)}
              >
                <TableCell>
                  <Button
                    variant="link"
                    className="character-row-name"
                    disabled={busy || Boolean(opening)}
                    onClick={(event) => {
                      event.stopPropagation();
                      void openCharacter(character.characterId);
                    }}
                    aria-label={`Open ${character.name} settings`}
                  >
                    {opening === character.characterId && (
                      <LoaderCircle className="animate-spin" />
                    )}
                    {character.name}
                  </Button>
                </TableCell>
                <TableCell className="character-row-description">
                  {character.description || "No description yet."}
                </TableCell>
                <TableCell>
                  {opening === character.characterId
                    ? "Opening…"
                    : character.characterId === selected
                      ? "Active"
                      : "—"}
                </TableCell>
              </TableRow>
            ))}
            {!filtered.length && (
              <TableRow>
                <TableCell
                  colSpan={3}
                  className="py-8 text-center text-muted-foreground"
                >
                  {query
                    ? "No matching characters. Try another name or clear the search."
                    : "Create your first character to start a conversation."}
                  {query && (
                    <Button variant="link" onClick={() => setQuery("")}>
                      Clear search
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </section>
      <section
        hidden={view !== "detail"}
        aria-label="Character settings"
        className="space-y-4"
      >
        <Button variant="ghost" disabled={busy} onClick={back}>
          <ArrowLeft />
          Back to characters
        </Button>
        <h2 className="text-lg font-medium">
          {profile?.name ?? activeCharacter?.name ?? "Character settings"}
        </h2>
        <dl className="character-profile-details">
          <div>
            <dt>Description</dt>
            <dd>{profile?.description ?? activeCharacter?.description}</dd>
          </div>
          {profile && (
            <>
              <div>
                <dt>Speaking style</dt>
                <dd>{profile.speechStyle.description}</dd>
              </div>
              <div>
                <dt>Fictional biography</dt>
                <dd>{profile.authoredBiography.text}</dd>
              </div>
            </>
          )}
        </dl>
        <p className="text-xs text-muted-foreground">
          Saved profiles cannot yet be edited or deleted here.
        </p>
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
      </section>
      <section
        hidden={view !== "create"}
        aria-label="Create a character"
        className="space-y-4"
      >
        <Button variant="ghost" disabled={busy} onClick={back}>
          <ArrowLeft />
          Back to characters
        </Button>
        <h2 className="text-lg font-medium">Create a character</h2>
        {workshopMounted && (
          <CharacterWorkshop
            busy={busy}
            provider={provider}
            model={model}
            canGenerate={canGenerate}
            onSave={saveTemplate}
          />
        )}
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            setOpen(!open);
            setError(null);
          }}
        >
          {open ? "Close writing form" : "Write a character yourself"}
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
      </section>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
