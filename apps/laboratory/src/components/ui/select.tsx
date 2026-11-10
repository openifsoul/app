"use client";
// shadcn/ui combobox composition: Radix Popover + cmdk Command.
import * as React from "react";
import { Command } from "cmdk";
import { Popover } from "radix-ui";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react";
import { cn } from "../../lib/utils";

type Option = {
  value: string;
  label: React.ReactNode;
  text: string;
  disabled?: boolean;
};
type Selection = {
  value: string;
  open: boolean;
  disabled?: boolean;
  options: Option[];
  setOpen: (open: boolean) => void;
  choose: (value: string) => void;
  triggerId: string;
  listId: string;
  setListId: (id: string) => void;
};
const SelectionContext = React.createContext<Selection | null>(null);
function useSelection() {
  const context = React.useContext(SelectionContext);
  if (!context) throw new Error("Select context unavailable");
  return context;
}
function textOf(node: React.ReactNode): string {
  return React.Children.toArray(node)
    .map((child) =>
      typeof child === "string" || typeof child === "number"
        ? String(child)
        : React.isValidElement<{ children?: React.ReactNode }>(child)
          ? textOf(child.props.children)
          : "",
    )
    .join("");
}
function collect(node: React.ReactNode): Option[] {
  return React.Children.toArray(node).flatMap((child) => {
    if (
      !React.isValidElement<{
        value?: string;
        textValue?: string;
        children?: React.ReactNode;
        disabled?: boolean;
      }>(child)
    )
      return [];
    if (child.type === SelectItem)
      return [
        {
          value: child.props.value!,
          label: child.props.children,
          text: child.props.textValue ?? textOf(child.props.children),
          disabled: child.props.disabled,
        },
      ];
    return collect(child.props.children);
  });
}
function Select({
  value,
  defaultValue = "",
  onValueChange,
  disabled,
  children,
}: {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  const [localValue, setLocalValue] = React.useState(defaultValue);
  const [open, setOpen] = React.useState(false);
  const id = React.useId();
  const [listId, setListId] = React.useState(`${id}-list`);
  const context: Selection = {
    value: value ?? localValue,
    open,
    disabled,
    options: collect(children),
    setOpen,
    choose(next) {
      setLocalValue(next);
      onValueChange?.(next);
      setOpen(false);
    },
    triggerId: `${id}-trigger`,
    listId,
    setListId,
  };
  return (
    <SelectionContext.Provider value={context}>
      <Popover.Root open={open && !disabled} onOpenChange={setOpen}>
        {children}
      </Popover.Root>
    </SelectionContext.Provider>
  );
}
function SelectValue({ placeholder }: { placeholder?: React.ReactNode }) {
  const { options, value } = useSelection();
  return (
    <span
      data-slot="select-value"
      className="flex min-w-0 items-center gap-2 truncate text-left [&>svg]:size-4 [&>svg]:shrink-0"
    >
      {options.find((option) => option.value === value)?.label ?? placeholder}
    </span>
  );
}
function SelectTrigger({
  className,
  size = "default",
  children,
  id,
  disabled,
  onKeyDown,
  ...props
}: React.ComponentProps<"button"> & { size?: "sm" | "default" }) {
  const context = useSelection();
  return (
    <Popover.Trigger asChild>
      <button
        {...props}
        type="button"
        id={id ?? context.triggerId}
        role="combobox"
        aria-expanded={context.open}
        aria-haspopup="listbox"
        aria-controls={context.open ? context.listId : undefined}
        data-slot="select-trigger"
        data-size={size}
        disabled={disabled || context.disabled}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (
            !event.defaultPrevented &&
            (event.key === "ArrowDown" || event.key === "ArrowUp")
          ) {
            event.preventDefault();
            context.setOpen(true);
          }
        }}
        className={cn(
          "flex min-h-11 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
      >
        {children}
        <ChevronDownIcon
          aria-hidden="true"
          className="ml-auto size-4 shrink-0 text-muted-foreground"
        />
      </button>
    </Popover.Trigger>
  );
}
function SelectContent({
  className,
  children,
  position: _position,
  align = "start",
  ...props
}: React.ComponentProps<typeof Popover.Content> & {
  position?: "item-aligned" | "popper";
}) {
  const context = useSelection();
  const searchable = context.options.length >= 5;
  const input = React.useRef<HTMLInputElement>(null);
  const command = React.useRef<HTMLDivElement>(null);
  const registerList = React.useCallback(
    (node: HTMLDivElement | null) => {
      if (node) context.setListId(node.id);
    },
    [context.setListId],
  );
  return (
    <Popover.Portal>
      <Popover.Content
        {...props}
        align={align}
        sideOffset={4}
        data-slot="select-content"
        className={cn(
          "z-50 w-[var(--radix-popover-trigger-width)] min-w-32 max-w-[calc(100vw-24px)] rounded-md border bg-popover text-popover-foreground shadow-md",
          className,
        )}
        onOpenAutoFocus={(event) => {
          props.onOpenAutoFocus?.(event);
          if (!event.defaultPrevented) {
            event.preventDefault();
            (searchable
              ? input.current
              : command.current?.querySelector<HTMLElement>("[cmdk-list]")
            )?.focus();
          }
        }}
      >
        <Command
          ref={command}
          tabIndex={-1}
          className="outline-none"
          defaultValue={`option:${context.value}`}
          loop
          label={searchable ? "Search options" : "Choose an option"}
          filter={(value, search, keywords) =>
            `${value} ${(keywords ?? []).join(" ")}`
              .toLocaleLowerCase()
              .includes(search.trim().toLocaleLowerCase())
              ? 1
              : 0
          }
        >
          {searchable && (
            <div className="flex items-center gap-2 border-b px-3">
              <SearchIcon
                aria-hidden="true"
                className="size-4 shrink-0 text-muted-foreground"
              />
              <Command.Input
                ref={input}
                aria-label="Search options"
                placeholder="Search…"
                className="min-h-11 w-full min-w-0 bg-transparent text-sm outline-none"
              />
            </div>
          )}
          <Command.List
            ref={registerList}
            label="Options"
            className="scroll-py-1 overflow-y-auto p-1"
            style={{
              maxHeight: `min(300px, calc(var(--radix-popover-content-available-height) - ${searchable ? 54 : 8}px))`,
            }}
          >
            <Command.Empty className="px-3 py-5 text-center text-sm text-muted-foreground">
              No matching options.
            </Command.Empty>
            {children}
          </Command.List>
        </Command>
      </Popover.Content>
    </Popover.Portal>
  );
}
function SelectItem({
  value,
  children,
  disabled,
  textValue,
  className,
}: {
  value: string;
  children?: React.ReactNode;
  disabled?: boolean;
  textValue?: string;
  className?: string;
}) {
  const context = useSelection();
  return (
    <Command.Item
      data-slot="select-item"
      value={`option:${value}`}
      keywords={[textValue ?? textOf(children)]}
      disabled={disabled}
      onSelect={() => context.choose(value)}
      className={cn(
        "relative flex min-h-11 cursor-default items-center gap-2 rounded-sm px-2 py-2 text-sm outline-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
        className,
      )}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2 break-words [&>svg]:size-4 [&>svg]:shrink-0">
        {children}
      </span>
      <CheckIcon
        aria-hidden="true"
        className={cn(
          "size-4 shrink-0",
          context.value === value ? "opacity-100" : "opacity-0",
        )}
      />
    </Command.Item>
  );
}
function SelectGroup(props: React.ComponentProps<typeof Command.Group>) {
  return <Command.Group {...props} />;
}
function SelectLabel(props: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="select-label"
      {...props}
      className={cn("px-2 py-2 text-xs text-muted-foreground", props.className)}
    />
  );
}
function SelectSeparator(props: React.ComponentProps<"div">) {
  return (
    <div
      role="separator"
      {...props}
      className={cn("my-1 h-px bg-border", props.className)}
    />
  );
}
/** Option-based convenience API; all choices still use the shared shadcn combobox. */
function OptionSelect({
  children,
  value,
  onValueChange,
  disabled,
  ...props
}: Omit<
  React.ComponentProps<typeof SelectTrigger>,
  "value" | "onChange" | "children" | "size"
> & {
  value: string;
  onValueChange: (value: string) => void;
  children?: React.ReactNode;
}) {
  return (
    <Select value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger {...props}>
        <SelectValue placeholder="Choose an option" />
      </SelectTrigger>
      <SelectContent>{children}</SelectContent>
    </Select>
  );
}
export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  OptionSelect,
};
