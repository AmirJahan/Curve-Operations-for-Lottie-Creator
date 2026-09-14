import { useCallback, useEffect, useRef, useState } from "react";
import {
  Badge,
  Button,
  Checkbox,
  Label,
  NumberInput,
  Separator,
  ThemeProvider,
  Tooltip,
  cn,
} from "@lottiefiles/creator-plugins-ui";

import type { Mode, PluginToUi, Settings, UiToPlugin } from "../shared/messages";
import { BlendIcon, ExcludeIcon, IntersectIcon, SubtractIcon, UnionIcon } from "./op-icons";

const send = (message: UiToPlugin) => {
  parent.postMessage({ pluginMessage: message }, "*");
};

const MODES = [
  { mode: "union", label: "Union", Icon: UnionIcon, hint: "Merge all selected paths into one." },
  { mode: "subtract", label: "Subtract", Icon: SubtractIcon, hint: "Remove the front paths from the back one." },
  { mode: "intersect", label: "Intersect", Icon: IntersectIcon, hint: "Keep only the overlapping area." },
  { mode: "exclude", label: "Exclude", Icon: ExcludeIcon, hint: "Keep everything except the overlap." },
] as const;

const IDLE_HINT = "Select two or more paths, then pick an operation to preview it.";

interface Theme {
  tokens?: Record<string, string>;
  themeName?: string;
}

export const App = () => {
  const [theme, setTheme] = useState<Theme>({});
  const [count, setCount] = useState(0);
  const [mode, setMode] = useState<Mode | null>(null);
  const [radius, setRadius] = useState(0);
  const [tolerance, setTolerance] = useState(0.25);
  const [keepOriginals, setKeepOriginals] = useState(false);
  const [active, setActive] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);

  // Dragging the radius fires continuously; only the last value is worth drawing.
  const pending = useRef<number | undefined>(undefined);

  const preview = useCallback((settings: Settings, debounce = false) => {
    if (pending.current !== undefined) clearTimeout(pending.current);
    pending.current = undefined;

    if (!debounce) {
      send({ type: "preview", settings });

      return;
    }

    pending.current = window.setTimeout(() => {
      pending.current = undefined;
      send({ type: "preview", settings });
    }, 90);
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message = event.data?.pluginMessage as PluginToUi | undefined;

      if (!message) return;

      if (message.type === "theme") {
        setTheme({ tokens: message.tokens, themeName: message.themeName });
        // Some library styles key off the dark class rather than the tokens.
        document.documentElement.classList.toggle("dark", !message.isLight);
      } else if (message.type === "selection") {
        setCount(message.count);
      } else if (message.type === "preview") {
        setActive(message.active);
        setStatus(message.message ? { ok: message.ok, message: message.message } : null);
      } else if (message.type === "applied") {
        setActive(false);
        setMode(null);
        setStatus(message.message ? { ok: message.ok, message: message.message } : null);
      }
    };

    const onHide = () => send({ type: "cancel" });

    window.addEventListener("message", onMessage);
    window.addEventListener("pagehide", onHide);
    send({ type: "ui-ready" });

    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("pagehide", onHide);
    };
  }, []);

  const pick = (next: Mode) => {
    const chosen = next === mode ? null : next;

    setMode(chosen);
    preview({ mode: chosen, radius, tolerance, keepOriginals });
  };

  const changeRadius = (next: number) => {
    setRadius(next);
    if (mode) preview({ mode, radius: next, tolerance, keepOriginals }, true);
  };

  const changeTolerance = (next: number) => {
    setTolerance(next);
    if (mode) preview({ mode, radius, tolerance: next, keepOriginals }, true);
  };

  const changeKeep = (next: boolean) => {
    setKeepOriginals(next);
    if (mode) preview({ mode, radius, tolerance, keepOriginals: next });
  };

  const cancel = () => {
    setMode(null);
    send({ type: "cancel" });
  };

  const ready = count >= 2;
  const blending = mode === "blend";

  return (
    <ThemeProvider tokens={theme.tokens} themeName={theme.themeName}>
      <div className="flex h-screen flex-col gap-3 bg-background p-3 text-foreground">
        <header className="flex items-center justify-between gap-2">
          <Label variant="title">Curve Ops</Label>
          <Badge variant={ready ? "secondary" : "outline"}>
            {count === 0 ? "Nothing selected" : `${count} path${count === 1 ? "" : "s"}`}
          </Badge>
        </header>

        <div className="grid grid-cols-2 gap-2">
          {MODES.map(({ mode: value, label, Icon, hint }) => (
            <Tooltip key={value} content={hint} side="bottom">
              <Button
                variant={mode === value ? "default" : "secondary"}
                disabled={!ready}
                aria-pressed={mode === value}
                onClick={() => pick(value)}
                className="h-auto flex-col gap-1.5 py-2.5"
              >
                <Icon />
                <span className="text-xs font-medium">{label}</span>
              </Button>
            </Tooltip>
          ))}
        </div>

        <Tooltip content="Fuse the selected paths into one shape, joined by arcs that meet each outline smoothly." side="bottom">
          <Button
            variant={blending ? "default" : "secondary"}
            disabled={!ready}
            aria-pressed={blending}
            onClick={() => pick("blend")}
            className="h-auto flex-col gap-1.5 py-2.5"
          >
            <BlendIcon />
            <span className="text-xs font-medium">Blend</span>
          </Button>
        </Tooltip>

        <div className={cn("flex items-center justify-between gap-2", !blending && "opacity-50")}>
          <Tooltip
            content="Radius of the bridging arcs, which touch both shapes tangentially. 0 auto-sizes to each gap; negative bows them outward."
            side="right"
          >
            <Label htmlFor="arc-radius">Arc radius</Label>
          </Tooltip>
          <div className="w-24">
            <NumberInput
              id="arc-radius"
              value={radius}
              onChange={changeRadius}
              min={-2000}
              max={2000}
              step={5}
              suffix="px"
              disabled={!blending}
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-2">
          <Tooltip
            content="Largest allowed deviation from the exact result. Higher values use fewer points; 0 keeps every one."
            side="right"
          >
            <Label htmlFor="tolerance">Tolerance</Label>
          </Tooltip>
          <div className="w-24">
            <NumberInput
              id="tolerance"
              value={tolerance}
              onChange={changeTolerance}
              min={0}
              max={5}
              step={0.05}
              decimals={2}
              suffix="px"
            />
          </div>
        </div>

        <Separator />

        <div className="flex items-center gap-2">
          <Checkbox
            id="keep-originals"
            size="sm"
            checked={keepOriginals}
            onCheckedChange={changeKeep}
          />
          <Label htmlFor="keep-originals" variant="inline">
            Keep originals
          </Label>
        </div>

        <p
          className={cn(
            "mt-auto min-h-8 text-xs leading-snug",
            status && !status.ok ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {status?.message ?? IDLE_HINT}
        </p>

        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="flex-1" disabled={!active} onClick={cancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="flex-1"
            disabled={!active}
            onClick={() => send({ type: "apply", keepOriginals })}
          >
            Apply
          </Button>
        </div>
      </div>
    </ThemeProvider>
  );
};
