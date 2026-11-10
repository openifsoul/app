import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import { useWorkspaceBreadcrumbs } from "../lib/workspace-breadcrumbs";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TableCaption,
} from "./ui/table";
import { OptionSelect, SelectItem } from "./ui/select";
import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type {
  BehaviorGoal,
  BehaviorOverride,
  BehaviorPermission,
  BehaviorPermissions,
  ParameterDefinition,
} from "@ifsoul/core/runtime";
import {
  readBehavior,
  saveBehavior,
  readBehaviorState,
  behaviorError,
  type BehaviorConfiguration,
  type BehaviorEditorSnapshot,
  type BehaviorInspection,
} from "../lib/behavior-api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "./ui/card";
import { Badge } from "./ui/badge";
import { LoaderCircle, Plus, RefreshCw, Save, Undo2, X } from "lucide-react";
const permissionLabels: Record<BehaviorPermission, string> = {
  observe: "Observe",
  remember: "Remember",
  updateRelationship: "Update relationships",
  speak: "Speak",
  requestAction: "Request actions",
};
const permissions = Object.keys(permissionLabels) as BehaviorPermission[];
const controlClass =
  "min-h-11 w-full rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-60";
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  const controlId = useId();
  return (
    <div className="grid min-w-0 gap-2 text-sm">
      <Label htmlFor={controlId}>{label}</Label>
      {isValidElement(children)
        ? cloneElement(
            children as React.ReactElement<{
              id?: string;
              "aria-describedby"?: string;
            }>,
            {
              id: controlId,
              ...(hint ? { "aria-describedby": `${controlId}-hint` } : {}),
            },
          )
        : children}
      {hint && (
        <span
          id={`${controlId}-hint`}
          className="text-xs text-muted-foreground"
        >
          {hint}
        </span>
      )}
    </div>
  );
}
function Numeric({
  label,
  value,
  onChange,
  disabled,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  min?: number;
  max?: number;
}) {
  return (
    <Field label={label}>
      <Input
        className="min-h-11"
        type="number"
        step="any"
        min={min}
        max={max}
        value={Number.isFinite(value) ? value : ""}
        disabled={disabled}
        onChange={(event) =>
          onChange(
            event.currentTarget.value === ""
              ? NaN
              : Number(event.currentTarget.value),
          )
        }
      />
    </Field>
  );
}
function Goals({
  goals,
  onChange,
  disabled,
  prefix,
}: {
  goals: BehaviorGoal[];
  onChange: (goals: BehaviorGoal[]) => void;
  disabled: boolean;
  prefix: string;
}) {
  return (
    <div className="grid gap-4">
      {goals.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No goals configured here. Add an objective when this scope should
          guide planning.
        </p>
      )}
      {goals.map((goal, index) => (
        <div
          key={`${prefix}-${index}`}
          className="grid gap-3 rounded-lg border p-4"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Goal ID *">
              <Input
                className="min-h-11"
                value={goal.goalId}
                disabled={disabled}
                onChange={(e) =>
                  onChange(
                    goals.map((g, i) =>
                      i === index ? { ...g, goalId: e.target.value } : g,
                    ),
                  )
                }
              />
            </Field>
            <Numeric
              label="Priority (0–100)"
              value={goal.priority}
              min={0}
              max={100}
              disabled={disabled}
              onChange={(priority) =>
                onChange(
                  goals.map((g, i) => (i === index ? { ...g, priority } : g)),
                )
              }
            />
          </div>
          <Field label="Objective *">
            <Input
              className="min-h-11"
              maxLength={512}
              value={goal.objective}
              disabled={disabled}
              onChange={(e) =>
                onChange(
                  goals.map((g, i) =>
                    i === index ? { ...g, objective: e.target.value } : g,
                  ),
                )
              }
            />
          </Field>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex min-h-11 items-center gap-3 text-sm">
              <input
                type="checkbox"
                checked={goal.enabled}
                disabled={disabled}
                onChange={(e) =>
                  onChange(
                    goals.map((g, i) =>
                      i === index ? { ...g, enabled: e.target.checked } : g,
                    ),
                  )
                }
              />
              Enabled
            </label>
            <Button
              type="button"
              variant="ghost"
              disabled={disabled}
              onClick={() => onChange(goals.filter((_, i) => i !== index))}
            >
              Remove goal
            </Button>
          </div>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        className="min-h-11 justify-self-start"
        disabled={disabled || goals.length >= 16}
        onClick={() =>
          onChange([
            ...goals,
            {
              goalId: `goal-${goals.length + 1}`,
              objective: "",
              priority: 50,
              enabled: true,
            },
          ])
        }
      >
        <Plus />
        Add goal
      </Button>
    </div>
  );
}
function Policy({
  value,
  onChange,
  disabled,
  denied,
  partial = false,
}: {
  value: {
    general?: Partial<BehaviorPermissions>;
    provocation?: Partial<BehaviorPermissions>;
  };
  onChange: (next: typeof value) => void;
  disabled: boolean;
  denied: BehaviorPermission[];
  partial?: boolean;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {(["general", "provocation"] as const).map((category) => (
        <fieldset
          key={category}
          className="behavior-policy-group grid gap-2 rounded-lg border p-4"
        >
          <legend className="px-1 text-sm font-medium">
            {category === "general"
              ? "General reactions"
              : "Provocation reactions"}
          </legend>
          {permissions.map((flag) => (
            <label
              key={flag}
              className="flex min-h-11 items-center justify-between gap-3 text-sm"
            >
              <span>
                {permissionLabels[flag]}
                {denied.includes(flag) && (
                  <small className="ml-2 text-muted-foreground">
                    Operator locked
                  </small>
                )}
              </span>
              {partial ? (
                <OptionSelect
                  aria-label={`${category} ${permissionLabels[flag]} override`}
                  className={`${controlClass} max-w-36`}
                  value={
                    value[category]?.[flag] === undefined
                      ? "inherit"
                      : String(value[category]![flag])
                  }
                  disabled={disabled || denied.includes(flag)}
                  onValueChange={(selectedValue) => {
                    const next = {
                      ...value,
                      [category]: { ...value[category] },
                    };
                    if (selectedValue === "inherit")
                      delete next[category]![flag];
                    else next[category]![flag] = selectedValue === "true";
                    onChange(next);
                  }}
                >
                  <SelectItem value="inherit">Inherit</SelectItem>
                  <SelectItem value="true">Allow</SelectItem>
                  <SelectItem value="false">Deny</SelectItem>
                </OptionSelect>
              ) : (
                <input
                  aria-label={`${category} ${permissionLabels[flag]}`}
                  className="size-5"
                  type="checkbox"
                  checked={
                    denied.includes(flag)
                      ? false
                      : Boolean(value[category]?.[flag])
                  }
                  disabled={disabled || denied.includes(flag)}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      [category]: {
                        ...value[category],
                        [flag]: e.target.checked,
                      },
                    })
                  }
                />
              )}
            </label>
          ))}
        </fieldset>
      ))}
    </div>
  );
}
function validDraft(config: BehaviorConfiguration): string | null {
  const seen = new Set<string>();
  for (const p of config.parameters) {
    if (
      !identifier.test(p.parameterId) ||
      seen.has(p.parameterId) ||
      !p.label.trim()
    )
      return "Give every parameter a unique ID and label.";
    seen.add(p.parameterId);
    if (
      ![p.initial, p.min, p.max, p.maxDelta].every(Number.isFinite) ||
      p.min >= p.max ||
      p.initial < p.min ||
      p.initial > p.max ||
      p.maxDelta <= 0 ||
      p.maxDelta > p.max - p.min
    )
      return `Check the initial value, range and maximum change for ${p.label}.`;
    if (
      p.decay &&
      (!Number.isFinite(p.decay.perHour) ||
        p.decay.perHour <= 0 ||
        !Number.isFinite(p.decay.toward) ||
        p.decay.toward < p.min ||
        p.decay.toward > p.max)
    )
      return `Check the decay rate and target for ${p.label}.`;
    if (p.kind === "trait" && (p.scope !== "portable" || p.decay))
      return "Stable traits must be portable and cannot decay.";
  }
  for (const goals of [
    config.defaults.goals,
    ...config.overrides.flatMap((o) => (o.goals ? [o.goals] : [])),
  ]) {
    const ids = new Set<string>();
    for (const g of goals) {
      if (
        !identifier.test(g.goalId) ||
        ids.has(g.goalId) ||
        !g.objective.trim() ||
        !Number.isInteger(g.priority) ||
        g.priority < 0 ||
        g.priority > 100
      )
        return "Give every goal a unique ID, objective and priority from 0 to 100.";
      ids.add(g.goalId);
    }
  }
  const scopes = new Set<string>();
  for (const o of config.overrides) {
    const key = `${o.scope.kind}:${o.scope.id}`;
    if (!o.scope.id || scopes.has(key))
      return "Choose a unique target for each scoped override.";
    scopes.add(key);
    for (const [id, value] of Object.entries(o.initialValues ?? {})) {
      const p = config.parameters.find((p) => p.parameterId === id);
      if (!p || !Number.isFinite(value) || value < p.min || value > p.max)
        return "Keep scoped initial values within their parameter ranges.";
    }
  }
  return config.parameters.length
    ? null
    : "Keep at least one parameter definition.";
}
export function BehaviorSettings({
  active,
  characterId,
}: {
  active: boolean;
  characterId?: string;
}) {
  const [snapshot, setSnapshot] = useState<BehaviorEditorSnapshot | null>(null),
    [draft, setDraft] = useState<BehaviorConfiguration | null>(null),
    [loading, setLoading] = useState(false),
    [saving, setSaving] = useState(false),
    [failure, setFailure] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null),
    [undo, setUndo] = useState<BehaviorConfiguration | null>(null);
  const [sessionId, setSessionId] = useState(""),
    [npcId, setNpcId] = useState(""),
    [inspection, setInspection] = useState<BehaviorInspection | null>(null),
    [stateLoading, setStateLoading] = useState(false),
    [stateFailure, setStateFailure] = useState<string | null>(null);
  const [stateRefresh, setStateRefresh] = useState(0);
  const [editingParameter, setEditingParameter] = useState<number | null>(null);
  const [panel, setPanel] = useState("parameters");
  const panelNames: Record<string, string> = {
    parameters: "Parameters",
    reactions: "Reactions",
    goals: "Goals",
    overrides: "Overrides",
    state: "State & history",
  };
  const selectedParameter =
    panel === "parameters" && editingParameter !== null
      ? draft?.parameters[editingParameter]
      : undefined;
  const inspectedNpc =
    panel === "state" && npcId
      ? snapshot?.catalog.npcs.find((npc) => npc.npcId === npcId)
      : undefined;
  useWorkspaceBreadcrumbs(
    "behavior",
    !draft
      ? []
      : [
          {
            label: panelNames[panel],
            onNavigate: selectedParameter
              ? () => setEditingParameter(null)
              : inspectedNpc
                ? () => setNpcId("")
                : undefined,
          },
          ...(selectedParameter
            ? [{ label: selectedParameter.label || "New parameter" }]
            : inspectedNpc
              ? [{ label: inspectedNpc.label }]
              : []),
        ],
    () => {
      setPanel("parameters");
      setEditingParameter(null);
    },
    saving || loading,
  );
  const loadController = useRef<AbortController | null>(null);
  const loadedCharacter = useRef<string | undefined>(undefined),
    loaded = useRef(false),
    instance = useId();
  const dirty = Boolean(
    snapshot &&
    draft &&
    JSON.stringify(snapshot.config) !== JSON.stringify(draft),
  );
  const editable = Boolean(snapshot?.operator.canEditConfig && !saving);
  async function load(discard = false) {
    if (loading || saving) return;
    if (dirty && !discard) {
      setNotice(
        "Your unsaved draft is preserved. Save it or discard it before reloading.",
      );
      return;
    }
    setLoading(true);
    setFailure(null);
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    try {
      const next = await readBehavior(characterId, controller.signal);
      if (controller.signal.aborted) return;
      setSnapshot(next);
      setDraft(structuredClone(next.config));
      setEditingParameter(null);
      setUndo(null);
      loaded.current = true;
      loadedCharacter.current = characterId;
      setNotice(null);
    } catch (error) {
      if (!controller.signal.aborted) setFailure(behaviorError(error));
    } finally {
      if (loadController.current === controller) setLoading(false);
    }
  }
  useEffect(() => () => loadController.current?.abort(), []);
  useEffect(() => {
    if (
      active &&
      (!loaded.current || loadedCharacter.current !== characterId) &&
      !dirty
    )
      void load();
  }, [active, characterId, dirty]);
  useEffect(() => {
    if (!active || !sessionId || !npcId) {
      setStateLoading(false);
      return;
    }
    const controller = new AbortController();
    setStateLoading(true);
    setStateFailure(null);
    void readBehaviorState(sessionId, npcId, controller.signal)
      .then(
        (value) => {
          if (!controller.signal.aborted) setInspection(value);
        },
        (error) => {
          if (!controller.signal.aborted) setStateFailure(behaviorError(error));
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setStateLoading(false);
      });
    return () => controller.abort();
  }, [active, sessionId, npcId, snapshot?.config.revision, stateRefresh]);
  function change(update: (config: BehaviorConfiguration) => void) {
    setDraft((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      update(next);
      return next;
    });
    setNotice(null);
  }
  function remove(update: (config: BehaviorConfiguration) => void) {
    if (draft) setUndo(structuredClone(draft));
    change(update);
  }
  async function save() {
    if (!snapshot || !draft || saving) return;
    setSaving(true);
    setFailure(null);
    setNotice(null);
    try {
      const next = await saveBehavior(draft, snapshot.config.revision);
      setSnapshot(next);
      setDraft(structuredClone(next.config));
      setUndo(null);
      setNotice(
        "Behavior configuration saved. New reactions use this revision; memory and state history are preserved.",
      );
    } catch (error) {
      setFailure(behaviorError(error));
    } finally {
      setSaving(false);
    }
  }
  if (!snapshot || !draft)
    return (
      <Card>
        <CardHeader>
          <CardTitle>Behavior configuration</CardTitle>
          <CardDescription>
            Set goals, bounded character parameters and independent reaction
            permissions.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {loading ? (
            <p role="status" className="flex items-center gap-2">
              <LoaderCircle className="size-4 animate-spin" />
              Loading behavior configuration…
            </p>
          ) : (
            <>
              <p role={failure ? "alert" : undefined}>
                {failure ??
                  "Open this section to load the runtime’s behavior configuration."}
              </p>
              <Button
                variant="outline"
                className="min-h-11 justify-self-start"
                onClick={() => void load()}
              >
                <RefreshCw />
                Retry
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    );
  const validation = validDraft(draft),
    locked = snapshot.operator;
  const availableNpcs =
    snapshot.catalog.sessions.find((s) => s.sessionId === sessionId)?.npcIds ??
    [];
  return (
    <div className="behavior-workspace">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>Shared behavior configuration</CardTitle>
            <Badge variant="outline">Revision {snapshot.config.revision}</Badge>
          </div>
          <CardDescription>
            One shared configuration for this workspace. Use scoped overrides
            for a world, group or NPC; each memory keeps its own state.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {!locked.canEditConfig && (
            <p className="text-sm text-muted-foreground">
              This runtime allows inspection only. Editing is restricted by the
              host.
            </p>
          )}
          {failure && (
            <p role="alert" className="feedback error">
              {failure}
            </p>
          )}
          {notice && (
            <p role="status" className="feedback notice">
              {notice}
            </p>
          )}
          {validation && dirty && (
            <p role="alert" className="text-sm">
              {validation}
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            <Button
              className="min-h-11"
              disabled={!editable || !dirty || Boolean(validation)}
              onClick={() => void save()}
            >
              {saving ? <LoaderCircle className="animate-spin" /> : <Save />}
              {saving ? "Saving…" : "Save configuration"}
            </Button>
            <Button
              variant="outline"
              className="min-h-11"
              disabled={saving || loading}
              onClick={() => {
                if (dirty) {
                  if (
                    window.confirm(
                      "Discard your unsaved behavior changes and reload the saved version?",
                    )
                  )
                    void load(true);
                } else void load();
              }}
            >
              <RefreshCw className={loading ? "animate-spin" : ""} />
              Reload saved
            </Button>
            {undo && (
              <Button
                variant="ghost"
                className="min-h-11"
                disabled={!editable}
                onClick={() => {
                  setDraft(undo);
                  setUndo(null);
                }}
              >
                <Undo2 />
                Undo removal
              </Button>
            )}
            {dirty && (
              <span className="self-center text-sm text-muted-foreground">
                Unsaved changes
              </span>
            )}
          </div>
        </CardContent>
      </Card>
      <Tabs
        value={panel}
        onValueChange={setPanel}
        className="behavior-sections"
      >
        <TabsList
          aria-label="Behavior sections"
          className="w-full justify-start"
        >
          <TabsTrigger value="parameters">Parameters</TabsTrigger>
          <TabsTrigger value="reactions">Reactions</TabsTrigger>
          <TabsTrigger value="goals">Goals</TabsTrigger>
          <TabsTrigger value="overrides">Overrides</TabsTrigger>
          <TabsTrigger value="state">State & history</TabsTrigger>
        </TabsList>
        <TabsContent value="reactions">
          <Card>
            <CardHeader>
              <CardTitle>Reaction policy</CardTitle>
              <CardDescription>
                Observation, memory, relationship updates, speech and action
                requests are separate permissions.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Policy
                value={draft.defaults.policy}
                disabled={!editable || locked.lockedPolicy}
                denied={locked.deniedPermissions}
                onChange={(value) =>
                  change((c) => {
                    c.defaults.policy = value as typeof c.defaults.policy;
                  })
                }
              />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="goals">
          <Card>
            <CardHeader>
              <CardTitle>Goals</CardTitle>
              <CardDescription>
                Goals guide planning. They do not add host capabilities or
                execute actions.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Goals
                goals={draft.defaults.goals}
                prefix={instance}
                disabled={!editable || locked.lockedGoals}
                onChange={(goals) =>
                  change((c) => {
                    c.defaults.goals = goals;
                  })
                }
              />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="parameters">
          <Card>
            <CardHeader>
              <CardTitle>Parameter definitions</CardTitle>
              <CardDescription>
                Stable traits, transient state and directed relationships have
                separate roles. Initial values affect new state; configuration
                edits do not reset memory.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5">
              <div className="flex justify-end">
                <Button
                  variant="outline"
                  className="min-h-11 justify-self-start"
                  disabled={!editable}
                  onClick={() => {
                    setEditingParameter(draft.parameters.length);
                    change((c) => {
                      c.parameters.push({
                        parameterId: `parameter-${c.parameters.length + 1}`,
                        label: "New parameter",
                        kind: "state",
                        scope: "world",
                        initial: 0,
                        min: 0,
                        max: 1,
                        maxDelta: 0.1,
                      });
                    });
                  }}
                >
                  <Plus />
                  Add parameter
                </Button>
              </div>
              <Table aria-label="Behavior parameters">
                <TableCaption>
                  Select a parameter to edit its bounds and behavior.
                </TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Parameter</TableHead>
                    <TableHead scope="col">Kind</TableHead>
                    <TableHead scope="col">Scope</TableHead>
                    <TableHead scope="col">Range</TableHead>
                    <TableHead scope="col">Initial</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {!draft.parameters.length && (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="py-6 text-center text-muted-foreground"
                      >
                        No parameters yet. Add a parameter to define character
                        behavior.
                      </TableCell>
                    </TableRow>
                  )}
                  {draft.parameters.map((parameter, index) => (
                    <TableRow
                      key={`${instance}-parameter-row-${index}`}
                      className="character-table-row"
                      data-state={
                        editingParameter === index ? "selected" : undefined
                      }
                      onClick={() => setEditingParameter(index)}
                    >
                      <TableCell>
                        <Button
                          variant="link"
                          className="character-row-name"
                          onClick={(event) => {
                            event.stopPropagation();
                            setEditingParameter(index);
                          }}
                          aria-label={`Edit ${parameter.label || "new parameter"}`}
                        >
                          {parameter.label || "New parameter"}
                        </Button>
                        {locked.lockedParameterIds.includes(
                          parameter.parameterId,
                        ) && <Badge variant="outline">Locked</Badge>}
                      </TableCell>
                      <TableCell>
                        {parameter.kind === "trait"
                          ? "Stable trait"
                          : parameter.kind === "state"
                            ? "Transient state"
                            : "Relationship"}
                      </TableCell>
                      <TableCell>
                        {parameter.scope === "world"
                          ? "Per world"
                          : "Across worlds"}
                      </TableCell>
                      <TableCell>
                        {parameter.min}–{parameter.max}
                      </TableCell>
                      <TableCell>{parameter.initial}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {editingParameter !== null && (
                <div className="flex justify-end">
                  <Button
                    variant="ghost"
                    onClick={() => setEditingParameter(null)}
                  >
                    Close parameter
                  </Button>
                </div>
              )}
              {draft.parameters.map((p, index) => {
                if (index !== editingParameter) return null;
                const disabled =
                  !editable ||
                  locked.lockedParameterIds.includes(p.parameterId);
                const set = (patch: Partial<ParameterDefinition>) =>
                  change((c) => {
                    c.parameters[index] = { ...c.parameters[index], ...patch };
                  });
                return (
                  <fieldset
                    key={`${instance}-parameter-${index}`}
                    disabled={disabled}
                    className="grid gap-4 rounded-lg border p-4"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="min-w-0 break-words font-medium">
                        {p.label || "New parameter"}
                      </h3>
                      {disabled && <Badge variant="outline">Locked</Badge>}
                      <Button
                        type="button"
                        variant="ghost"
                        className="min-h-11"
                        disabled={disabled}
                        onClick={() => {
                          remove((c) => {
                            c.parameters.splice(index, 1);
                          });
                          setEditingParameter(null);
                        }}
                      >
                        <X />
                        Remove
                      </Button>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label="Parameter ID *">
                        <Input
                          className="min-h-11"
                          value={p.parameterId}
                          onChange={(e) => set({ parameterId: e.target.value })}
                        />
                      </Field>
                      <Field label="Label *">
                        <Input
                          className="min-h-11"
                          maxLength={80}
                          value={p.label}
                          onChange={(e) => set({ label: e.target.value })}
                        />
                      </Field>
                      <Field label="Kind">
                        <OptionSelect
                          className={controlClass}
                          value={p.kind}
                          onValueChange={(value) =>
                            set(
                              value === "trait"
                                ? {
                                    kind: "trait",
                                    scope: "portable",
                                    decay: undefined,
                                  }
                                : {
                                    kind: value as ParameterDefinition["kind"],
                                  },
                            )
                          }
                        >
                          <SelectItem value="trait">Stable trait</SelectItem>
                          <SelectItem value="state">Transient state</SelectItem>
                          <SelectItem value="relationship">
                            Directed relationship
                          </SelectItem>
                        </OptionSelect>
                      </Field>
                      <Field label="Scope">
                        <OptionSelect
                          className={controlClass}
                          value={p.scope}
                          disabled={disabled || p.kind === "trait"}
                          onValueChange={(value) =>
                            set({
                              scope: value as ParameterDefinition["scope"],
                            })
                          }
                        >
                          <SelectItem value="portable">
                            Across worlds
                          </SelectItem>
                          <SelectItem value="world">Per world</SelectItem>
                        </OptionSelect>
                      </Field>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                      <Numeric
                        label="Initial value"
                        value={p.initial}
                        onChange={(initial) => set({ initial })}
                      />
                      <Numeric
                        label="Minimum"
                        value={p.min}
                        onChange={(min) => set({ min })}
                      />
                      <Numeric
                        label="Maximum"
                        value={p.max}
                        onChange={(max) => set({ max })}
                      />
                      <Numeric
                        label="Maximum change"
                        value={p.maxDelta}
                        onChange={(maxDelta) => set({ maxDelta })}
                      />
                    </div>
                    <label className="flex min-h-11 items-center gap-3 text-sm">
                      <input
                        type="checkbox"
                        checked={Boolean(p.decay)}
                        disabled={disabled || p.kind === "trait"}
                        onChange={(e) =>
                          set({
                            decay: e.target.checked
                              ? { perHour: p.maxDelta, toward: p.initial }
                              : undefined,
                          })
                        }
                      />
                      Explicit-time decay
                    </label>
                    {p.decay && (
                      <div className="grid gap-4 sm:grid-cols-2">
                        <Numeric
                          label="Change per hour"
                          value={p.decay.perHour}
                          onChange={(perHour) =>
                            set({ decay: { ...p.decay!, perHour } })
                          }
                        />
                        <Numeric
                          label="Decay toward"
                          value={p.decay.toward}
                          onChange={(toward) =>
                            set({ decay: { ...p.decay!, toward } })
                          }
                        />
                      </div>
                    )}
                  </fieldset>
                );
              })}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="overrides">
          <Card>
            <CardHeader>
              <CardTitle>Scoped overrides</CardTitle>
              <CardDescription>
                Use only the NPCs, groups and worlds supplied by this runtime.
                Inherited permissions stay unchanged.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5">
              {draft.overrides.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No scoped overrides. The shared policy and goals apply to
                  every configured NPC.
                </p>
              )}
              {draft.overrides.map((o, index) => {
                const update = (patch: Partial<BehaviorOverride>) =>
                  change((c) => {
                    c.overrides[index] = { ...c.overrides[index], ...patch };
                  });
                const targets =
                  o.scope.kind === "npc"
                    ? snapshot.catalog.npcs.map((n) => ({
                        id: n.npcId,
                        label: n.label,
                      }))
                    : o.scope.kind === "group"
                      ? snapshot.catalog.groups.map((g) => ({
                          id: g.groupId,
                          label: g.groupId,
                        }))
                      : snapshot.catalog.worlds.map((id) => ({
                          id,
                          label: id,
                        }));
                return (
                  <div
                    key={`${instance}-override-${index}`}
                    className="grid gap-4 rounded-lg border p-4"
                  >
                    <div className="grid gap-3 sm:grid-cols-[1fr_2fr_auto]">
                      <Field label="Override scope">
                        <OptionSelect
                          className={controlClass}
                          value={o.scope.kind}
                          disabled={!editable}
                          onValueChange={(value) =>
                            update({
                              scope: {
                                kind: value as BehaviorOverride["scope"]["kind"],
                                id: "",
                              },
                            })
                          }
                        >
                          <SelectItem value="world">World</SelectItem>
                          <SelectItem value="group">Group</SelectItem>
                          <SelectItem value="npc">NPC</SelectItem>
                        </OptionSelect>
                      </Field>
                      <Field label="Target *">
                        <OptionSelect
                          className={controlClass}
                          value={o.scope.id}
                          disabled={!editable}
                          onValueChange={(value) =>
                            update({ scope: { ...o.scope, id: value } })
                          }
                        >
                          <SelectItem value="">Choose target</SelectItem>
                          {targets.map((t, i) => (
                            <SelectItem key={`${t.id}-${i}`} value={t.id}>
                              {t.label}
                            </SelectItem>
                          ))}
                        </OptionSelect>
                      </Field>
                      <Button
                        variant="ghost"
                        className="min-h-11 self-end"
                        disabled={!editable}
                        onClick={() =>
                          remove((c) => {
                            c.overrides.splice(index, 1);
                          })
                        }
                      >
                        <X />
                        Remove
                      </Button>
                    </div>
                    <Policy
                      value={o.policy ?? {}}
                      partial
                      disabled={!editable || locked.lockedPolicy}
                      denied={locked.deniedPermissions}
                      onChange={(policy) => update({ policy })}
                    />
                    <details className="rounded-lg border p-3">
                      <summary className="cursor-pointer py-2 text-sm font-medium">
                        Scoped goals and initial values
                      </summary>
                      <div className="mt-4 grid gap-4">
                        <label className="flex min-h-11 items-center gap-3 text-sm">
                          <input
                            type="checkbox"
                            checked={o.goals !== undefined}
                            disabled={!editable || locked.lockedGoals}
                            onChange={(e) =>
                              update({
                                goals: e.target.checked
                                  ? structuredClone(draft.defaults.goals)
                                  : undefined,
                              })
                            }
                          />
                          Override goals
                        </label>
                        {o.goals && (
                          <Goals
                            goals={o.goals}
                            prefix={`${instance}-override-${index}`}
                            disabled={!editable || locked.lockedGoals}
                            onChange={(goals) => update({ goals })}
                          />
                        )}
                        <div className="grid gap-3">
                          {draft.parameters.map((p) => (
                            <div
                              key={p.parameterId}
                              className="grid items-end gap-3 sm:grid-cols-[1fr_1fr]"
                            >
                              <label className="flex min-h-11 items-center gap-3 text-sm">
                                <input
                                  type="checkbox"
                                  checked={Object.hasOwn(
                                    o.initialValues ?? {},
                                    p.parameterId,
                                  )}
                                  disabled={
                                    !editable ||
                                    locked.lockedParameterIds.includes(
                                      p.parameterId,
                                    )
                                  }
                                  onChange={(e) => {
                                    const values = { ...o.initialValues };
                                    if (e.target.checked)
                                      values[p.parameterId] = p.initial;
                                    else delete values[p.parameterId];
                                    update({ initialValues: values });
                                  }}
                                />
                                Initial {p.label}
                              </label>
                              {Object.hasOwn(
                                o.initialValues ?? {},
                                p.parameterId,
                              ) && (
                                <Numeric
                                  label={`${p.label} override`}
                                  value={o.initialValues![p.parameterId]}
                                  min={p.min}
                                  max={p.max}
                                  disabled={
                                    !editable ||
                                    locked.lockedParameterIds.includes(
                                      p.parameterId,
                                    )
                                  }
                                  onChange={(value) =>
                                    update({
                                      initialValues: {
                                        ...o.initialValues,
                                        [p.parameterId]: value,
                                      },
                                    })
                                  }
                                />
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    </details>
                  </div>
                );
              })}
              <Button
                variant="outline"
                className="min-h-11 justify-self-start"
                disabled={!editable || snapshot.catalog.worlds.length === 0}
                onClick={() =>
                  change((c) => {
                    c.overrides.push({ scope: { kind: "world", id: "" } });
                  })
                }
              >
                <Plus />
                Add scoped override
              </Button>
              {snapshot.catalog.worlds.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  Open a character or connect a trusted host session to
                  configure scoped behavior.
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="state">
          <Card>
            <CardHeader>
              <CardTitle>State and revision history</CardTitle>
              <CardDescription>
                Inspect one NPC’s authorized values. Relationship confidence is
                separate from its value.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Session">
                  <OptionSelect
                    className={controlClass}
                    value={sessionId}
                    onValueChange={(value) => {
                      setSessionId(value);
                      setNpcId("");
                      setInspection(null);
                      setStateFailure(null);
                    }}
                  >
                    <SelectItem value="">Choose session</SelectItem>
                    {snapshot.catalog.sessions.map((s) => (
                      <SelectItem key={s.sessionId} value={s.sessionId}>
                        {s.worldId} · {s.sessionId}
                      </SelectItem>
                    ))}
                  </OptionSelect>
                </Field>
                <Field label="NPC">
                  <OptionSelect
                    className={controlClass}
                    value={npcId}
                    disabled={!sessionId}
                    onValueChange={(value) => {
                      setNpcId(value);
                      setInspection(null);
                    }}
                  >
                    <SelectItem value="">Choose NPC</SelectItem>
                    {availableNpcs.map((id) => (
                      <SelectItem key={id} value={id}>
                        {snapshot.catalog.npcs.find((n) => n.npcId === id)
                          ?.label ?? id}
                      </SelectItem>
                    ))}
                  </OptionSelect>
                </Field>
              </div>
              <Button
                variant="outline"
                className="min-h-11 justify-self-start"
                disabled={!sessionId || !npcId || stateLoading}
                onClick={() => setStateRefresh((value) => value + 1)}
              >
                <RefreshCw />
                Refresh state
              </Button>
              {stateLoading && <p role="status">Loading state and history…</p>}
              {stateFailure && (
                <p role="alert" className="feedback error">
                  {stateFailure}
                </p>
              )}
              {!npcId && (
                <p className="text-sm text-muted-foreground">
                  Choose a session and NPC to inspect its current state and
                  evidence history.
                </p>
              )}
              {inspection && !stateLoading && (
                <>
                  <p className="text-sm text-muted-foreground">
                    State revision {inspection.stateRevision} · configuration
                    revision {inspection.configRevision}
                  </p>
                  {inspection.values.length === 0 ? (
                    <p className="text-sm">
                      No recorded parameter changes yet. New evidence can create
                      bounded state; initial definitions remain above.
                    </p>
                  ) : (
                    <div className="grid gap-3 sm:grid-cols-2">
                      {inspection.values.map((v, i) => (
                        <div key={i} className="rounded-lg border p-4">
                          <strong className="text-sm">
                            {inspection.parameters.find(
                              (p) => p.parameterId === v.parameterId,
                            )?.label ?? v.parameterId}
                          </strong>
                          <p className="mt-1 text-xl font-medium">{v.value}</p>
                          <p className="break-all text-xs text-muted-foreground">
                            {v.targetParticipantId
                              ? `Toward ${v.targetParticipantId}`
                              : "Individual state"}{" "}
                            · confidence {Math.round(v.confidence * 100)}%
                            {v.worldId ? ` · ${v.worldId}` : " · across worlds"}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                  {inspection.history.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No revision history yet.
                    </p>
                  ) : (
                    <ol className="grid gap-3">
                      {inspection.history
                        .slice(-30)
                        .reverse()
                        .map((h, i) => (
                          <li
                            key={`${h.changeId}-${i}`}
                            className="grid gap-1 rounded-lg border p-4 text-sm"
                          >
                            <strong>
                              {h.parameterId}: {h.before} → {h.after}
                            </strong>
                            <span>{h.reason}</span>
                            <span className="text-xs text-muted-foreground">
                              Revision {h.revision} ·{" "}
                              {h.kind === "decay"
                                ? "Configured decay"
                                : `Evidence: ${h.evidenceEventIds.join(", ")}`}{" "}
                              · confidence {Math.round(h.confidence * 100)}%
                            </span>
                          </li>
                        ))}
                    </ol>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
