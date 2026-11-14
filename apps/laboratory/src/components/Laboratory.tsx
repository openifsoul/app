import { useState } from "react";
import { ArrowLeft, FlaskConical, LoaderCircle, Plus } from "lucide-react";
import type {
  CharacterSummary,
  LabRun,
  LabRunResponse,
  LabSnapshot,
} from "../../../runtime-host/src/service-types";
import { friendlyError } from "../lib/api";
import { useWorkspaceBreadcrumbs } from "../lib/workspace-breadcrumbs";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { OptionSelect, SelectItem } from "./ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table";

function date(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "Unknown time"
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(parsed);
}
const kind = (run: LabRun) =>
  run.operation === "plan" ? "Plan" : "Conversation";
const stageNames: Record<string, string> = {
  context: "Host context received",
  "selected-memory": "Scoped memory selected",
  controller: "Controller requested",
  proposal: "Proposal validated",
  "host-acceptance": "Host adoption recorded",
  "host-decision": "Host decision recorded",
  "host-outcome": "Host outcome recorded",
  memory: "Memory saved",
  dialogue: "Reply proposed",
  delivery: "Delivery recorded",
  reuse: "Saved request reused",
  rejected: "Request safely rejected",
};

export function Laboratory({
  snapshot,
  characters,
  pending,
  running,
  ready,
  provider,
  model,
  onSelect,
  onRun,
}: {
  snapshot: LabSnapshot | null;
  characters: CharacterSummary[];
  pending: boolean;
  running: boolean;
  ready: boolean;
  provider: string;
  model: string;
  onSelect: (profileId: string, memoryId: string) => Promise<void>;
  onRun: () => Promise<LabRunResponse | undefined>;
}) {
  const [view, setView] = useState<"list" | "new" | "detail">("list");
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState("summary");
  const [error, setError] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [starting, setStarting] = useState(false);
  const busy = pending || selecting || starting;
  const profileId =
    snapshot?.persona?.characterId ?? snapshot?.character.characterId ?? "";
  const memoryId = snapshot?.character.characterId ?? "";
  const run = snapshot?.runs.find((run) => run.requestId === selectedId);
  const title = run
    ? `${kind(run)} · ${date(run.startedAt)}`
    : "Request details";
  const tabNames: Record<string, string> = {
    summary: "Result",
    trace: "Trace",
    memory: "Recalled memory",
    debug: "Debug",
  };
  function back() {
    setError("");
    setView("list");
  }
  useWorkspaceBreadcrumbs(
    "laboratory",
    view === "list"
      ? []
      : view === "new"
        ? [{ label: "New test" }]
        : [
            {
              label: title,
              onNavigate:
                tab !== "summary" ? () => setTab("summary") : undefined,
            },
            ...(tab !== "summary" ? [{ label: tabNames[tab] }] : []),
          ],
    back,
    busy,
  );
  const runs = [...(snapshot?.runs ?? [])]
    .reverse()
    .filter((run) =>
      `${run.persona?.name ?? ""} ${kind(run)} ${run.status} ${run.model} ${date(run.startedAt)}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
    );
  function open(run: LabRun) {
    setSelectedId(run.requestId);
    setTab("summary");
    setView("detail");
    setError("");
  }
  async function select(profile: string, memory: string) {
    if (busy) return;
    setSelecting(true);
    setError("");
    try {
      await onSelect(profile, memory);
    } catch (reason) {
      setError(friendlyError(reason));
    } finally {
      setSelecting(false);
    }
  }
  async function start() {
    if (busy || !ready) return;
    setStarting(true);
    setError("");
    try {
      const result = await onRun();
      if (result) open(result.run);
    } catch (reason) {
      setError(friendlyError(reason));
    } finally {
      setStarting(false);
    }
  }
  return (
    <div className="laboratory-workspace">
      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <FlaskConical aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        Synthetic tests and request inspection. This host does not control a
        game or an NPC.
      </p>
      <section
        hidden={view !== "list"}
        aria-label="Laboratory requests"
        className="grid gap-5"
      >
        <div className="characters-table-toolbar">
          <h2 className="text-sm font-medium">Request history</h2>
          <Button
            disabled={busy}
            onClick={() => {
              setError("");
              setView("new");
            }}
          >
            <Plus />
            New test
          </Button>
        </div>
        <div className="app-field-row grid gap-4 sm:grid-cols-2">
          <div className="app-form-field grid gap-2">
            <Label htmlFor="lab-list-memory">Memory history</Label>
            <OptionSelect
              id="lab-list-memory"
              value={memoryId}
              disabled={busy}
              onValueChange={(id) => void select(profileId, id)}
            >
              {characters.map((character) => (
                <SelectItem
                  key={character.characterId}
                  value={character.characterId}
                >
                  {character.name}
                </SelectItem>
              ))}
            </OptionSelect>
          </div>
          <div className="app-form-field grid gap-2">
            <Label htmlFor="lab-request-search">Find a request</Label>
            <Input
              id="lab-request-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search character, model or status…"
            />
          </div>
        </div>
        <Table aria-label="Laboratory request history">
          <TableCaption>
            Open a request to inspect its recorded result, trace and recalled
            memory.
          </TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Started</TableHead>
              <TableHead scope="col">Operation</TableHead>
              <TableHead scope="col">Character</TableHead>
              <TableHead scope="col">Request status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run) => (
              <TableRow
                key={run.requestId}
                className="character-table-row"
                onClick={() => !busy && open(run)}
                aria-disabled={busy}
              >
                <TableCell>
                  <Button
                    variant="link"
                    className="character-row-name"
                    disabled={busy}
                    aria-label={`Open ${kind(run)} request from ${date(run.startedAt)}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      open(run);
                    }}
                  >
                    {date(run.startedAt)}
                  </Button>
                </TableCell>
                <TableCell>{kind(run)}</TableCell>
                <TableCell>{run.persona?.name ?? "Not recorded"}</TableCell>
                <TableCell>
                  {run.status === "completed" ? "Completed" : "Failed"}
                </TableCell>
              </TableRow>
            ))}
            {!runs.length && (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="py-8 text-center text-muted-foreground"
                >
                  {query
                    ? "No matching requests. Try another search."
                    : "No requests in this history yet. Start a synthetic test to inspect its result."}
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
        hidden={view !== "new"}
        aria-label="New laboratory test"
        className="grid gap-5"
      >
        <Button
          variant="ghost"
          className="justify-self-start"
          disabled={busy}
          onClick={back}
        >
          <ArrowLeft />
          Back to requests
        </Button>
        <h2 className="text-lg font-medium">New synthetic test</h2>
        <div className="app-field-row grid gap-4 sm:grid-cols-2">
          <div className="app-form-field grid gap-2">
            <Label htmlFor="lab-test-profile">Character profile</Label>
            <OptionSelect
              id="lab-test-profile"
              value={profileId}
              disabled={busy}
              onValueChange={(id) => void select(id, memoryId)}
            >
              {characters.map((character) => (
                <SelectItem
                  key={character.characterId}
                  value={character.characterId}
                >
                  {character.name}
                </SelectItem>
              ))}
            </OptionSelect>
          </div>
          <div className="app-form-field grid gap-2">
            <Label htmlFor="lab-test-memory">Memory history</Label>
            <OptionSelect
              id="lab-test-memory"
              value={memoryId}
              disabled={busy}
              onValueChange={(id) => void select(profileId, id)}
            >
              {characters.map((character) => (
                <SelectItem
                  key={character.characterId}
                  value={character.characterId}
                >
                  {character.name}
                </SelectItem>
              ))}
            </OptionSelect>
          </div>
        </div>
        <div className="grid gap-2">
          <h3 className="text-sm font-medium">Garden inspection</h3>
          <p className="text-sm text-muted-foreground">
            Two herb beds need inspection. One plot is dry; no water is
            available. The host records acceptance and actual outcomes
            separately.
          </p>
          <p className="text-xs text-muted-foreground">
            {provider} · {model || "Choose a model in Settings"}
          </p>
        </div>
        <Button
          className="justify-self-start"
          disabled={busy || !ready}
          onClick={() => void start()}
        >
          {starting || running ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <FlaskConical />
          )}
          {starting || running ? "Requesting plan…" : "Run test"}
        </Button>
      </section>
      <section
        hidden={view !== "detail"}
        aria-label="Laboratory request details"
        className="grid gap-5"
      >
        <Button
          variant="ghost"
          className="justify-self-start"
          disabled={busy}
          onClick={back}
        >
          <ArrowLeft />
          Back to requests
        </Button>
        {run ? (
          <>
            <div className="grid gap-2">
              <h2 className="text-lg font-medium">{title}</h2>
              <p className="text-sm text-muted-foreground">
                {run.persona?.name ?? "Character not recorded"} · {run.provider}{" "}
                · {run.model}
              </p>
            </div>
            <Tabs
              value={tab}
              onValueChange={setTab}
              className="lab-detail-tabs"
            >
              <TabsList aria-label="Request inspection" className="w-full">
                <TabsTrigger value="summary">Result</TabsTrigger>
                <TabsTrigger value="trace">Trace</TabsTrigger>
                <TabsTrigger value="memory">Recalled memory</TabsTrigger>
                <TabsTrigger value="debug">Debug</TabsTrigger>
              </TabsList>
              <TabsContent value="summary" className="grid gap-4">
                <p className="text-sm text-muted-foreground">
                  Request {run.status === "completed" ? "completed" : "failed"}.
                  Task outcomes below are reported separately by the host.
                </p>
                {run.result.type === "plan" ? (
                  <Table aria-label="Host task outcomes">
                    <TableHeader>
                      <TableRow>
                        <TableHead scope="col">Task</TableHead>
                        <TableHead scope="col">Host decision</TableHead>
                        <TableHead scope="col">Outcome</TableHead>
                        <TableHead scope="col">Report</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {run.result.proposal.tasks.map((task) => {
                        if (run.result.type !== "plan") return null;
                        const decision = run.result.decision.taskDecisions.find(
                          (item) => item.taskId === task.taskId,
                        );
                        const report = [...run.result.reports]
                          .reverse()
                          .find((item) => item.taskId === task.taskId);
                        return (
                          <TableRow key={task.taskId}>
                            <TableCell>
                              {task.intentId === "inspect-area"
                                ? "Inspect herb beds"
                                : task.intentId === "water-plot" ||
                                    task.intentId === "tend-plot"
                                  ? "Water dry plot"
                                  : "Proposed host task"}
                            </TableCell>
                            <TableCell>
                              {decision?.decision === "accepted"
                                ? "Accepted"
                                : decision?.decision === "rejected"
                                  ? "Rejected"
                                  : "Not recorded"}
                            </TableCell>
                            <TableCell>
                              {report?.status === "succeeded"
                                ? "Succeeded"
                                : report
                                  ? "Not completed"
                                  : "No outcome reported"}
                            </TableCell>
                            <TableCell className="lab-summary-cell">
                              {report?.summary ?? "No host report retained."}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                ) : run.result.type === "chat" ? (
                  <p className="whitespace-pre-wrap text-sm">
                    {run.result.response.output.type === "utterance"
                      ? run.result.response.output.content
                      : "No utterance was proposed."}
                  </p>
                ) : (
                  <p role="alert" className="text-sm text-destructive">
                    The provider could not complete this request. Start a new
                    test or check the model connection in Settings.
                  </p>
                )}
              </TabsContent>
              <TabsContent value="trace">
                <Table aria-label="Request trace">
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">Step</TableHead>
                      <TableHead scope="col">Stage</TableHead>
                      <TableHead scope="col">Memory records</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {run.stages.map((stage, index) => (
                      <TableRow key={index}>
                        <TableCell>{index + 1}</TableCell>
                        <TableCell>
                          {stageNames[stage.stage] ?? "Request processing"}
                        </TableCell>
                        <TableCell>{stage.memoryIds?.length ?? "—"}</TableCell>
                      </TableRow>
                    ))}
                    {!run.stages.length && (
                      <TableRow>
                        <TableCell colSpan={3}>
                          No trace stages were retained for this request.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </TabsContent>
              <TabsContent value="memory" className="grid gap-4">
                <p className="text-sm text-muted-foreground">
                  Records recalled for this request. Other workspace history is
                  available on the Memory page.
                </p>
                <Table aria-label="Recalled memory">
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">Recorded</TableHead>
                      <TableHead scope="col">Summary</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {run.selectedMemoryIds.map((id) => {
                      const record = snapshot?.memories.find(
                        (memory) => memory.memoryId === id,
                      );
                      return (
                        <TableRow key={id}>
                          <TableCell>
                            {record ? date(record.recordedAt) : "Not retained"}
                          </TableCell>
                          <TableCell className="lab-summary-cell">
                            {record?.summary ??
                              (record
                                ? "Received evidence"
                                : "This record is no longer retained in the current history.")}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                    {!run.selectedMemoryIds.length && (
                      <TableRow>
                        <TableCell
                          colSpan={2}
                          className="py-6 text-center text-muted-foreground"
                        >
                          No memory records were recalled for this request.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </TabsContent>
              <TabsContent value="debug" className="grid gap-3">
                <p className="text-sm text-muted-foreground">
                  Technical inspection of this request only.
                </p>
                <details>
                  <summary className="text-sm">
                    Inspect recorded request
                  </summary>
                  <pre className="lab-debug-payload">
                    {JSON.stringify(run, null, 2)}
                  </pre>
                </details>
              </TabsContent>
            </Tabs>
          </>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            This request is no longer in the retained history. Return to the
            list to choose another.
          </p>
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
