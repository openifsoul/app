import {
  conversationChannels,
  type ChannelPolicy,
} from "@ifsoul/adapter-sdk/bridge";
import { Checkbox } from "./ui/checkbox";
import { OptionSelect, SelectItem } from "./ui/select";
import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { GameBinding } from "../lib/game-connections-api";
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

const supportLabel = {
  supported: "Supported",
  partial: "Partial",
  unsupported: "Unsupported",
} as const;

export function GameCapabilities({
  connection,
  onUpdate,
  refresh,
}: {
  connection: GameBinding;
  onUpdate: (connection: GameBinding) => void;
  refresh: () => Promise<void>;
}) {
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [status, setStatus] = useState<{ error: boolean; text: string }>();
  const [now, setNow] = useState(Date.now);
  const capability = connection.capability;
  useEffect(() => {
    if (!capability) return;
    const timeout = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, capability.expiresAt - Date.now()),
    );
    return () => clearTimeout(timeout);
  }, [capability?.expiresAt]);
  const offline =
    connection.capabilityOffline ||
    (connection.capabilityRequired && !capability) ||
    connection.revoked ||
    connection.expiresAt <= now ||
    (capability && capability.expiresAt <= now);
  const rows = capability?.manifest.capabilities ?? [];
  const query = rows.length >= 5 ? search.trim().toLocaleLowerCase() : "";
  const visible = rows
    .filter((row) =>
      [row.intentId, row.category, row.description].some((value) =>
        value.toLocaleLowerCase().includes(query),
      ),
    )
    .sort((left, right) => left.intentId.localeCompare(right.intentId));
  async function savePermission(
    key: string,
    allowedIntentIds: string[],
    channelPolicy?: ChannelPolicy,
  ) {
    if (!capability || offline || pending) return;
    setPending(key);
    setStatus(undefined);
    try {
      const response = await api<{ connection: GameBinding }>(
        `game-connections/${encodeURIComponent(connection.connectionId)}/capabilities`,
        {
          method: "PUT",
          body: {
            providerId: capability.providerId,
            manifestRevision: capability.manifest.revision,
            policyRevision: capability.policyRevision,
            allowedIntentIds,
            ...(channelPolicy && { channelPolicy }),
          },
        },
      );
      onUpdate(response.connection);
      setStatus({ error: false, text: "Permission saved." });
    } catch (error) {
      setStatus({
        error: true,
        text:
          error instanceof ApiError && error.code === "conflict"
            ? "The host or its permissions changed. Review the refreshed table and try again."
            : "Could not save this permission. Check the connection and try again.",
      });
      await refresh();
    } finally {
      setPending(null);
    }
  }
  return (
    <div className="grid min-w-0 gap-2">
      <h4 className="font-medium">Host capabilities</h4>
      {!capability ? (
        <p className="text-muted-foreground">
          {offline
            ? "This connection is offline."
            : "This host has not reported its capabilities. Connect a compatible host and refresh."}
        </p>
      ) : (
        <>
          <p className="break-words text-muted-foreground">
            {offline ? "Host offline · last report" : "Connected host"} ·{" "}
            {capability.manifest.worldId} · {capability.manifest.embodimentId}
          </p>
          {rows.length >= 5 && (
            <Input
              aria-label="Search host capabilities"
              placeholder="Search capabilities"
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
            />
          )}
          {!visible.length ? (
            <p className="text-muted-foreground">
              {query
                ? "No capabilities match your search."
                : "This host reported no capabilities for this world and character."}
            </p>
          ) : (
            <Table
              aria-label="Reported host capabilities"
              className="w-full text-xs sm:text-sm"
            >
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Action</TableHead>
                  <TableHead scope="col">Support</TableHead>
                  <TableHead scope="col">Readiness</TableHead>
                  <TableHead scope="col">Permission</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((row) => {
                  const allowed = capability.allowedIntentIds.includes(
                    row.intentId,
                  );
                  return (
                    <TableRow key={row.intentId}>
                      <TableCell className="break-words whitespace-normal">
                        {row.description}
                        <div className="break-all text-xs text-muted-foreground">
                          {row.intentId}
                        </div>
                      </TableCell>
                      <TableCell>{supportLabel[row.support]}</TableCell>
                      <TableCell className="break-words whitespace-normal">
                        {offline
                          ? "Offline"
                          : row.readiness === "ready"
                            ? "Ready"
                            : "Unavailable"}
                        {row.reason && (
                          <div className="text-xs text-muted-foreground">
                            {row.reason}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        {row.support === "unsupported" || offline ? (
                          allowed ? (
                            "Allowed"
                          ) : (
                            "Denied"
                          )
                        ) : (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="min-h-11 whitespace-normal"
                            disabled={pending === row.intentId}
                            aria-disabled={pending !== null}
                            aria-label={`${allowed ? "Revoke" : "Allow"} ${row.description}`}
                            onClick={() =>
                              void savePermission(
                                row.intentId,
                                allowed
                                  ? capability.allowedIntentIds.filter(
                                      (id) => id !== row.intentId,
                                    )
                                  : [
                                      ...capability.allowedIntentIds,
                                      row.intentId,
                                    ],
                              )
                            }
                          >
                            {pending === row.intentId
                              ? "Saving…"
                              : allowed
                                ? "Allowed · Revoke"
                                : "Denied · Allow"}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </>
      )}
      <h4 className="font-medium">Conversation channels</h4>
      <p className="text-muted-foreground">
        React requires Listen. Speaking can be allowed separately.
      </p>
      <Table aria-label="Conversation channel permissions">
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Channel</TableHead>
            <TableHead scope="col">Listen</TableHead>
            <TableHead scope="col">React</TableHead>
            <TableHead scope="col">Speak</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {conversationChannels.map((channel) => {
            const supported = capability?.manifest.channels?.find(
              (entry) => entry.channel === channel,
            );
            const policy = capability?.channelPolicy;
            const current = policy?.channels.find(
              (entry) => entry.channel === channel,
            );
            const effective =
              !offline && capability && supported && policy && current;
            return (
              <TableRow key={channel}>
                <TableCell className="capitalize">
                  {channel}
                  {!effective && (
                    <div className="text-xs text-muted-foreground">
                      {offline
                        ? "Host offline"
                        : capability?.manifest.channels
                          ? "Unsupported"
                          : "Awaiting host report"}
                    </div>
                  )}
                </TableCell>
                {(["listen", "react", "speak"] as const).map((permission) => (
                  <TableCell key={permission}>
                    <label className="inline-flex min-h-11 min-w-11 items-center justify-center">
                      <Checkbox
                        aria-label={`${permission} on ${channel}`}
                        disabled={
                          !effective ||
                          !supported?.[permission] ||
                          pending !== null ||
                          (permission === "react" && !current?.listen)
                        }
                        checked={current?.[permission] ?? false}
                        onCheckedChange={(checked) => {
                          if (
                            !capability ||
                            !policy ||
                            !current ||
                            typeof checked !== "boolean"
                          )
                            return;
                          const next = { ...current, [permission]: checked };
                          if (permission === "listen" && !checked)
                            next.react = false;
                          void savePermission(
                            channel,
                            capability.allowedIntentIds,
                            {
                              ...policy,
                              channels: policy.channels.map((entry) =>
                                entry.channel === channel ? next : entry,
                              ),
                            },
                          );
                        }}
                      />
                    </label>
                  </TableCell>
                ))}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {capability?.channelPolicy && !connection.minecraftTarget && (
        <div className="grid gap-2">
          <label htmlFor={`reply-route-${connection.connectionId}`}>
            When speaking in the channel is disabled
          </label>
          <OptionSelect
            id={`reply-route-${connection.connectionId}`}
            value={capability.channelPolicy.fallback}
            disabled={Boolean(offline || pending)}
            onValueChange={(fallback) => {
              if (
                (fallback !== "silence" && fallback !== "private") ||
                !capability.channelPolicy
              )
                return;
              void savePermission(
                "reply-destination",
                capability.allowedIntentIds,
                { ...capability.channelPolicy, fallback },
              );
            }}
          >
            <SelectItem value="silence">Stay silent</SelectItem>
            <SelectItem value="private">
              Reply privately when available
            </SelectItem>
          </OptionSelect>
        </div>
      )}
      {status && (
        <p
          role={status.error ? "alert" : "status"}
          className={
            status.error ? "text-destructive" : "text-muted-foreground"
          }
        >
          {status.text}
        </p>
      )}
    </div>
  );
}
