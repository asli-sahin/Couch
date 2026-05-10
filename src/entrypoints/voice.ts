import { defineUnlistedScript } from "wxt/utils/define-unlisted-script"
import { initVoice } from "~/runtime/voice"

export default defineUnlistedScript(() => {
  initVoice()
})
