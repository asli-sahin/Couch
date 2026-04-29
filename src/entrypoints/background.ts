import { defineBackground } from "wxt/utils/define-background"
import browser from "webextension-polyfill"
import { SOCKET_URL, SOCKET_EVENTS, type ControlMode } from "~/types/socket"
import { MESSAGE_STATUS, MESSAGE_TYPE } from "~/types/messaging"
import type { MessageKey } from "~/lib/i18n"
import type { State } from "~/types/state"
import { createPostHog, getSharedDistinctId } from "~/lib/posthog"
import type { PostHog } from "posthog-js/dist/module.no-external"

let posthog: PostHog

const TOP_FRAME_SUPPORT_SCRIPTS = [
  "chat.js",
  "reactions.js",
  "toast.js",
  "videoPlayer.js",
  "videoSelector.js"
]

const ALL_FRAME_SUPPORT_SCRIPTS = ["autoInject.js"]
const AUTO_ENABLE_DEBUG_SHIELD = false
const DEBUG_INJECT_FLOW = true
const SOCKET_FETCH_HEADERS = {
  "ngrok-skip-browser-warning": "true"
}

function logInjectDebug(source: string, extra?: Record<string, unknown>) {
  if (!DEBUG_INJECT_FLOW) return
  console.log(`[couch][inject-debug] ${source}`, extra ?? {})
}

function toOriginPattern(url?: string): string | null {
  if (!url) return null

  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null
    }
    return `${parsed.protocol}//${parsed.host}/*`
  } catch {
    return null
  }
}

function getDebugShieldRegistrationId(origin: string): string {
  return `synclify-debug-shield-${origin.replace(/[^a-z0-9]+/gi, "_").slice(0, 80)}`
}

type DebugShieldRegistrationResult = {
  origin: string | null
  registered: boolean
  alreadyRegistered?: boolean
  error?: string
}

async function injectSupportScripts(tabId: number): Promise<void> {
  await browser.scripting.executeScript({
    files: TOP_FRAME_SUPPORT_SCRIPTS,
    target: { tabId }
  })

  await browser.scripting.executeScript({
    files: ALL_FRAME_SUPPORT_SCRIPTS,
    target: { tabId, allFrames: true }
  })
}

async function injectMainWorldScripts(
  tabId: number,
  files: string[],
  frameIds?: number[]
): Promise<void> {
  await browser.scripting.executeScript({
    files,
    target: frameIds ? { tabId, frameIds } : { tabId, allFrames: true },
    world: "MAIN"
  })
}

async function setPersistentDebugShield(
  tabId: number,
  enabled: boolean
): Promise<DebugShieldRegistrationResult> {
  const tab = await browser.tabs.get(tabId)
  const origin = toOriginPattern(tab.url)
  if (!origin) return { origin: null, registered: false }

  const id = getDebugShieldRegistrationId(origin)

  if (!enabled) {
    try {
      await browser.scripting.unregisterContentScripts({ ids: [id] })
    } catch {
      // Ignore missing registrations.
    }
    return { origin, registered: false, alreadyRegistered: false }
  }

  try {
    const existing = await browser.scripting.getRegisteredContentScripts({
      ids: [id]
    })
    if (existing.length > 0) {
      return { origin, registered: true, alreadyRegistered: true }
    }
  } catch {
    // Continue and attempt a fresh registration below.
  }

  try {
    await browser.scripting.registerContentScripts([
      {
        id,
        js: ["debugShield.js"],
        matches: [origin],
        runAt: "document_start",
        allFrames: true,
        matchAboutBlank: true,
        matchOriginAsFallback: true,
        world: "MAIN",
        persistAcrossSessions: true
      }
    ])
    return { origin, registered: true, alreadyRegistered: false }
  } catch (error) {
    return {
      origin,
      registered: false,
      alreadyRegistered: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export default defineBackground(async () => {
  const bg = globalThis as typeof globalThis & {
    synclifyDebug?: {
      enableShield: (tabId?: number) => Promise<unknown>
      disableShield: (tabId?: number) => Promise<unknown>
      detectVideos: (tabId?: number) => Promise<unknown>
      getActiveTabId: () => Promise<number>
    }
  }

  async function autoEnableDebugShieldForTab(tabId?: number): Promise<void> {
    if (!AUTO_ENABLE_DEBUG_SHIELD) return
    if (!tabId) return

    try {
      const tab = await browser.tabs.get(tabId)
      if (!tab.url) return

      const origin = toOriginPattern(tab.url)
      if (!origin) return

      await handleSetDebugShield(true, tabId)
    } catch {
      // Best effort only.
    }
  }

  browser.runtime.onMessage.addListener((message) => {
    if (message.action === "getPosthogDistinctId") {
      return getSharedDistinctId("background")
    }

    return undefined
  })

  posthog = await createPostHog("background")

  // --- Persistent rooms: re-inject on full page navigation ---
  browser.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
    if (changeInfo.url) {
      await autoEnableDebugShieldForTab(tabId)
    }

    if (changeInfo.status !== "complete") return
    const result = await browser.storage.local.get("state")
    const state = result.state as State | undefined
    if (state && state[tabId]) {
      try {
        await reinjectTab(tabId)
      } catch {
        // Tab may not be ready yet, ignore
      }
    }
  })

  // --- Tab lifecycle ---
  browser.tabs.onRemoved.addListener((tabId) => {
    browser.storage.local.get("state").then((result) => {
      const state = result.state as State | undefined
      if (state === undefined)
        throw new Error(
          "State undefined in background worker tab closed callback"
        )
      delete state[tabId]
      browser.storage.local.set({ state })
    })
  })

  browser.runtime.onInstalled.addListener(async (details) => {
    if (
      details.reason === "update" &&
      details.previousVersion !== browser.runtime.getManifest().version
    ) {
      await browser.storage.local.remove("state")
      browser.runtime.reload()
    }
  })

  browser.tabs.onActivated.addListener(async ({ tabId }) => {
    await autoEnableDebugShieldForTab(tabId)
  })

  browser.tabs
    .query({
      active: true,
      currentWindow: true
    })
    .then(async (tabs) => {
      await autoEnableDebugShieldForTab(tabs[0]?.id)
    })
    .catch(() => {
      // Ignore startup probe failures.
    })

  // --- Message handlers (replaces Plasmo background/messages/) ---

  // Self-contained function injected into page context via executeScript.
  // Must not reference any outer scope — it gets serialized and run in the page.
  function detectPageVideos() {
    const SITE_VIDEO_SELECTORS: Record<
      string,
      {
        hostPatterns: RegExp[]
        videoSelector: string
        playerContainer: string
        excludeSelector?: string
        watchPageTest?: () => boolean
      }
    > = {
      netflix: {
        hostPatterns: [/netflix\.com$/],
        videoSelector: ".watch-video--player-view video",
        playerContainer: ".watch-video--player-view",
        watchPageTest: () => location.pathname.includes("/watch")
      },
      youtube: {
        hostPatterns: [/youtube\.com$/, /youtu\.be$/],
        videoSelector: "#movie_player video.html5-main-video",
        playerContainer: "#movie_player",
        watchPageTest: () => location.pathname.includes("/watch"),
        excludeSelector: ".ytp-ad-overlay-container video"
      },
      primevideo: {
        hostPatterns: [
          /primevideo\.com$/,
          /amazon\.(com|co\.\w+|de|fr|it|es|in|jp|br|ca|com\.au)$/
        ],
        videoSelector: ".dv-player-fullscreen video",
        playerContainer: ".dv-player-fullscreen",
        watchPageTest: () => !!document.querySelector(".dv-player-fullscreen")
      },
      disneyplus: {
        hostPatterns: [/disneyplus\.com$/],
        videoSelector: "#hudson-wrapper video",
        playerContainer: "#hudson-wrapper",
        watchPageTest: () => {
          const url = location.href
          return (
            url.includes("video") ||
            url.includes("/watch") ||
            url.includes("/play")
          )
        }
      },
      max: {
        hostPatterns: [/play\.max\.com$/, /play\.hbomax\.com$/],
        videoSelector:
          '[data-testid="playerContainer"] video:not([class^="mmn-screenVideo"])',
        playerContainer: '[data-testid="playerContainer"]',
        watchPageTest: () => location.href.includes("video/watch"),
        excludeSelector: '[class^="mmn-screenVideo"]'
      },
      hulu: {
        hostPatterns: [/hulu\.com$/],
        videoSelector: ".ContentPlayer video",
        playerContainer: ".ContentPlayer",
        watchPageTest: () => location.href.includes("watch"),
        excludeSelector: "#ad-video-player, #intro-video-player"
      },
      appletv: {
        hostPatterns: [/tv\.apple\.com$/],
        videoSelector: "#hudson-wrapper video",
        playerContainer: "#hudson-wrapper"
      },
      peacock: {
        hostPatterns: [/peacocktv\.com$/],
        videoSelector: "#hudson-wrapper video",
        playerContainer: "#hudson-wrapper"
      },
      crunchyroll: {
        hostPatterns: [/crunchyroll\.com$/],
        videoSelector: "#hudson-wrapper video",
        playerContainer: "#hudson-wrapper"
      },
      paramountplus: {
        hostPatterns: [/paramountplus\.com$/],
        videoSelector: "video",
        playerContainer: "body"
      },
      hotstar: {
        hostPatterns: [/hotstar\.com$/],
        videoSelector: "video",
        playerContainer: ".player-base"
      },
      mubi: {
        hostPatterns: [/mubi\.com$/],
        videoSelector: "video",
        playerContainer: ".player"
      }
    }

    const COMMERCIAL_PLAYER_SELECTORS = [
      ".watch-video--player-view",
      "#movie_player",
      ".dv-player-fullscreen",
      "#hudson-wrapper",
      '[data-testid="playerContainer"]',
      ".ContentPlayer",
      ".html5-video-player",
      ".video-player",
      ".jw-wrapper",
      ".vjs-player",
      ".plyr",
      ".mejs__container",
      ".flowplayer",
      ".video-js",
      "[data-player]",
      ".bitmovin-player",
      ".bmpui-ui-uicontainer",
      ".bmpui-container",
      ".shaka-video-container",
      ".theoplayer-container",
      ".fp-player",
      "[class*='brightcove']",
      ".avp-player",
      ".html5-main-video",
      "[data-uia='video-canvas']"
    ]

    /* Detect which streaming site we are on */
    const host = location.hostname
    let siteConfig: (typeof SITE_VIDEO_SELECTORS)[string] | null = null
    let detectedSite = "unknown"
    for (const [site, config] of Object.entries(SITE_VIDEO_SELECTORS)) {
      if (config.hostPatterns.some((p) => p.test(host))) {
        siteConfig = config
        detectedSite = site
        break
      }
    }

    /* If on a known site, skip watch-page test failures */
    if (siteConfig?.watchPageTest && !siteConfig.watchPageTest()) {
      return []
    }

    /* Helper: does a video have playable content? */
    const isPlayable = (video: HTMLVideoElement) => {
      const sourceChild = video.querySelector(
        "source"
      ) as HTMLSourceElement | null
      const src = video.currentSrc || video.src || sourceChild?.src || ""
      return (
        video.srcObject !== null ||
        src !== "" ||
        video.videoWidth > 0 ||
        video.readyState > 0
      )
    }

    /* Find candidate videos */
    let candidates: HTMLVideoElement[]
    if (siteConfig) {
      // Use site-specific selector for more precise matching
      candidates = Array.from(
        document.querySelectorAll<HTMLVideoElement>(siteConfig.videoSelector)
      )
      // Filter out excluded elements (ads, overlays, etc.)
      if (siteConfig.excludeSelector) {
        const excludeSel = siteConfig.excludeSelector
        candidates = candidates.filter((v) => !v.matches(excludeSel))
      }
      // If site-specific selector returned nothing, fall back to all videos
      if (candidates.length === 0) {
        candidates = Array.from(document.getElementsByTagName("video"))
      }
    } else {
      candidates = Array.from(document.getElementsByTagName("video"))
    }

    return candidates
      .map((video) => {
        if (!isPlayable(video)) return null
        if (!video.dataset.synclifyId)
          video.dataset.synclifyId = Math.random().toString(36).slice(2, 7)

        const sourceChild = video.querySelector(
          "source"
        ) as HTMLSourceElement | null
        const src = video.currentSrc || video.src || sourceChild?.src || ""

        /* Decide whether Couch should show its own player controls.
           On known streaming sites, always false (their UI is better). */
        let needsCustomPlayer = false
        if (detectedSite === "unknown") {
          const hasNativeControls = video.hasAttribute("controls")
          const isNotLooping = !video.loop
          const isVisible = video.videoWidth > 0
          const isLongEnough = video.duration > 10 || isNaN(video.duration)
          const insideCommercialPlayer = COMMERCIAL_PLAYER_SELECTORS.some(
            (sel) => video.closest(sel) !== null
          )
          needsCustomPlayer =
            hasNativeControls &&
            isNotLooping &&
            isVisible &&
            isLongEnough &&
            !insideCommercialPlayer
        }

        return {
          src,
          duration: video.duration,
          width: video.videoWidth,
          height: video.videoHeight,
          title: document.title,
          id: video.dataset.synclifyId,
          needsCustomPlayer,
          streamingSite: detectedSite
        }
      })
      .filter((video) => video !== null)
  }

  async function handleGetTabId(): Promise<number> {
    const tabs = await browser.tabs.query({
      active: true,
      currentWindow: true
    })
    if (tabs.length === 0) throw new Error("No active tab found")
    return tabs[0].id as number
  }

  type DebugVideoReport = {
    id: string | null
    src: string
    currentSrc: string
    readyState: number
    width: number
    height: number
    duration: number | null
    paused: boolean
    controls: boolean
  }

  type DebugFrameReport = {
    url: string
    title: string
    readyState: string
    frameElement: string | null
    iframeCount: number
    videoCount: number
    videos: DebugVideoReport[]
    iframes: Array<{
      src: string | null
      id: string | null
      className: string | null
      width: number
      height: number
    }>
  }

  function inspectFrameForDebug(): DebugFrameReport {
    const videos = Array.from(document.querySelectorAll("video")).map(
      (video) => ({
        id: video.dataset.synclifyId ?? null,
        src: video.getAttribute("src") ?? "",
        currentSrc: video.currentSrc ?? "",
        readyState: video.readyState,
        width: video.videoWidth,
        height: video.videoHeight,
        duration: Number.isFinite(video.duration) ? video.duration : null,
        paused: video.paused,
        controls: video.hasAttribute("controls")
      })
    )

    const iframes = Array.from(document.querySelectorAll("iframe")).map(
      (iframe) => ({
        src: iframe.getAttribute("src"),
        id: iframe.id || null,
        className: iframe.className || null,
        width: iframe.clientWidth,
        height: iframe.clientHeight
      })
    )

    const frameElement =
      window.frameElement instanceof HTMLIFrameElement
        ? window.frameElement.getAttribute("src")
        : null

    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      frameElement,
      iframeCount: iframes.length,
      videoCount: videos.length,
      videos,
      iframes
    }
  }

  async function getActiveTabIdOrThrow(tabId?: number): Promise<number> {
    if (tabId) return tabId
    return handleGetTabId()
  }

  async function handleDebugDetectVideos(tabId?: number) {
    const activeTabId = await getActiveTabIdOrThrow(tabId)
    await injectSupportScripts(activeTabId)

    const [detectedVideos, frameSnapshots] = await Promise.all([
      browser.scripting.executeScript({
        func: detectPageVideos,
        target: { tabId: activeTabId, allFrames: true }
      }),
      browser.scripting.executeScript({
        func: inspectFrameForDebug,
        target: { tabId: activeTabId, allFrames: true }
      })
    ])

    return frameSnapshots.map((snapshot) => {
      const matchedVideos = detectedVideos.find(
        (candidate) => candidate.frameId === snapshot.frameId
      )

      return {
        frameId: snapshot.frameId,
        detectedVideos: Array.isArray(matchedVideos?.result)
          ? matchedVideos.result
          : [],
        frame:
          snapshot.result && typeof snapshot.result === "object"
            ? snapshot.result
            : null
      }
    })
  }

  async function handleSetDebugShield(
    enabled: boolean,
    tabId?: number
  ): Promise<{
    persistentRegistration: DebugShieldRegistrationResult
    reloaded: boolean
    frames: Array<{
      frameId: number
      state: unknown
    }>
  }> {
    const activeTabId = await getActiveTabIdOrThrow(tabId)
    const persistentRegistration = await setPersistentDebugShield(
      activeTabId,
      enabled
    )
    await injectMainWorldScripts(activeTabId, ["debugShield.js"])

    const results = await browser.scripting.executeScript({
      target: { tabId: activeTabId, allFrames: true },
      world: "MAIN",
      args: [enabled],
      func: (shouldEnable: boolean) => {
        const api = (
          window as Window & {
            __synclifyDebugShield?: {
              enable: () => unknown
              disable: () => unknown
            }
          }
        ).__synclifyDebugShield

        if (!api) return null
        return shouldEnable ? api.enable() : api.disable()
      }
    })

    const frames = results.map((result) => ({
      frameId: result.frameId,
      state: result.result
    }))

    const shouldReload =
      enabled &&
      persistentRegistration.registered &&
      !persistentRegistration.alreadyRegistered
    if (shouldReload) {
      try {
        await browser.tabs.reload(activeTabId)
      } catch {
        // Best effort; the current page is already patched as a fallback.
      }
    }

    return {
      persistentRegistration,
      reloaded: shouldReload,
      frames
    }
  }

  async function handleCreateRoom(): Promise<string> {
    const res = await fetch(`${SOCKET_URL}/create`, {
      headers: SOCKET_FETCH_HEADERS
    })
    const code = await res.text()
    if (!res.ok) {
      const e = new Error(
        `Failed to fetch room code from socket server: ${JSON.stringify({ code: res.status, statusText: res.statusText, body: code })}`
      )
      posthog.captureException(e)
    }
    return code
  }

  async function handleShouldInject(senderTabId?: number): Promise<boolean> {
    let tabId = senderTabId
    if (tabId === undefined) {
      const tabs = await browser.tabs.query({
        active: true,
        currentWindow: true
      })
      tabId = tabs[0]?.id
    }
    if (!tabId) return false
    const result = await browser.storage.local.get("state")
    const rooms = result.state as State | undefined
    return !!(rooms && rooms[tabId])
  }

  interface Video {
    src: string
    duration: number
    width: number
    height: number
    title: string
    id: string
    needsCustomPlayer: boolean
    streamingSite: string
  }

  async function handleInject(body?: {
    frameIds?: number[]
    videoId?: string
    needsCustomPlayer?: boolean
    tabId?: number
    roomId?: string
    nickname?: string
    controlMode?: ControlMode
    participantId?: string
  }) {
    const wait = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms))

    const providedTabId = body?.tabId
    const tabs = providedTabId
      ? [await browser.tabs.get(providedTabId)]
      : await browser.tabs.query({
          active: true,
          currentWindow: true
        })
    const tabId = tabs[0]?.id
    if (!tabId) throw new Error("Tab id is undefined")
    logInjectDebug("handleInject.start", {
      tabId,
      providedTabId,
      body
    })

    const activeTabUrl = tabs[0].url ?? ""
    const isInjectableUrl = /^https?:\/\//.test(activeTabUrl)
    logInjectDebug("handleInject.tab", { tabId, activeTabUrl, isInjectableUrl })
    if (!isInjectableUrl) {
      const storageResult = await browser.storage.local.get("state")
      const tabState = (storageResult.state as State | undefined)?.[tabId]
      const roomId = tabState?.roomId
      let fallbackUrl = "https://example.com/"

      if (roomId) {
        try {
          const response = await fetch(
            `${SOCKET_URL}/room/${encodeURIComponent(roomId)}/url`,
            {
              headers: SOCKET_FETCH_HEADERS
            }
          )
          if (response.ok) {
            const json = (await response.json()) as { url?: string }
            if (
              json.url &&
              (json.url.startsWith("http://") || json.url.startsWith("https://"))
            ) {
              fallbackUrl = json.url
            }
          }
        } catch {
          // Keep default fallback when room host URL is unavailable.
        }
      }
      logInjectDebug("handleInject.nonInjectable.redirect", {
        tabId,
        roomId,
        fallbackUrl
      })

      await browser.tabs.update(tabId, { url: fallbackUrl })
      await new Promise<void>((resolve) => {
        const onUpdated = (
          updatedTabId: number,
          changeInfo: browser.Tabs.OnUpdatedChangeInfoType
        ) => {
          if (updatedTabId !== tabId || changeInfo.status !== "complete") return
          browser.tabs.onUpdated.removeListener(onUpdated)
          resolve()
        }
        browser.tabs.onUpdated.addListener(onUpdated)
      })
    }

    await injectSupportScripts(tabId)

    let frameIds = body?.frameIds ?? null
    let videoId: string | null = null
    let needsCustomPlayer = true
    let noVideoFallback = false

    if (!frameIds) {
      let videos: Array<Video & { frameId: number }> = []
      for (let attempt = 0; attempt < 6 && videos.length === 0; attempt++) {
        const result = await browser.scripting.executeScript({
          func: detectPageVideos,
          target: { tabId: tabId, allFrames: true }
        })

        videos = result
          .filter(
            (injection) =>
              Array.isArray(injection.result) && injection.result.length !== 0
          )
          .flatMap((injection) =>
            Array.from(injection.result as Video[]).map((video) => {
              return {
                ...video,
                frameId: injection.frameId
              }
            })
          )

        if (videos.length === 0 && attempt < 5) {
          await wait(750)
        }
        logInjectDebug("handleInject.videoProbe", {
          tabId,
          attempt,
          foundCount: videos.length,
          videos: videos.map((video) => ({
            frameId: video.frameId,
            id: video.id,
            streamingSite: video.streamingSite,
            src: video.src?.slice(0, 120)
          }))
        })
      }

      if (videos.length > 1) {
        browser.tabs.sendMessage(tabId, {
          to: "videoSelector",
          videos: videos
        })
        return {
          status: MESSAGE_STATUS.MULTIPLE_VIDEOS,
          messageKey: "multipleVideosDetected"
        }
      } else if (videos.length === 1) {
        frameIds = [videos[0].frameId]
        videoId = videos[0].id
        needsCustomPlayer = videos[0].needsCustomPlayer
        logInjectDebug("handleInject.singleVideo", {
          tabId,
          frameId: frameIds[0],
          videoId
        })
      } else {
        // No detectable video yet (SPA may mount late). Inject only the top frame:
        // injecting into every iframe spawns duplicate sockets/participant joins and breaks
        // host URL sync, connection state, and post-navigation recovery on YouTube.
        noVideoFallback = true
        frameIds = [0]
        videoId = ""
        needsCustomPlayer = false
        logInjectDebug("handleInject.noVideoFallback", {
          tabId,
          primaryFrameId: frameIds[0]
        })
      }
    }

    if (!frameIds?.length) {
      logInjectDebug("handleInject.missingFrameIds", { tabId })
      return {
        status: MESSAGE_STATUS.ERROR,
        messageKey: "injectedScriptNotReadyRetrySync"
      }
    }

    // Inject the unlisted content script only into targeted frame(s).
    await browser.scripting.executeScript({
      files: ["injected.js"],
      target: { tabId: tabId, frameIds: frameIds }
    })

    const resolvedVideoId = body?.videoId ?? videoId ?? ""
    const initPayload = {
      type: MESSAGE_TYPE.INIT,
      videoId: resolvedVideoId,
      roomId: body?.roomId,
      nickname: body?.nickname,
      controlMode: body?.controlMode,
      participantId: body?.participantId
    }
    let initSucceeded = false
    let initResponse: unknown = null
    const primaryFrameId = frameIds[0]
    for (let attempt = 0; attempt < 6 && !initSucceeded; attempt++) {
      try {
        initResponse = await browser.tabs.sendMessage(tabId, initPayload, {
          frameId: primaryFrameId
        })
        initSucceeded = true
        logInjectDebug("handleInject.init.targeted.success", {
          tabId,
          frameId: primaryFrameId,
          noVideoFallback,
          attempt,
          response: initResponse as Record<string, unknown>
        })
      } catch {
        logInjectDebug("handleInject.init.targeted.retry", {
          tabId,
          frameId: primaryFrameId,
          noVideoFallback,
          attempt
        })
        await wait(200)
      }
    }
    // Fallback: some iframe-heavy pages may reject targeted frame messaging
    // even though injected script exists in another frame.
    if (!initSucceeded) {
      for (let attempt = 0; attempt < 3 && !initSucceeded; attempt++) {
        try {
          initResponse = await browser.tabs.sendMessage(tabId, initPayload)
          initSucceeded = true
          logInjectDebug("handleInject.init.broadcast.success", {
            tabId,
            response: initResponse as Record<string, unknown>
          })
        } catch {
          logInjectDebug("handleInject.init.broadcast.retry", { tabId, attempt })
          await wait(150)
        }
      }
    }
    if (!initSucceeded) {
      logInjectDebug("handleInject.init.failed", { tabId, initPayload })
      return {
        status: MESSAGE_STATUS.ERROR,
        messageKey: "injectedScriptNotReadyRetrySync"
      }
    }

    // Notify the video player content script to attach custom controls
    // Only show custom player for native videos not inside commercial players
    const selectedVideoId = body?.videoId ?? videoId
    const showCustomPlayer = body
      ? (body.needsCustomPlayer ?? needsCustomPlayer)
      : needsCustomPlayer
    if (selectedVideoId && showCustomPlayer) {
      await injectMainWorldScripts(tabId, ["fullscreenPatch.js"], frameIds)
      setTimeout(() => {
        browser.tabs
          .sendMessage(tabId, {
            to: "videoPlayer",
            videoId: selectedVideoId
          })
          .catch(() => {
            /* videoPlayer content script may not be ready yet */
          })
      }, 300)
    }

    return (initResponse as { status?: MESSAGE_STATUS } | null) ?? {
      status: MESSAGE_STATUS.SUCCESS
    }
  }

  async function handleShowToast(
    body: {
      error?: boolean
      content: string
      show?: boolean
      messageKey?: MessageKey
    },
    senderTabId?: number
  ) {
    let id = senderTabId
    if (!id) {
      const tabs = await browser.tabs.query({
        active: true,
        currentWindow: true
      })
      id = tabs[0].id as number
    }
    await injectSupportScripts(id)
    browser.tabs.sendMessage(id, {
      to: "toast",
      error: body.error,
      content: body.content,
      messageKey: body.messageKey,
      show: body.show ?? true
    })
    return null
  }

  function getTelemetryHost(url?: string): string | null {
    if (!url) return null

    try {
      return new URL(url).host
    } catch {
      return null
    }
  }

  async function handleOverlayTelemetry(
    body: {
      event: "chat_opened" | "chat_used" | "reaction_used"
      surface: "overlay" | "emoji_bar"
      firstInteraction?: "incoming" | "outgoing"
    },
    sender: browser.Runtime.MessageSender
  ) {
    const properties: Record<string, string> = {
      surface: body.surface
    }
    const pageHost = getTelemetryHost(sender.tab?.url)

    if (pageHost) {
      properties.page_host = pageHost
    }

    if (body.firstInteraction) {
      properties.first_interaction = body.firstInteraction
    }

    posthog.capture(body.event, properties)
    return null
  }

  /**
   * After a full navigation (e.g. client URL-sync redirect), the injected script is gone.
   * Re-run the same inject path used from the popup so INIT receives room credentials and we
   * only inject once (no allFrames duplicate joins / ROOM_ERROR / clearTabState).
   */
  async function reinjectTab(tabId: number): Promise<void> {
    const wait = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms))

    const snapshot = await browser.storage.local.get("state")
    const persisted = snapshot.state as State | undefined
    const tabState = persisted?.[tabId]

    if (!tabState?.roomId) {
      logInjectDebug("reinjectTab.skip.noRoomInStorage", { tabId })
      return
    }
    // Join flow always assigns participantId before syncing; reconnect needs the same identity.
    if (!tabState.participantId) {
      logInjectDebug("reinjectTab.skip.noParticipantId", { tabId })
      return
    }

    let lastStatus: MESSAGE_STATUS | undefined

    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        await wait(520 * attempt)
      }
      try {
        const response = await handleInject({
          tabId,
          roomId: tabState.roomId,
          nickname: tabState.nickname,
          participantId: tabState.participantId,
          controlMode: tabState.controlMode
        })

        lastStatus =
          (response as { status?: MESSAGE_STATUS } | undefined)?.status ??
          MESSAGE_STATUS.SUCCESS

        logInjectDebug("reinjectTab.attempt", {
          tabId,
          attempt,
          status: lastStatus,
          roomId: tabState.roomId
        })

        if (lastStatus !== MESSAGE_STATUS.ERROR) {
          logInjectDebug("reinjectTab.complete", {
            tabId,
            roomId: tabState.roomId
          })
          return
        }
      } catch (error) {
        logInjectDebug("reinjectTab.attempt.catch", {
          tabId,
          attempt,
          error,
          roomId: tabState.roomId
        })
      }
    }

    logInjectDebug("reinjectTab.exhaustedRetries", {
      tabId,
      roomId: tabState.roomId,
      lastStatus
    })
  }

  bg.synclifyDebug = {
    enableShield: (tabId?: number) => handleSetDebugShield(true, tabId),
    disableShield: (tabId?: number) => handleSetDebugShield(false, tabId),
    detectVideos: (tabId?: number) => handleDebugDetectVideos(tabId),
    getActiveTabId: () => handleGetTabId()
  }

  // Central message router
  browser.runtime.onMessage.addListener((message, sender) => {
    switch (message.action) {
      case "getTabId":
        return sender.tab?.id ?? handleGetTabId()
      case "getTabUrl": {
        const requestedTabId =
          typeof message.tabId === "number" ? message.tabId : sender.tab?.id
        if (!requestedTabId) return sender.tab?.url
        return browser.tabs
          .get(requestedTabId)
          .then((tab) => tab.url)
          .catch(() => sender.tab?.url)
      }
      case "createRoom":
        return handleCreateRoom()
      case "shouldInject":
        return handleShouldInject(sender.tab?.id)
      case "inject":
        return handleInject(message.body)
      case "debugDetectVideos":
        return handleDebugDetectVideos(sender.tab?.id)
      case "enableDebugShield":
        return handleSetDebugShield(true, sender.tab?.id)
      case "disableDebugShield":
        return handleSetDebugShield(false, sender.tab?.id)
      case "showToast":
        return handleShowToast(message.body, sender.tab?.id)
      case "trackChatTelemetry":
        return handleOverlayTelemetry(
          { ...message.body, surface: "overlay" },
          sender
        )
      case "trackReactionTelemetry":
        return handleOverlayTelemetry(
          { ...message.body, surface: "emoji_bar" },
          sender
        )
      case "chatMessage": {
        // Relay from chat content script -> injected script
        const chatTabId = sender.tab?.id
        if (chatTabId) {
          browser.tabs.sendMessage(chatTabId, {
            type: MESSAGE_TYPE.CHAT,
            text: message.body.text
          })
        }
        return Promise.resolve(null)
      }
      case "reaction": {
        // Relay from reactions content script -> injected script
        const reactionTabId = sender.tab?.id
        if (reactionTabId) {
          browser.tabs.sendMessage(reactionTabId, {
            type: MESSAGE_TYPE.REACTION,
            emoji: message.body.emoji
          })
        }
        return Promise.resolve(null)
      }
      case "forwardToChat": {
        // Relay from injected script -> chat content script
        const fwdChatTabId = sender.tab?.id
        if (fwdChatTabId) {
          browser.tabs.sendMessage(fwdChatTabId, {
            to: "chat",
            type: "incoming",
            nickname: message.nickname,
            text: message.text,
            timestamp: message.timestamp,
            self: message.self
          })
        }
        return Promise.resolve(null)
      }
      case "forwardToReaction": {
        // Relay from injected script -> reactions content script
        const fwdReactionTabId = sender.tab?.id
        if (fwdReactionTabId) {
          browser.tabs.sendMessage(fwdReactionTabId, {
            to: "reaction",
            emoji: message.emoji,
            nickname: message.nickname
          })
        }
        return Promise.resolve(null)
      }
      default:
        return undefined
    }
  })
})
