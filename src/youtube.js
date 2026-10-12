// LocalBlock YouTube ad skipper (runs in the page, MAIN world, at document_start).
//
// YouTube now holds back the video for roughly the ad's length when its ad data has been
// stripped out, which shows up as a spinner. So on YouTube, LocalBlock lets the ad load and
// gets rid of it as soon as it starts instead: mute it, hide it, press Skip when offered,
// and jump to the end of the ad (or play it at 16x when it's stitched into the video
// stream itself). Everything is restored the moment the ad ends.

(() => {
  if (window.__localBlockYouTube) return;
  window.__localBlockYouTube = true;

  const SKIP_BUTTONS = [
    ".ytp-skip-ad-button",
    ".ytp-ad-skip-button",
    ".ytp-ad-skip-button-modern",
    ".ytp-ad-skip-button-slot button",
    "button.ytp-ad-skip-button-container",
  ].join(",");
  const AD_CLASSES = ["ad-showing", "ad-interrupting"];

  let inAd = false;
  let saved = null; // the viewer's own settings, restored after the ad
  let observedPlayer = null;
  let classObserver = null;

  const playerEl = () => document.getElementById("movie_player") || document.querySelector(".html5-video-player");

  function isAd(player) {
    return !!player && AD_CLASSES.some((c) => player.classList.contains(c));
  }

  // Stitched ads (server-side ad insertion) live in the same stream as the video, so the
  // <video> element's duration is the whole thing: never seek to its end in that case.
  function isStitched(player) {
    try {
      const info = player.getStatsForNerds?.()?.debug_info || "";
      return info.startsWith("SSAP");
    } catch {
      return false;
    }
  }

  function enterAd(player, video) {
    if (!inAd) {
      inAd = true;
      saved = { muted: video.muted, rate: video.playbackRate === 16 ? 1 : video.playbackRate };
    }
    video.muted = true;
    video.style.setProperty("opacity", "0", "important");
    player.style.setProperty("--localblock-ad", "1");

    const skip = player.querySelector(SKIP_BUTTONS) || document.querySelector(SKIP_BUTTONS);
    if (skip) {
      skip.click();
      return;
    }
    try {
      video.playbackRate = 16;
    } catch {}
    if (!isStitched(player) && Number.isFinite(video.duration) && video.duration > 0) {
      try {
        if (video.currentTime < video.duration - 0.25) video.currentTime = video.duration - 0.1;
      } catch {}
    }
  }

  function leaveAd(video) {
    if (!inAd) return;
    inAd = false;
    if (video) {
      video.style.removeProperty("opacity");
      if (saved) {
        try {
          video.playbackRate = saved.rate || 1;
        } catch {}
        video.muted = saved.muted;
      }
    }
    playerEl()?.style.removeProperty("--localblock-ad");
    saved = null;
  }

  function check() {
    const player = playerEl();
    if (!player) return;
    watchPlayer(player);
    const video = player.querySelector("video");
    if (!video) return;
    if (isAd(player)) enterAd(player, video);
    else leaveAd(video);
  }

  // React the instant YouTube flips the player into or out of ad mode.
  function watchPlayer(player) {
    if (observedPlayer === player) return;
    classObserver?.disconnect();
    observedPlayer = player;
    classObserver = new MutationObserver(check);
    classObserver.observe(player, { attributes: true, attributeFilter: ["class"] });
  }

  // Skip buttons and the player itself appear later; also catch those.
  const domObserver = new MutationObserver(() => {
    if (!observedPlayer || inAd) check();
  });
  const start = () => {
    domObserver.observe(document.documentElement, { childList: true, subtree: true });
    check();
  };
  if (document.documentElement) start();
  else document.addEventListener("readystatechange", start, { once: true });

  // Safety net for anything the observers miss (e.g. a skip button that appears mid-ad).
  setInterval(() => {
    if (inAd || isAd(playerEl())) check();
  }, 250);
})();
