/** Messages exchanged between the plugin sandbox and the UI iframe. */

export type Mode = 'union' | 'subtract' | 'intersect' | 'exclude' | 'blend';

/** Everything the preview depends on. Any change rebuilds it. */
export interface Settings {
  mode: Mode | null;
  radius: number;
  /** Max deviation of the fitted result, in scene units. 0 keeps every vertex. */
  tolerance: number;
  keepOriginals: boolean;
}

/** UI -> plugin. Must be sent wrapped: `{ pluginMessage: ... }`. */
export type UiToPlugin =
  | { type: 'ui-ready' }
  | { type: 'preview'; settings: Settings }
  | { type: 'apply'; keepOriginals: boolean }
  | { type: 'cancel' };

/** Plugin -> UI. Arrives wrapped in `event.data.pluginMessage`. */
export type PluginToUi =
  | { type: 'theme'; tokens: Record<string, string>; themeName: string; isLight: boolean }
  | { type: 'selection'; count: number }
  | { type: 'preview'; active: boolean; ok: boolean; message: string }
  | { type: 'applied'; ok: boolean; message: string };
