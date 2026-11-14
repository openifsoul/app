import { OptionSelect, SelectItem } from "./ui/select";
import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Calculator,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  RefreshCw,
  Save,
  Wallet,
} from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  billingError,
  customerUSD,
  dollarsInput,
  estimateBilling,
  parseDollars,
  readBilling,
  updateSpendingLimits,
  type BillingCapability,
  type BillingExpense,
  type BillingSnapshot,
  type CustomerEstimate,
} from "../lib/billing-api";
import { ApiError } from "../lib/api";
const selectClass =
  "min-h-11 w-full rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-60";
const stateLabels: Record<BillingExpense["state"], string> = {
  held: "Reserved",
  settled: "Charged",
  released: "Released",
  unknown: "Awaiting reconciliation",
};
const integer = (text: string) =>
  /^\d+$/.test(text) && Number.isSafeInteger(Number(text))
    ? Number(text)
    : null;
function timestamp(at: number) {
  const date = new Date(at);
  return Number.isFinite(date.valueOf())
    ? date.toLocaleString()
    : "Time unavailable";
}
function Balance({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-0 rounded-lg border p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-2 break-all font-mono text-lg font-semibold tabular-nums">
        {customerUSD(value)}
      </p>
    </div>
  );
}
function Estimate({ snapshot }: { snapshot: BillingSnapshot }) {
  const [model, setModel] = useState(snapshot.tariffs[0]?.model ?? ""),
    [calls, setCalls] = useState("1"),
    [input, setInput] = useState("0"),
    [output, setOutput] = useState("0"),
    [pending, setPending] = useState(false),
    [result, setResult] = useState<CustomerEstimate | null>(null),
    [failure, setFailure] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    controller.current?.abort();
    setPending(false);
    setResult(null);
    if (!snapshot.tariffs.some((t) => t.model === model))
      setModel(snapshot.tariffs[0]?.model ?? "");
  }, [snapshot.tariffs]);
  const callCount = integer(calls),
    inputCount = integer(input),
    outputCount = integer(output),
    valid =
      Boolean(model) &&
      callCount !== null &&
      callCount > 0 &&
      inputCount !== null &&
      outputCount !== null;
  function edit(change: () => void) {
    change();
    setResult(null);
    setFailure(null);
  }
  async function estimate() {
    if (!valid || pending) return;
    controller.current?.abort();
    const active = new AbortController();
    controller.current = active;
    setPending(true);
    setFailure(null);
    try {
      const value = await estimateBilling(
        model,
        inputCount!,
        outputCount!,
        callCount!,
        active.signal,
      );
      if (!active.signal.aborted) setResult(value);
    } catch (error) {
      if (!active.signal.aborted) setFailure(billingError(error));
    } finally {
      if (controller.current === active) setPending(false);
    }
  }
  return (
    <section className="grid gap-4" aria-labelledby="billing-estimator-title">
      <div>
        <h3 id="billing-estimator-title" className="font-medium">
          Estimate a workload
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Enter the total input and output tokens across all calls. Cost uses
          this service’s final customer tariff.
        </p>
      </div>
      {snapshot.tariffs.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No customer tariff is available to estimate a workload.
        </p>
      ) : (
        <>
          <div className="app-field-row grid gap-4 sm:grid-cols-2">
            <div className="app-form-field grid gap-2">
              <Label htmlFor="billing-estimate-model">Model</Label>
              <OptionSelect
                id="billing-estimate-model"
                className={selectClass}
                value={model}
                disabled={pending}
                onValueChange={(value) => edit(() => setModel(value))}
              >
                {[...new Set(snapshot.tariffs.map((t) => t.model))].map(
                  (id) => (
                    <SelectItem key={id} value={id}>
                      {id}
                    </SelectItem>
                  ),
                )}
              </OptionSelect>
            </div>
            <div className="app-form-field grid gap-2">
              <Label htmlFor="billing-estimate-calls">Calls *</Label>
              <Input
                id="billing-estimate-calls"
                className="min-h-11"
                inputMode="numeric"
                maxLength={16}
                value={calls}
                disabled={pending}
                onChange={(e) => edit(() => setCalls(e.target.value))}
              />
            </div>
            <div className="app-form-field grid gap-2">
              <Label htmlFor="billing-estimate-input">
                Total input tokens *
              </Label>
              <Input
                id="billing-estimate-input"
                className="min-h-11"
                inputMode="numeric"
                maxLength={16}
                value={input}
                disabled={pending}
                onChange={(e) => edit(() => setInput(e.target.value))}
              />
            </div>
            <div className="app-form-field grid gap-2">
              <Label htmlFor="billing-estimate-output">
                Total output tokens *
              </Label>
              <Input
                id="billing-estimate-output"
                className="min-h-11"
                inputMode="numeric"
                maxLength={16}
                value={output}
                disabled={pending}
                onChange={(e) => edit(() => setOutput(e.target.value))}
              />
            </div>
          </div>
          {!valid && (
            <p className="text-sm text-muted-foreground">
              Use a positive whole number of calls and nonnegative whole token
              totals.
            </p>
          )}
          {failure && (
            <p role="alert" className="feedback error">
              {failure}
            </p>
          )}
          <Button
            variant="outline"
            className="min-h-11 justify-self-start"
            disabled={!valid || pending}
            onClick={() => void estimate()}
          >
            {pending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Calculator />
            )}
            {pending ? "Estimating…" : "Estimate workload"}
          </Button>
          {result && (
            <p role="status" className="rounded-lg border p-4 text-sm">
              <strong className="font-mono text-base">
                {customerUSD(result.microdollars)}
              </strong>
              <span className="mt-1 block text-muted-foreground">
                For {callCount?.toLocaleString()} calls · tariff{" "}
                {result.tariffVersion}. Actual charges follow recorded usage.
              </span>
            </p>
          )}
        </>
      )}
    </section>
  );
}
export function BillingSettings() {
  const [capability, setCapability] = useState<BillingCapability | null>(null),
    [loading, setLoading] = useState(true),
    [failure, setFailure] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null),
    [saving, setSaving] = useState(false),
    [daily, setDaily] = useState(""),
    [session, setSession] = useState(""),
    [paused, setPaused] = useState(false),
    [conflict, setConflict] = useState(false),
    [confirmReload, setConfirmReload] = useState(false),
    [search, setSearch] = useState(""),
    [state, setState] = useState("all"),
    [page, setPage] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const snapshot = capability?.available ? capability : null;
  const dailyAmount = parseDollars(daily),
    sessionAmount = parseDollars(session),
    valid = dailyAmount !== null && sessionAmount !== null;
  const dirty = Boolean(
    snapshot &&
    (dailyAmount !== snapshot.limits.dailyMicrodollars ||
      sessionAmount !== snapshot.limits.sessionMicrodollars ||
      paused !== snapshot.limits.paused),
  );
  function adopt(value: BillingSnapshot) {
    setCapability({ available: true, ...value });
    setDaily(dollarsInput(value.limits.dailyMicrodollars));
    setSession(dollarsInput(value.limits.sessionMicrodollars));
    setPaused(value.limits.paused);
    setConflict(false);
    setConfirmReload(false);
  }
  async function load() {
    controller.current?.abort();
    const active = new AbortController();
    controller.current = active;
    setLoading(true);
    setFailure(null);
    try {
      const value = await readBilling(active.signal);
      if (active.signal.aborted) return;
      if (value.available) adopt(value);
      else setCapability(value);
      setNotice(null);
    } catch (error) {
      if (!active.signal.aborted) setFailure(billingError(error));
    } finally {
      if (controller.current === active) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    return () => controller.current?.abort();
  }, []);
  async function save() {
    if (!snapshot || !valid || saving || conflict) return;
    setSaving(true);
    setFailure(null);
    setNotice(null);
    try {
      adopt(
        await updateSpendingLimits({
          revision: snapshot.limits.revision,
          dailyMicrodollars: dailyAmount!,
          sessionMicrodollars: sessionAmount!,
          paused,
        }),
      );
      setNotice("Spending limits saved.");
    } catch (error) {
      setFailure(billingError(error));
      setConflict(
        error instanceof ApiError && ["conflict", "stale"].includes(error.code),
      );
    } finally {
      setSaving(false);
    }
  }
  const filtered = (snapshot?.expenses ?? []).filter(
    (e) =>
      (state === "all" || e.state === state) &&
      `${e.category} ${e.model} ${e.npcId ?? ""} ${e.gameId ?? ""} ${e.sessionId ?? ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / 20)),
    currentPage = Math.min(page, pages - 1),
    expenses = filtered.slice(currentPage * 20, currentPage * 20 + 20);
  return (
    <Card className="billing-panel" aria-label="Balance and billing">
      <CardHeader>
        <div className="billing-heading-row">
          <CardTitle className="flex items-center gap-2">
            <Wallet className="size-4" />
            Balance and billing
          </CardTitle>
          <Button
            variant="outline"
            className="billing-refresh"
            disabled={loading || saving}
            onClick={() => {
              if (dirty) setConfirmReload(true);
              else void load();
            }}
          >
            <RefreshCw className={loading ? "animate-spin" : ""} />
            Refresh billing
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Managed inference prices are separate from your own provider keys and
          local models. All amounts are USD.
        </p>
      </CardHeader>
      <CardContent className="grid gap-6">
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
        {loading && !capability && (
          <p role="status" className="flex items-center gap-2 text-sm">
            <LoaderCircle className="size-4 animate-spin" />
            Loading billing…
          </p>
        )}
        {!loading && capability && !capability.available && (
          <p className="text-sm text-muted-foreground">
            A managed balance is not enabled on this service. Local models and
            your provider keys keep their own payment setup.
          </p>
        )}
        {!loading && !capability && (
          <Button
            variant="outline"
            className="min-h-11 justify-self-start"
            onClick={() => void load()}
          >
            Retry billing
          </Button>
        )}
        {confirmReload && (
          <div className="grid gap-3 rounded-lg border p-4">
            <p className="text-sm">
              Reload saved limits and discard your unsaved limit changes?
            </p>
            <div className="flex flex-wrap gap-3">
              <Button
                variant="outline"
                className="min-h-11"
                onClick={() => setConfirmReload(false)}
              >
                Keep editing
              </Button>
              <Button className="min-h-11" onClick={() => void load()}>
                Discard draft and reload
              </Button>
            </div>
          </div>
        )}
        {snapshot && (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Balance
                label="Available"
                value={snapshot.availableMicrodollars}
              />
              <Balance label="Reserved" value={snapshot.reservedMicrodollars} />
              <Balance
                label="Promotional grant (included)"
                value={snapshot.promotionalMicrodollars}
              />
              <Balance label="Spent" value={snapshot.spentMicrodollars} />
            </div>
            <section
              className="grid gap-4"
              aria-labelledby="billing-limits-title"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 id="billing-limits-title" className="font-medium">
                  Spending controls
                </h3>
                <Badge variant="outline">
                  Revision {snapshot.limits.revision}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                Limits include reserved work. Pausing blocks new managed
                inference; existing reservations keep their reported state.
              </p>
              <div className="app-field-row grid gap-4 sm:grid-cols-2">
                <div className="app-form-field grid gap-2">
                  <Label htmlFor="billing-daily-limit">
                    Daily limit (USD) *
                  </Label>
                  <Input
                    id="billing-daily-limit"
                    className="min-h-11"
                    inputMode="decimal"
                    maxLength={24}
                    value={daily}
                    disabled={saving}
                    onChange={(e) => {
                      setDaily(e.target.value);
                      setNotice(null);
                      setConflict(false);
                    }}
                    aria-describedby="billing-limit-note"
                  />
                </div>
                <div className="app-form-field grid gap-2">
                  <Label htmlFor="billing-session-limit">
                    Session limit (USD) *
                  </Label>
                  <Input
                    id="billing-session-limit"
                    className="min-h-11"
                    inputMode="decimal"
                    maxLength={24}
                    value={session}
                    disabled={saving}
                    onChange={(e) => {
                      setSession(e.target.value);
                      setNotice(null);
                      setConflict(false);
                    }}
                    aria-describedby="billing-limit-note"
                  />
                </div>
              </div>
              <p
                id="billing-limit-note"
                className="text-xs text-muted-foreground"
              >
                Nonnegative amounts with up to six decimal places, such as
                0.000001.
              </p>
              <label className="flex min-h-11 items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  className="size-5"
                  checked={paused}
                  disabled={saving}
                  onChange={(e) => {
                    setPaused(e.target.checked);
                    setNotice(null);
                    setConflict(false);
                  }}
                />
                Pause new managed inference
              </label>
              {!valid && (
                <p role="alert" className="text-sm">
                  Enter valid nonnegative USD amounts with no more than six
                  decimal places.
                </p>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  className="min-h-11"
                  disabled={saving || !dirty || !valid || conflict}
                  onClick={() => void save()}
                >
                  {saving ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <Save />
                  )}
                  {saving ? "Saving…" : "Save spending limits"}
                </Button>
                {conflict && (
                  <Button
                    variant="outline"
                    className="min-h-11"
                    onClick={() => setConfirmReload(true)}
                  >
                    Reload saved limits
                  </Button>
                )}
                {dirty && (
                  <span className="text-sm text-muted-foreground">
                    Unsaved changes
                  </span>
                )}
              </div>
            </section>
            <section
              className="grid gap-3"
              aria-labelledby="billing-tariffs-title"
            >
              <h3 id="billing-tariffs-title" className="font-medium">
                Final customer prices
              </h3>
              {snapshot.tariffs.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No final model tariff is currently published by this service.
                </p>
              ) : (
                <div className="grid gap-3">
                  {snapshot.tariffs.map((tariff, index) => (
                    <div
                      key={`${tariff.model}-${tariff.version}-${index}`}
                      className="grid min-w-0 gap-3 rounded-lg border p-4"
                    >
                      <div className="flex flex-wrap justify-between gap-2">
                        <strong className="break-all text-sm">
                          {tariff.model}
                        </strong>
                        <Badge variant="outline">{tariff.version}</Badge>
                      </div>
                      <dl className="grid gap-3 text-sm sm:grid-cols-3">
                        <div>
                          <dt className="text-xs text-muted-foreground">
                            Input / 1 million tokens
                          </dt>
                          <dd className="mt-1 break-all font-mono">
                            {customerUSD(tariff.inputMicrodollarsPerMillion)}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-xs text-muted-foreground">
                            Output / 1 million tokens
                          </dt>
                          <dd className="mt-1 break-all font-mono">
                            {customerUSD(tariff.outputMicrodollarsPerMillion)}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-xs text-muted-foreground">
                            Per request
                          </dt>
                          <dd className="mt-1 break-all font-mono">
                            {customerUSD(tariff.requestMicrodollars)}
                          </dd>
                        </div>
                      </dl>
                    </div>
                  ))}
                </div>
              )}
            </section>
            <Estimate snapshot={snapshot} />
            <section
              className="grid gap-4"
              aria-labelledby="billing-expenses-title"
            >
              <h3 id="billing-expenses-title" className="font-medium">
                Expenses and reservations
              </h3>
              <div className="app-field-row grid gap-3 sm:grid-cols-2">
                <div className="app-form-field grid gap-2">
                  <Label htmlFor="billing-expense-search">
                    Find category, NPC, game or model
                  </Label>
                  <Input
                    id="billing-expense-search"
                    className="min-h-11"
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setPage(0);
                    }}
                  />
                </div>
                <div className="app-form-field grid gap-2">
                  <Label htmlFor="billing-expense-state">State</Label>
                  <OptionSelect
                    id="billing-expense-state"
                    className={selectClass}
                    value={state}
                    onValueChange={(value) => {
                      setState(value);
                      setPage(0);
                    }}
                  >
                    <SelectItem value="all">All states</SelectItem>
                    {Object.entries(stateLabels).map(([id, label]) => (
                      <SelectItem key={id} value={id}>
                        {label}
                      </SelectItem>
                    ))}
                  </OptionSelect>
                </div>
              </div>
              {filtered.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {snapshot.expenses.length
                    ? "No expenses match these filters. Clear the search or choose all states."
                    : "No managed inference expenses yet. Charges and reservations will appear here when work is requested."}
                </p>
              ) : (
                <>
                  <ol className="grid gap-3">
                    {expenses.map((expense) => (
                      <li
                        key={expense.id}
                        className="grid min-w-0 gap-3 rounded-lg border p-4 text-sm"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <strong className="break-all capitalize">
                            {expense.category.replace(/[-_]/g, " ")}
                          </strong>
                          <Badge variant="outline">
                            {stateLabels[expense.state]}
                          </Badge>
                        </div>
                        <p className="break-all text-xs text-muted-foreground">
                          {timestamp(expense.at)} · {expense.model}
                          {expense.npcId ? ` · NPC ${expense.npcId}` : ""}
                          {expense.gameId ? ` · game ${expense.gameId}` : ""}
                          {expense.sessionId
                            ? ` · session ${expense.sessionId}`
                            : ""}
                        </p>
                        <div className="flex flex-wrap gap-x-5 gap-y-2 font-mono text-xs">
                          <span>
                            Reserved {customerUSD(expense.reservedMicrodollars)}
                          </span>
                          <span>
                            Charged {customerUSD(expense.chargedMicrodollars)}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Input tokens:{" "}
                          {expense.inputTokens === undefined
                            ? "not reported"
                            : expense.inputTokens.toLocaleString()}{" "}
                          · output tokens:{" "}
                          {expense.outputTokens === undefined
                            ? "not reported"
                            : expense.outputTokens.toLocaleString()}{" "}
                          · accounting: {expense.accounting ?? "not reported"}
                        </p>
                      </li>
                    ))}
                  </ol>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="text-xs text-muted-foreground">
                      Showing {currentPage * 20 + 1}–
                      {Math.min((currentPage + 1) * 20, filtered.length)} of{" "}
                      {filtered.length}
                    </span>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        className="min-h-11"
                        aria-label="Previous expense page"
                        disabled={currentPage === 0}
                        onClick={() => setPage(currentPage - 1)}
                      >
                        <ChevronLeft />
                      </Button>
                      <Button
                        variant="outline"
                        className="min-h-11"
                        aria-label="Next expense page"
                        disabled={currentPage + 1 >= pages}
                        onClick={() => setPage(currentPage + 1)}
                      >
                        <ChevronRight />
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </section>
          </>
        )}
        {snapshot && (
          <div className="flex flex-wrap items-center gap-3 border-t pt-4">
            <Button asChild variant="outline" className="min-h-11">
              <a
                href="https://t.me/h3lpkey"
                target="_blank"
                rel="noopener noreferrer"
              >
                Discuss a top-up
                <ArrowUpRight />
              </a>
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
