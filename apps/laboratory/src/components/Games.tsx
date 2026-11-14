import { useState } from "react";
import { useWorkspaceBreadcrumbs } from "../lib/workspace-breadcrumbs";
import { ArrowLeft, ArrowRight, Gamepad2, Search } from "lucide-react";
import type { ProviderOption } from "../lib/api";
import { minecraftConnectors } from "../../../shared/src/minecraft-connectors";
import { MinecraftServerConnector } from "./MinecraftServerConnector";
import { OptionSelect, SelectItem } from "./ui/select";
import { GameConnectionSettings } from "./GameConnectionSettings";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export function Games({
  providers,
  selectedProvider,
  selectedModel,
}: {
  providers: ProviderOption[];
  selectedProvider: string;
  selectedModel: string;
}) {
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState(false);
  const [visited, setVisited] = useState(false);
  const [runtime, setRuntime] = useState("Vanilla 1.20.2");
  const [connector, setConnector] = useState<keyof typeof minecraftConnectors>(
    "minecraft-mineflayer",
  );
  const profiles = Object.entries(minecraftConnectors);
  const runtimes = [
    ...new Set(
      profiles.map(([, profile]) => `${profile.loader} ${profile.version}`),
    ),
  ];
  const matchesRuntime = profiles.filter(
    ([, profile]) => `${profile.loader} ${profile.version}` === runtime,
  );
  useWorkspaceBreadcrumbs("games", detail ? [{ label: "Minecraft" }] : [], () =>
    setDetail(false),
  );
  const matches =
    "Minecraft Java Mineflayer Citizens Easy NPC MineColonies CustomNPCs"
      .toLowerCase()
      .includes(query.trim().toLowerCase());
  return (
    <div className="games-workspace">
      <section
        hidden={detail}
        aria-label="Available games"
        className="grid gap-6"
      >
        <div className="grid max-w-sm gap-2">
          <Label htmlFor="games-search">Find a game</Label>
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              id="games-search"
              className="pl-9"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search games…"
            />
          </div>
        </div>
        {matches ? (
          <div className="games-grid">
            <Card className="game-catalog-card">
              <CardContent className="grid gap-4">
                <Gamepad2 aria-hidden="true" className="game-icon size-16" />
                <div className="grid gap-2">
                  <h2 className="text-lg font-medium">Minecraft</h2>
                  <p className="text-sm text-muted-foreground">
                    Connect a character to your Minecraft Java server through
                    the local companion.
                  </p>
                </div>
                <Button
                  variant="outline"
                  className="justify-between"
                  onClick={() => {
                    setVisited(true);
                    setDetail(true);
                  }}
                >
                  Configure Minecraft <ArrowRight aria-hidden="true" />
                </Button>
              </CardContent>
            </Card>
          </div>
        ) : (
          <div role="status" className="grid justify-items-start gap-3 py-6">
            <p className="text-sm text-muted-foreground">
              No games match your search.
            </p>
            <Button variant="outline" onClick={() => setQuery("")}>
              Clear search
            </Button>
          </div>
        )}
      </section>
      <section
        hidden={!detail}
        aria-label="Minecraft settings"
        className="grid gap-5"
      >
        <Button
          variant="ghost"
          className="justify-self-start"
          onClick={() => setDetail(false)}
        >
          <ArrowLeft aria-hidden="true" />
          Back to games
        </Button>
        <div className="app-field-row grid gap-4 sm:grid-cols-2">
          <div className="app-form-field grid gap-2">
            <Label htmlFor="minecraft-runtime">
              Server software and Minecraft version
            </Label>
            <OptionSelect
              id="minecraft-runtime"
              value={runtime}
              onValueChange={(value) => {
                setRuntime(value);
                const match = profiles.find(
                  ([, profile]) =>
                    `${profile.loader} ${profile.version}` === value,
                );
                if (match)
                  setConnector(match[0] as keyof typeof minecraftConnectors);
              }}
            >
              {runtimes.map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </OptionSelect>
          </div>
          <div className="app-form-field grid gap-2">
            <Label htmlFor="minecraft-connector">Bridge</Label>
            <OptionSelect
              id="minecraft-connector"
              value={connector}
              onValueChange={(value) =>
                setConnector(value as keyof typeof minecraftConnectors)
              }
            >
              {matchesRuntime.map(([id, profile]) => (
                <SelectItem key={id} value={id}>
                  {profile.label}
                </SelectItem>
              ))}
            </OptionSelect>
          </div>
        </div>
        {visited && connector === "minecraft-mineflayer" && (
          <GameConnectionSettings
            providers={providers}
            selectedProvider={selectedProvider}
            selectedModel={selectedModel}
          />
        )}
        {visited && connector !== "minecraft-mineflayer" && (
          <MinecraftServerConnector
            key={connector}
            connector={connector}
            providers={providers}
          />
        )}
      </section>
    </div>
  );
}
