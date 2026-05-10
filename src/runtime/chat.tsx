import ReactDOM from "react-dom/client"
import { useCallback, useEffect, useRef, useState } from "react"
import browser from "webextension-polyfill"
import { t } from "~/lib/i18n"
import { mountUi, runOnce, whenBodyReady } from "~/lib/runtime-ui"

type ChatMsg = {
  nickname: string
  text: string
  timestamp: number
  self?: boolean
}

const BUBBLE_SIZE = 48
const EDGE_MARGIN = 12
const CHAT_PANEL_HEIGHT = 420
const TOAST_DURATION_MS = 4000
const TOAST_FADE_MS = 500
const MAX_TOASTS = 4

type Toast = {
  id: number
  nickname: string
  text: string
  visible: boolean
}

function ChatApp() {
  const [visible, setVisible] = useState(false)
  const [settingEnabled, setSettingEnabled] = useState(true)
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [unread, setUnread] = useState(0)
  const [inputText, setInputText] = useState("")
  const [bubblePos, setBubblePos] = useState({ x: -1, y: -1 })
  const [dragging, setDragging] = useState(false)
  // Initialize to false: relying solely on the fullscreenchange event avoids
  // false positives when document.fullscreenElement is transiently non-null at
  // script injection time (which would otherwise lock the UI hidden permanently).
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])
  const isFullscreenRef = useRef(false)
  const toastIdRef = useRef(0)
  const isDown = useRef(false)
  const dragStart = useRef({ x: 0, y: 0, bx: 0, by: 0, moved: false })
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const hasTrackedOpen = useRef(false)
  const hasTrackedUsage = useRef(false)

  const trackChatTelemetry = useCallback(
    (body: {
      event: "chat_opened" | "chat_used"
      firstInteraction?: "incoming" | "outgoing"
    }) => {
      browser.runtime
        .sendMessage({
          action: "trackChatTelemetry",
          body
        })
        .catch(() => {})
    },
    []
  )

  // Check if in a room
  useEffect(() => {
    const check = () => {
      browser.runtime
        .sendMessage({ action: "shouldInject" })
        .then((res: boolean) => setVisible(res))
    }
    check()
    const listener = (
      changes: Record<string, browser.Storage.StorageChange>
    ) => {
      if (changes.state) check()
    }
    browser.storage.onChanged.addListener(listener)
    return () => browser.storage.onChanged.removeListener(listener)
  }, [])

  // Read showChat setting and watch for changes
  useEffect(() => {
    browser.storage.sync.get("settings").then((result) => {
      const settings = result.settings as { showChat?: boolean } | undefined
      if (settings?.showChat === false) setSettingEnabled(false)
    })
    const listener = (
      changes: Record<string, browser.Storage.StorageChange>,
      area: string
    ) => {
      if (area === "sync" && changes.settings) {
        const newSettings = changes.settings.newValue as
          | { showChat?: boolean }
          | undefined
        setSettingEnabled(newSettings?.showChat !== false)
      }
    }
    browser.storage.onChanged.addListener(listener)
    return () => browser.storage.onChanged.removeListener(listener)
  }, [])

  // Track fullscreen state — hide the UI while fullscreen, restore on exit
  useEffect(() => {
    const handler = () => {
      const fs = !!document.fullscreenElement
      isFullscreenRef.current = fs
      setIsFullscreen(fs)
      if (fs) setOpen(false)
    }
    document.addEventListener("fullscreenchange", handler)
    return () => document.removeEventListener("fullscreenchange", handler)
  }, [])

  // Publish open state so the voice panel can shift itself above the chat panel
  useEffect(() => {
    browser.storage.local.set({ chatPanelOpen: open }).catch(() => {})
  }, [open])

  // Load saved position
  useEffect(() => {
    browser.storage.local.get("chatBubblePos").then((result) => {
      if (result.chatBubblePos) {
        const saved = result.chatBubblePos as { x: number; y: number }
        setBubblePos({
          x: Math.max(
            EDGE_MARGIN,
            Math.min(saved.x, document.documentElement.clientWidth - BUBBLE_SIZE - EDGE_MARGIN)
          ),
          y: Math.max(
            EDGE_MARGIN,
            Math.min(saved.y, window.innerHeight - BUBBLE_SIZE - EDGE_MARGIN)
          )
        })
      } else {
        // Bottom-right, paired with voice bubble directly above
        setBubblePos({
          x: document.documentElement.clientWidth - BUBBLE_SIZE - EDGE_MARGIN,
          y: window.innerHeight - BUBBLE_SIZE - EDGE_MARGIN
        })
      }
    })
  }, [])

  // Keep bubble in bounds on window resize
  const initialized = bubblePos.x >= 0
  const prevSize = useRef({ w: window.innerWidth, h: window.innerHeight })
  useEffect(() => {
    if (!initialized) return
    const onResize = () => {
      const oldW = prevSize.current.w
      const oldH = prevSize.current.h
      const newW = document.documentElement.clientWidth
      const newH = window.innerHeight
      prevSize.current = { w: newW, h: newH }

      setBubblePos((prev) => {
        const wasOnRight = prev.x > oldW / 2
        const x = wasOnRight ? newW - BUBBLE_SIZE - EDGE_MARGIN : EDGE_MARGIN

        const ratio = oldH > 0 ? prev.y / oldH : 0.5
        const y = Math.max(
          EDGE_MARGIN,
          Math.min(Math.round(ratio * newH), newH - BUBBLE_SIZE - EDGE_MARGIN)
        )

        if (x === prev.x && y === prev.y) return prev
        return { x, y }
      })
    }
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [initialized])

  // Listen for incoming chat messages
  useEffect(() => {
    const handler = (
      msg: {
        to?: string
        type?: string
        nickname?: string
        text?: string
        timestamp?: number
        self?: boolean
      },
      _sender: browser.Runtime.MessageSender,
      sendResponse: (r: unknown) => void
    ) => {
      if (msg.to === "chat" && msg.type === "incoming") {
        const chatMsg: ChatMsg = {
          nickname: msg.nickname || "Anonymous",
          text: msg.text || "",
          timestamp: msg.timestamp || Date.now(),
          self: msg.self
        }
        setMessages((prev) => [...prev, chatMsg])
        if (!msg.self && !hasTrackedUsage.current) {
          hasTrackedUsage.current = true
          trackChatTelemetry({
            event: "chat_used",
            firstInteraction: "incoming"
          })
        }
        if (!open && !msg.self) {
          setUnread((prev) => prev + 1)
          // In fullscreen, show a temporary toast instead of the unread badge
          if (isFullscreenRef.current) {
            const id = ++toastIdRef.current
            const nickname = msg.nickname || "Anonymous"
            const text = msg.text || ""
            setToasts((prev) => [
              ...prev.slice(-(MAX_TOASTS - 1)),
              { id, nickname, text, visible: true }
            ])
            setTimeout(() => {
              setToasts((prev) =>
                prev.map((t) => (t.id === id ? { ...t, visible: false } : t))
              )
              setTimeout(() => {
                setToasts((prev) => prev.filter((t) => t.id !== id))
              }, TOAST_FADE_MS)
            }, TOAST_DURATION_MS)
          }
        }
        sendResponse(null)
        return true
      }
    }
    browser.runtime.onMessage.addListener(handler)
    return () => browser.runtime.onMessage.removeListener(handler)
  }, [open, trackChatTelemetry])

  // Auto-scroll on new messages
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [messages])

  // Focus input on open
  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus()
    }
  }, [open])

  const sendMessage = useCallback(async () => {
    const text = inputText.trim()
    if (!text) return
    try {
      await browser.runtime.sendMessage({
        action: "chatMessage",
        body: { text }
      })
      if (!hasTrackedUsage.current) {
        hasTrackedUsage.current = true
        trackChatTelemetry({
          event: "chat_used",
          firstInteraction: "outgoing"
        })
      }
      setInputText("")
    } catch {}
  }, [inputText, trackChatTelemetry])

  const toggleOpen = useCallback(() => {
    if (!dragging) {
      setOpen((prev) => {
        const next = !prev
        if (next && !hasTrackedOpen.current) {
          hasTrackedOpen.current = true
          trackChatTelemetry({ event: "chat_opened" })
        }
        return next
      })
      setUnread(0)
    }
  }, [dragging, trackChatTelemetry])

  // Drag handlers
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      isDown.current = true
      dragStart.current = {
        x: e.clientX,
        y: e.clientY,
        bx: bubblePos.x,
        by: bubblePos.y,
        moved: false
      }
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
      const newX = Math.max(
        EDGE_MARGIN,
        Math.min(
          document.documentElement.clientWidth - BUBBLE_SIZE - EDGE_MARGIN,
          dragStart.current.bx + dx
        )
      )
      const newY = Math.max(
        EDGE_MARGIN,
        Math.min(
          window.innerHeight - BUBBLE_SIZE - EDGE_MARGIN,
          dragStart.current.by + dy
        )
      )
      setBubblePos({ x: newX, y: newY })
    }
  }, [])

  const onPointerUp = useCallback(() => {
    isDown.current = false
    if (dragStart.current.moved) {
      dragStart.current.moved = false
      // Snap to nearest edge
      const midX = window.innerWidth / 2
      const snappedX =
        bubblePos.x + BUBBLE_SIZE / 2 < midX
          ? EDGE_MARGIN
          : document.documentElement.clientWidth - BUBBLE_SIZE - EDGE_MARGIN
      const finalPos = { x: snappedX, y: bubblePos.y }
      setBubblePos(finalPos)
      browser.storage.local.set({ chatBubblePos: finalPos })
      // Small timeout so the click handler doesn't fire
      setTimeout(() => setDragging(false), 100)
    }
  }, [bubblePos])

  const bubbleOnRight = bubblePos.x + BUBBLE_SIZE / 2 > window.innerWidth / 2

  if (!visible || !settingEnabled || bubblePos.x < 0) return null

  const formatTime = (ts: number) => {
    const d = new Date(ts)
    return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`
  }

  // While fullscreen: hide all UI, only render incoming message toasts
  if (isFullscreen) {
    return (
      <div
        style={{
          position: "fixed",
          bottom: BUBBLE_SIZE + EDGE_MARGIN * 2,
          right: EDGE_MARGIN,
          display: "flex",
          flexDirection: "column",
          gap: 6,
          alignItems: "flex-end",
          zIndex: 2147483647,
          pointerEvents: "none"
        }}>
        {toasts.map((toast) => (
          <div
            key={toast.id}
            style={{
              maxWidth: 300,
              padding: "8px 14px",
              borderRadius: 10,
              background: "rgba(25, 0, 48, 0.88)",
              backdropFilter: "blur(16px)",
              border: "1px solid rgba(130, 0, 67, 0.4)",
              boxShadow: "0 4px 20px rgba(25,0,48,0.6)",
              fontFamily: "'DM Sans', system-ui, sans-serif",
              opacity: toast.visible ? 1 : 0,
              transform: toast.visible ? "translateY(0)" : "translateY(6px)",
              transition: `opacity ${TOAST_FADE_MS}ms ease, transform ${TOAST_FADE_MS}ms ease`
            }}>
            <span
              style={{
                fontSize: 10,
                fontWeight: 600,
                color: "hsl(329, 85%, 68%)",
                display: "block",
                marginBottom: 2,
                letterSpacing: "0.04em"
              }}>
              {toast.nickname}
            </span>
            <span
              style={{
                fontSize: 13,
                color: "rgba(255,255,255,0.88)",
                lineHeight: 1.4,
                wordBreak: "break-word"
              }}>
              {toast.text}
            </span>
          </div>
        ))}
      </div>
    )
  }

  return (
    <>
      {/* Bubble */}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onClick={toggleOpen}
        style={{
          position: "fixed",
          ...(bubbleOnRight
            ? { right: dragging
                ? document.documentElement.clientWidth - bubblePos.x - BUBBLE_SIZE
                : EDGE_MARGIN }
            : { left: bubblePos.x }),
          top: bubblePos.y,
          width: BUBBLE_SIZE,
          height: BUBBLE_SIZE,
          borderRadius: "50%",
          background: "#820043",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "grab",
          zIndex: 2147483647,
          boxShadow: "0 4px 16px rgba(130,0,67,0.45)",
          transition: dragging ? "none" : "left 0.2s ease",
          touchAction: "none",
          userSelect: "none"
        }}>
        {/* Chat icon SVG */}
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="rgba(255,255,255,0.92)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round">
          <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
        </svg>
        {/* Unread badge */}
        {unread > 0 && (
          <div
            style={{
              position: "absolute",
              top: -4,
              right: -4,
              background: "#ef4444",
              color: "#fff",
              fontSize: 11,
              fontWeight: 700,
              minWidth: 18,
              height: 18,
              borderRadius: 9,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "0 4px",
              fontFamily: "system-ui, sans-serif"
            }}>
            {unread > 99 ? "99+" : unread}
          </div>
        )}
      </div>

      {/* Chat window */}
      {open && (
        <div
          onKeyDown={(e) => e.stopPropagation()}
          onKeyUp={(e) => e.stopPropagation()}
          style={{
            position: "fixed",
            bottom: EDGE_MARGIN,
            ...(bubbleOnRight
              ? { right: BUBBLE_SIZE + EDGE_MARGIN + 8 }
              : { left: bubblePos.x + BUBBLE_SIZE + 8 }),
            width: 320,
            height: CHAT_PANEL_HEIGHT,
            borderRadius: 12,
            background: "rgba(25, 0, 48, 0.96)",
            backdropFilter: "blur(24px)",
            border: "1px solid rgba(130, 0, 67, 0.3)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            zIndex: 2147483646,
            boxShadow:
              "0 0 0 1px rgba(130,0,67,0.15), 0 24px 48px rgba(25,0,48,0.7)",
            fontFamily: "'DM Sans', system-ui, sans-serif",
            pointerEvents: dragging ? "none" : "auto"
          }}>
          {/* Header */}
          <div
            style={{
              padding: "12px 16px",
              borderBottom: "1px solid rgba(130,0,67,0.2)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between"
            }}>
            <span
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: "hsl(329, 85%, 68%)",
                letterSpacing: "0.03em"
              }}>
              Chat
            </span>
            <button
              onClick={() => setOpen(false)}
              style={{
                background: "none",
                border: "none",
                color: "rgba(255,255,255,0.4)",
                fontSize: 18,
                cursor: "pointer",
                padding: "0 4px",
                lineHeight: 1
              }}>
              &times;
            </button>
          </div>

          {/* Message list */}
          <div
            ref={listRef}
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "12px 12px 8px",
              display: "flex",
              flexDirection: "column",
              gap: 4
            }}>
            {messages.length === 0 && (
              <div
                style={{
                  textAlign: "center",
                  color: "rgba(255,255,255,0.25)",
                  fontSize: 12,
                  marginTop: 60
                }}>
                No messages yet
              </div>
            )}
            {messages.map((msg, i) => {
              const prevMsg = i > 0 ? messages[i - 1] : null
              const sameAuthor =
                prevMsg &&
                prevMsg.nickname === msg.nickname &&
                prevMsg.self === msg.self
              return (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: msg.self ? "flex-end" : "flex-start",
                    marginTop: sameAuthor ? 0 : 8
                  }}>
                  {!sameAuthor && (
                    <span
                      style={{
                        fontSize: 10,
                        color: "rgba(255,255,255,0.35)",
                        marginBottom: 2,
                        padding: msg.self ? "0 8px 0 0" : "0 0 0 8px"
                      }}>
                      {msg.nickname}
                    </span>
                  )}
                  <div
                    style={{
                      maxWidth: "80%",
                      padding: "6px 12px",
                      borderRadius: 12,
                      background: msg.self
                        ? "#820043"
                        : "rgba(255,255,255,0.08)",
                      color: msg.self
                        ? "#fff"
                        : "rgba(255,255,255,0.85)",
                      fontSize: 13,
                      lineHeight: 1.4,
                      wordBreak: "break-word",
                      whiteSpace: "pre-wrap"
                    }}>
                    {msg.text}
                  </div>
                  <span
                    style={{
                      fontSize: 9,
                      color: "rgba(255,255,255,0.2)",
                      marginTop: 2,
                      padding: msg.self ? "0 8px 0 0" : "0 0 0 8px"
                    }}>
                    {formatTime(msg.timestamp)}
                  </span>
                </div>
              )
            })}
          </div>

          {/* Input area */}
          <div
            style={{
              padding: "8px 12px 12px",
              borderTop: "1px solid rgba(130,0,67,0.2)",
              display: "flex",
              gap: 8,
              alignItems: "flex-end"
            }}>
            <textarea
              ref={inputRef}
              value={inputText}
              onChange={(e) => setInputText(e.currentTarget.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault()
                  sendMessage()
                }
              }}
              placeholder={t("typeMessage")}
              rows={1}
              style={{
                flex: 1,
                resize: "none",
                background: "rgba(130,0,67,0.1)",
                border: "1px solid rgba(130,0,67,0.2)",
                borderRadius: 8,
                padding: "8px 12px",
                color: "rgba(255,255,255,0.85)",
                fontSize: 13,
                fontFamily: "inherit",
                outline: "none",
                maxHeight: 80,
                lineHeight: 1.4
              }}
            />
            <button
              onClick={sendMessage}
              style={{
                background: "#820043",
                border: "none",
                borderRadius: 8,
                width: 36,
                height: 36,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                flexShrink: 0
              }}>
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="rgba(255,255,255,0.92)"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </>
  )
}

export function initChat(): void {
  if (!runOnce("chat")) return

  whenBodyReady(() => {
    const { mountPoint } = mountUi({
      id: "synclify-chat-root",
      shadow: true,
      watchFullscreenHost: true
    })
    const root = ReactDOM.createRoot(mountPoint)
    root.render(<ChatApp />)
  })
}
