import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Search } from "lucide-react";
import type {
  MemoryExplorerPage,
  RetainedMemoryRecord,
} from "../../../runtime-host/src/memory-explorer";
import {
  readGameConnections,
  type GameBinding,
} from "../lib/game-connections-api";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { api } from "../lib/api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table";

const fields = [
  ["q", "Search saved text", "search", 120],
  ["world", "World ID", "text", 160],
  ["session", "Session ID", "text", 160],
  ["entity", "Entity ID", "text", 160],
  ["npc", "NPC ID", "text", 160],
  ["kind", "Record kind", "text", 160],
  ["since", "From date", "date", undefined],
  ["until", "Through date", "date", undefined],
  ["confidence", "Minimum confidence", "number", undefined],
] as const;

export function MemoryExplorer({ memoryId }: { memoryId: string }) {
  const [query, setQuery] = useState("");
  const [connection, setConnection] = useState("");
  const [connections, setConnections] = useState<GameBinding[]>([]);
  const [cursors, setCursors] = useState([""]);
  const [result, setResult] = useState<MemoryExplorerPage>();
  const [selected, setSelected] = useState<RetainedMemoryRecord>();
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const cursor = cursors.at(-1)!;

  useEffect(() => {
    const controller = new AbortController();
    setConnection("");
    setConnections([]);
    void readGameConnections(controller.signal).then(
      ({ connections: known }) => {
        if (!controller.signal.aborted)
          setConnections(
            known.filter(
              (row) =>
                row.memoryId === memoryId &&
                !row.revoked &&
                row.player &&
                row.expiresAt > Date.now(),
            ),
          );
      },
      () => {},
    );
    return () => controller.abort();
  }, [memoryId]);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams(query);
    params.set("memoryId", memoryId);
    if (cursor) params.set("cursor", cursor);
    if (connection) params.set("connection", connection);
    setResult(undefined);
    setSelected(undefined);
    setFailed(false);
    void api<MemoryExplorerPage>(`memory/browse?${params}`, {
      signal: controller.signal,
      timeoutMs: 15_000,
    }).then(
      (page) => {
        if (!controller.signal.aborted) setResult(page);
      },
      () => {
        if (!controller.signal.aborted) setFailed(true);
      },
    );
    return () => controller.abort();
  }, [connection, cursor, memoryId, query, retry]);

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const params = new URLSearchParams();
    for (const [name, value] of new FormData(event.currentTarget)) {
      const text = String(value).trim();
      if (text) params.set(name, text);
    }
    setCursors([""]);
    setQuery(params.toString());
    setRetry((previous) => previous + 1);
  }

  function followSource(id: string) {
    setCursors([""]);
    setQuery(new URLSearchParams({ source: id }).toString());
  }

  return (
    <section aria-labelledby="saved-memory-heading" className="space-y-4">
      <div className="space-y-1">
        <h3 id="saved-memory-heading" className="font-medium">
          Saved records
        </h3>
        <p className="text-sm text-muted-foreground">
          Browse retained records in this memory. Expired or deleted sources
          cannot be reconstructed.
        </p>
      </div>
      {connections.length > 0 && (
        <div className="space-y-2">
          <Label htmlFor="memory-history-scope">History</Label>
          <Select
            value={connection || "saved"}
            onValueChange={(value) => {
              setConnection(value === "saved" ? "" : value);
              setCursors([""]);
              setQuery("");
            }}
          >
            <SelectTrigger
              id="memory-history-scope"
              className="w-full sm:max-w-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="saved">Saved records</SelectItem>
              {connections.map((row) => (
                <SelectItem key={row.connectionId} value={row.connectionId}>
                  {row.player?.name} · {row.hostId}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {connection && (
            <p className="text-sm text-muted-foreground">
              The connected player can allow or withdraw inspection with a
              private bot whisper
              <code> !ifsoul allow-history</code> or{" "}
              <code>!ifsoul deny-history</code>.
            </p>
          )}
        </div>
      )}
      <form className="space-y-3" onSubmit={search}>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {fields.map(([name, label, type, maxLength]) => (
            <div key={name} className="min-w-0 space-y-1">
              <Label htmlFor={`retained-memory-${name}`}>{label}</Label>
              <Input
                id={`retained-memory-${name}`}
                name={name}
                type={type}
                maxLength={maxLength}
                {...(type === "number" ? { min: 0, max: 1, step: 0.01 } : {})}
              />
            </div>
          ))}
        </div>
        <Button type="submit" variant="outline">
          <Search />
          Search
        </Button>
      </form>
      {new URLSearchParams(query).has("source") && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="break-all">
            Source {new URLSearchParams(query).get("source")}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setQuery("");
              setCursors([""]);
            }}
          >
            Clear source filter
          </Button>
        </div>
      )}
      {failed ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
          {connection
            ? "This private history is unavailable. Check the player’s inspection permission and connection."
            : "Saved records could not be loaded."}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRetry((previous) => previous + 1)}
          >
            Retry
          </Button>
        </div>
      ) : !result ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading saved records…
        </p>
      ) : (
        <>
          {result.total !== undefined && (
            <p className="text-sm text-muted-foreground">
              {result.total} matching records
            </p>
          )}
          {result.facets && Object.keys(result.facets.worlds).length > 0 && (
            <p className="text-sm text-muted-foreground">
              {Object.entries(result.facets.worlds)
                .map(([world, count]) => `${world} (${count})`)
                .join(" · ")}
            </p>
          )}
          <Table aria-label="Saved memory records">
            <TableHeader>
              <TableRow>
                <TableHead>Record</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>World</TableHead>
                <TableHead>Recorded (UTC)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.records.map((record) => (
                <TableRow key={record.id}>
                  <TableCell className="max-w-80 whitespace-normal break-words">
                    <button
                      type="button"
                      className="text-left underline-offset-4 hover:underline"
                      aria-pressed={selected?.id === record.id}
                      onClick={() => setSelected(record)}
                    >
                      {record.text.slice(0, 180)}
                    </button>
                  </TableCell>
                  <TableCell>{record.kind}</TableCell>
                  <TableCell>{record.worldId ?? "Unknown"}</TableCell>
                  <TableCell>
                    {record.recordedAt?.slice(0, 10) ?? "Unknown"}
                  </TableCell>
                </TableRow>
              ))}
              {!result.records.length && (
                <TableRow>
                  <TableCell colSpan={4}>
                    {result.next
                      ? "No matches in this part of the retained history."
                      : "No matching records on this page."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={cursors.length === 1}
              onClick={() => setCursors((previous) => previous.slice(0, -1))}
            >
              <ArrowLeft /> Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!result.next}
              onClick={() =>
                setCursors((previous) => [...previous, result.next!])
              }
            >
              Next <ArrowRight />
            </Button>
          </div>
          {selected && (
            <section
              aria-label="Record details"
              className="space-y-2 rounded-md border p-3 text-sm"
            >
              <h4 className="font-medium">{selected.kind}</h4>
              <p className="whitespace-pre-wrap break-words">{selected.text}</p>
              <dl className="grid gap-2 sm:grid-cols-2">
                <div>
                  <dt className="font-medium">Record ID</dt>
                  <dd className="break-all">{selected.id}</dd>
                </div>
                <div>
                  <dt className="font-medium">Session</dt>
                  <dd className="break-all">
                    {selected.sessionId ?? "Unknown"}
                  </dd>
                </div>
                <div>
                  <dt className="font-medium">Entity IDs</dt>
                  <dd className="break-all">
                    {selected.entityIds.join(", ") || "Unknown"}
                  </dd>
                </div>
                {selected.confidence !== undefined && (
                  <div>
                    <dt className="font-medium">Model confidence</dt>
                    <dd>{selected.confidence}</dd>
                  </div>
                )}
              </dl>
              <h5 className="font-medium">Sources</h5>
              <ul className="space-y-2">
                {selected.sources.map((source, index) => (
                  <li
                    key={`${source.id}:${index}`}
                    className="space-y-1 break-words"
                  >
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto max-w-full whitespace-normal px-0 text-left"
                      onClick={() => followSource(source.id)}
                    >
                      {source.kind} · {source.id}
                    </Button>
                    {source.excerpt && (
                      <blockquote>{source.excerpt}</blockquote>
                    )}
                    {source.digest && (
                      <p className="break-all text-muted-foreground">
                        {source.digest}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
              {selected.detail !== undefined && (
                <details>
                  <summary className="cursor-pointer font-medium">
                    Stored details
                  </summary>
                  <pre className="mt-2 whitespace-pre-wrap break-all text-xs">
                    {JSON.stringify(selected.detail, null, 2)}
                  </pre>
                </details>
              )}
            </section>
          )}
        </>
      )}
    </section>
  );
}
