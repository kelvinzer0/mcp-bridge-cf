const urlInput = document.getElementById("urlInput")
const connectBtn = document.getElementById("connectBtn")
const disconnectBtn = document.getElementById("disconnectBtn")
const dot = document.getElementById("dot")
const statusText = document.getElementById("statusText")
const toolsSection = document.getElementById("toolsSection")
const toolCount = document.getElementById("toolCount")
const toolList = document.getElementById("toolList")
const mcpUrl = document.getElementById("mcpUrl")
const mcpEndpoint = document.getElementById("mcpEndpoint")

function updateUI(state) {
  // Status dot
  dot.className = `dot ${state.connectionState}`
  statusText.textContent =
    state.connectionState === "connected" ? "Connected" :
    state.connectionState === "connecting" ? "Connecting..." :
    "Disconnected"

  // Buttons
  connectBtn.style.display = state.connectionState === "connected" ? "none" : "block"
  disconnectBtn.style.display = state.connectionState === "connected" ? "block" : "none"

  // URL input
  if (state.workerUrl) urlInput.value = state.workerUrl

  // Tools
  if (state.connectionState === "connected" && state.tools?.length > 0) {
    toolsSection.style.display = "block"
    toolCount.textContent = state.tools.length
    toolList.innerHTML = state.tools
      .map((t) => `<div class="tool-item"><span class="tool-name">${t}</span></div>`)
      .join("")

    mcpUrl.style.display = "block"
    mcpEndpoint.textContent = `${state.workerUrl}/mcp`
  } else {
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

connectBtn.addEventListener("click", () => {
  const url = urlInput.value.trim()
  if (!url) return
  chrome.runtime.sendMessage({ type: "connect", url })
  updateUI({ connectionState: "connecting", workerUrl: url, tools: [] })
})

disconnectBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "disconnect" })
  updateUI({ connectionState: "disconnected", tools: [] })
})
