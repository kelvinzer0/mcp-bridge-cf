// === Extension ↔ Worker Messages ===

export interface RegisterToolsMessage {
  type: "registerTools"
  tools: ToolDefinition[]
}

export interface UnregisterToolsMessage {
  type: "unregisterTools"
  names: string[]
}

export interface CallToolMessage {
  type: "callTool"
  callId: string
  name: string
  params: Record<string, unknown>
}

export interface ToolResultMessage {
  type: "toolResult"
  callId: string
  result: ToolResult
}

export interface PongMessage {
  type: "pong"
}

export type ExtensionMessage =
  | RegisterToolsMessage
  | UnregisterToolsMessage
  | ToolResultMessage
  | PongMessage

export type WorkerMessage = CallToolMessage

// === Tool Definition ===

export interface ToolDefinition {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface ToolResult {
  content: ToolContent[]
  isError?: boolean
}

export interface ToolContent {
  type: "text" | "image" | "resource"
  text?: string
  data?: string
  mimeType?: string
}

// === MCP JSON-RPC ===

export interface JsonRpcRequest {
  jsonrpc: "2.0"
  id: number | string
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcNotification {
  jsonrpc: "2.0"
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: number | string | null
  result?: unknown
  error?: JsonRpcError
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}
