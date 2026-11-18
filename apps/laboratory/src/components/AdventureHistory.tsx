import { useRef, useState } from "react";
import { api } from "../lib/api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table";

type Event = {
  eventId: string;
  sessionId: string;
  channelId: string;
  senderId: string;
  recipientIds: string[];
  observerIds: string[];
  text: string;
};
type Snapshot = {
  events: Event[];
  actors: Record<string, string>;
  trace: { stage: string; detail: unknown; eventId?: string }[];
};

export function AdventureHistory({
  traceOnly = false,
}: { traceOnly?: boolean } = {}) {
  const title = traceOnly ? "Adventure decision trace" : "Adventure history";
  const [data, setData] = useState<Snapshot>();
  const [status, setStatus] = useState<"loading" | "failed" | "idle">("idle");
  const [search, setSearch] = useState("");
  const loading = useRef(false);
  async function refresh() {
    if (loading.current) return;
    loading.current = true;
    setStatus("loading");
    try {
      setData(
        await api<Snapshot>("game-groups/adventure", { timeoutMs: 5000 }),
      );
      setStatus("idle");
    } catch {
      setStatus("failed");
    } finally {
      loading.current = false;
    }
  }
  const label = (id: string) =>
    data?.actors[id] ?? (id.startsWith("player-") ? "Player" : "Character");
  const query = search.trim().toLowerCase();
  const events =
    data?.events.filter((event) =>
      [event.text, label(event.senderId), event.channelId].some((value) =>
        value.toLowerCase().includes(query),
      ),
    ) ?? [];
  return (
    <section className="grid min-w-0 gap-3 border-t pt-5" aria-label={title}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">{title}</h3>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={status === "loading"}
          onClick={() => void refresh()}
        >
          {status === "loading"
            ? "Loading…"
            : `${data ? "Refresh" : "Load"} ${traceOnly ? "trace" : "history"}`}
        </Button>
      </div>
      {status === "failed" && (
        <p role="alert">The records could not be loaded. Try refreshing.</p>
      )}
      {data && (
        <>
          {!traceOnly && data.events.length >= 5 && (
            <Input
              value={search}
              aria-label="Search adventure messages"
              placeholder="Search messages"
              onChange={(event) => setSearch(event.currentTarget.value)}
            />
          )}
          {!traceOnly &&
            (events.length ? (
              <Table aria-label="Recorded adventure messages">
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Speaker</TableHead>
                    <TableHead scope="col">Audience</TableHead>
                    <TableHead scope="col">Message</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {events.map((event) => (
                    <TableRow key={event.eventId}>
                      <TableCell>
                        {label(event.senderId)}
                        {event.eventId.startsWith("adventure-host-") && (
                          <div className="text-xs text-muted-foreground">
                            Host observation
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-normal">
                        {event.channelId === "public"
                          ? "Public · "
                          : event.channelId === "team"
                            ? "Group · "
                            : "Private · "}
                        {event.recipientIds.map(label).join(", ")}
                        {event.observerIds.length > 0 && (
                          <div className="text-xs text-muted-foreground">
                            Observed by{" "}
                            {event.observerIds.map(label).join(", ")}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="break-words whitespace-normal">
                        {event.text}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="text-muted-foreground">
                {query
                  ? "No messages match your search."
                  : "No group messages have been recorded."}
              </p>
            ))}
          <details className="min-w-0" open={traceOnly || undefined}>
            <summary className="min-h-11 cursor-pointer content-center font-medium">
              Decision trace
            </summary>
            {data.trace.length ? (
              <ul className="grid gap-3">
                {data.trace.map((item, index) => (
                  <li key={index} className="grid min-w-0 gap-1">
                    <strong className="capitalize">{item.stage}</strong>
                    <pre className="max-w-full overflow-auto whitespace-pre-wrap break-words text-xs">
                      {JSON.stringify(item.detail, null, 2)}
                    </pre>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">
                No decisions have been recorded.
              </p>
            )}
          </details>
        </>
      )}
    </section>
  );
}
