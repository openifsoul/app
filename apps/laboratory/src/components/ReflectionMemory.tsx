import type { LabSnapshot } from "../lib/api";
import { Badge } from "./ui/badge";

type Reflection = NonNullable<LabSnapshot["bridgeReflection"]>;
type Item = Reflection["facts"][number] | Reflection["relationships"][number];

function Sources({ sources }: { sources: Item["sources"] }) {
  return sources.length ? (
    <ul className="space-y-2 pl-4">
      {sources.map((source, index) => (
        <li key={`${source.id}-${index}`}>
          <p>{source.excerpt}</p>
          <span className="memory-scope">
            World: {source.hostId} · Source {source.id} · {source.recordedAt}
          </span>
          <span className="memory-scope break-all">
            Digest: {source.digest}
          </span>
        </li>
      ))}
    </ul>
  ) : (
    <p>No retained source excerpt is available.</p>
  );
}

function Claim({ item }: { item: Item }) {
  return (
    <article className="memory-row">
      <div className="min-w-0 w-full">
        <div className="memory-label">
          <span>{item.key}</span>
          <Badge variant="secondary">
            {item.kind === "subjective-belief"
              ? "Subjective belief"
              : "Reported claim"}
          </Badge>
          <Badge variant="outline">{item.status}</Badge>
        </div>
        <p>
          {typeof item.value === "string"
            ? item.value
            : JSON.stringify(item.value)}
        </p>
        <p>Reason: {item.reason}</p>
        <span className="memory-scope">
          {item.kind === "subjective-belief"
            ? item.relationshipScope === "legacy-contextual"
              ? "Historical world views · reconciliation pending"
              : "Across worlds and chat"
            : `World: ${item.hostId}`}{" "}
          · Subject: {item.subjectId}
          {item.targetId ? ` · Target: ${item.targetId}` : ""}
        </span>
        <span className="memory-scope">
          Perspective: {item.perspectiveCharacterId} · Confidence:{" "}
          {item.confidence} · Revision {item.revision} · Valid from{" "}
          {item.validFrom}
        </span>
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer">
            Review sources ({item.sources.length})
          </summary>
          <Sources sources={item.sources} />
        </details>
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer">
            Review history ({item.history.length})
          </summary>
          {item.history.map((version, index) => (
            <div
              key={`${version.recordedAt}-${index}`}
              className="mt-2 border-l pl-3"
            >
              <p>
                {typeof version.value === "string"
                  ? version.value
                  : JSON.stringify(version.value)}
              </p>
              <span className="memory-scope">
                {version.status}
                {version.key ? ` · ${version.key}` : ""} · Confidence:{" "}
                {version.confidence} · {version.recordedAt}
              </span>
              <p>{version.reason}</p>
              <Sources sources={version.sources} />
            </div>
          ))}
          {!item.history.length && <p>No earlier revisions.</p>}
        </details>
      </div>
    </article>
  );
}

export function ReflectionMemory({
  reflection,
  query,
}: {
  reflection: LabSnapshot["bridgeReflection"];
  query: string;
}) {
  if (!reflection) return null;
  const groups = [
    { label: "Derived facts", items: reflection.facts },
    { label: "Relationships", items: reflection.relationships },
  ];
  return (
    <section aria-label="Derived memory" className="pb-4">
      <div className="py-4">
        <h3 className="text-sm font-medium">Derived memory</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Source-backed reported claims and subjective beliefs from this
          character’s perspective. These are not verified world facts.
        </p>
        {reflection.status === "pending" && (
          <p role="status" className="mt-2 text-xs">
            Reflection is pending. Received events remain available below.
          </p>
        )}
        {reflection.status === "empty" && (
          <p role="status" className="mt-2 text-xs">
            No interpretations generated yet. Received experiences remain
            available below.
          </p>
        )}
        {reflection.status === "deferred" && (
          <p role="status" className="mt-2 text-xs">
            Interpretation was deferred because this interaction was too large.
            Earlier interpretations and received experiences remain available.
          </p>
        )}
        {reflection.status === "ready" &&
          !reflection.facts.length &&
          !reflection.relationships.length && (
            <p role="status" className="mt-2 text-xs">
              No grounded interpretation was proposed from the available
              experiences.
            </p>
          )}
        {reflection.status === "failed" && (
          <p role="status" className="mt-2 text-xs">
            Derived memory could not be refreshed. Review the received events
            below and try again after the next interaction.
          </p>
        )}
      </div>
      {groups.map(({ label, items }) => {
        const matches = items.filter((item) =>
          JSON.stringify(item).toLowerCase().includes(query.toLowerCase()),
        );
        return (
          <section key={label} aria-label={label}>
            <h4 className="text-xs font-medium">
              {label} ({matches.length})
            </h4>
            {matches.map((item) => (
              <Claim key={item.id} item={item} />
            ))}
            {!matches.length && (
              <p className="py-3 text-xs text-muted-foreground">
                {query
                  ? "No matching derived memories. Try another word or clear the search."
                  : "No source-backed entries yet. Received experiences can add claims here."}
              </p>
            )}
          </section>
        );
      })}
    </section>
  );
}
