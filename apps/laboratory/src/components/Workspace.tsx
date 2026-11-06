import { MemoryArchiveControls } from "./MemoryArchive";
import { Message, MessageContent } from "./ui/message";
import { Suggestions, Suggestion } from "./ui/suggestions";
import { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  CheckCheck,
  ChevronRight,
  CircleDashed,
  Clock3,
  Database,
  FileText,
  FlaskConical,
  GitBranch,
  ListChecks,
  LoaderCircle,
  MessageCircle,
  Search,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Badge } from "./ui/badge";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { ScrollArea } from "./ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import type { LabSnapshot } from "../lib/api";
import type { MemoryEvent } from "@ifsoul/core/protocol";
import { ReflectionMemory } from "./ReflectionMemory";

type PanelProps = {
  snapshot: LabSnapshot | null;
  pending: "plan" | "chat" | null;
  ready: boolean;
};
const providerName: Record<string, string> = {
  scenario: "Synthetic",
  openai: "OpenAI",
  ollama: "Ollama",
  cloudflare: "Cloudflare",
};
const time = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" });
};

export function ChatPanel({
  snapshot,
  draft,
  setDraft,
  pending,
  ready,
  provider,
  model,
  onSend,
}: PanelProps & {
  draft: string;
  setDraft: (value: string) => void;
  provider: string;
  model: string;
  onSend: () => void;
}) {
  const chats = snapshot?.runs.filter((run) => run.operation === "chat") ?? [];
  return (
    <Card className="chat-card">
      <CardHeader>
        <div className="panel-title-row">
          <CardTitle>
            <MessageCircle size={17} />
            Conversation
          </CardTitle>
          <Badge variant="outline">Text channel</Badge>
        </div>
        <p className="card-subtitle">
          Talk about experiences, ideas, and remembered events.
        </p>
      </CardHeader>
      <CardContent className="chat-content">
        <ScrollArea className="conversation-scroll">
          <div
            className="conversation-list"
            role="log"
            aria-label="Conversation"
            aria-live="polite"
          >
            {!chats.length && (
              <div className="chat-empty">
                <div className="empty-icon">
                  <Sparkles size={21} />
                </div>
                <h3>Start with a question.</h3>
                <p>
                  Your character's answers draw on the memory selected for this
                  conversation.
                </p>
                <Suggestions className="chat-suggestions">
                  <Suggestion
                    className="prompt-suggestion"
                    onClick={() =>
                      setDraft("What would you like to talk about?")
                    }
                  >
                    What would you like to talk about?
                    <ChevronRight size={14} />
                  </Suggestion>
                </Suggestions>
              </div>
            )}
            {chats.map((run) => (
              <div className="conversation-turn" key={run.requestId}>
                {run.message && (
                  <Message from="user" className="message user-message">
                    <MessageContent>
                      <div className="message-label">
                        You <time>{time(run.startedAt)}</time>
                      </div>
                      <p>{run.message}</p>
                    </MessageContent>
                  </Message>
                )}
                {run.result.type === "chat" ? (
                  <Message
                    from="assistant"
                    className="message character-message"
                  >
                    <MessageContent>
                      <div className="message-label">
                        <span className="mini-avatar">
                          {
                            (run.persona?.name ??
                              snapshot?.character.profile.name ??
                              "I")[0]
                          }
                        </span>
                        {run.persona?.name ??
                          snapshot?.character.profile.name ??
                          "Character"}
                        <time>{time(run.completedAt)}</time>
                      </div>
                      <p>
                        {run.result.response.output.type === "utterance"
                          ? run.result.response.output.content
                          : "The character did not propose a reply for this request."}
                      </p>
                      <div className="message-meta">
                        <Badge variant="secondary">
                          {providerName[run.provider] ?? "Model"}
                        </Badge>
                        <span>
                          <Database size={11} /> {run.selectedMemoryIds.length}{" "}
                          memories selected
                        </span>
                        <span>
                          <CheckCheck size={12} />
                          {run.result.delivery.status === "delivered"
                            ? "Delivered"
                            : "Delivery unconfirmed"}
                        </span>
                      </div>
                    </MessageContent>
                  </Message>
                ) : (
                  <div className="message failed-message">
                    <p>
                      This attempt did not produce a reply. Your draft remains
                      available to retry.
                    </p>
                  </div>
                )}
              </div>
            ))}
            {pending === "chat" && (
              <div className="reply-pending">
                <span />
                <span />
                <span />
                <span className="sr-only">
                  Waiting for the character's reply
                </span>
              </div>
            )}
          </div>
        </ScrollArea>
        <div className="composer">
          <label className="sr-only" htmlFor="chat-message">
            Message your character
          </label>
          <Textarea
            id="chat-message"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (
                (event.metaKey || event.ctrlKey) &&
                event.key === "Enter" &&
                ready &&
                draft.trim()
              ) {
                event.preventDefault();
                onSend();
              }
            }}
            placeholder="Message your character…"
            maxLength={4000}
            disabled={Boolean(pending)}
          />
          <div className="composer-actions">
            <span>
              {provider}
              <span className="composer-model">
                {" "}
                · {model || "No model selected"}
              </span>
            </span>
            <Button
              onClick={onSend}
              disabled={!ready || !draft.trim()}
              aria-label={
                pending === "chat" ? "Sending message" : "Send message"
              }
            >
              {pending === "chat" ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <ArrowUp size={16} />
              )}
              <span>{pending === "chat" ? "Sending…" : "Send"}</span>
            </Button>
          </div>
          <p className="composer-note">
            {draft.length > 3600
              ? `${4000 - draft.length} characters remaining`
              : "Draft kept in this tab until sent. Ctrl / ⌘ + Enter to send."}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export function PlanPanel({
  snapshot,
  pending,
  ready,
  onPlan,
}: PanelProps & { onPlan: () => void }) {
  const lastPlan = [...(snapshot?.runs ?? [])]
    .reverse()
    .find((run) => run.result.type === "plan");
  const plan = lastPlan?.result.type === "plan" ? lastPlan.result : null;
  return (
    <Card className="plan-card">
      <CardHeader>
        <div className="panel-title-row">
          <CardTitle>
            <ListChecks size={17} />
            Synthetic host
          </CardTitle>
          <Badge variant="outline">
            <FlaskConical size={11} />
            Sandbox
          </Badge>
        </div>
        <p className="card-subtitle">
          A small garden. Two tasks. The host decides.
        </p>
      </CardHeader>
      <CardContent>
        <div className="host-context">
          <div className="host-context-label">
            <span className="status-dot" /> HOST BRIEFING
          </div>
          <p>
            Two herb beds need inspection.
            <br />
            One plot is dry. No water is available.
          </p>
          <div>
            <Badge variant="secondary">
              <Clock3 size={11} />
              Morning
            </Badge>
            <Badge variant="secondary">Water · 0 ml</Badge>
          </div>
        </div>
        {plan ? (
          <div className="task-list">
            {plan.proposal.tasks.map((task, index) => {
              const decision = plan.decision.taskDecisions.find(
                (item) => item.taskId === task.taskId,
              );
              const report = [...plan.reports]
                .reverse()
                .find((item) => item.taskId === task.taskId);
              const rejected = decision?.decision === "rejected";
              const completed = report?.status === "succeeded";
              const title =
                task.intentId === "inspect-area"
                  ? "Inspect the herb beds"
                  : task.intentId === "water-plot" ||
                      task.intentId === "tend-plot"
                    ? "Water the dry plot"
                    : "Proposed host task";
              return (
                <article
                  key={task.taskId}
                  className={`task-row ${rejected ? "task-rejected" : ""}`}
                >
                  <div
                    className={`task-number ${completed ? "task-done" : ""}`}
                  >
                    {completed ? (
                      <Check size={15} />
                    ) : rejected ? (
                      <X size={15} />
                    ) : (
                      String(index + 1).padStart(2, "0")
                    )}
                  </div>
                  <div className="task-detail">
                    <h3>{title}</h3>
                    <div className="task-states">
                      <span>Proposed</span>
                      <ChevronRight size={11} />
                      <span className={rejected ? "rejected-state" : ""}>
                        {rejected
                          ? "Rejected"
                          : decision?.decision === "accepted"
                            ? "Accepted"
                            : "Awaiting host"}
                      </span>
                      {report && (
                        <>
                          <ChevronRight size={11} />
                          <span className={completed ? "completed-state" : ""}>
                            {completed
                              ? "Completed"
                              : report.status === "failed"
                                ? "Failed"
                                : "Outcome pending"}
                          </span>
                        </>
                      )}
                    </div>
                    <p>
                      {rejected
                        ? "The host has no water. This task was not completed."
                        : (report?.summary ??
                          "Waiting for a host-reported outcome.")}
                    </p>
                  </div>
                </article>
              );
            })}
            <div className="plan-outcome">
              <ShieldCheck size={15} />
              <span>
                {plan.decision.status === "partially-accepted"
                  ? "Partial acceptance"
                  : plan.decision.status === "accepted"
                    ? "Plan accepted"
                    : "Plan rejected"}{" "}
                · outcomes recorded separately
              </span>
            </div>
          </div>
        ) : (
          <div className="plan-empty">
            <CircleDashed size={23} />
            <h3>No plan requested yet</h3>
            <p>
              Ask the selected controller to propose a bounded plan. The
              synthetic host then accepts or rejects each task.
            </p>
          </div>
        )}
        <Button className="wide plan-button" onClick={onPlan} disabled={!ready}>
          {pending === "plan" ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <GitBranch size={15} />
          )}
          {pending === "plan"
            ? "Requesting a plan…"
            : plan
              ? "Request another plan"
              : "Request a plan"}
        </Button>
        <p className="host-note">
          This host simulates abstract task outcomes. It does not control a game
          or an NPC.
        </p>
        {lastPlan && (
          <div className="last-plan-note">
            Last plan · {providerName[lastPlan.provider] ?? "Model"} ·{" "}
            {time(lastPlan.completedAt)}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const kindLabels: Record<string, string> = {
  "context-report": "Host context",
  "plan-proposal": "Intention",
  "plan-decision": "Host decision",
  "task-report": "Observed outcome",
  "conversation-request": "Conversation",
  "conversation-response": "Reply proposed",
  "conversation-delivery": "Reply delivery",
};

function memoryDescription(memory: MemoryEvent): string {
  const payload = memory.recordedPayload;
  if (typeof payload.summary === "string") return payload.summary;
  if (
    payload.kind === "context-report" &&
    payload.observedState &&
    typeof payload.observedState === "object"
  ) {
    const state = payload.observedState as { summary?: unknown };
    if (typeof state.summary === "string") return state.summary;
  }
  if (payload.kind === "plan-proposal")
    return "A bounded plan was proposed. This records intention, not completed work.";
  if (payload.kind === "plan-decision")
    return payload.status === "partially-accepted"
      ? "The host accepted part of the plan and rejected the remaining task."
      : "The host recorded its acceptance decision.";
  if (payload.kind === "conversation-request")
    return "An incoming message requested a character reply.";
  if (payload.kind === "conversation-response")
    return "The character proposed a response for the current text channel.";
  if (payload.kind === "conversation-delivery")
    return payload.status === "delivered"
      ? "The host confirmed that the reply was delivered."
      : "The host recorded a delivery status.";
  return (
    memory.summary ??
    "An authorized event was preserved with its original source."
  );
}

const stageLabels: Record<string, string> = {
  context: "Host context received",
  "selected-memory": "Scoped memory selected",
  controller: "Controller requested",
  proposal: "Proposal validated",
  "host-acceptance": "Host adoption recorded",
  "host-decision": "Host adoption recorded",
  "host-outcome": "Host outcome recorded",
  memory: "Memory saved",
  dialogue: "Reply proposed",
  delivery: "Delivery recorded",
  reuse: "Saved request reused",
  rejected: "Request safely rejected",
};

export function EvidencePanel({
  snapshot,
  debug = false,
  disabled,
  onMemoryImported,
}: {
  snapshot: LabSnapshot | null;
  debug?: boolean;
  disabled?: boolean;
  onMemoryImported?: (id: string) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const lastRun = snapshot?.runs.at(-1);
  const selected = new Set(lastRun?.selectedMemoryIds ?? []);
  const memories = useMemo(
    () =>
      [...(snapshot?.memories ?? [])]
        .reverse()
        .filter((memory) =>
          `${memoryDescription(memory)} ${kindLabels[String(memory.recordedPayload.kind)] ?? "Event"}`
            .toLowerCase()
            .includes(query.toLowerCase()),
        ),
    [snapshot?.memories, query],
  );
  return (
    <Card className="evidence-card" id="evidence">
      <Tabs defaultValue="memory">
        <div className="evidence-top">
          <TabsList aria-label="Workspace evidence">
            <TabsTrigger value="memory">
              <Database size={14} />
              Memory
              <span className="tab-count">
                {snapshot?.memories.length ?? 0}
              </span>
            </TabsTrigger>
            {debug && (
              <>
                <TabsTrigger value="trace">
                  <GitBranch size={14} />
                  Trace
                </TabsTrigger>
                <TabsTrigger value="debug">
                  <FileText size={14} />
                  Debug
                </TabsTrigger>
              </>
            )}
          </TabsList>
          <span className="evidence-caption">
            See the source behind the story.
          </span>
        </div>
        <TabsContent value="memory">
          <MemoryArchiveControls
            memoryId={snapshot?.character.characterId}
            profileId={
              snapshot?.persona?.characterId ?? snapshot?.character.characterId
            }
            disabled={disabled}
            onImported={onMemoryImported}
          />
          <div className="memory-toolbar">
            <div>
              <h3>Remembered events</h3>
              <p>
                Original received evidence, with intention and outcome kept
                distinct.
              </p>
            </div>
            <div className="memory-search">
              <Search size={14} />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="Search memory"
                placeholder="Search memory…"
              />
            </div>
          </div>
          <ScrollArea className="memory-scroll">
            <div className="memory-list">
              <ReflectionMemory
                reflection={snapshot?.bridgeReflection}
                query={query}
              />
              {memories.length ? (
                memories.map((memory) => (
                  <article className="memory-row" key={memory.memoryId}>
                    <div className="memory-icon">
                      {memory.recordedPayload.kind === "task-report" ? (
                        <Check size={15} />
                      ) : (
                        <Database size={14} />
                      )}
                    </div>
                    <div>
                      <div className="memory-label">
                        <span>
                          {kindLabels[String(memory.recordedPayload.kind)] ??
                            "Received event"}
                        </span>
                        {selected.has(memory.memoryId) && (
                          <Badge variant="secondary">
                            Selected for last request
                          </Badge>
                        )}
                      </div>
                      <p>{memoryDescription(memory)}</p>
                      <span className="memory-scope">
                        Participant-limited · {time(memory.recordedAt)}
                      </span>
                    </div>
                  </article>
                ))
              ) : (
                <EmptyEvidence
                  title={
                    query
                      ? "No matching memories"
                      : "A history starts with an event"
                  }
                  text={
                    query
                      ? "Try another word or clear the search."
                      : "Send a message. Authorized received events will appear here."
                  }
                />
              )}
            </div>
          </ScrollArea>
        </TabsContent>
        {debug && (
          <>
            <TabsContent value="trace">
              <div className="trace-intro">
                <h3>Last request, step by step</h3>
                <p>
                  Observable stages show what was selected, proposed, validated,
                  and saved.
                </p>
              </div>
              {lastRun ? (
                <div className="trace-list">
                  {lastRun.stages.map((stage, index) => (
                    <div className="trace-step" key={`${stage.stage}-${index}`}>
                      <span className="trace-index">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <div>
                        <h4>
                          {stageLabels[stage.stage] ?? "Request processing"}
                        </h4>
                        <p>
                          {stage.memoryIds
                            ? `${stage.memoryIds.length} authorized memory records`
                            : stage.stage === "rejected"
                              ? "No rejected output was adopted as completed work."
                              : "Recorded by the current runtime."}
                        </p>
                      </div>
                      <Check size={14} />
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyEvidence
                  title="Nothing to trace yet"
                  text="The next request will leave an observable sequence here."
                />
              )}
            </TabsContent>
            <TabsContent value="debug">
              <div className="debug-intro">
                <h3>Technical inspection</h3>
                <p>
                  Full technical identifiers and authorized synthetic payloads.
                  Provider keys are never included.
                </p>
              </div>
              <details className="debug-details">
                <summary>
                  Inspect current snapshot <ChevronRight size={14} />
                </summary>
                <ScrollArea className="debug-scroll">
                  <pre>{JSON.stringify(snapshot, null, 2)}</pre>
                </ScrollArea>
              </details>
            </TabsContent>
          </>
        )}
      </Tabs>
    </Card>
  );
}

function EmptyEvidence({ title, text }: { title: string; text: string }) {
  return (
    <div className="evidence-empty">
      <Database size={22} />
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
