const urlInput = document.getElementById("urlInput")
const newRoomBtn = document.getElementById("newRoomBtn")
const connectBtn = document.getElementById("connectBtn")
const disconnectBtn = document.getElementById("disconnectBtn")
const dot = document.getElementById("dot")
const statusText = document.getElementById("statusText")
const roomInfo = document.getElementById("roomInfo")
const roomId = document.getElementById("roomId")
const toolCount = document.getElementById("toolCount")
const toolsSection = document.getElementById("toolsSection")
const toolList = document.getElementById("toolList")
const mcpUrl = document.getElementById("mcpUrl")
const mcpEndpoint = document.getElementById("mcpEndpoint")
const copyBtn = document.getElementById("copyBtn")

function updateUI(state) {
  dot.className = `dot ${state.connectionState}`
  statusText.textContent =
    state.connectionState === "connected" ? "Connected" :
    state.connectionState === "connecting" ? "Connecting..." :
    "Disconnected"

  connectBtn.style.display = state.connectionState === "connected" ? "none" : "block"
  disconnectBtn.style.display = state.connectionState === "connected" ? "block" : "none"
  newRoomBtn.style.display = state.connectionState === "connected" ? "none" : "block"

  if (state.workerUrl) urlInput.value = state.workerUrl

  if (state.connectionState === "connected") {
    roomInfo.style.display = "block"
    roomId.textContent = state.room || "-"

    if (state.tools?.length > 0) {
      toolsSection.style.display = "block"
      toolCount.textContent = state.tools.length
      toolList.innerHTML = state.tools
        .map((t) => `<div class="tool-item"><span class="tool-name">${t}</span></div>`)
        .join("")
    } else {
      toolsSection.style.display = "none"
    }

    if (state.mcpUrl) {
      mcpUrl.style.display = "block"
      mcpEndpoint.textContent = state.mcpUrl
    }
  } else {
    roomInfo.style.display = "none"
    toolsSection.style.display = "none"
    mcpUrl.style.display = "none"
  }
}

// Get current state
chrome.runtime.sendMessage({ type: "getState" }, (response) => {
  if (response) updateUI(response)
})

// Listen for state updates
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "stateUpdate") updateUI(msg.state)
})

// New Room — create room then connect
newRoomBtn.addEventListener("click", async () => {
  const baseUrl = urlInput.value.trim().replace(/\/+$/, "")
  if (!baseUrl) {
    alert("Enter bridge URL first")
    return
  }

  newRoomBtn.disabled = true
  newRoomBtn.textContent = "Creating..."

  try {
    const res = await fetch(`${baseUrl}/new`)
    const data = await res.json()

    urlInput.value = baseUrl
    chrome.runtime.sendMessage({
      type: "connect",
      url: baseUrl,
      room: data.room,
    })
    updateUI({ connectionState: "connecting", workerUrl: baseUrl, room: data.room })
  } catch (err) {
    alert(`Failed: ${err.message}`)
  } finally {
    newRoomBtn.disabled = false
    newRoomBtn.textContent = "New Room"
  }
})

// Connect to existing room
connectBtn.addEventListener("click", () => {
  const url = urlInput.value.trim()
  if (!url) return

  // Extract room from URL if present
  const urlObj = new URL(url.startsWith("http") ? url : `https://${url}`)
  const room = urlObj.searchParams.get("room") || "default"
  const baseUrl = `${urlObj.protocol}//${urlObj.host}`

  chrome.runtime.sendMessage({ type: "connect", url: baseUrl, room })
  updateUI({ connectionState: "connecting", workerUrl: baseUrl, room })
})

// Disconnect
disconnectBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "disconnect" })
  updateUI({ connectionState: "disconnected", tools: [] })
})

// Copy MCP URL
copyBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(mcpEndpoint.textContent)
  copyBtn.textContent = " ✅"
  setTimeout(() => { copyBtn.textContent = " 📋" }, 1500)
})
