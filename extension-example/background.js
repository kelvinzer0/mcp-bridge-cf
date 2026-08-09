/**
 * MCP Bridge — Background Service Worker
 *
 * Manages WebSocket connection to Cloudflare Worker bridge.
 * Handles tool registration from content scripts.
 * Forwards tool calls to content scripts for execution.
 */

let ws = null
let workerUrl = ""
let reconnectTimer = null
let connectionState = "disconnected" // disconnected | connecting | connected

// Pending tool calls waiting for content script response
const pendingCalls = new Map()

// Registered tools
const registeredTools = new Map()

// ============================================================
//  CONNECTION MANAGEMENT
// ============================================================

async function connect(url) {
  if (ws) disconnect()

  workerUrl = url
  connectionState = "connecting"
  broadcastState()

  try {
    ws = new WebSocket(`${url}/ws/extension`)

    ws.onopen = () => {
      connectionState = "connected"
      broadcastState()
      clearTimeout(reconnectTimer)

      // Save URL for reconnect
      chrome.storage.local.set({ workerUrl: url })

      // Re-register all tools
      if (registeredTools.size > 0) {
        sendToWorker({
          type: "registerTools",
          tools: Array.from(registeredTools.values()),
        })
      }
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        handleWorkerMessage(msg)
      } catch (err) {
        console.error("[MCP Bridge] Bad message:", err)
      }
    }

    ws.onclose = () => {
      connectionState = "disconnected"
      broadcastState()
      ws = null

      // Auto-reconnect
      reconnectTimer = setTimeout(() => {
        if (workerUrl) connect(workerUrl)
      }, 5000)
    }

    ws.onerror = (err) => {
      console.error("[MCP Bridge] WebSocket error:", err)
    }
  } catch (err) {
    console.error("[MCP Bridge] Connect failed:", err)
    connectionState = "disconnected"
    broadcastState()
  }
}

function disconnect() {
  clearTimeout(reconnectTimer)
  workerUrl = ""
  if (ws) {
    ws.close()
    ws = null
  }
  connectionState = "disconnected"
  broadcastState()
}

function sendToWorker(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

// ============================================================
//  WORKER MESSAGE HANDLING
// ============================================================

function handleWorkerMessage(msg) {
  switch (msg.type) {
    case "callTool":
      handleToolCall(msg.callId, msg.name, msg.params)
      break
    case "ping":
      sendToWorker({ type: "pong" })
      break
  }
}

async function handleToolCall(callId, name, params) {
  try {
    const result = await executeTool(name, params)
    sendToWorker({ type: "toolResult", callId, result })
  } catch (err) {
    sendToWorker({
      type: "toolResult",
      callId,
      result: {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      },
    })
  }
}

// ============================================================
//  TOOL EXECUTION
// ============================================================

async function executeTool(name, params) {
  // Get active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab) throw new Error("No active tab")

  // Ensure content script is injected
  await ensureContentScript(tab.id)

  // Send tool call to content script and wait for response
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingCalls.delete(callId)
      reject(new Error("Tool execution timeout"))
    }, 30000)

    const callId = crypto.randomUUID()
    pendingCalls.set(callId, { resolve, reject, timeout })

    chrome.tabs.sendMessage(tab.id, {
      type: "executeTool",
      callId,
      name,
      params,
    })
  })
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "ping" })
  } catch {
    // Content script not loaded, inject it
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    })
    // Wait a bit for script to initialize
    await new Promise((r) => setTimeout(r, 100))
  }
}

// Handle content script responses
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === "toolResult" && msg.callId) {
    const pending = pendingCalls.get(msg.callId)
    if (pending) {
      clearTimeout(pending.timeout)
      pendingCalls.delete(msg.callId)
      pending.resolve(msg.result)
    }
  }

  if (msg.type === "registerTools") {
    for (const tool of msg.tools) {
      registeredTools.set(tool.name, tool)
    }
    sendToWorker({
      type: "registerTools",
      tools: msg.tools,
    })
  }

  if (msg.type === "unregisterTools") {
    for (const name of msg.names) {
      registeredTools.delete(name)
    }
    sendToWorker({ type: "unregisterTools", names: msg.names })
  }
})

// ============================================================
//  STATE BROADCASTING
// ============================================================

function broadcastState() {
  const state = {
    connectionState,
    workerUrl,
    toolsCount: registeredTools.size,
    tools: Array.from(registeredTools.keys()),
  }
  chrome.runtime.sendMessage({ type: "stateUpdate", state }).catch(() => {})
}

// ============================================================
//  INIT
// ============================================================

// Handle popup messages
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "connect") {
    connect(msg.url)
  }
  if (msg.type === "disconnect") {
    disconnect()
  }
  if (msg.type === "getState") {
    sendResponse({
      connectionState,
      workerUrl,
      toolsCount: registeredTools.size,
      tools: Array.from(registeredTools.keys()),
    })
  }
})

// Auto-connect on startup if URL was saved
chrome.storage.local.get(["workerUrl"], ({ workerUrl: savedUrl }) => {
  if (savedUrl) connect(savedUrl)
})

// Re-register tools when tab changes
chrome.tabs.onActivated.addListener(async () => {
  if (connectionState === "connected") {
    // Let content script detect context and re-register
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tab) {
      try {
        await ensureContentScript(tab.id)
        chrome.tabs.sendMessage(tab.id, { type: "detectAndRegister" })
      } catch {}
    }
  }
})

// Re-register on navigation
chrome.webNavigation?.onCompleted?.addListener(async (details) => {
  if (details.frameId === 0 && connectionState === "connected") {
    try {
      await ensureContentScript(details.tabId)
      chrome.tabs.sendMessage(details.tabId, { type: "detectAndRegister" })
    } catch {}
  }
})
