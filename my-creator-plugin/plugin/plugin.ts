import type { Settings, UiToPlugin } from '../shared/messages';
import {
  applyPreview,
  cancelPreview,
  describeSelection,
  hasPreview,
  refreshPreview,
  sweepOrphans,
} from './curve-ops';

creator.ui.show({ width: 288, height: 504 });

// The last settings the UI asked for, so a selection change can rebuild.
let current: Settings = { mode: null, radius: 0, tolerance: 0.25, keepOriginals: false };

function sendTheme(theme: ThemeTokens): void {
  creator.ui.postMessage({
    type: 'theme',
    tokens: theme.tokens,
    themeName: theme.themeName,
    isLight: theme.isLight,
  });
}

function sendSelection(): void {
  creator.ui.postMessage({ type: 'selection', count: describeSelection().count });
}

function rebuild(): void {
  let result;

  try {
    result = refreshPreview(current.mode, current.radius, current.tolerance, current.keepOriginals);
  } catch (error) {
    console.error('Curve Ops preview failed', error);
    cancelPreview();
    result = { active: false, ok: false, message: 'That combination failed on these paths.' };
  }

  creator.ui.postMessage({
    type: 'preview',
    active: result.active,
    ok: result.ok,
    message: result.message,
  });
}

creator.ui.onMessage((msg: UiToPlugin) => {
  switch (msg.type) {
    case 'ui-ready': {
      // A previous session may have closed with a preview still on the canvas.
      sweepOrphans();
      sendTheme(creator.ui.theme);
      sendSelection();
      break;
    }

    case 'preview': {
      current = msg.settings;
      rebuild();
      break;
    }

    case 'apply': {
      let result;

      try {
        result = applyPreview(msg.keepOriginals);
      } catch (error) {
        console.error('Curve Ops apply failed', error);
        result = { ok: false, message: 'Applying failed; the preview was left in place.' };
      }

      current = { ...current, mode: null };
      creator.ui.postMessage({ type: 'applied', ok: result.ok, message: result.message });
      sendSelection();
      break;
    }

    case 'cancel': {
      const result = cancelPreview();

      current = { ...current, mode: null };

      creator.ui.postMessage({ type: 'applied', ok: result.ok, message: result.message });
      sendSelection();
      break;
    }
  }
});

creator.on('change:theme', (theme) => {
  sendTheme(theme);
});

creator.on('selection:nodes', () => {
  sendSelection();
  // The preview is built from the selection, so it has to follow it.
  if (current.mode !== null || hasPreview()) rebuild();
});
