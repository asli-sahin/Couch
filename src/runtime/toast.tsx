import ReactDOM from "react-dom/client"
import { Toaster } from "~/components/ui/sonner"
import { toast } from "sonner"
import { useEffect, useRef } from "react"
import browser from "webextension-polyfill"
import type { MessageKey } from "~/lib/i18n"
import { t } from "~/lib/i18n"
import { mountUi, runOnce, whenBodyReady } from "~/lib/runtime-ui"

const ToastOverlay = () => {
  const isFullscreenRef = useRef(false)

  useEffect(() => {
    const handler = () => {
      isFullscreenRef.current = !!document.fullscreenElement
    }
    document.addEventListener("fullscreenchange", handler)
    return () => document.removeEventListener("fullscreenchange", handler)
  }, [])

  useEffect(() => {
    const callback = (
      msg: unknown,
      _sender: browser.Runtime.MessageSender,
      sendResponse: (response: unknown) => void
    ) => {
      const m = msg as {
        to: string
        show: boolean
        content: string
        error: boolean
        messageKey?: MessageKey
      }
      if (m.to === "toast") {
        const content = m.messageKey ? t(m.messageKey) : m.content
        if (m.show) {
          if (!isFullscreenRef.current) {
            // Use a stable id keyed to the content so repeated identical toasts
            // update the existing one instead of stacking new popups.
            const id = m.messageKey ?? content
            if (m.error) toast.error(content, { id })
            else toast.success(content, { id })
          }
        } else toast.dismiss()
        sendResponse(null)
        return true
      }
      return false
    }
    browser.runtime.onMessage.addListener(
      callback as browser.Runtime.OnMessageListener
    )

    return () => {
      browser.runtime.onMessage.removeListener(
        callback as browser.Runtime.OnMessageListener
      )
    }
  }, [])

  return <Toaster />
}

export function initToast(): void {
  if (!runOnce("toast")) return

  whenBodyReady(() => {
    const { mountPoint } = mountUi({
      id: "synclify-toast-root",
      watchFullscreenHost: true
    })
    const root = ReactDOM.createRoot(mountPoint)
    root.render(<ToastOverlay />)
  })
}
