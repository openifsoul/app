import { useRef, useState } from "react";
import { Download, Upload } from "lucide-react";
import { api, ApiError, friendlyError } from "../lib/api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import type {
  ArchivePreview,
  MemoryArchive,
} from "../../../runtime-host/src/memory-archive";

export function MemoryArchiveControls({
  memoryId,
  profileId,
  disabled,
  onImported,
  mode = "all",
  onPendingChange,
}: {
  onPendingChange?: (pending: boolean) => void;
  mode?: "all" | "create" | "import";
  memoryId?: string;
  profileId?: string;
  disabled?: boolean;
  onImported?: (id: string) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<ArchivePreview | null>(null);
  const archive = useRef<unknown>(null);
  const file = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  async function perform(action: () => Promise<void>, operation?: "export") {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    onPendingChange?.(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (reason) {
      setError(
        operation === "export" &&
          reason instanceof ApiError &&
          reason.code === "unsupported"
          ? "No export-permitted history is available for this memory."
          : friendlyError(reason),
      );
    } finally {
      inFlight.current = false;
      setPending(false);
      onPendingChange?.(false);
    }
  }
  async function open(id: string) {
    await onImported?.(id);
  }
  return (
    <section className="space-y-3 border-b p-4" aria-label="Portable memory">
      <div>
        <h3 className="text-sm font-medium">
          {mode === "create"
            ? "New memory"
            : mode === "import"
              ? "Import memory"
              : "Portable memory"}
        </h3>
        <p className="text-xs text-muted-foreground">
          {mode === "create"
            ? "Start a separate history for the selected profile."
            : mode === "import"
              ? "Inspect an archive before creating a separate fork. Existing export restrictions stay unchanged."
              : "Download permitted retained history, or inspect an archive before creating a separate fork. Existing export restrictions stay unchanged."}
        </p>
      </div>
      {mode !== "create" && (
        <div className="flex flex-wrap gap-2">
          {mode === "all" && (
            <Button
              variant="outline"
              size="sm"
              disabled={disabled || pending || !memoryId}
              onClick={() =>
                void perform(async () => {
                  const value = await api<MemoryArchive>(
                    `memory/export?memoryId=${encodeURIComponent(memoryId!)}`,
                  );
                  const url = URL.createObjectURL(
                    new Blob([JSON.stringify(value)], {
                      type: "application/json",
                    }),
                  );
                  try {
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = "ifsoul-memory.json";
                    a.click();
                  } finally {
                    URL.revokeObjectURL(url);
                  }
                  setNotice(
                    `Downloaded ${value.payload.events.length} retained records. Excluded: ${value.payload.omitted.forbidden} restricted, ${value.payload.omitted.derived} interpretations, ${value.payload.omitted.unsupported} unsupported records.`,
                  );
                }, "export")
              }
            >
              <Download size={14} /> Download memory
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || pending}
            onClick={() => file.current?.click()}
          >
            <Upload size={14} /> Inspect archive
          </Button>
          <Input
            ref={file}
            type="file"
            accept="application/json,.json"
            className="hidden"
            aria-label="Choose memory archive"
            disabled={disabled || pending}
            onChange={(event) => {
              const selected = event.target.files?.[0];
              event.target.value = "";
              archive.current = null;
              setPreview(null);
              if (!selected) return;
              if (selected.size > 2_000_000) {
                setError("Choose a memory archive smaller than 2 MB.");
                return;
              }
              void perform(async () => {
                let value: unknown;
                try {
                  value = JSON.parse(await selected.text());
                } catch {
                  setError(
                    "This file is not valid JSON. Choose an IfSoul memory archive.",
                  );
                  return;
                }
                const result = await api<ArchivePreview>("memory/preview", {
                  method: "POST",
                  body: { archive: value },
                });
                archive.current = value;
                setPreview(result);
              });
            }}
          />
        </div>
      )}
      {mode !== "import" && (
        <details
          className="text-xs"
          open={mode === "create" ? true : undefined}
        >
          <summary className="cursor-pointer">
            Start a new exportable memory
          </summary>
          <p className="my-2 text-muted-foreground">
            Creates empty memory with a copy of this profile. Future records may
            be downloaded by this workspace owner. Existing history is
            untouched. Avoid entering secrets into conversations.
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || pending || !profileId}
            onClick={() =>
              void perform(async () => {
                const result = await api<{ memoryId: string }>("memory/new", {
                  method: "POST",
                  body: { characterId: profileId, consent: true },
                });
                setNotice(
                  "Created a new exportable memory. Earlier history stays in its original memory.",
                );
                await open(result.memoryId);
              })
            }
          >
            Create new exportable memory
          </Button>
        </details>
      )}
      {preview && (
        <div className="space-y-2 rounded-md border p-3 text-xs">
          <h4 className="font-medium">Import preview: {preview.name}</h4>
          <p>
            {preview.events} retained records · {preview.profiles} profiles. A
            new separate exportable fork will be created.
          </p>
          <p>
            {Object.entries(preview.categories)
              .map(([category, count]) => `${category}: ${count}`)
              .join(" · ")}
          </p>
          <p>
            {preview.trust} Checksums detect changes; they do not verify
            authorship.
          </p>
          <p>
            Excluded at export: {preview.omitted.forbidden} restricted ·{" "}
            {preview.omitted.derived} interpretations ·{" "}
            {preview.omitted.unsupported} unsupported records.
          </p>
          <ul className="list-disc space-y-1 pl-4">
            {preview.losses.map((loss) => (
              <li key={loss}>{loss}</li>
            ))}
          </ul>
          <Button
            size="sm"
            disabled={disabled || pending}
            onClick={() =>
              void perform(async () => {
                const result = await api<{ memoryId: string }>(
                  "memory/import",
                  {
                    method: "POST",
                    body: {
                      archive: archive.current,
                      expectedDigest: preview.sha256,
                    },
                  },
                );
                archive.current = null;
                setPreview(null);
                setNotice(
                  "Imported a separate memory fork. Historical reports remain untrusted; host permissions are not transferred.",
                );
                await open(result.memoryId);
              })
            }
          >
            Import as a new memory fork
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => {
              archive.current = null;
              setPreview(null);
            }}
          >
            Cancel
          </Button>
        </div>
      )}
      {pending && (
        <p role="status" className="text-xs">
          Preparing memory…
        </p>
      )}
      {notice && (
        <p role="status" className="text-xs">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
