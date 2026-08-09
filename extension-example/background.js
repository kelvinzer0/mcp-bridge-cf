/**
 * MCP Bridge — Background Service Worker
 *
 * Manages WebSocket connection to Cloudflare Worker bridge.
 * Supports multi-room: each connection gets its own room.
 */

let ws = null
let workerUrl = ""
let room = ""
let reconnectTimer = null
let connectionState = "disconnected"

const pendingCalls = new Map()
const registeredTools = new Map()

// ============================================================
//  CONNECTION
// ============================================================

async function connect(url, roomId = "default") {
  if (ws) disconnect()

  workerUrl = url
  room = roomId
  connectionState = "connecting"
  broadcastState()

  try {
    const wsUrl = url.replace(/^http/, "ws") + `/ws/extension?room=${roomId}`
    ws = new WebSocket(wsUrl)

    ws.onopen = () => {
      connectionState = "connected"
      broadcastState()
      clearTimeout(reconnectTimer)
      chrome.storage.local.set({ workerUrl: url, room: roomId })

      if (registeredTools.size > 0) {
        sendToWorker({ type: "registerTools", tools: Array.from(registeredTools.values()) })
      }
    }

    ws.onmessage = (event) => {
      try {
        handleWorkerMessage(JSON.parse(event.data))
      } catch (err) {
        console.error("[MCP Bridge] Bad message:", err)
      }
    }

    ws.onclose = () => {
      connectionState = "disconnected"
      broadcastState()
      ws = null
      reconnectTimer = setTimeout(() => {
        if (workerUrl) connect(workerUrl, room)
      }, 5000)
    }

    ws.onerror = (err) => console.error("[MCP Bridge] WS error:", err)
  } catch (err) {
    console.error("[MCP Bridge] Connect failed:", err)
    connectionState = "disconnected"
    broadcastState()
  }
}

function disconnect() {
  clearTimeout(reconnectTimer)
  workerUrl = ""
  room = ""
  if (ws) { ws.close(); ws = null }
  connectionState = "disconnected"
  broadcastState()
}

function sendToWorker(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

// ============================================================
//  WORKER MESSAGES
// ============================================================

function handleWorkerMessage(msg) {
  if (msg.type === "callTool") handleToolCall(msg.callId, msg.name, msg.params)
  if (msg.type === "ping") sendToWorker({ type: "pong" })
}

async function handleToolCall(callId, name, params) {
  try {
    const result = await executeTool(name, params)
    sendToWorker({ type: "toolResult", callId, result })
  } catch (err) {
    sendToWorker({
      type: "toolResult", callId,
      result: { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true },
    })
  }
}

// ============================================================
//  TOOL EXECUTION
// ============================================================

async function executeTool(name, params) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab) throw new Error("No active tab")

  await ensureContentScript(tab.id)

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingCalls.delete(callId)
      reject(new Error("Tool execution timeout"))
    }, 30000)

    const callId = crypto.randomUUID()
    pendingCalls.set(callId, { resolve, reject, timeout })

    chrome.tabs.sendMessage(tab.id, { type: "executeTool", callId, name, params })
  })
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "ping" })
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] })
    await new Promise((r) => setTimeout(r, 100))
  }
}

// ============================================================
//  MESSAGE HANDLING (from popup & content)
// ============================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case "connect":
      connect(msg.url, msg.room || "default")
      break
    case "disconnect":
      disconnect()
      break
    case "getState":
      sendResponse({
        connectionState, workerUrl, room,
        toolsCount: registeredTools.size,
        tools: Array.from(registeredTools.keys()),
        mcpUrl: connectionState === "connected" ? `${workerUrl}/mcp?room=${room}` : null,
      })
      break
    case "toolResult":
      const pending = pendingCalls.get(msg.callId)
      if (pending) {
        clearTimeout(pending.timeout)
        pendingCalls.delete(msg.callId)
        pending.resolve(msg.result)
      }
      break
    case "registerTools":
      for (const tool of msg.tools) registeredTools.set(tool.name, tool)
      sendToWorker({ type: "registerTools", tools: msg.tools })
      break
    case "unregisterTools":
      for (const name of msg.names) registeredTools.delete(name)
      sendToWorker({ type: "unregisterTools", names: msg.names })
      break
  }
})

// ============================================================
//  AUTO-RECONNECT & CONTEXT DETECTION
// ============================================================

chrome.storage.local.get(["workerUrl", "room"], ({ workerUrl: savedUrl, room: savedRoom }) => {
  if (savedUrl) connect(savedUrl, savedRoom || "default")
})

chrome.tabs.onActivated.addListener(async () => {
  if (connectionState === "connected") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tab) {
      try {
        await ensureContentScript(tab.id)
        chrome.tabs.sendMessage(tab.id, { type: "detectAndRegister" })
      } catch {}
    }
  }
})

chrome.webNavigation?.onCompleted?.addListener(async (details) => {
  if (details.frameId === 0 && connectionState === "connected") {
    try {
      await ensureContentScript(details.tabId)
      chrome.tabs.sendMessage(details.tabId, { type: "detectAndRegister" })
    } catch {}
  }
})
