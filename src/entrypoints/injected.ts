import { defineUnlistedScript } from "wxt/utils/define-unlisted-script"
import { MESSAGE_STATUS, MESSAGE_TYPE } from "~/types/messaging"
import type { ExtMessage, ChatMessage } from "~/types/messaging"
import {
  type ControlMode,
  SOCKET_EVENTS,
  SOCKET_URL,
  type JoinRoomPayload,
  type LeaveRoomPayload,
  type RoomErrorPayload,
  type RoomState
} from "~/types/socket"
import type { State, TabState } from "~/types/state"
import { VIDEO_EVENTS } from "~/types/video"
import { findSiteVideo, detectStreamingSite, getSiteConfig } from "~/lib/video-detection"
import { debugRoomLog } from "~/lib/debug"
import browser from "webextension-polyfill"
import { io } from "socket.io-client"
import { createPostHog } from "~/lib/posthog"

declare global {
  interface Window {
    __synclifyInjected?: boolean
  }
}

export default defineUnlistedScript(async () => {
  if (window.__synclifyInjected) return
  window.__synclifyInjected = true

  const posthog = await createPostHog("injected")
  const TRACKED_MULTI_PARTICIPANT_ROOMS_STORAGE_KEY =
    "tracked_multi_participant_rooms"
  const MAX_TRACKED_MULTI_PARTICIPANT_ROOMS = 200
  const ROOM_URL_SYNC_REQUEST = "__COUCH_ROOM_URL_REQUEST__"
  const ROOM_URL_SYNC_PREFIX = "__COUCH_ROOM_URL__:"

  /** Treats query param order/spacing drift as identical (helps YouTube redirects). */
  const urlsPlaybackEquivalent = (a: string, b: string): boolean => {
    try {
      const ua = new URL(a)
      const ub = new URL(b)
      if (ua.origin !== ub.origin) return false
      const normalizePathname = (path: string) =>
        path !== "/" ? path.replace(/\/$/, "") : "/"
      if (normalizePathname(ua.pathname) !== normalizePathname(ub.pathname)) {
        return false
      }
      const sa = [...new URLSearchParams(ua.search).entries()].sort(
        (x, y) => x[0].localeCompare(y[0]) || x[1].localeCompare(y[1])
      )
      const sb = [...new URLSearchParams(ub.search).entries()].sort(
        (x, y) => x[0].localeCompare(y[0]) || x[1].localeCompare(y[1])
      )
      return JSON.stringify(sa) === JSON.stringify(sb)
    } catch {
      return a === b
    }
  }

  function logRoomDebug(
    source: string,
    details?: {
      roomId?: string
      participantId?: string
      participantCount?: number
      participants?: Array<{ id: string; nickname: string; isHost: boolean }>
      extra?: Record<string, unknown>
    }
  ) {
    debugRoomLog("injected", {
      source,
      at: new Date().toISOString(),
      tabId,
      roomId: details?.roomId ?? roomCode,
      participantId: details?.participantId ?? state?.[tabId]?.participantId,
      participantCount: details?.participantCount,
      participants:
        details?.participants?.map((participant) => ({
          id: participant.id,
          nickname: participant.nickname,
          isHost: participant.isHost
        })) ?? state?.[tabId]?.participants,
      extra: details?.extra
    })
  }

  let tabId: number
  let roomCode: string
  let state: State
  let video: HTMLVideoElement | null | undefined
  let boundVideo: HTMLVideoElement | null = null
  let suppressEventsUntil = 0
  let lastAppliedRemoteEventTimestamp = 0
  let joinedRoom: string | null = null
  let activeRoomState: RoomState | null = null
  let pendingJoinPromise:
    | Promise<{ status: MESSAGE_STATUS; message?: string }>
    | null = null
  let pendingInitPromise:
    | Promise<{ status: MESSAGE_STATUS; message?: string; messageKey?: string }>
    | null = null
  let pendingConnectPromise: Promise<void> | null = null
  let connectRequestedByJoin = false
  let isExitingRoom = false
  let settings: { syncAudio: boolean } | undefined
  let canonicalPageUrl: string | undefined
  let videoNotFoundToastShown = false
  let teardownRemotePlaybackGesture: (() => void) | null = null
  const SYNTHETIC_SUPPRESSION_MS = 400

  // ----- Host-only control lock state -----
  type SyncedHostState = {
    paused: boolean
    currentTime: number
    syncedAt: number
    playbackRate: number
  }
  let lastSyncedHostState: SyncedHostState | null = null
  let controlLockOverlay: HTMLDivElement | null = null
  let controlLockKeyboardHandler: ((e: KeyboardEvent) => void) | null = null

  const clearPlaybackGestureListeners = () => {
    teardownRemotePlaybackGesture?.()
    teardownRemotePlaybackGesture = null
  }

  // ----- Control lock: blocks mouse/touch via overlay + keyboard shortcuts -----

  /**
   * Returns true when the keyboard event originates from a text input field.
   * Uses composedPath() to pierce Shadow DOM boundaries (e.g. the chat textarea).
   */
  const isTypingTarget = (e: KeyboardEvent): boolean => {
    const target = (e.composedPath()[0] ?? e.target) as HTMLElement | null
    if (!target) return false
    const tag = target.tagName
    return tag === "INPUT" || tag === "TEXTAREA" || !!target.isContentEditable
  }

  /**
   * Keys that affect playback position or play/pause state.
   * These are intercepted at the window capture phase so the site never
   * receives them when a non-host is in host-only control mode.
   */
  const BLOCKED_MEDIA_KEYS = new Set([
    " ", // Space — play/pause (most sites)
    "k", "K", // YouTube play/pause
    "j", "J", // YouTube back 10 s
    "l", "L", // YouTube forward 10 s
    "ArrowLeft", "ArrowRight", // back/forward 5 s
    "Home", "End", // seek to start / end
    ".", ",", // frame-step while paused
    "0", "1", "2", "3", "4", "5", "6", "7", "8", "9" // YouTube seek to % of video
  ])

  const findPlayerContainer = (): Element | null => {
    const config = getSiteConfig()
    if (config?.playerContainer) {
      const el = document.querySelector(config.playerContainer)
      if (el) {
        console.log("[couch-control-lock] findPlayerContainer: found via site config", {
          selector: config.playerContainer,
          element: el.tagName,
          id: (el as HTMLElement).id
        })
        return el
      }
      console.warn("[couch-control-lock] findPlayerContainer: site config selector matched nothing", {
        selector: config.playerContainer
      })
    }
    const fallback = video?.parentElement ?? null
    console.log("[couch-control-lock] findPlayerContainer: using fallback parent", {
      tagName: fallback?.tagName,
      id: (fallback as HTMLElement | null)?.id,
      className: (fallback as HTMLElement | null)?.className?.slice(0, 60)
    })
    return fallback
  }

  const enableControlLock = () => {
    console.log("[couch-control-lock] enableControlLock called", {
      hasExistingOverlay: !!controlLockOverlay,
      hasKeyboardHandler: !!controlLockKeyboardHandler,
      videoFound: !!video
    })

    if (!controlLockOverlay) {
      const container = findPlayerContainer()
      if (container) {
        controlLockOverlay = document.createElement("div")
        controlLockOverlay.id = "__synclify-control-lock__"
        controlLockOverlay.style.cssText = [
          "position: absolute",
          "top: 0",
          "left: 0",
          "right: 0",
          "bottom: 0",
          "z-index: 2147483647",
          "cursor: not-allowed",
          "background: transparent",
          "pointer-events: all"
        ].join("; ")

        const containerEl = container as HTMLElement
        const existingPosition = window.getComputedStyle(containerEl).position
        if (existingPosition === "static") {
          containerEl.style.position = "relative"
          console.log("[couch-control-lock] set container to position:relative", {
            tagName: containerEl.tagName,
            id: containerEl.id
          })
        }
        containerEl.appendChild(controlLockOverlay)
        console.log("[couch-control-lock] overlay injected", {
          container: containerEl.tagName,
          containerId: containerEl.id,
          containerClass: containerEl.className?.slice(0, 60)
        })
      } else {
        console.warn("[couch-control-lock] enableControlLock: no container found, overlay skipped")
      }
    } else {
      console.log("[couch-control-lock] overlay already exists, skipping re-injection")
    }

    if (!controlLockKeyboardHandler) {
      controlLockKeyboardHandler = (e: KeyboardEvent) => {
        if (isTypingTarget(e)) return
        if (BLOCKED_MEDIA_KEYS.has(e.key)) {
          e.preventDefault()
          e.stopImmediatePropagation()
          console.log("[couch-control-lock] blocked keyboard shortcut", {
            key: e.key,
            code: e.code,
            target: (e.target as Element)?.tagName
          })
        }
      }
      window.addEventListener("keydown", controlLockKeyboardHandler, true)
      console.log("[couch-control-lock] keyboard blocker attached")
    } else {
      console.log("[couch-control-lock] keyboard blocker already attached, skipping")
    }
  }

  const disableControlLock = () => {
    console.log("[couch-control-lock] disableControlLock called", {
      hasOverlay: !!controlLockOverlay,
      hasKeyboardHandler: !!controlLockKeyboardHandler
    })
    if (controlLockOverlay) {
      controlLockOverlay.remove()
      controlLockOverlay = null
      console.log("[couch-control-lock] overlay removed")
    }
    if (controlLockKeyboardHandler) {
      window.removeEventListener("keydown", controlLockKeyboardHandler, true)
      controlLockKeyboardHandler = null
      console.log("[couch-control-lock] keyboard blocker detached")
    }
  }

  const applyRemoteSyncedPlay = async (
    media: HTMLVideoElement,
    targetTimeSeconds: number
  ) => {
    suppressOutboundEvents()
    media.currentTime = targetTimeSeconds
    clearPlaybackGestureListeners()

    const preferredMuted = media.muted

    try {
      await media.play()
      return
    } catch (e: unknown) {
      const err = e as { name?: string }
      if (err?.name !== "NotAllowedError") {
        posthog.captureException(e instanceof Error ? e : new Error(String(e)))
        return
      }
    }

    media.muted = true
    try {
      await media.play()
      browser.runtime.sendMessage({
        action: "showToast",
        body: {
          error: false,
          content: "",
          messageKey: "remotePlayMutedHint"
        }
      })

      const onGesture = (e: Event) => {
        if (e instanceof KeyboardEvent && isTypingTarget(e)) return
        clearPlaybackGestureListeners()
        void (async () => {
          media.muted = preferredMuted
          try {
            await media.play()
          } catch {
            /* User can still use site controls after a gesture */
          }
        })()
      }

      document.addEventListener("pointerdown", onGesture, true)
      document.addEventListener("keydown", onGesture, true)
      teardownRemotePlaybackGesture = () => {
        document.removeEventListener("pointerdown", onGesture, true)
        document.removeEventListener("keydown", onGesture, true)
      }
    } catch {
      media.muted = preferredMuted

      const onGestureOnce = (e: Event) => {
        if (e instanceof KeyboardEvent && isTypingTarget(e)) return
        clearPlaybackGestureListeners()
        suppressOutboundEvents()
        void media.play()
      }

      document.addEventListener("pointerdown", onGestureOnce, true)
      document.addEventListener("keydown", onGestureOnce, true)
      teardownRemotePlaybackGesture = () => {
        document.removeEventListener("pointerdown", onGestureOnce, true)
        document.removeEventListener("keydown", onGestureOnce, true)
      }
    }
  }
  const suppressOutboundEvents = () => {
    suppressEventsUntil = Date.now() + SYNTHETIC_SUPPRESSION_MS
  }
  const markRemoteEventApplied = (serverTimestamp?: number) => {
    if (typeof serverTimestamp === "number") {
      lastAppliedRemoteEventTimestamp = Math.max(
        lastAppliedRemoteEventTimestamp,
        serverTimestamp
      )
    }
  }
  const isStaleRemoteEvent = (serverTimestamp?: number) => {
    return (
      typeof serverTimestamp === "number" &&
      serverTimestamp < lastAppliedRemoteEventTimestamp
    )
  }

  const persistState = (nextState: State) => {
    const nextTabState = nextState?.[tabId]
    logRoomDebug("persistState", {
      roomId: nextTabState?.roomId,
      participantId: nextTabState?.participantId,
      participantCount: nextTabState?.participantCount,
      participants: nextTabState?.participants,
      extra: {
        isHost: nextTabState?.isHost,
        hostId: nextTabState?.hostId
      }
    })
    state = nextState
    return browser.storage.local.set({ state: nextState })
  }

  const readLatestState = async () => {
    const storageResult = await browser.storage.local.get("state")
    return (storageResult.state as State | undefined) ?? state ?? {}
  }

  const updateTabState = async (patch: Partial<TabState>) => {
    const latestState = await readLatestState()
    const nextState = Object.assign({}, latestState, {
      [tabId]: {
        ...latestState?.[tabId],
        ...patch
      }
    })
    return persistState(nextState)
  }

  const clearTabState = async () => {
    const latestState = await readLatestState()
    const nextState = { ...latestState }
    delete nextState[tabId]
    activeRoomState = null
    joinedRoom = null
    roomCode = ""
    return persistState(nextState)
  }

  const trackMultiParticipantRoom = async (nextRoomState: RoomState) => {
    const participantId = state?.[tabId]?.participantId

    if (!participantId || nextRoomState.participantCount <= 2) return

    const trackingKey = `${participantId}:${nextRoomState.roomId}`
    const storageResult = await browser.storage.local.get(
      TRACKED_MULTI_PARTICIPANT_ROOMS_STORAGE_KEY
    )
    const trackedRooms = Array.isArray(
      storageResult[TRACKED_MULTI_PARTICIPANT_ROOMS_STORAGE_KEY]
    )
      ? (storageResult[
          TRACKED_MULTI_PARTICIPANT_ROOMS_STORAGE_KEY
        ] as string[])
      : []

    if (trackedRooms.includes(trackingKey)) return

    posthog.capture("room_more_than_two_participants", {
      roomId: nextRoomState.roomId,
      participantCount: nextRoomState.participantCount,
      controlMode: nextRoomState.controlMode,
      isHost: nextRoomState.hostId === participantId
    })

    await browser.storage.local.set({
      [TRACKED_MULTI_PARTICIPANT_ROOMS_STORAGE_KEY]: [
        ...trackedRooms.slice(-(MAX_TRACKED_MULTI_PARTICIPANT_ROOMS - 1)),
        trackingKey
      ]
    })
  }

  const applyRoomState = async (nextRoomState: RoomState) => {
    const participantId = state?.[tabId]?.participantId
    logRoomDebug("applyRoomState", {
      roomId: nextRoomState.roomId,
      participantId,
      participantCount: nextRoomState.participantCount,
      participants: nextRoomState.participants,
      extra: {
        hostId: nextRoomState.hostId,
        maxParticipants: nextRoomState.maxParticipants
      }
    })
    activeRoomState = nextRoomState
    joinedRoom = nextRoomState.roomId
    const isLocalHost = nextRoomState.hostId === participantId
    await updateTabState({
      roomId: nextRoomState.roomId,
      participantId,
      controlMode: nextRoomState.controlMode,
      nickname: state?.[tabId]?.nickname ?? "Anonymous",
      participants: nextRoomState.participants,
      participantCount: nextRoomState.participantCount,
      hostId: nextRoomState.hostId,
      isHost: isLocalHost,
      maxParticipants: nextRoomState.maxParticipants
    })
    await trackMultiParticipantRoom(nextRoomState)

    console.log("[couch-control-lock] applyRoomState: evaluating control lock", {
      controlMode: nextRoomState.controlMode,
      isLocalHost,
      participantId,
      hostId: nextRoomState.hostId
    })
    if (nextRoomState.controlMode === "host" && !isLocalHost) {
      enableControlLock()
    } else {
      disableControlLock()
    }
  }

  const ensureParticipantId = async () => {
    const existingParticipantId = state?.[tabId]?.participantId
    if (existingParticipantId) return existingParticipantId

    const participantId = crypto.randomUUID()
    await updateTabState({
      participantId
    })
    return participantId
  }

  const showRoomError = async (message: string) => {
    await browser.runtime.sendMessage({
      action: "showToast",
      body: {
        error: true,
        content: message
      }
    })
  }

  const resolveCanonicalPageUrl = async () => {
    try {
      const tabUrl = await browser.runtime.sendMessage({
        action: "getTabUrl",
        tabId
      })
      if (
        typeof tabUrl === "string" &&
        (tabUrl.startsWith("http://") || tabUrl.startsWith("https://"))
      ) {
        canonicalPageUrl = tabUrl
        return tabUrl
      }
    } catch {
      // Fallback to current frame URL below.
    }

    const frameUrl = window.location.href
    if (frameUrl.startsWith("http://") || frameUrl.startsWith("https://")) {
      canonicalPageUrl = frameUrl
      return frameUrl
    }
    return undefined
  }

  const emitRoomUrlSync = () => {
    if (!roomCode) return

    const currentUrl = canonicalPageUrl ?? window.location.href
    if (!currentUrl.startsWith("http://") && !currentUrl.startsWith("https://")) {
      logRoomDebug("urlSync.emit.skip.invalidUrl", {
        extra: {
          currentUrl
        }
      })
      return
    }

    const nickname = state?.[tabId]?.nickname || "Host"
    const payload: ChatMessage = {
      nickname,
      text: `${ROOM_URL_SYNC_PREFIX}${currentUrl}`,
      timestamp: Date.now()
    }

    logRoomDebug("urlSync.emit", {
      extra: {
        currentUrl
      }
    })
    console.log("[couch-url-sync] emit", {
      roomCode,
      currentUrl
    })
    socket.emit(SOCKET_EVENTS.CHAT_MESSAGE, roomCode, payload)
  }

  const emitRoomUrlSyncRequest = () => {
    if (!roomCode) return
    const nickname = state?.[tabId]?.nickname || "Anonymous"
    const payload: ChatMessage = {
      nickname,
      text: ROOM_URL_SYNC_REQUEST,
      timestamp: Date.now()
    }
    logRoomDebug("urlSync.request.emit")
    console.log("[couch-url-sync] request.emit", {
      roomCode
    })
    socket.emit(SOCKET_EVENTS.CHAT_MESSAGE, roomCode, payload)
  }

  const handleIncomingRoomUrlSync = (message: ChatMessage) => {
    if (!message.text.startsWith(ROOM_URL_SYNC_PREFIX)) return false

    const targetUrl = message.text.slice(ROOM_URL_SYNC_PREFIX.length).trim()
    if (
      !targetUrl ||
      (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://"))
    ) {
      logRoomDebug("urlSync.receive.skip.invalidTarget", {
        extra: {
          targetUrl
        }
      })
      return true
    }

    const isHost = state?.[tabId]?.isHost ?? false
    if (isHost) {
      logRoomDebug("urlSync.receive.skip.host", {
        extra: {
          targetUrl
        }
      })
      return true
    }

    const here = window.location.href.startsWith("http")
      ? window.location.href
      : canonicalPageUrl && canonicalPageUrl.startsWith("http")
        ? canonicalPageUrl
        : window.location.href
    if (urlsPlaybackEquivalent(targetUrl, here)) {
      logRoomDebug("urlSync.receive.skip.sameUrl", {
        extra: {
          targetUrl,
          here
        }
      })
      return true
    }

    logRoomDebug("urlSync.receive.navigate", {
      extra: {
        from: window.location.href,
        to: targetUrl
      }
    })
    console.log("[couch-url-sync] receive.navigate", {
      from: window.location.href,
      to: targetUrl
    })
    window.location.href = targetUrl
    return true
  }

  const socket = io(SOCKET_URL, {
    autoConnect: false,
    transports: ["websocket", "polling"]
  })

  const init = async (
    videoId: string,
    roomIdOverride?: string,
    nicknameOverride?: string,
    controlModeOverride?: ControlMode,
    participantIdOverride?: string
  ) => {
    if (pendingInitPromise) {
      return pendingInitPromise
    }

    pendingInitPromise = (async () => {
    const tabIdResult = await browser.runtime.sendMessage({
      action: "getTabId"
    })
    tabId = tabIdResult as number
    const storageResult = await browser.storage.local.get("state")
    const savedState = storageResult.state as State | undefined

    state = savedState ?? {}

    const settingsResult = await browser.storage.sync.get("settings")
    settings = settingsResult.settings as { syncAudio: boolean } | undefined
    await resolveCanonicalPageUrl()
    const nextRoomCode = roomIdOverride || state[tabId]?.roomId
    roomCode = nextRoomCode
    logRoomDebug("init", {
      roomId: roomCode,
      participantId: state?.[tabId]?.participantId,
      participantCount: state?.[tabId]?.participantCount,
      participants: state?.[tabId]?.participants,
      extra: {
        hasSavedState: !!savedState,
        hasActiveRoomState: !!activeRoomState
      }
    })
    if (!roomCode) {
      return {
        status: MESSAGE_STATUS.ERROR,
        message: "Missing room code."
      }
    }

    if (
      roomIdOverride ||
      nicknameOverride ||
      controlModeOverride ||
      participantIdOverride
    ) {
      await updateTabState({
        roomId: roomCode,
        nickname: nicknameOverride ?? state?.[tabId]?.nickname,
        controlMode: controlModeOverride ?? state?.[tabId]?.controlMode,
        participantId: participantIdOverride ?? state?.[tabId]?.participantId
      })
    }

    await ensureParticipantId()

    const joinResult = await joinRoom()
    if (joinResult.status !== MESSAGE_STATUS.SUCCESS) return joinResult

    // Join first so URL handoff can work even when the client starts on a page
    // without a detectable video (e.g. blank/new tab/homepage).
    return getVideo(videoId)
    })()

    try {
      return await pendingInitPromise
    } finally {
      pendingInitPromise = null
    }
  }

  const videoEventHandler = (event: Event) => {
    const controlMode = state?.[tabId]?.controlMode ?? "shared"
    const isHost = state?.[tabId]?.isHost ?? false
    const canControlPlayback = controlMode === "shared" || isHost

    if (!canControlPlayback) {
      // Overlay + keyboard blocker should prevent most interactions.
      // This revert is a safety net for anything that slips through
      // (e.g. site-internal programmatic calls, mobile gestures).
      console.log("[couch-control-lock] videoEventHandler: fallback revert triggered for non-host", {
        eventType: event.type,
        hasLastSyncedState: !!lastSyncedHostState,
        controlMode,
        isHost
      })
      suppressOutboundEvents()
      if (lastSyncedHostState && video) {
        const elapsed = (Date.now() - lastSyncedHostState.syncedAt) / 1000
        const expectedTime = lastSyncedHostState.paused
          ? lastSyncedHostState.currentTime
          : lastSyncedHostState.currentTime + elapsed * lastSyncedHostState.playbackRate
        console.log("[couch-control-lock] reverting video state", {
          eventType: event.type,
          expectedTime: expectedTime.toFixed(2),
          hostStatePaused: lastSyncedHostState.paused,
          currentVideoTime: video.currentTime.toFixed(2),
          currentVideoPaused: video.paused,
          elapsedSinceSync: elapsed.toFixed(2)
        })
        if (event.type === VIDEO_EVENTS.PLAY && lastSyncedHostState.paused) {
          video.pause()
        } else if (event.type === VIDEO_EVENTS.PAUSE && !lastSyncedHostState.paused) {
          void applyRemoteSyncedPlay(video, expectedTime)
        } else if (event.type === VIDEO_EVENTS.SEEKED) {
          video.currentTime = expectedTime
        }
      } else {
        console.warn("[couch-control-lock] fallback revert: no lastSyncedHostState or video available", {
          hasVideo: !!video,
          hasState: !!lastSyncedHostState
        })
      }
      return
    }

    if (roomCode) {
      const volumeOrRate =
        event.type === VIDEO_EVENTS.RATECHANGE
          ? video?.playbackRate
          : video?.volume
      socket.emit(
        SOCKET_EVENTS.VIDEO_EVENT,
        roomCode,
        event.type,
        volumeOrRate,
        video?.currentTime
      )
    }
  }

  const checkVideoEvent = (event: Event) => {
    if (Date.now() < suppressEventsUntil) {
      event.stopImmediatePropagation()
    } else videoEventHandler(event)
  }

  const observer = new MutationObserver(() => {
    if (!video) getVideo()
  })

  const getVideo = (videoId?: string) => {
    // First try by synclify-id if provided
    if (videoId) {
      video = document.querySelector(
        `[data-synclify-id="${videoId}"]`
      ) as HTMLVideoElement | null
    }

    // If no videoId or element not found, use site-specific detection
    if (!video) {
      const site = detectStreamingSite()
      if (site !== "unknown") {
        video = findSiteVideo()
        if (video) {
          // Ensure it has a synclify-id for future lookups
          if (!video.dataset.synclifyId) {
            video.dataset.synclifyId = Math.random().toString(36).slice(2, 7)
          }
        }
      }
    }

    // Final fallback: first video on the page
    if (!video) {
      video = document.querySelector("video")
      posthog.capture("video_id_null_fallback", {
        message:
          "videoId is null, using first element returned by document.querySelector"
      })
    }

    if (video != null) {
      videoNotFoundToastShown = false
      updateTabState({
        roomId: roomCode,
        videoFound: true
      }).catch((error) => {
        posthog.captureException(error as Error)
      })
      if (boundVideo) {
        for (const event of Object.values(VIDEO_EVENTS)) {
          boundVideo.removeEventListener(event, checkVideoEvent)
        }
      }
      boundVideo = video
      lastSyncedHostState = {
        paused: video.paused,
        currentTime: video.currentTime,
        syncedAt: Date.now(),
        playbackRate: video.playbackRate || 1
      }
      console.log("[couch-control-lock] lastSyncedHostState initialized from video element", {
        paused: lastSyncedHostState.paused,
        currentTime: lastSyncedHostState.currentTime.toFixed(2),
        playbackRate: lastSyncedHostState.playbackRate
      })
      for (const event of Object.values(VIDEO_EVENTS)) {
        boundVideo.addEventListener(event, checkVideoEvent)
      }
      observer.disconnect()
      browser.runtime.sendMessage({
        action: "showToast",
        body: { content: "", messageKey: "videoDetected" }
      })
      return { status: MESSAGE_STATUS.SUCCESS }
    }
    observer.observe(document, { subtree: true, childList: true })
    posthog.capture("no_video_found_pending_observer", {
      message: `No video element yet — observing DOM in ${window.location.href}`
    })
    // Room join already succeeded — return SUCCESS so the popup does NOT roll back storage
    // while the MutationObserver attaches to the player (common on slow-mount sites).
    return { status: MESSAGE_STATUS.SUCCESS }
  }

  const ensureSocketConnected = async () => {
    if (socket.connected) return
    if (pendingConnectPromise) {
      return pendingConnectPromise
    }

    connectRequestedByJoin = true
    pendingConnectPromise = new Promise<void>((resolve, reject) => {
      const onConnect = () => {
        cleanup()
        resolve()
      }
      const onError = (error: Error) => {
        cleanup()
        reject(error)
      }
      const cleanup = () => {
        socket.off("connect", onConnect)
        socket.off("connect_error", onError)
        pendingConnectPromise = null
        connectRequestedByJoin = false
      }

      socket.on("connect", onConnect)
      socket.on("connect_error", onError)
      socket.connect()
    })

    return pendingConnectPromise
  }

  const joinRoom = async () => {
    if (pendingJoinPromise) {
      return pendingJoinPromise
    }
    if (!roomCode) {
      const e = new Error("Invalid room code: " + roomCode)
      posthog.captureException(e)
      throw e
    }
    await ensureSocketConnected()

    if (joinedRoom === roomCode && activeRoomState) {
      return { status: MESSAGE_STATUS.SUCCESS }
    }

    const nickname = state?.[tabId]?.nickname || "Anonymous"
    const participantId = await ensureParticipantId()
    const controlMode: ControlMode = state?.[tabId]?.controlMode ?? "shared"
    const payload: JoinRoomPayload = {
      roomId: roomCode,
      nickname,
      participantId,
      controlMode,
      pageUrl: await resolveCanonicalPageUrl()
    }
    logRoomDebug("joinRoom.emit", {
      roomId: roomCode,
      participantId,
      participantCount: state?.[tabId]?.participantCount,
      participants: state?.[tabId]?.participants,
      extra: {
        nickname,
        controlMode,
        socketConnected: socket.connected
      }
    })

    pendingJoinPromise = new Promise<{ status: MESSAGE_STATUS; message?: string }>(
      (resolve) => {
        const onJoined = async (nextRoomState: RoomState) => {
          if (nextRoomState.roomId !== roomCode) return
          logRoomDebug("roomJoined", {
            roomId: nextRoomState.roomId,
            participantId,
            participantCount: nextRoomState.participantCount,
            participants: nextRoomState.participants,
            extra: {
              hostId: nextRoomState.hostId
            }
          })
          cleanup()
          await applyRoomState(nextRoomState)
          const isLocalHost = nextRoomState.hostId === participantId
          if (!isLocalHost) {
            emitRoomUrlSyncRequest()
          }
          resolve({ status: MESSAGE_STATUS.SUCCESS })
        }

        const onError = async (error: RoomErrorPayload) => {
          if (error.roomId && error.roomId !== roomCode) return
          cleanup()
          await clearTabState()
          await showRoomError(error.message)
          resolve({
            status: MESSAGE_STATUS.ERROR,
            message: error.message
          })
        }

        const cleanup = () => {
          socket.off(SOCKET_EVENTS.ROOM_JOINED, onJoined)
          socket.off(SOCKET_EVENTS.ROOM_ERROR, onError)
          pendingJoinPromise = null
        }

        socket.on(SOCKET_EVENTS.ROOM_JOINED, onJoined)
        socket.on(SOCKET_EVENTS.ROOM_ERROR, onError)
        socket.emit(SOCKET_EVENTS.JOIN, payload)
      }
    )
    return pendingJoinPromise
  }

  socket.on("disconnect", () => {
    logRoomDebug("disconnect", {
      extra: {
        isExitingRoom
      }
    })
    joinedRoom = null
    activeRoomState = null
    if (isExitingRoom) {
      isExitingRoom = false
      return
    }
    if (state?.[tabId]) {
      updateTabState({
        isHost: false
      }).catch(() => {})
    }
  })

  socket.on("connect", () => {
    logRoomDebug("connect", {
      extra: {
        connectRequestedByJoin,
        joinedRoom,
        hasActiveRoomState: !!activeRoomState
      }
    })
    // Measure latency on connect and periodically
    measureLatency()
    const latencyInterval = setInterval(() => {
      if (socket.connected) measureLatency()
      else clearInterval(latencyInterval)
    }, 30000)

    if (
      roomCode &&
      joinedRoom !== roomCode &&
      !pendingJoinPromise &&
      !connectRequestedByJoin
    ) {
      joinRoom().catch((error) => {
        posthog.captureException(error as Error)
      })
    }
  })

  socket.on(SOCKET_EVENTS.FULL, (room) => {
    const e = new Error("Room is full: " + room)
    posthog.captureException(e)
  })

  socket.on(SOCKET_EVENTS.ROOM_UPDATED, (nextRoomState: RoomState) => {
    if (nextRoomState.roomId !== roomCode) return
    const previousParticipantCount =
      activeRoomState?.participantCount ?? state?.[tabId]?.participantCount ?? 0
    const localParticipantId = state?.[tabId]?.participantId
    const isLocalHost =
      !!localParticipantId && nextRoomState.hostId === localParticipantId
    logRoomDebug("roomUpdated", {
      roomId: nextRoomState.roomId,
      participantId: state?.[tabId]?.participantId,
      participantCount: nextRoomState.participantCount,
      participants: nextRoomState.participants,
      extra: {
        hostId: nextRoomState.hostId
      }
    })
    applyRoomState(nextRoomState).catch((error) => {
      posthog.captureException(error as Error)
    })

    if (
      isLocalHost &&
      nextRoomState.participantCount > 1 &&
      nextRoomState.participantCount >= previousParticipantCount
    ) {
      emitRoomUrlSync()
    }
  })

  socket.on("connect_error", () => {
    posthog.capture("socket_connection_error", {
      message: "Socket connection error, allowing polling"
    })
    socket.io.opts.transports = ["polling", "websocket"]
  })

  // --- Chat message handling ---
  socket.on(SOCKET_EVENTS.CHAT_MESSAGE, (message: ChatMessage) => {
    if (message.text === ROOM_URL_SYNC_REQUEST) {
      const localParticipantId = state?.[tabId]?.participantId
      const isLocalHost =
        !!localParticipantId && activeRoomState?.hostId === localParticipantId
      logRoomDebug("urlSync.request.receive", {
        extra: {
          isLocalHost
        }
      })
      console.log("[couch-url-sync] request.receive", {
        roomCode,
        isLocalHost
      })
      if (isLocalHost) emitRoomUrlSync()
      return
    }
    if (handleIncomingRoomUrlSync(message)) return
    // Forward to chat content script via background relay
    browser.runtime.sendMessage({
      action: "forwardToChat",
      nickname: message.nickname,
      text: message.text,
      timestamp: message.timestamp
    })
  })

  // --- Reaction handling ---
  socket.on(
    SOCKET_EVENTS.REACTION,
    (data: { emoji: string; nickname: string }) => {
      // Forward to reactions content script via background relay
      browser.runtime.sendMessage({
        action: "forwardToReaction",
        emoji: data.emoji,
        nickname: data.nickname
      })
    }
  )

  // --- Latency compensation ---
  let estimatedClockOffsetMs = 0

  const measureLatency = async () => {
    const samples: Array<{ rtt: number; offset: number }> = []
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now()
      const pong = await new Promise<{
        clientSendTs: number
        serverTs: number
      }>((resolve) => {
        socket.once(SOCKET_EVENTS.SYNC_PONG, resolve)
        socket.emit(SOCKET_EVENTS.SYNC_PING, { clientSendTs: t0 })
      })
      const t2 = Date.now()
      const rtt = t2 - t0
      const offset = pong.serverTs - t0 - rtt / 2
      samples.push({ rtt, offset })
    }
    // Discard highest and lowest RTT, average the rest
    samples.sort((a, b) => a.rtt - b.rtt)
    const trimmed = samples.slice(1, -1)
    estimatedClockOffsetMs =
      trimmed.reduce((s, v) => s + v.offset, 0) / trimmed.length
  }

  socket.on(
    SOCKET_EVENTS.VIDEO_EVENT,
    (
      eventType: VIDEO_EVENTS,
      volumeValue: string,
      currentTime: string,
      serverTimestamp?: number
    ) => {
      if (video == null) {
        posthog.capture("socket_video_event_no_element", {
          eventType,
          note: "No video bound yet — likely early remote event."
        })
        return
      }
      const shouldTrackTimelineEvent =
        eventType === VIDEO_EVENTS.PLAY ||
        eventType === VIDEO_EVENTS.PAUSE ||
        eventType === VIDEO_EVENTS.SEEKED

      if (shouldTrackTimelineEvent) {
        if (isStaleRemoteEvent(serverTimestamp)) return
        markRemoteEventApplied(serverTimestamp)
      }

      // Latency-compensated time adjustment
      const adjustTime = (rawTime: number): number => {
        if (!serverTimestamp) return rawTime
        const localEventTime = serverTimestamp - estimatedClockOffsetMs
        const elapsed = (Date.now() - localEventTime) / 1000
        return rawTime + elapsed
      }

      switch (eventType) {
        case VIDEO_EVENTS.PLAY: {
          const adjustedTime = adjustTime(Number.parseFloat(currentTime))
          void applyRemoteSyncedPlay(video, adjustedTime)
          lastSyncedHostState = {
            paused: false,
            currentTime: adjustedTime,
            syncedAt: Date.now(),
            playbackRate: video.playbackRate || 1
          }
          console.log("[couch-control-lock] lastSyncedHostState updated: PLAY", {
            currentTime: adjustedTime.toFixed(2),
            playbackRate: lastSyncedHostState.playbackRate
          })
          break
        }
        case VIDEO_EVENTS.PAUSE:
          suppressOutboundEvents()
          video.pause()
          lastSyncedHostState = {
            paused: true,
            currentTime: video.currentTime,
            syncedAt: Date.now(),
            playbackRate: video.playbackRate || 1
          }
          console.log("[couch-control-lock] lastSyncedHostState updated: PAUSE", {
            currentTime: video.currentTime.toFixed(2)
          })
          break
        case VIDEO_EVENTS.VOLUMECHANGE:
          if (!settings?.syncAudio) break
          suppressOutboundEvents()
          video.volume = Number.parseFloat(volumeValue)
          break
        case VIDEO_EVENTS.SEEKED: {
          const adjustedTime = adjustTime(Number.parseFloat(currentTime))
          suppressOutboundEvents()
          video.currentTime = adjustedTime
          if (lastSyncedHostState) {
            lastSyncedHostState = {
              ...lastSyncedHostState,
              currentTime: adjustedTime,
              syncedAt: Date.now()
            }
            console.log("[couch-control-lock] lastSyncedHostState updated: SEEKED", {
              currentTime: adjustedTime.toFixed(2)
            })
          }
          break
        }
        case VIDEO_EVENTS.RATECHANGE:
          suppressOutboundEvents()
          video.playbackRate = Number.parseFloat(volumeValue)
          if (lastSyncedHostState) {
            lastSyncedHostState = {
              ...lastSyncedHostState,
              playbackRate: Number.parseFloat(volumeValue),
              syncedAt: Date.now()
            }
            console.log("[couch-control-lock] lastSyncedHostState updated: RATECHANGE", {
              playbackRate: lastSyncedHostState.playbackRate
            })
          }
          break
      }
    }
  )

  browser.runtime.onMessage.addListener(
    (
      request: ExtMessage & {
        type: MESSAGE_TYPE
        text?: string
        emoji?: string
      }
    ) => {
      switch (request.type) {
        case MESSAGE_TYPE.INIT: {
          return init(
            request.videoId,
            request.roomId,
            request.nickname,
            request.controlMode,
            request.participantId
          ).then((res) => {
            return res
          })
        }
        case MESSAGE_TYPE.EXIT:
          isExitingRoom = true
          clearPlaybackGestureListeners()
          disableControlLock()
          lastSyncedHostState = null
          console.log("[couch-control-lock] EXIT: control lock cleared")
          for (const event of Object.values(VIDEO_EVENTS)) {
            boundVideo?.removeEventListener(event, checkVideoEvent)
          }
          if (socket.connected && roomCode && state?.[tabId]?.participantId) {
            const leavePayload: LeaveRoomPayload = {
              roomId: roomCode,
              participantId: state[tabId].participantId as string
            }
            socket.emit(SOCKET_EVENTS.LEAVE, leavePayload)
          }
          clearTabState().catch(() => {})
          socket.disconnect()
          roomCode = ""
          joinedRoom = null
          activeRoomState = null
          pendingJoinPromise = null
          observer.disconnect()
          video = null
          boundVideo = null
          return Promise.resolve({
            status: MESSAGE_STATUS.SUCCESS
          })
        case MESSAGE_TYPE.CHAT: {
          // Outbound chat message from content script via background
          const nickname = state?.[tabId]?.nickname || "Anonymous"
          const msg: ChatMessage = {
            nickname,
            text: request.text || "",
            timestamp: Date.now()
          }
          socket.emit(SOCKET_EVENTS.CHAT_MESSAGE, roomCode, msg)
          // Echo back to own chat UI via background relay
          browser.runtime.sendMessage({
            action: "forwardToChat",
            nickname: msg.nickname,
            text: msg.text,
            timestamp: msg.timestamp,
            self: true
          })
          return Promise.resolve(null)
        }
        case MESSAGE_TYPE.REACTION: {
          const nickname = state?.[tabId]?.nickname || "Anonymous"
          socket.emit(SOCKET_EVENTS.REACTION, roomCode, {
            emoji: request.emoji,
            nickname
          })
          // Echo back to own reaction UI via background relay
          browser.runtime.sendMessage({
            action: "forwardToReaction",
            emoji: request.emoji,
            nickname
          })
          return Promise.resolve(null)
        }
        default:
          return
      }
    }
  )
})
