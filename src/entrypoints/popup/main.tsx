import React from "react"
import ReactDOM from "react-dom/client"

import App from "./App"
import "~/assets/style.css"
import { setDocumentTitle } from "~/lib/i18n"

function mount() {
  setDocumentTitle("popupTitle")

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

mount()
