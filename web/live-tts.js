// live-tts.js — Browser-native TTS tracker for Nio WebUI
// Only createLiveResponseTracker is used (by web/index.html). TTS speaking
// itself is handled inline there via the browser's SpeechSynthesis API.

/**
 * Creates a tracker for streamed response text. update() receives the FULL
 * accumulated buffer (the caller passes its own running total, not per-token
 * chunks) — so this REPLACES, it does not append. Returns the complete text
 * when finished.
 */
export function createLiveResponseTracker() {
  let active = false;
  let response = "";
  return {
    begin() {
      active = true;
      response = "";
    },
    update(text) {
      // Non-strings are ignored: a mistaken tracker.update(evt) (the whole
      // SSE event instead of evt.text) would otherwise be spoken as
      // "[object Object]". Failing quietly beats failing audibly.
      if (active && typeof text === "string") response = text;
    },
    finish() {
      // The line formatter appends \n to every line — trim so TTS doesn't
      // pause on trailing whitespace.
      if (!active) return "";
      active = false;
      const finished = response.trim();
      response = "";
      return finished;
    },
    cancel() {
      active = false;
      response = "";
    },
  };
}
