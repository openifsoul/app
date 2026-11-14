import { useState } from "react";
import { useWorkspaceBreadcrumbs } from "../lib/workspace-breadcrumbs";
import { ArrowLeft, LoaderCircle, Plus, Upload } from "lucide-react";
import type {
  CharacterSummary,
  LabSnapshot,
} from "../../../runtime-host/src/service-types";
import { friendlyError } from "../lib/api";
import { EvidencePanel } from "./Workspace";
import { MemoryExplorer } from "./MemoryExplorer";
import { MemoryArchiveControls } from "./MemoryArchive";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table";

export function Memories({
  characters,
  snapshot,
  busy,
  onSelect,
  onImported,
}: {
  characters: CharacterSummary[];
  snapshot: LabSnapshot | null;
  busy: boolean;
  onSelect: (profileId: string, memoryId: string) => Promise<void>;
  onImported: (id: string) => Promise<void>;
}) {
  const [view, setView] = useState<"list" | "detail" | "create" | "import">(
    "list",
  );
  const [query, setQuery] = useState("");
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [newProfile, setNewProfile] = useState("");
  const [archiveBusy, setArchiveBusy] = useState(false);
  const memoryId = snapshot?.character.characterId;
  const profileId =
    snapshot?.persona?.characterId ??
    memoryId ??
    characters[0]?.characterId ??
    "";
  const disabled = busy || Boolean(opening) || archiveBusy;
  const filtered = characters.filter((c) =>
    `${c.name} ${c.description}`.toLowerCase().includes(query.toLowerCase()),
  );
  useWorkspaceBreadcrumbs(
    "memory",
    view === "list"
      ? []
      : [
          {
            label:
              view === "detail"
                ? (snapshot?.character.profile.name ?? "Memory")
                : view === "create"
                  ? "Create memory"
                  : "Import memory",
          },
        ],
    () => navigate("list"),
    disabled,
  );
  function navigate(next: typeof view) {
    setError("");
    setView(next);
  }
  async function open(id: string) {
    if (disabled) return;
    setError("");
    setOpening(id);
    try {
      await onSelect(profileId, id);
      setView("detail");
    } catch (reason) {
      setError(friendlyError(reason));
    } finally {
      setOpening(null);
    }
  }
  async function imported(id: string) {
    await onImported(id);
    setView("detail");
  }
  return (
    <div className="memory-workspace space-y-4">
      <section
        hidden={view !== "list"}
        aria-label="Memory list"
        className="space-y-4"
      >
        <div className="characters-table-toolbar">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={disabled}
              onClick={() => navigate("import")}
            >
              <Upload />
              Import memory
            </Button>
            <Button
              disabled={disabled || !characters.length}
              onClick={() => {
                setNewProfile(profileId);
                navigate("create");
              }}
            >
              <Plus />
              Create memory
            </Button>
          </div>
        </div>
        {(characters.length > 20 || query) && (
          <div className="max-w-sm space-y-2">
            <Label htmlFor="memory-history-search">Find a memory</Label>
            <Input
              id="memory-history-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name or description…"
            />
          </div>
        )}
        <Table aria-label="Your memories" aria-busy={Boolean(opening)}>
          <TableCaption>
            Open a memory to view its events, interpretations and archive
            settings.
          </TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Memory</TableHead>
              <TableHead scope="col">Description</TableHead>
              <TableHead scope="col">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((c) => (
              <TableRow
                key={c.characterId}
                className="character-table-row"
                aria-disabled={disabled}
                onClick={() => void open(c.characterId)}
              >
                <TableCell>
                  <Button
                    variant="link"
                    className="character-row-name"
                    disabled={disabled}
                    aria-label={`Open ${c.name} memory`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void open(c.characterId);
                    }}
                  >
                    {opening === c.characterId && (
                      <LoaderCircle className="animate-spin" />
                    )}
                    {c.name}
                  </Button>
                </TableCell>
                <TableCell className="character-row-description">
                  {c.description || "No description yet."}
                </TableCell>
                <TableCell>
                  {opening === c.characterId
                    ? "Opening…"
                    : c.characterId === memoryId
                      ? "Connected"
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
                    ? "No matching memories. Try another name or clear the search."
                    : "No memory histories yet. Create a character first, or import a memory archive."}
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
        aria-label="Memory details"
        className="space-y-4"
      >
        <Button
          variant="ghost"
          disabled={disabled}
          onClick={() => navigate("list")}
        >
          <ArrowLeft />
          Back to memories
        </Button>
        <h2 className="text-lg font-medium">
          {snapshot?.character.profile.name ?? "Memory"}
        </h2>
        <div className="max-w-sm space-y-2">
          <Label htmlFor="memory-profile">Character profile</Label>
          <Select
            value={profileId}
            disabled={disabled}
            onValueChange={(id) => {
              if (!memoryId) return;
              setError("");
              void onSelect(id, memoryId).catch((reason) =>
                setError(friendlyError(reason)),
              );
            }}
          >
            <SelectTrigger id="memory-profile">
              <SelectValue />
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
        {view === "detail" && memoryId && (
          <MemoryExplorer key={memoryId} memoryId={memoryId} />
        )}
        <EvidencePanel
          snapshot={snapshot}
          disabled={disabled}
          onMemoryImported={imported}
        />
      </section>
      <section
        hidden={view !== "create" && view !== "import"}
        aria-label="Memory archive setup"
        className="space-y-4"
      >
        <Button
          variant="ghost"
          disabled={disabled}
          onClick={() => navigate("list")}
        >
          <ArrowLeft />
          Back to memories
        </Button>
        {view === "create" && (
          <div className="max-w-sm space-y-2">
            <Label htmlFor="new-memory-profile">Character profile</Label>
            <Select
              value={newProfile || profileId}
              disabled={disabled}
              onValueChange={setNewProfile}
            >
              <SelectTrigger id="new-memory-profile">
                <SelectValue />
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
        )}
        {(view === "create" || view === "import") && (
          <MemoryArchiveControls
            key={view}
            mode={view}
            profileId={newProfile || profileId}
            disabled={disabled}
            onImported={imported}
            onPendingChange={setArchiveBusy}
          />
        )}
      </section>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
