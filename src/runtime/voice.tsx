import ReactDOM from "react-dom/client"
import { useCallback, useEffect, useRef, useState } from "react"
import browser from "webextension-polyfill"
import { mountUi, runOnce, whenBodyReady } from "~/lib/runtime-ui"
import { io, type Socket } from "socket.io-client"
import {
  SOCKET_URL,
  type VoiceOfferPayload,
  type VoiceAnswerPayload,
  type VoiceIceCandidatePayload,
  type VoiceMutePayload,
  type VoicePeerJoinedPayload,
  type VoicePeerLeftPayload,
  type VoiceStateUpdatedPayload
} from "~/types/socket"
import type { TabState } from "~/types/state"

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" }
]

const BUBBLE_SIZE = 48
const EDGE_MARGIN = 12
const SPEAKING_THRESHOLD = 28
const SILENCE_THRESHOLD = 14

type VoiceParticipant = {
  id: string
  nickname: string
  muted: boolean
  self: boolean
}

function VoiceApp() {
  // --- Stable refs (never cause re-renders) ---
  const socketRef = useRef<Socket | null>(null)
  const peersRef = useRef(new Map<string, RTCPeerConnection>())
  const iceCandidateQueuesRef = useRef(new Map<string, RTCIceCandidateInit[]>())
  const audioElementsRef = useRef(new Map<string, HTMLAudioElement>())
  const localStreamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const vadCleanupsRef = useRef(new Map<string, () => void>())
  const roomIdRef = useRef("")
  const participantIdRef = useRef("")
  const nicknameRef = useRef("Anonymous")
  const allParticipantsRef = useRef<Array<{ id: string; nickname: string; isHost: boolean }>>([])
  const volumeRef = useRef(1)
  const mutedRef = useRef(false)
  const inVoiceRef = useRef(false)
  const isDown = useRef(false)
  const dragStart = useRef({ x: 0, y: 0, bx: 0, by: 0, moved: false })

  // Stable function refs so socket handlers never go stale
  const joinVoiceRef = useRef<(() => Promise<void>) | null>(null)
  const leaveVoiceRef = useRef<(() => void) | null>(null)
  const toggleMuteRef = useRef<(() => void) | null>(null)

  // --- React state ---
  const [visible, setVisible] = useState(false)
  const [inVoice, setInVoice] = useState(false)
  const [muted, setMuted] = useState(false)
  const [volume, setVolume] = useState(1)
  const [open, setOpen] = useState(false)
  const [voiceParticipants, setVoiceParticipants] = useState<VoiceParticipant[]>([])
  const [speakingIds, setSpeakingIds] = useState<Set<string>>(new Set())
  const [bubblePos, setBubblePos] = useState({ x: -1, y: -1 })
  const [dragging, setDragging] = useState(false)
  const [micError, setMicError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)

  // --- Visibility: only show when in a room ---
  useEffect(() => {
    const check = () => {
      browser.runtime
        .sendMessage({ action: "shouldInject" })
        .then((res: boolean) => setVisible(res))
        .catch(() => {})
    }
    check()
    const listener = (changes: Record<string, browser.Storage.StorageChange>) => {
      if (changes.state) check()
    }
    browser.storage.onChanged.addListener(listener)
    return () => browser.storage.onChanged.removeListener(listener)
  }, [])

  // --- Keep allParticipantsRef in sync with room state ---
  useEffect(() => {
    const sync = async () => {
      const tabState = (await browser.runtime
        .sendMessage({ action: "getTabState" })
        .catch(() => null)) as TabState | null
      if (tabState?.participants) {
        allParticipantsRef.current = tabState.participants
      }
    }
    sync()
    const listener = (changes: Record<string, browser.Storage.StorageChange>) => {
      if (changes.state) sync()
    }
    browser.storage.onChanged.addListener(listener)
    return () => browser.storage.onChanged.removeListener(listener)
  }, [])

  // --- Load saved bubble position (left side by default) ---
  useEffect(() => {
    browser.storage.local.get("voiceBubblePos").then((result) => {
      if (result.voiceBubblePos) {
        const saved = result.voiceBubblePos as { x: number; y: number }
        setBubblePos({
          x: Math.max(EDGE_MARGIN, Math.min(saved.x, window.innerWidth - BUBBLE_SIZE - EDGE_MARGIN)),
          y: Math.max(EDGE_MARGIN, Math.min(saved.y, window.innerHeight - BUBBLE_SIZE - EDGE_MARGIN))
        })
      } else {
        setBubblePos({
          x: EDGE_MARGIN,
          y: window.innerHeight - BUBBLE_SIZE - 80
        })
      }
    })
  }, [])

  // --- Keep bubble in bounds on resize ---
  const initialized = bubblePos.x >= 0
  const prevSize = useRef({ w: window.innerWidth, h: window.innerHeight })
  useEffect(() => {
    if (!initialized) return
    const onResize = () => {
      const oldW = prevSize.current.w
      const oldH = prevSize.current.h
      const newW = window.innerWidth
      const newH = window.innerHeight
      prevSize.current = { w: newW, h: newH }
      setBubblePos((prev) => {
        const wasOnRight = prev.x > oldW / 2
        const x = wasOnRight ? newW - BUBBLE_SIZE - EDGE_MARGIN : EDGE_MARGIN
        const ratio = oldH > 0 ? prev.y / oldH : 0.5
        const y = Math.max(EDGE_MARGIN, Math.min(Math.round(ratio * newH), newH - BUBBLE_SIZE - EDGE_MARGIN))
        if (x === prev.x && y === prev.y) return prev
        return { x, y }
      })
    }
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [initialized])

  // --- Core WebRTC + signaling logic, defined once on mount ---
  useEffect(() => {
    const getOrCreateAudioContext = (): AudioContext => {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioContext()
      }
      return audioCtxRef.current
    }

    const setupVAD = (stream: MediaStream, participantId: string): (() => void) => {
      try {
        const ctx = getOrCreateAudioContext()
        const source = ctx.createMediaStreamSource(stream)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 512
        analyser.smoothingTimeConstant = 0.8
        source.connect(analyser)

        const buffer = new Uint8Array(analyser.frequencyBinCount)
        let rafId: number
        let isSpeaking = false

        const check = () => {
          analyser.getByteFrequencyData(buffer)
          // Focus on rough speech frequency range
          const speechEnd = Math.min(Math.floor((3500 / 22050) * buffer.length), buffer.length)
          let sum = 0
          for (let i = 0; i < speechEnd; i++) sum += buffer[i]
          const avg = sum / speechEnd

          const threshold = isSpeaking ? SILENCE_THRESHOLD : SPEAKING_THRESHOLD
          const nowSpeaking = avg > threshold
          if (nowSpeaking !== isSpeaking) {
            isSpeaking = nowSpeaking
            setSpeakingIds((prev) => {
              const next = new Set(prev)
              if (isSpeaking) next.add(participantId)
              else next.delete(participantId)
              return next
            })
          }
          rafId = requestAnimationFrame(check)
        }
        check()

        return () => {
          cancelAnimationFrame(rafId)
          try { source.disconnect() } catch { /* ignore */ }
        }
      } catch {
        return () => {}
      }
    }

    const addRemoteStream = (peerId: string, stream: MediaStream) => {
      const existing = audioElementsRef.current.get(peerId)
      if (existing) {
        existing.pause()
        existing.srcObject = null
        existing.remove()
      }

      // Must be appended to the DOM for autoplay policy to allow playback
      const audio = document.createElement("audio")
      audio.srcObject = stream
      audio.volume = volumeRef.current
      audio.autoplay = true
      audio.style.cssText = "position:fixed;width:0;height:0;opacity:0;pointer-events:none"
      document.body.appendChild(audio)
      log(`addRemoteStream: audio element appended for peer ${peerId}, tracks: ${stream.getTracks().length}`)

      const startPlayback = () => {
        audio.play().then(() => {
          log(`audio playing for peer ${peerId}`)
        }).catch((err) => {
          logErr(`audio.play() failed for peer ${peerId}:`, err)
          // If still blocked, retry once on next user gesture
          const retry = () => { audio.play().catch(() => {}); document.removeEventListener("click", retry, true) }
          document.addEventListener("click", retry, { capture: true, once: true })
        })
      }
      startPlayback()
      audioElementsRef.current.set(peerId, audio)

      // Resume AudioContext if suspended (can happen after user gesture expires)
      if (audioCtxRef.current?.state === "suspended") {
        audioCtxRef.current.resume().catch(() => {})
      }

      const cleanup = setupVAD(stream, peerId)
      const prev = vadCleanupsRef.current.get(peerId)
      if (prev) prev()
      vadCleanupsRef.current.set(peerId, cleanup)
    }

    const log = (...args: unknown[]) => console.log("[couch-voice]", ...args)
    const logErr = (...args: unknown[]) => console.error("[couch-voice]", ...args)

    const flushIceCandidates = async (peerId: string, pc: RTCPeerConnection) => {
      const queued = iceCandidateQueuesRef.current.get(peerId) ?? []
      if (queued.length) log(`flushing ${queued.length} buffered ICE candidates for`, peerId)
      for (const candidate of queued) {
        try { await pc.addIceCandidate(candidate) } catch (e) { logErr("addIceCandidate failed", e) }
      }
      iceCandidateQueuesRef.current.delete(peerId)
    }

    const createPeer = async (peerId: string, isOfferer: boolean): Promise<RTCPeerConnection> => {
      // Close and replace a peer that is already in a broken state
      const existing = peersRef.current.get(peerId)
      if (existing) {
        if (existing.signalingState !== "closed" && existing.connectionState !== "failed") {
          log(`reusing existing peer for ${peerId} (state: ${existing.connectionState})`)
          return existing
        }
        log(`closing stale peer for ${peerId} before recreating`)
        existing.close()
      }

      log(`creating peer for ${peerId} as ${isOfferer ? "offerer" : "answerer"}`)
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
      peersRef.current.set(peerId, pc)

      // Share local audio tracks
      const stream = localStreamRef.current
      if (stream) {
        const tracks = stream.getAudioTracks()
        log(`adding ${tracks.length} local audio track(s) to peer ${peerId}`)
        for (const track of tracks) {
          pc.addTrack(track, stream)
        }
      } else {
        logErr("no local stream when creating peer for", peerId)
      }

      pc.ontrack = (event) => {
        const remoteStream = event.streams[0] ?? new MediaStream([event.track])
        log(`ontrack fired for peer ${peerId} — stream has ${remoteStream.getTracks().length} track(s)`)
        addRemoteStream(peerId, remoteStream)
      }

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          log(`sending ICE candidate to ${peerId}:`, event.candidate.type)
          socketRef.current?.emit("voiceIceCandidate", roomIdRef.current, peerId, event.candidate.toJSON())
        } else {
          log(`ICE gathering complete for peer ${peerId}`)
        }
      }

      pc.oniceconnectionstatechange = () => {
        log(`ICE connection state for ${peerId}: ${pc.iceConnectionState}`)
        if (pc.iceConnectionState === "failed") {
          logErr(`ICE failed for peer ${peerId} — restarting ICE`)
          pc.restartIce()
        }
      }

      pc.onconnectionstatechange = () => {
        log(`connection state for ${peerId}: ${pc.connectionState}`)
      }

      if (isOfferer) {
        try {
          const offer = await pc.createOffer()
          await pc.setLocalDescription(offer)
          log(`offer created and set for ${peerId}, sending via socket`)
          socketRef.current?.emit("voiceOffer", roomIdRef.current, peerId, offer)
        } catch (e) {
          logErr("failed to create/send offer for", peerId, e)
        }
      }

      return pc
    }

    const closePeer = (peerId: string) => {
      const pc = peersRef.current.get(peerId)
      if (pc) {
        pc.close()
        peersRef.current.delete(peerId)
      }
      const audio = audioElementsRef.current.get(peerId)
      if (audio) {
        audio.pause()
        audio.srcObject = null
        audio.remove()
        audioElementsRef.current.delete(peerId)
      }
      const vadCleanup = vadCleanupsRef.current.get(peerId)
      if (vadCleanup) {
        vadCleanup()
        vadCleanupsRef.current.delete(peerId)
      }
      iceCandidateQueuesRef.current.delete(peerId)
      setSpeakingIds((prev) => {
        const next = new Set(prev)
        next.delete(peerId)
        return next
      })
    }

    const lookupNickname = (participantId: string): string => {
      const found = allParticipantsRef.current.find((p) => p.id === participantId)
      return found?.nickname ?? "Unknown"
    }

    const updateParticipantsList = (voiceParticipantIds: string[]) => {
      const list: VoiceParticipant[] = voiceParticipantIds.map((id) => ({
        id,
        nickname: id === participantIdRef.current ? nicknameRef.current : lookupNickname(id),
        muted: id === participantIdRef.current ? mutedRef.current : false,
        self: id === participantIdRef.current
      }))
      // Ensure self is always in the list
      if (!voiceParticipantIds.includes(participantIdRef.current) && participantIdRef.current) {
        list.unshift({
          id: participantIdRef.current,
          nickname: nicknameRef.current,
          muted: mutedRef.current,
          self: true
        })
      }
      setVoiceParticipants(list)
    }

    const setupSocket = (): Socket => {
      const socket = io(SOCKET_URL, {
        autoConnect: false,
        transports: ["websocket", "polling"]
      })

      socket.on("voicePeerJoined", async ({ participantId }: VoicePeerJoinedPayload) => {
        if (participantId === participantIdRef.current) return
        log(`voicePeerJoined: ${participantId} joined — I will send the offer`)
        try {
          await createPeer(participantId, true)
        } catch (e) {
          logErr("voicePeerJoined: createPeer failed", e)
        }
        setVoiceParticipants((prev) => {
          if (prev.some((p) => p.id === participantId)) return prev
          return [
            ...prev,
            {
              id: participantId,
              nickname: lookupNickname(participantId),
              muted: false,
              self: false
            }
          ]
        })
      })

      socket.on("voiceOffer", async ({ fromParticipantId, sdp }: VoiceOfferPayload) => {
        log(`voiceOffer received from ${fromParticipantId}`)
        try {
          const pc = await createPeer(fromParticipantId, false)
          await pc.setRemoteDescription(new RTCSessionDescription(sdp))
          await flushIceCandidates(fromParticipantId, pc)
          const answer = await pc.createAnswer()
          await pc.setLocalDescription(answer)
          log(`voiceAnswer sent to ${fromParticipantId}`)
          socket.emit("voiceAnswer", roomIdRef.current, fromParticipantId, answer)
        } catch (e) {
          logErr("voiceOffer handler failed", e)
        }
      })

      socket.on("voiceAnswer", async ({ fromParticipantId, sdp }: VoiceAnswerPayload) => {
        log(`voiceAnswer received from ${fromParticipantId}`)
        const pc = peersRef.current.get(fromParticipantId)
        if (!pc) { logErr("voiceAnswer: no peer found for", fromParticipantId); return }
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(sdp))
          await flushIceCandidates(fromParticipantId, pc)
        } catch (e) {
          logErr("voiceAnswer handler failed", e)
        }
      })

      socket.on("voiceIceCandidate", async ({ fromParticipantId, candidate }: VoiceIceCandidatePayload) => {
        log(`voiceIceCandidate received from ${fromParticipantId}`)
        const pc = peersRef.current.get(fromParticipantId)
        if (pc && pc.remoteDescription) {
          try { await pc.addIceCandidate(new RTCIceCandidate(candidate)) } catch (e) { logErr("addIceCandidate failed", e) }
        } else {
          log(`buffering ICE candidate from ${fromParticipantId} (no remoteDescription yet)`)
          const queue = iceCandidateQueuesRef.current.get(fromParticipantId) ?? []
          queue.push(candidate)
          iceCandidateQueuesRef.current.set(fromParticipantId, queue)
        }
      })

      socket.on("voiceStateUpdated", ({ voiceParticipants }: VoiceStateUpdatedPayload) => {
        updateParticipantsList(voiceParticipants)
      })

      socket.on("voicePeerLeft", ({ participantId }: VoicePeerLeftPayload) => {
        closePeer(participantId)
        setVoiceParticipants((prev) => prev.filter((p) => p.id !== participantId))
      })

      socket.on("voiceMuteToggle", ({ participantId, muted }: VoiceMutePayload) => {
        setVoiceParticipants((prev) =>
          prev.map((p) => (p.id === participantId ? { ...p, muted } : p))
        )
      })

      socket.on("disconnect", () => {
        if (inVoiceRef.current) {
          // Unexpected disconnect: clean up peer connections
          for (const peerId of peersRef.current.keys()) closePeer(peerId)
        }
      })

      socketRef.current = socket
      return socket
    }

    // --- Public API stored in refs so React callbacks can call them ---

    joinVoiceRef.current = async () => {
      setConnecting(true)
      setMicError(null)

      try {
        // Get tab state (roomId, participantId, nickname, participants)
        const tabState = (await browser.runtime
          .sendMessage({ action: "getTabState" })
          .catch(() => null)) as TabState | null

        if (!tabState?.roomId || !tabState.participantId) {
          setMicError("Not in a room")
          return
        }

        roomIdRef.current = tabState.roomId
        participantIdRef.current = tabState.participantId
        nicknameRef.current = tabState.nickname ?? "Anonymous"
        allParticipantsRef.current = tabState.participants ?? []

        // Request microphone access
        let stream: MediaStream
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
        } catch (err) {
          const e = err as Error
          if (e.name === "NotAllowedError" || e.name === "PermissionDeniedError") {
            setMicError("Microphone access denied")
          } else if (e.name === "NotFoundError" || e.name === "DevicesNotFoundError") {
            setMicError("No microphone found")
          } else {
            setMicError("Could not access microphone")
          }
          return
        }

        localStreamRef.current = stream

        // Resume / create AudioContext while still inside the user-gesture callback
        if (!audioCtxRef.current) {
          audioCtxRef.current = new AudioContext()
        } else if (audioCtxRef.current.state === "suspended") {
          await audioCtxRef.current.resume().catch(() => {})
        }

        // Set up voice activity detection for our own audio
        const localVADCleanup = setupVAD(stream, participantIdRef.current)
        vadCleanupsRef.current.set("__local__", localVADCleanup)

        // Connect / reuse socket
        const socket = socketRef.current ?? setupSocket()
        if (!socket.connected) {
          await new Promise<void>((resolve, reject) => {
            const onConnect = () => { cleanup(); resolve() }
            const onError = () => { cleanup(); reject(new Error("Socket connection failed")) }
            const cleanup = () => {
              socket.off("connect", onConnect)
              socket.off("connect_error", onError)
            }
            socket.once("connect", onConnect)
            socket.once("connect_error", onError)
            socket.connect()
          })
        }

        // Register this socket for voice signaling
        console.log("[couch-voice] emitting voiceConnect", { roomId: roomIdRef.current, participantId: participantIdRef.current })
        socket.emit("voiceConnect", {
          roomId: roomIdRef.current,
          participantId: participantIdRef.current
        })

        // Enter voice chat
        console.log("[couch-voice] emitting voiceJoin")
        socket.emit("voiceJoin", roomIdRef.current, participantIdRef.current)

        inVoiceRef.current = true
        setInVoice(true)
        setOpen(true)
        setVoiceParticipants([{
          id: participantIdRef.current,
          nickname: nicknameRef.current,
          muted: false,
          self: true
        }])
      } catch (err) {
        setMicError("Failed to join voice chat")
        // Clean up partial state
        if (localStreamRef.current) {
          localStreamRef.current.getTracks().forEach((t) => t.stop())
          localStreamRef.current = null
        }
      } finally {
        setConnecting(false)
      }
    }

    leaveVoiceRef.current = () => {
      if (socketRef.current?.connected) {
        socketRef.current.emit("voiceLeave", roomIdRef.current, participantIdRef.current)
      }

      // Close all peer connections
      for (const peerId of Array.from(peersRef.current.keys())) closePeer(peerId)

      // Stop local microphone
      localStreamRef.current?.getTracks().forEach((t) => t.stop())
      localStreamRef.current = null

      // Stop local VAD
      const localVAD = vadCleanupsRef.current.get("__local__")
      if (localVAD) { localVAD(); vadCleanupsRef.current.delete("__local__") }

      inVoiceRef.current = false
      mutedRef.current = false
      setInVoice(false)
      setMuted(false)
      setVoiceParticipants([])
      setSpeakingIds(new Set())
      setOpen(false)
    }

    toggleMuteRef.current = () => {
      const stream = localStreamRef.current
      if (!stream) return
      const newMuted = !mutedRef.current
      mutedRef.current = newMuted
      for (const track of stream.getAudioTracks()) {
        track.enabled = !newMuted
      }
      setMuted(newMuted)
      if (socketRef.current?.connected) {
        socketRef.current.emit("voiceMuteToggle", roomIdRef.current, newMuted)
      }
      // Update own entry in participants list
      setVoiceParticipants((prev) =>
        prev.map((p) => (p.self ? { ...p, muted: newMuted } : p))
      )
    }

    return () => {
      // Cleanup on unmount
      leaveVoiceRef.current?.()
      socketRef.current?.disconnect()
    }
  }, []) // run once on mount

  // --- Volume control ---
  const handleVolumeChange = useCallback((vol: number) => {
    volumeRef.current = vol
    setVolume(vol)
    for (const audio of audioElementsRef.current.values()) {
      audio.volume = vol
    }
  }, [])

  // --- Drag logic (same pattern as chat bubble) ---
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      isDown.current = true
      dragStart.current = { x: e.clientX, y: e.clientY, bx: bubblePos.x, by: bubblePos.y, moved: false }
      setDragging(false)
    },
    [bubblePos]
  )

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDown.current) return
    const dx = e.clientX - dragStart.current.x
    const dy = e.clientY - dragStart.current.y
    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
      dragStart.current.moved = true
      setDragging(true)
    }
    if (dragStart.current.moved) {
      setBubblePos({
        x: Math.max(EDGE_MARGIN, Math.min(window.innerWidth - BUBBLE_SIZE - EDGE_MARGIN, dragStart.current.bx + dx)),
        y: Math.max(EDGE_MARGIN, Math.min(window.innerHeight - BUBBLE_SIZE - EDGE_MARGIN, dragStart.current.by + dy))
      })
    }
  }, [])

  const onPointerUp = useCallback(() => {
    isDown.current = false
    if (dragStart.current.moved) {
      dragStart.current.moved = false
      const midX = window.innerWidth / 2
      const snappedX =
        bubblePos.x + BUBBLE_SIZE / 2 < midX ? EDGE_MARGIN : window.innerWidth - BUBBLE_SIZE - EDGE_MARGIN
      const finalPos = { x: snappedX, y: bubblePos.y }
      setBubblePos(finalPos)
      browser.storage.local.set({ voiceBubblePos: finalPos })
      setTimeout(() => setDragging(false), 100)
    }
  }, [bubblePos])

  const handleBubbleClick = useCallback(() => {
    if (dragging) return
    if (inVoice) {
      setOpen((prev) => !prev)
    } else {
      joinVoiceRef.current?.()
    }
  }, [dragging, inVoice])

  const handleLeave = useCallback(() => {
    leaveVoiceRef.current?.()
  }, [])

  const handleToggleMute = useCallback(() => {
    toggleMuteRef.current?.()
  }, [])

  const isSelfSpeaking = speakingIds.has(participantIdRef.current)
  const bubbleOnRight = bubblePos.x + BUBBLE_SIZE / 2 > window.innerWidth / 2

  if (!visible || bubblePos.x < 0) return null

  const panelLeft = bubbleOnRight
    ? undefined
    : bubblePos.x + BUBBLE_SIZE + 8
  const panelRight = bubbleOnRight
    ? window.innerWidth - bubblePos.x + 8
    : undefined
  const panelTop = Math.max(
    EDGE_MARGIN,
    Math.min(bubblePos.y, window.innerHeight - 340 - EDGE_MARGIN)
  )

  return (
    <>
      {/* Floating mic bubble */}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onClick={handleBubbleClick}
        style={{
          position: "fixed",
          left: bubblePos.x,
          top: bubblePos.y,
          width: BUBBLE_SIZE,
          height: BUBBLE_SIZE,
          borderRadius: "50%",
          background: inVoice ? "hsl(142, 71%, 45%)" : "hsl(220, 20%, 20%)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: connecting ? "wait" : "grab",
          zIndex: 2147483647,
          boxShadow: isSelfSpeaking && inVoice
            ? "0 0 0 4px rgba(34,197,94,0.45), 0 4px 16px rgba(0,0,0,0.35)"
            : inVoice
              ? "0 0 0 2px rgba(34,197,94,0.3), 0 4px 16px rgba(0,0,0,0.35)"
              : "0 4px 16px rgba(0,0,0,0.3)",
          transition: dragging ? "none" : "left 0.2s ease, box-shadow 0.15s",
          touchAction: "none",
          userSelect: "none",
          opacity: connecting ? 0.7 : 1
        }}>
        {/* Mic icon */}
        {muted ? (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.7)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="1" y1="1" x2="23" y2="23" />
            <path d="M9 9v3a3 3 0 005.12 2.12M15 9.34V4a3 3 0 00-5.94-.6" />
            <path d="M17 16.95A7 7 0 015 12v-2m14 0v2a7 7 0 01-.11 1.23" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="8" y1="23" x2="16" y2="23" />
          </svg>
        ) : (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={inVoice ? "hsl(220,20%,6%)" : "rgba(255,255,255,0.85)"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" />
            <path d="M19 10v2a7 7 0 01-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="8" y1="23" x2="16" y2="23" />
          </svg>
        )}
      </div>

      {/* Voice panel */}
      {open && inVoice && (
        <div
          style={{
            position: "fixed",
            top: panelTop,
            left: panelLeft,
            right: panelRight,
            width: 260,
            borderRadius: 12,
            background: "rgba(10, 13, 20, 0.94)",
            backdropFilter: "blur(24px)",
            border: "1px solid rgba(34,197,94,0.18)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            zIndex: 2147483646,
            boxShadow: "0 0 0 1px rgba(34,197,94,0.08), 0 20px 40px rgba(0,0,0,0.55)",
            fontFamily: "'DM Sans', system-ui, sans-serif",
            pointerEvents: dragging ? "none" : "auto"
          }}>
          {/* Header */}
          <div
            style={{
              padding: "10px 14px",
              borderBottom: "1px solid rgba(255,255,255,0.06)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between"
            }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: "hsl(142, 71%, 45%)",
                  boxShadow: "0 0 6px rgba(34,197,94,0.6)"
                }}
              />
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: "rgba(255,255,255,0.85)",
                  letterSpacing: "0.04em"
                }}>
                Voice Chat
              </span>
            </div>
            <button
              onClick={() => setOpen(false)}
              style={{
                background: "none",
                border: "none",
                color: "rgba(255,255,255,0.35)",
                fontSize: 18,
                cursor: "pointer",
                padding: "0 2px",
                lineHeight: 1
              }}>
              &times;
            </button>
          </div>

          {/* Error message */}
          {micError && (
            <div
              style={{
                padding: "8px 14px",
                background: "rgba(239,68,68,0.12)",
                borderBottom: "1px solid rgba(239,68,68,0.2)",
                color: "rgba(239,68,68,0.9)",
                fontSize: 11,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between"
              }}>
              <span>{micError}</span>
              <button
                onClick={() => setMicError(null)}
                style={{
                  background: "none",
                  border: "none",
                  color: "rgba(239,68,68,0.6)",
                  cursor: "pointer",
                  fontSize: 14,
                  padding: 0,
                  lineHeight: 1
                }}>
                &times;
              </button>
            </div>
          )}

          {/* Participant list */}
          <div
            style={{
              padding: "8px 6px",
              display: "flex",
              flexDirection: "column",
              gap: 2,
              maxHeight: 180,
              overflowY: "auto"
            }}>
            {voiceParticipants.length === 0 && (
              <div
                style={{
                  textAlign: "center",
                  color: "rgba(255,255,255,0.25)",
                  fontSize: 11,
                  padding: "12px 0"
                }}>
                Waiting for others to join...
              </div>
            )}
            {voiceParticipants.map((p) => {
              const speaking = speakingIds.has(p.id) && !p.muted
              return (
                <div
                  key={p.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "5px 8px",
                    borderRadius: 7,
                    background: speaking ? "rgba(34,197,94,0.08)" : "transparent",
                    transition: "background 0.15s"
                  }}>
                  {/* Avatar circle */}
                  <div
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: "50%",
                      background: p.self ? "hsl(142,71%,38%)" : "rgba(255,255,255,0.1)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 11,
                      fontWeight: 700,
                      color: p.self ? "hsl(220,20%,6%)" : "rgba(255,255,255,0.7)",
                      flexShrink: 0,
                      boxShadow: speaking
                        ? "0 0 0 2px rgba(34,197,94,0.7)"
                        : "0 0 0 1px rgba(255,255,255,0.08)",
                      transition: "box-shadow 0.15s"
                    }}>
                    {p.nickname.charAt(0).toUpperCase()}
                  </div>
                  {/* Name */}
                  <span
                    style={{
                      flex: 1,
                      fontSize: 12,
                      color: speaking ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.65)",
                      fontWeight: speaking ? 600 : 400,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      transition: "color 0.15s"
                    }}>
                    {p.nickname}
                    {p.self && (
                      <span style={{ color: "rgba(255,255,255,0.3)", fontWeight: 400 }}> (you)</span>
                    )}
                  </span>
                  {/* Muted icon */}
                  {p.muted && (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(239,68,68,0.7)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="1" y1="1" x2="23" y2="23" />
                      <path d="M9 9v3a3 3 0 005.12 2.12M15 9.34V4a3 3 0 00-5.94-.6" />
                      <path d="M17 16.95A7 7 0 015 12v-2m14 0v2a7 7 0 01-.11 1.23" />
                    </svg>
                  )}
                </div>
              )
            })}
          </div>

          {/* Controls */}
          <div
            style={{
              padding: "8px 14px 12px",
              borderTop: "1px solid rgba(255,255,255,0.06)",
              display: "flex",
              flexDirection: "column",
              gap: 10
            }}>
            {/* Mute/unmute + Leave row */}
            <div style={{ display: "flex", gap: 8 }}>
              {/* Mute toggle */}
              <button
                onClick={handleToggleMute}
                title={muted ? "Unmute" : "Mute"}
                style={{
                  flex: 1,
                  padding: "7px 0",
                  borderRadius: 8,
                  border: "1px solid rgba(255,255,255,0.1)",
                  background: muted ? "rgba(239,68,68,0.15)" : "rgba(255,255,255,0.06)",
                  color: muted ? "rgba(239,68,68,0.9)" : "rgba(255,255,255,0.75)",
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 5,
                  fontFamily: "inherit",
                  transition: "background 0.15s, color 0.15s"
                }}>
                {muted ? (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="1" y1="1" x2="23" y2="23" />
                    <path d="M9 9v3a3 3 0 005.12 2.12M15 9.34V4a3 3 0 00-5.94-.6" />
                    <path d="M17 16.95A7 7 0 015 12v-2" />
                  </svg>
                ) : (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" />
                    <path d="M19 10v2a7 7 0 01-14 0v-2" />
                    <line x1="12" y1="19" x2="12" y2="23" />
                  </svg>
                )}
                {muted ? "Unmute" : "Mute"}
              </button>

              {/* Leave voice */}
              <button
                onClick={handleLeave}
                title="Leave voice chat"
                style={{
                  padding: "7px 12px",
                  borderRadius: 8,
                  border: "1px solid rgba(239,68,68,0.25)",
                  background: "rgba(239,68,68,0.1)",
                  color: "rgba(239,68,68,0.85)",
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  whiteSpace: "nowrap"
                }}>
                Leave
              </button>
            </div>

            {/* Volume slider */}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07" />
              </svg>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={volume}
                onChange={(e) => handleVolumeChange(parseFloat(e.currentTarget.value))}
                style={{
                  flex: 1,
                  accentColor: "hsl(142, 71%, 45%)",
                  cursor: "pointer",
                  height: 4
                }}
              />
              <span
                style={{
                  fontSize: 10,
                  color: "rgba(255,255,255,0.3)",
                  minWidth: 26,
                  textAlign: "right",
                  fontVariantNumeric: "tabular-nums"
                }}>
                {Math.round(volume * 100)}%
              </span>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export function initVoice(): void {
  if (!runOnce("voice")) return

  whenBodyReady(() => {
    const { mountPoint } = mountUi({
      id: "synclify-voice-root",
      shadow: true,
      watchFullscreenHost: true
    })
    const root = ReactDOM.createRoot(mountPoint)
    root.render(<VoiceApp />)
  })
}
