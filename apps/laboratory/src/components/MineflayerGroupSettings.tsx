import { AdventureHistory } from "./AdventureHistory";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import {
  readGameConnections,
  type GameBinding,
} from "../lib/game-connections-api";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { OptionSelect, SelectItem } from "./ui/select";

type Group = {
  id: string;
  revision: number;
  state: "waiting" | "connected" | "stopped";
  members: { name: string; character: string; connectionId: string }[];
};
type Snapshot = { group: Group | null; code?: string };
const blank = () => ({ name: "", connectionId: "" });
const minecraftName = /^[A-Za-z0-9_]{3,16}$/;
const playerUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const axes = ["x", "y", "z"] as const;
function coordinates(value: string) {
  const fields = value.trim().split(/[ ,]+/u);
  if (fields.length !== 3 || fields.some((field) => !/^-?\d{1,8}$/.test(field)))
    return undefined;
  const [x, y, z] = fields.map(Number);
  return { x, y, z };
}
const regionFields = [
  ["travelMinimum", "Travel area minimum"],
  ["travelMaximum", "Travel area maximum"],
  ["harvestMinimum", "Harvest area minimum"],
  ["harvestMaximum", "Harvest area maximum"],
] as const;

export function MineflayerGroupSettings() {
  const [connections, setConnections] = useState<GameBinding[]>([]);
  const [group, setGroup] = useState<Group | null>(null);
  const [setup, setSetup] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [loadingFailed, setLoadingFailed] = useState(false);
  const [server, setServer] = useState({ host: "127.0.0.1", port: "25565" });
  const [player, setPlayer] = useState({ name: "", uuid: "" });
  const [members, setMembers] = useState([blank(), blank()]);
  const [autonomous, setAutonomous] = useState(false);
  const [publicChat, setPublicChat] = useState(false);
  const [adventure, setAdventure] = useState(false);
  const [forest, setForest] = useState({
    dimension: "overworld",
    resources: "oak_log",
    travelMinimum: "",
    travelMaximum: "",
    harvestMinimum: "",
    harvestMaximum: "",
  });
  const [consent, setConsent] = useState(false);
  const active = group?.state === "connected" || group?.state === "waiting";
  function eligible(rows: GameBinding[]) {
    return rows.filter(
      (row) =>
        !row.revoked &&
        row.expiresAt > Date.now() &&
        !row.minecraftTarget &&
        row.actions?.includes("movement"),
    );
  }
  async function refresh(signal?: AbortSignal) {
    try {
      const [snapshot, grants] = await Promise.all([
        api<Snapshot>("game-groups", { signal, timeoutMs: 5000 }),
        readGameConnections(signal),
      ]);
      if (!signal?.aborted) {
        setGroup(snapshot.group);
        setConnections(eligible(grants.connections));
        setLoadingFailed(false);
      }
    } catch {
      if (!signal?.aborted) setLoadingFailed(true);
    } finally {
      if (!signal?.aborted) setLoaded(true);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = setInterval(() => void refresh(controller.signal), 5000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, []);
  async function change(
    body: Record<string, unknown>,
    localAdventure?: Record<string, unknown>,
  ) {
    setBusy(true);
    setMessage("");
    try {
      const snapshot = await api<Snapshot>("game-groups", {
        method: "POST",
        body,
        timeoutMs: 8000,
      });
      setGroup(snapshot.group);
      setSetup(
        snapshot.code
          ? JSON.stringify(
              {
                ifsoul: location.origin,
                server: body.server,
                code: snapshot.code,
                ...(localAdventure && { adventure: localAdventure }),
              },
              null,
              2,
            )
          : "",
      );
      setMessage(
        snapshot.code
          ? "Group setup code created."
          : snapshot.group?.state === "stopped"
            ? "The group stopped."
            : "The member was removed.",
      );
    } catch {
      setMessage(
        "The group could not be changed. Refresh and check its connections.",
      );
    } finally {
      setBusy(false);
    }
  }
  const hasPlayer = player.name.length > 0 || player.uuid.length > 0;
  const selected = members.map((m) =>
    connections.find((row) => row.connectionId === m.connectionId),
  );
  const travelMinimum = coordinates(forest.travelMinimum);
  const travelMaximum = coordinates(forest.travelMaximum);
  const harvestMinimum = coordinates(forest.harvestMinimum);
  const harvestMaximum = coordinates(forest.harvestMaximum);
  const resources = [...new Set(forest.resources.trim().split(/[ ,]+/u))];
  const forestPolicy =
    travelMinimum &&
    travelMaximum &&
    harvestMinimum &&
    harvestMaximum &&
    /^[a-z][a-z0-9_:-]{0,63}$/u.test(forest.dimension) &&
    resources.every((item) =>
      /^(?:oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_log$/u.test(
        item,
      ),
    ) &&
    axes.every(
      (axis) =>
        travelMinimum[axis] <= harvestMinimum[axis] &&
        harvestMinimum[axis] <= harvestMaximum[axis] &&
        harvestMaximum[axis] <= travelMaximum[axis] &&
        travelMaximum[axis] - travelMinimum[axis] <= 48,
    )
      ? {
          dimension: forest.dimension,
          resources,
          region: { min: travelMinimum, max: travelMaximum },
          harvestRegion: { min: harvestMinimum, max: harvestMaximum },
        }
      : undefined;
  const valid =
    (!adventure || (members.length === 3 && hasPlayer && forestPolicy)) &&
    /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(server.host) &&
    /^\d+$/.test(server.port) &&
    Number(server.port) >= 1024 &&
    Number(server.port) <= 65535 &&
    (hasPlayer
      ? minecraftName.test(player.name) && playerUuid.test(player.uuid)
      : autonomous) &&
    members.every(
      (m) =>
        minecraftName.test(m.name) &&
        m.name.toLowerCase() !== player.name.toLowerCase(),
    ) &&
    new Set(members.map((m) => m.name.toLowerCase())).size === members.length &&
    new Set(selected.map((row) => row?.memoryId)).size === members.length &&
    selected.every(
      (row) =>
        row &&
        row.model === selected[0]?.model &&
        row.provider === selected[0]?.provider,
    );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Mineflayer group</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {!loaded && <p role="status">Checking group settings…</p>}
        {loadingFailed && (
          <p role="alert">
            Group settings are unavailable.{" "}
            <Button variant="link" onClick={() => void refresh()}>
              Retry
            </Button>
          </p>
        )}
        {group && (
          <section aria-label="Current group" className="grid gap-2">
            <p role="status">
              {group.state === "connected"
                ? "Group host connected."
                : group.state === "waiting"
                  ? "Waiting for the group host."
                  : "Group stopped."}
            </p>
            <ul className="grid gap-2">
              {group.members.map((member) => (
                <li
                  key={member.connectionId}
                  className="flex flex-wrap items-center justify-between gap-2"
                >
                  <span>
                    {member.name} · {member.character}
                  </span>
                  {active && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      aria-label={`Remove ${member.name} from group`}
                      onClick={() =>
                        void change({
                          action: "revoke-member",
                          revision: group.revision,
                          connectionId: member.connectionId,
                        })
                      }
                    >
                      Remove member
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            {active && (
              <Button
                variant="outline"
                className="justify-self-start"
                disabled={busy}
                onClick={() =>
                  void change({ action: "stop", revision: group.revision })
                }
              >
                Stop group
              </Button>
            )}
          </section>
        )}
        {setup && group?.state === "waiting" && (
          <div className="grid gap-2">
            <Label htmlFor="mineflayer-group-setup">
              Group host configuration
            </Label>
            <textarea
              id="mineflayer-group-setup"
              className="min-h-32 rounded-md border bg-background p-3 font-mono text-sm"
              readOnly
              value={setup}
            />
            <p className="text-sm text-muted-foreground">
              Save this configuration in a private file and open it with the
              Mineflayer group runner. The code can be used once within five
              minutes.
            </p>
          </div>
        )}
        {loaded && !loadingFailed && !active && connections.length < 2 && (
          <p className="text-sm text-muted-foreground">
            Create at least two Mineflayer connections with movement enabled and
            separate memories. Use the same provider and model for every member.
          </p>
        )}
        {loaded && !loadingFailed && !active && connections.length >= 2 && (
          <form
            className="grid max-w-2xl gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!valid || !consent || busy) return;
              void change(
                {
                  action: "configure",
                  server: { host: server.host, port: Number(server.port) },
                  members,
                  ...(hasPlayer && { player }),
                  autonomous,
                  publicChat: hasPlayer && publicChat,
                  consent,
                },
                adventure && forestPolicy
                  ? { forest: forestPolicy, publicChat }
                  : undefined,
              );
            }}
          >
            <fieldset className="grid gap-2">
              <legend className="font-medium">Minecraft server</legend>
              <Label htmlFor="group-host">Host</Label>
              <Input
                id="group-host"
                value={server.host}
                onChange={(event) =>
                  setServer({ ...server, host: event.target.value })
                }
                required
              />
              <Label htmlFor="group-port">Port</Label>
              <Input
                id="group-port"
                value={server.port}
                inputMode="numeric"
                onChange={(event) =>
                  setServer({ ...server, port: event.target.value })
                }
                required
              />
            </fieldset>
            <fieldset className="grid gap-3">
              <legend className="font-medium">Group members</legend>
              <p className="text-sm text-muted-foreground">
                Choose a different memory and bot name for each member. Use the
                same provider and model.
              </p>
              {members.map((member, index) => (
                <div className="grid gap-2 sm:grid-cols-2" key={index}>
                  <div className="grid gap-2">
                    <Label htmlFor={`group-actor-${index}`}>
                      Bot name {index + 1}
                    </Label>
                    <Input
                      id={`group-actor-${index}`}
                      value={member.name}
                      required
                      maxLength={16}
                      onChange={(event) =>
                        setMembers((current) =>
                          current.map((value, i) =>
                            i === index
                              ? { ...value, name: event.target.value }
                              : value,
                          ),
                        )
                      }
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor={`group-connection-${index}`}>
                      Connection {index + 1}
                    </Label>
                    <OptionSelect
                      id={`group-connection-${index}`}
                      value={member.connectionId}
                      onValueChange={(connectionId) =>
                        setMembers((current) =>
                          current.map((value, i) =>
                            i === index ? { ...value, connectionId } : value,
                          ),
                        )
                      }
                    >
                      {connections.map((row) => (
                        <SelectItem
                          value={row.connectionId}
                          key={row.connectionId}
                        >
                          {row.character.name} · {row.model} ·{" "}
                          {row.connectionId.slice(0, 8)}
                        </SelectItem>
                      ))}
                    </OptionSelect>
                  </div>
                </div>
              ))}
              <Button
                variant="outline"
                type="button"
                className="justify-self-start"
                disabled={connections.length < 3}
                onClick={() =>
                  setMembers(
                    members.length === 2
                      ? [...members, blank()]
                      : members.slice(0, 2),
                  )
                }
              >
                {members.length === 2
                  ? "Add a third member"
                  : "Remove third member"}
              </Button>
            </fieldset>
            <fieldset className="grid gap-2">
              <legend className="font-medium">
                Player access and movement
              </legend>
              <Label htmlFor="group-player">Approved player name</Label>
              <Input
                id="group-player"
                value={player.name}
                onChange={(event) =>
                  setPlayer({ ...player, name: event.target.value })
                }
                maxLength={16}
              />
              <Label htmlFor="group-player-uuid">Approved player UUID</Label>
              <Input
                id="group-player-uuid"
                value={player.uuid}
                onChange={(event) =>
                  setPlayer({ ...player, uuid: event.target.value })
                }
                maxLength={36}
              />
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={autonomous}
                  onChange={(event) => setAutonomous(event.target.checked)}
                />
                <span>
                  Allow up to three short surveys while the approved player is
                  away. Leave player fields blank to disable group dialogue.
                </span>
              </label>
              <label className="flex min-h-11 items-start gap-2">
                <input
                  type="checkbox"
                  checked={publicChat}
                  disabled={!hasPlayer}
                  onChange={(event) => setPublicChat(event.target.checked)}
                />
                <span>
                  Let these characters respond to the approved player in this
                  server’s public chat.
                </span>
              </label>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(event) => setConsent(event.target.checked)}
                />
                <span>
                  I trust this server and approve separate survey assignments
                  for these members.
                </span>
              </label>
            </fieldset>
            <fieldset className="grid gap-3">
              <legend className="font-medium">Forest adventure</legend>
              <label className="flex min-h-11 items-center gap-2">
                <input
                  type="checkbox"
                  checked={adventure}
                  onChange={(event) => setAdventure(event.target.checked)}
                />
                <span>Enable gathering and return for three characters</span>
              </label>
              {adventure && (
                <>
                  <p className="text-sm text-muted-foreground">
                    Select three members and an approved player. Enter block
                    coordinates as X Y Z. The harvest area must fit inside the
                    travel area, which spans at most 48 blocks per axis.
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {regionFields.map(([key, label]) => (
                      <div key={key} className="grid gap-2">
                        <Label htmlFor={`forest-${key}`}>{label}</Label>
                        <Input
                          id={`forest-${key}`}
                          value={forest[key]}
                          maxLength={30}
                          onChange={(event) =>
                            setForest({ ...forest, [key]: event.target.value })
                          }
                        />
                      </div>
                    ))}
                    <div className="grid gap-2">
                      <Label htmlFor="adventure-dimension">Dimension</Label>
                      <Input
                        id="adventure-dimension"
                        value={forest.dimension}
                        maxLength={64}
                        onChange={(event) =>
                          setForest({
                            ...forest,
                            dimension: event.target.value,
                          })
                        }
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="adventure-resources">Log types</Label>
                      <Input
                        id="adventure-resources"
                        value={forest.resources}
                        maxLength={120}
                        onChange={(event) =>
                          setForest({
                            ...forest,
                            resources: event.target.value,
                          })
                        }
                      />
                    </div>
                  </div>
                  {!forestPolicy && (
                    <p className="text-sm text-muted-foreground">
                      Fill in the four corners and enter log IDs such as oak_log
                      or spruce_log.
                    </p>
                  )}
                </>
              )}
            </fieldset>
            <Button
              className="justify-self-start"
              type="submit"
              disabled={!valid || !consent || busy}
            >
              {busy ? "Creating group…" : "Create group host configuration"}
            </Button>
          </form>
        )}
        {message && <p role="status">{message}</p>}
        <AdventureHistory />
      </CardContent>
    </Card>
  );
}
