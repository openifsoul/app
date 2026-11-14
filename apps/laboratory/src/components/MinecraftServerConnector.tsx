import { desktopBridge } from "../lib/desktop";
import { useEffect, useState } from "react";
import {
  minecraftConnectors,
  validMinecraftTarget,
  type MinecraftTarget,
} from "../../../shared/src/minecraft-connectors";
import type { ProviderOption } from "../lib/api";
import {
  createGameConnection,
  readGameConnections,
  readOwnedCharacters,
  revokeGameConnection,
  type CharacterSummary,
  type GameBinding,
  type GameGrant,
  type GamePairRequest,
} from "../lib/game-connections-api";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { OptionSelect, SelectItem } from "./ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table";

type Connector = MinecraftTarget["connector"];

export function MinecraftServerConnector({
  connector,
  providers,
}: {
  connector: Connector;
  providers: ProviderOption[];
}) {
  const profile = minecraftConnectors[connector];
  const [characters, setCharacters] = useState<CharacterSummary[]>([]);
  const [connections, setConnections] = useState<GameBinding[]>([]);
  const [character, setCharacter] = useState("");
  const [memory, setMemory] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [playerId, setPlayerId] = useState("");
  const [npcId, setNpcId] = useState("");
  const [approved, setApproved] = useState(false);
  const [grant, setGrant] = useState<GameGrant>();
  const [renewal, setRenewal] = useState<string>();
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [installed, setInstalled] = useState(false);
  const desktop = desktopBridge();
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const target = {
    connector,
    playerId: playerId.trim().toLowerCase(),
    npcId: npcId.trim().toLowerCase(),
  };
  const models =
    providers.find((item) => item.id === provider && item.available)?.models ??
    [];

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      readOwnedCharacters(controller.signal),
      readGameConnections(controller.signal),
    ])
      .then(([owned, result]) => {
        if (controller.signal.aborted) return;
        setCharacters(owned);
        setConnections(
          result.connections.filter(
            (row) => row.minecraftTarget?.connector === connector,
          ),
        );
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError(
            "Open your App workspace and try loading connections again.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [connector, reload]);

  async function install() {
    if (!desktop) return;
    setWorking(true);
    setError("");
    try {
      const result = await desktop.installServerBridge(connector);
      if (result.status === "installed") setInstalled(true);
      if (result.status === "unavailable")
        setError(
          "Could not install the bridge. Check the JAR, server folder and whether the bridge is already installed.",
        );
    } catch {
      setError("Could not open the installer. Try again.");
    } finally {
      setWorking(false);
    }
  }

  async function pair() {
    setError("");
    setWorking(true);
    try {
      const created = await createGameConnection({
        characterId: character,
        memoryId: memory,
        consent: approved,
        provider: provider as GamePairRequest["provider"],
        model,
        minecraftTarget: target,
        ...(renewal ? { connectionId: renewal } : {}),
      });
      setGrant(created);
      setRenewal(undefined);
      setReload((value) => value + 1);
    } catch {
      setError(
        "Could not issue a code. Check your character, provider and server details, then try again.",
      );
    } finally {
      setWorking(false);
    }
  }

  async function revoke(connection: GameBinding) {
    setError("");
    setWorking(true);
    try {
      await revokeGameConnection(connection.connectionId);
      if (grant?.connection.connectionId === connection.connectionId)
        setGrant(undefined);
      setReload((value) => value + 1);
    } catch {
      setError("Could not revoke the connection. Retry to stop access.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{profile.label}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <p className="text-sm">
          Minecraft {profile.version} · {profile.loader} · Java {profile.java} ·{" "}
          {profile.label} {profile.upstream}
        </p>
        <p className="text-sm text-muted-foreground">
          Ask the server operator to install the matching IfSoul bridge and its
          required mod. Native compatibility is still being tested.
        </p>
        {desktop && (
          <div className="grid justify-items-start gap-2">
            <Button
              variant="outline"
              disabled={working}
              onClick={() => void install()}
            >
              Install from local JAR
            </Button>
            {installed && (
              <p role="status">Bridge JAR installed in the selected folder.</p>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {loading ? (
          <p role="status">Loading characters and connections…</p>
        ) : characters.length === 0 ? (
          <Button
            className="justify-self-start"
            variant="outline"
            onClick={() => {
              setLoading(true);
              setReload((value) => value + 1);
            }}
          >
            Reload characters
          </Button>
        ) : (
          <div className="app-field-row grid gap-4 sm:grid-cols-2">
            <div className="app-form-field grid gap-2">
              <Label htmlFor="server-connector-character">
                Character profile *
              </Label>
              <OptionSelect
                id="server-connector-character"
                value={character}
                onValueChange={setCharacter}
              >
                {characters.map((item) => (
                  <SelectItem key={item.characterId} value={item.characterId}>
                    {item.name}
                  </SelectItem>
                ))}
              </OptionSelect>
            </div>
            <div className="app-form-field grid gap-2">
              <Label htmlFor="server-connector-memory">Owned memory *</Label>
              <OptionSelect
                id="server-connector-memory"
                value={memory}
                onValueChange={setMemory}
              >
                {characters.map((item) => (
                  <SelectItem key={item.characterId} value={item.characterId}>
                    {item.name}
                  </SelectItem>
                ))}
              </OptionSelect>
            </div>
            <div className="app-form-field grid gap-2">
              <Label htmlFor="server-connector-provider">
                Available provider *
              </Label>
              <OptionSelect
                id="server-connector-provider"
                value={provider}
                onValueChange={(value) => {
                  setProvider(value);
                  setModel("");
                }}
              >
                {providers
                  .filter((item) => item.available)
                  .map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.label}
                    </SelectItem>
                  ))}
              </OptionSelect>
            </div>
            <div className="app-form-field grid gap-2">
              <Label htmlFor="server-connector-model">Model *</Label>
              <OptionSelect
                id="server-connector-model"
                value={model}
                onValueChange={setModel}
              >
                {models.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.label}
                  </SelectItem>
                ))}
              </OptionSelect>
            </div>
            <div className="app-form-field grid gap-2">
              <Label htmlFor="server-connector-player">Player UUID *</Label>
              <Input
                id="server-connector-player"
                value={playerId}
                maxLength={36}
                onChange={(event) => setPlayerId(event.target.value)}
              />
            </div>
            <div className="app-form-field grid gap-2">
              <Label htmlFor="server-connector-npc">
                {connector === "minecraft-minecolonies"
                  ? "Dimension / colony ID / citizen ID *"
                  : "NPC UUID *"}
              </Label>
              <Input
                id="server-connector-npc"
                value={npcId}
                maxLength={128}
                onChange={(event) => setNpcId(event.target.value)}
              />
            </div>
          </div>
        )}
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={approved}
            onChange={(event) => setApproved(event.target.checked)}
          />
          I approve private dialogue for this player and NPC.
        </label>
        <Button
          className="justify-self-start"
          disabled={
            working ||
            loading ||
            !character ||
            !memory ||
            !model ||
            !approved ||
            !validMinecraftTarget(target)
          }
          onClick={() => void pair()}
        >
          {working
            ? "Working…"
            : renewal
              ? "Renew pairing code"
              : "Issue pairing code"}
        </Button>
        {grant && (
          <div role="status" className="grid gap-2 text-sm">
            <Label htmlFor="server-connector-code">
              One-use server pairing code
            </Label>
            <Input id="server-connector-code" value={grant.code} readOnly />
            <p>
              Enter this code into the selected bridge’s server configuration
              within five minutes.
            </p>
          </div>
        )}
        {connections.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Character</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {connections.map((connection) => (
                <TableRow key={connection.connectionId}>
                  <TableCell>{connection.character.name}</TableCell>
                  <TableCell>
                    {connection.revoked
                      ? "Revoked"
                      : connection.expiresAt <= Date.now()
                        ? "Expired"
                        : connection.player
                          ? "Bridge handshake received"
                          : "Waiting for bridge handshake"}
                  </TableCell>
                  <TableCell className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={working}
                      onClick={() => {
                        setRenewal(connection.connectionId);
                        setPlayerId(connection.minecraftTarget!.playerId);
                        setNpcId(connection.minecraftTarget!.npcId);
                        setCharacter(connection.characterId);
                        setMemory(connection.memoryId);
                        setProvider(connection.provider);
                        setModel(connection.model);
                        setApproved(false);
                      }}
                    >
                      Renew
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={working || connection.revoked}
                      onClick={() => void revoke(connection)}
                    >
                      Revoke
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <Button
          className="justify-self-start"
          variant="ghost"
          disabled={working || loading}
          onClick={() => {
            setLoading(true);
            setReload((value) => value + 1);
          }}
        >
          Refresh connection status
        </Button>
      </CardContent>
    </Card>
  );
}
